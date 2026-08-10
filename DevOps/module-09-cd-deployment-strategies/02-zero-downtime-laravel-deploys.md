# Lecture 9.2 — Zero-Downtime Laravel Deploys

> **Module 9 — Continuous Delivery & Deployment Strategies** · Lecture 2 of 4 · Estimated time: ~90 min

Before we automate deployment (next lecture), we need to agree on what a *correct* deploy must actually do — because automating a wrong deploy just produces outages faster. This lecture teaches those mechanics on the classic VM model: code on a server, updated in place. Two reasons for the detour. First, half the industry runs exactly this way, and "can you deploy a Laravel app to a VM without downtime?" is a question you will face professionally whether or not TicketHub ever does it again. Second — and more importantly — every mechanism here *transfers*: atomicity, operation ordering, worker restarts, and above all schema compatibility under live traffic are identical problems on Fargate and Kubernetes; only the machinery answering them changes. The migration discipline in sections 5–7 is, without exaggeration, the most production-critical content in this module.

## Learning objectives

- Dissect the naive `git pull` deploy into its specific failure modes: mixed-code fatals, opcache staleness, downtime windows
- Implement atomic deploys with the releases/shared/current-symlink layout, and place Laravel's caches and state correctly
- Write a complete Deployer 7 configuration for TicketHub with the correct task ordering, worker restart, and rollback
- Explain the old-code/new-schema overlap window and why every migration must be backward-compatible one version
- Execute a column rename with expand/contract: dual-write, chunked backfill, verified switch, deferred contract
- Classify MySQL 8 DDL operations by danger tier (INSTANT/INPLACE/COPY) and place migrations correctly in the release

## 1. Autopsy of the naive deploy

Since Module 3, the VPS deploy has been `git pull && composer install` in the live directory — labeled "deliberately naive" from day one. Time to name exactly what's wrong, because each failure becomes a requirement:

**Mixed-code fatals.** The update is not atomic; it's thousands of file writes over many seconds. A request arriving mid-deploy can execute *new* `routes/api.php` calling a controller method that doesn't exist yet in the *old*, not-yet-replaced controller file — or old code autoloading a class whose file Composer just rewrote. The window is seconds wide, which at 50 requests/second is hundreds of requests rolling dice on `Class ... not found` and `Call to undefined method`. These land as 500s on real customers, and they're unreproducible five minutes later.

**Opcache staleness.** Module 3 set `opcache.validate_timestamps=0` in production — the correct setting: PHP never stats files on disk, compiled code is served from shared memory at full speed. The corollary: after a deploy, **the old code keeps running — fully, consistently pinned in opcache — until FPM is reloaded**. This is actually the *good* failure mode (consistent old code beats mixed code), but it means "the deploy finished and nothing changed" until you remember the reload — and it forces a discipline: every deploy ends with an explicit opcache flush. Forget it and you deploy ghosts.

**Downtime equals install duration.** `composer install` takes tens of seconds; while `vendor/` is half-rewritten the app is effectively down or erroring. Add `config:cache` rebuilding mid-traffic and the window widens.

So the requirements write themselves: the new version must be built **completely, beside** live traffic, and swapped in **atomically**; long-lived processes (FPM's opcache, queue workers) must be told to pick up the new code; and the swap must be **reversible in seconds**. That's the atomic deploy.

## 2. Atomic deploys: releases, shared, current

The industry-standard layout, used by Capistrano, Deployer, Envoyer, and every serious VM deploy tool:

```text
/var/www/tickethub/
├── releases/
│   ├── 20260807103015/        # previous release — complete, untouched
│   └── 20260809141122/        # new release — built cold, beside traffic
│       ├── app/ ... vendor/   # full checkout + its own vendor/
│       ├── bootstrap/cache/   # per-release: config/route/view caches
│       ├── storage -> ../../shared/storage        (symlink)
│       └── .env    -> ../../shared/.env           (symlink)
├── shared/
│   ├── storage/               # logs, framework runtime files — state, survives releases
│   └── .env                   # config — belongs to the environment, not the release
└── current -> releases/20260809141122/    # THE atomic flip
```

Nginx's root points at `current/public` — never at a release directly. A deploy builds the new release directory *completely* — clone, `composer install`, caches, everything — while traffic flows untouched through `current`. Then one operation: re-point `current`. A symlink replacement (an atomic `rename(2)` of a new link over the old) is indivisible at the filesystem level; every request resolves either entirely-old or entirely-new. The mixed-code window collapses from seconds to zero.

The split between `shared/` and per-release follows one rule: **state and config are shared; code and its derivatives are per-release.** `storage/` (logs, temp files) is state — new releases must see the same files. `.env` is config — factor III says it belongs to the environment, and a release shouldn't carry it. `vendor/` and `bootstrap/cache/*` are *derived from the release's code* — sharing them would re-create the mixed-code bug you just eliminated. This is also why Laravel's caches must be built **per release, at deploy time** — not committed, not shared: `config:cache` compiles `.env` + `config/` into one file, `route:cache`/`view:cache`/`event:cache` compile the release's own code. Old release, old caches; new release, new caches; the flip swaps them as a set.

One nginx subtlety you already met in Module 3 and 8.4's config: `fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;`. `$realpath_root` resolves the symlink *per request*, so FPM executes the real path (`releases/2026.../public/index.php`), not the symlink path. With `$document_root` instead, opcache — which caches by resolved path — could keep serving the old release after the flip. Small line, load-bearing.

## 3. Deployer 7: the reference implementation

[Deployer](https://deployer.org) is PHP's standard deploy tool and the reference implementation of section 2. Here is TicketHub's complete `deploy/deploy.php`:

```php
<?php
// deploy/deploy.php — TicketHub atomic VM deploys (Deployer 7).
// Run: vendor/bin/dep deploy stage=staging

namespace Deployer;

require 'recipe/laravel.php';

set('application', 'tickethub');
set('repository', 'git@github.com:tickethub/tickethub-api.git');
set('keep_releases', 5);            // rollback depth: 5 previous releases kept

// State & config live outside the release (section 2's rule).
set('shared_files', ['.env']);
set('shared_dirs', ['storage']);
set('writable_dirs', ['bootstrap/cache', 'storage']);

host('app-a.staging.tickethub.example')
    ->set('labels', ['stage' => 'staging', 'role' => 'primary'])
    ->set('remote_user', 'deploy')
    ->set('deploy_path', '/var/www/tickethub');

host('app-b.staging.tickethub.example')
    ->set('labels', ['stage' => 'staging'])
    ->set('remote_user', 'deploy')
    ->set('deploy_path', '/var/www/tickethub');

// ---- Custom tasks --------------------------------------------------------

// Composer: production flags. (recipe/laravel.php runs this via deploy:vendors;
// pinned here so the flags are explicit and reviewed.)
set('composer_options', '--no-dev --prefer-dist --optimize-autoloader --no-interaction');

// Migrations: EXACTLY ONCE per release, not once per server (section 7).
desc('Run database migrations (single host)');
task('tickethub:migrate', function () {
    run('{{bin/php}} {{release_path}}/artisan migrate --force');
})->select('role=primary');

desc('Reload PHP-FPM (publishes the new release to opcache)');
task('tickethub:fpm-reload', function () {
    run('sudo /usr/bin/systemctl reload php8.4-fpm');
});

desc('Restart Horizon so workers load the new code');
task('tickethub:horizon-terminate', function () {
    // Graceful: finish current jobs, exit; systemd Restart=always
    // resurrects Horizon from the NEW current/ symlink.
    run('cd {{deploy_path}}/current && {{bin/php}} artisan horizon:terminate');
});

// ---- The deploy flow -----------------------------------------------------

desc('Deploy TicketHub');
task('deploy', [
    'deploy:prepare',            // lock, create releases/<timestamp>, checkout
    'deploy:vendors',            // composer install into the new release
    'artisan:storage:link',
    'artisan:config:cache',      // per-release caches, built at deploy time
    'artisan:route:cache',
    'artisan:view:cache',
    'artisan:event:cache',
    'tickethub:migrate',         // BEFORE the flip — see section 7
    'deploy:publish',            // atomic symlink flip + unlock
    'tickethub:fpm-reload',      // old opcache dies, new code goes live
    'tickethub:horizon-terminate',
    'deploy:cleanup',            // prune to keep_releases
]);

after('deploy:failed', 'deploy:unlock');
```

Walk the order, because the order *is* the lecture: everything expensive and fallible (clone, Composer, caches) happens in the unlinked release — a failure there aborts harmlessly, traffic never noticed. Migrations run next (placement argued in section 7), still before any traffic sees new code. Then the flip. Then the two long-lived-process steps that beginners forget:

**FPM reload.** `systemctl reload php8.4-fpm` gracefully replaces workers — each finishes its in-flight request, exits, and its replacement boots with an empty opcache that compiles from the *new* `current`. (The `deploy` user gets exactly this one command via sudoers: `deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload php8.4-fpm`.) The alternative, worth knowing: [cachetool](https://github.com/gordalina/cachetool) calls `opcache_reset()` over FPM's socket — no sudo, no worker churn — at the cost of one more tool to install. Either works; doing *neither* means the deploy didn't happen, per section 1.

**Worker restart — and the heisenbug that teaches it.** Horizon workers are long-running PHP processes: they booted from the old release and hold its code in memory *forever* — `validate_timestamps` doesn't apply, they simply never re-read disk. Skip the restart and hours later jobs start failing with `Class "App\Jobs\SomeNewJob" not found`: new web code dispatches a job class that old workers have never heard of — or subtler, an old job class runs with new serialized properties and explodes on unserialize. It looks like a queue bug, a Redis bug, anything but what it is: a worker that missed a deploy. The mechanism under `horizon:terminate` (same as `queue:restart`) is elegant: it writes a timestamp to the **cache** (`illuminate:queue:restart`); every worker checks it between jobs and exits cleanly when it changes — no job is interrupted; systemd's `Restart=always` (Module 8.4's unit) boots the replacement, whose working directory resolves through the *new* symlink. This is also why the cache must be a shared store (Redis — Module 5): a signal written to a per-process array cache would signal no one.

**Rollback** is the layout's reward: `dep rollback` re-points `current` at the previous release and reloads — seconds, no build, no network. But hold that thought with both hands: **rollback re-points code, not data.** If release 47 migrated the schema, release 46's code now runs against 47's schema. Whether that's fine or a disaster is decided entirely by how you write migrations — which is the rest of this lecture.

**Honesty note: Deployer needs SSH, and Module 8 deliberately closed it.** No contradiction — this lecture teaches the *mechanisms* with the industry-standard tool, because you will meet both again. A real VM fleet reconciles the two in one of two ways: open SSH to a deploy runner only, using short-lived certificates from a CA (Vault/Teleport-style) instead of static keys; or script the same steps over **SSM Run Command** — no SSH at all, at the cost of writing your own orchestration around 8.4's `send-command` (exercise 5 of 8.4 was literally this). TicketHub's own path is neither: next lecture the release becomes an *image* and the "copy code to servers" problem disappears — but atomicity (image swap), ordering (migrate before traffic), worker restarts (task replacement), and health verification transfer one-for-one.

## 4. The overlap window: why migrations rule everything

Here is the fact that governs every schema change you will ever ship, on any platform: **in any zero-downtime deploy, old code and new schema run against each other for a window of time.** On the VM model: migrations run, then the symlink flips seconds later — and during those seconds (longer with N servers flipping in sequence), old code queries a migrated database. On ECS rolling deploys, the window is *minutes* — old tasks drain while new tasks ramp. And if you ever roll back, the window reopens indefinitely: previous code, current schema.

You cannot make the window zero without taking downtime (that option, honestly, in section 8). So the rule is: **every migration must be backward-compatible with the code version currently running.** Equivalently: schema version N must work with code versions N and N−1. Additive changes (new nullable column, new table) pass automatically — old code doesn't select what it doesn't know. Destructive or transformative changes (drop, rename, type change) fail catastrophically — and the standard technique for shipping them anyway is **expand/contract**.

## 5. Expand/contract, taught on a real rename

The scenario: `tickets.qr_code` stores what has quietly become a *payload* (a signed JSON blob the mobile scanner verifies), and the team wants the column named honestly: `qr_payload`. Trivial in dev. Under traffic, the naive version is an outage:

```php
// ⛔ THE WRONG WAY — one release containing:
Schema::table('tickets', function (Blueprint $table) {
    $table->renameColumn('qr_code', 'qr_payload');
});
```

The instant this runs, every *currently running* old-code process — web requests mid-flight, Horizon workers mid-PDF — issues `SELECT ... qr_code ...` against a column that no longer exists. `SQLSTATE[42S22]: Column not found`, as 500s at the ticket-scanning gate and failed jobs on the `pdfs` queue, until the flip completes everywhere. Roll back the code and it's worse: old code is now the *only* code, and the column is still renamed. You'd have to migrate backwards under fire.

The right way splits one change into three releases, each individually boring:

**Phase 1 — EXPAND (release N):** add the new column, teach code to write both and read either, backfill. Schema gains, never loses — old code is untouched by definition.

**Phase 2 — SWITCH (release N+1):** reads move to the new column exclusively; verify nothing still needs the old one.

**Phase 3 — CONTRACT (release N+2, later):** drop the old column — by now no running or rollback-reachable code references it.

Each phase is a normal PR through the normal pipeline, and at every moment the running code (and the one before it) is compatible with the live schema. Rollback at any phase is safe. The cost is calendar time and discipline — the price of never taking the site down. Section's code follows in the hands-on.

## 6. MySQL 8 DDL reality: not all migrations are equal

Even a *compatible* migration can hurt if the DDL itself locks the table. MySQL 8 executes `ALTER TABLE` with one of three algorithms, and you should know which tier you're in before running anything against a hot table:

| Tier | Operations (examples) | Cost on a hot table |
|---|---|---|
| **INSTANT** | Add column (last position), drop column (8.0.29+), rename column (8.0.28+), default changes | Metadata-only, milliseconds, no table rebuild. Safe anytime |
| **INPLACE** (online) | Add/drop index, add virtual column, rename table | Table rebuilt or index built in place; DML continues concurrently; brief metadata locks at start/end. Watch duration and disk, but no outage |
| **COPY** | Change column type (`VARCHAR(100)`→`TEXT`, `INT`→`BIGINT`), change charset, most PK changes | Full table copy **with concurrent writes blocked or heavily degraded**. Danger tier: on `tickets` at a million rows, this is an outage wearing a migration's clothes |

Two consequences. First, when a migration *should* be instant, **assert it** — if MySQL can't use the algorithm you name, it errors instead of silently falling back to a copy:

```php
public function up(): void
{
    // Fails loudly if MySQL would need a rebuild — instead of quietly locking
    // the hottest table in the system during business hours.
    DB::statement('ALTER TABLE tickets ADD COLUMN qr_payload VARCHAR(255) NULL, ALGORITHM=INSTANT');
}
```

Second, when you genuinely need a COPY-tier change on a big table, the answer at scale isn't a maintenance window — it's an online schema-change tool: **gh-ost** (GitHub) or **pt-online-schema-change** (Percona). Both build a shadow copy of the table, replay changes (via binlog or triggers respectively), and cut over with a rename — turning a locking ALTER into a slow-but-online background process. Know the names, reach for them the day `orders` outgrows in-place ALTERs; for TicketHub's current size, staying out of COPY tier and asserting INSTANT covers you.

## 7. Placement, exactly-once, and the truth about `down()`

**Migrations run *before* the flip.** The logic follows from section 4's rule: expand/contract already guarantees old code tolerates the new schema — so applying schema first is safe by construction, while flipping code first would mean new code briefly running against the *old* schema, a compatibility direction you haven't engineered for and shouldn't have to. New code may assume its release's migrations have run; old code must tolerate them. One contract, one direction, memorize it.

**Migrations are a release-phase singleton: exactly once per release, not once per server.** Laravel's `migrations` table makes re-runs mostly idempotent, but two servers racing the same pending migration can both see it as pending and both execute the DDL — best case an error, worst case a duplicate index build on a hot table. In Deployer, `->select('role=primary')` pins the task to one host. Next lecture the same principle becomes a one-off ECS task that runs to completion before the service updates. Same sentence, different machinery — which is the theme of this whole lecture.

**`down()` methods: write them, don't trust them.** Write `down()` for development — `migrate:rollback` while iterating on a branch is genuinely useful. In production, be honest about the asymmetry: `up()` was tested by CI and staging and every developer; `down()` was tested by nobody, and data transformations aren't invertible anyway (a dropped column's data doesn't come back; a backfill can't be un-run without deciding what happens to rows written since). The policy, stated plainly: **production recovers by rolling forward** — a new migration through the pipeline that moves the schema where it needs to be. And notice the quiet payoff: if you practice expand/contract, `down()` is mostly moot — a bad release rolls back to code that is *already compatible* with the current schema, so there's nothing to un-migrate. The discipline you adopted for zero-downtime turns out to be your rollback insurance too. That is not a coincidence; it's the same property.

## 8. Maintenance mode: the honest escape hatch

Some changes genuinely aren't zero-downtime-able at your current size and tooling — a COPY-tier ALTER without gh-ost, a data restructure too risky to dual-write. The professional move is not heroics; it's a **scheduled, announced window**:

```console
$ php artisan down --secret="deploy-ninja" --render="errors::503" --retry=120
```

`--render` pre-renders the 503 page at the moment `down` runs — the maintenance response doesn't boot the (mid-change) framework to serve it. `--secret` gives you a bypass cookie via `/deploy-ninja` so you can verify the site before `php artisan up`. `--retry` sets `Retry-After` for well-behaved clients. Behind the ALB, `/up` starts returning 503 too — which would eject every target, so a real maintenance window also means telling the balancer (or your uptime monitor) to expect it. A 20-minute window at 4 a.m., announced to organizers a week ahead, is a professional operation. A "zero-downtime" deploy that gambles on a locking ALTER finishing fast is a gamble, and the house is a ticket on-sale.

## Hands-on with TicketHub

⚠️ **Cost check:** nothing new in AWS. Everything here is repo code — the Deployer config (kept as reference craft in `deploy/`, per [TICKETHUB.md](../TICKETHUB.md)'s layout) and the expand/contract implementation, which ships through the normal pipeline and *stays* — 9.3 runs these exact migrations on Fargate.

### 1. Install Deployer and commit the reference config

```console
$ composer require --dev deployer/deployer:^7.5
$ mkdir -p deploy && $EDITOR deploy/deploy.php     # section 3's file, in full
$ vendor/bin/dep --file=deploy/deploy.php deploy stage=staging --dry-run
task deploy:prepare
task deploy:vendors
task artisan:config:cache
...
```

`--dry-run` prints the task plan without connecting — which is as far as we execute it against this fleet (the honesty note stands: these instances have no SSH, and they retire next lecture). The file earns its place in the repo as the executable answer to "how do we deploy this to VMs?"

### 2. Expand — migration, dual-write, read-fallback

The phase-1 migration (`database/migrations/2026_08_09_000001_add_qr_payload_to_tickets_table.php`):

```php
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // EXPAND: additive and nullable — old code never notices.
        // ALGORITHM assertion: metadata-only or fail loudly (Lecture 9.2 §6).
        DB::statement(
            'ALTER TABLE tickets ADD COLUMN qr_payload VARCHAR(255) NULL, ALGORITHM=INSTANT'
        );
    }

    public function down(): void
    {
        // Dev convenience only. Production rolls forward (§7).
        DB::statement('ALTER TABLE tickets DROP COLUMN qr_payload');
    }
};
```

Dual-write lives where tickets are born — the issuing action writes both columns, and a model accessor reads new-with-fallback:

```php
// app/Actions/IssueTicketsForOrder.php  (excerpt — the write path)
foreach ($order->items as $item) {
    for ($i = 0; $i < $item->quantity; $i++) {
        $payload = TicketQr::signedPayload($order, $item);

        $order->tickets()->create([
            'ticket_type_id' => $item->ticket_type_id,
            'qr_code'        => $payload,   // legacy column — until CONTRACT
            'qr_payload'     => $payload,   // new column — the future
        ]);
    }
}
```

```php
// app/Models/Ticket.php  (excerpt)
use Illuminate\Database\Eloquent\Casts\Attribute;

/**
 * Read path during EXPAND: prefer the new column, fall back to the old
 * for rows the backfill hasn't reached yet. All readers (scanner API,
 * PDF job, mail template) go through this single accessor.
 */
protected function qrData(): Attribute
{
    return Attribute::make(
        get: fn () => $this->qr_payload ?? $this->qr_code,
    );
}
```

Every reader — `GenerateTicketPdf`, the scanner endpoint, the confirmation mail — switches to `$ticket->qr_data` in this same PR, so the *choice* of column lives in one place.

### 3. Backfill — chunked, throttled, queued

Why not one `UPDATE tickets SET qr_payload = qr_code WHERE qr_payload IS NULL`? Because a single UPDATE touching a million rows holds row locks on the whole affected set for the duration of one giant transaction — on the same table the on-sale path locks with `SELECT ... FOR UPDATE` (TicketHub's oversell invariant). Lock waits cascade into checkout timeouts; congratulations, the backfill is now an incident. Chunk it, commit per chunk, breathe between chunks:

```php
<?php
// app/Console/Commands/BackfillTicketQrPayload.php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class BackfillTicketQrPayload extends Command
{
    protected $signature = 'tickethub:backfill-ticket-qr-payload
                            {--chunk=1000 : Rows per transaction}
                            {--sleep-ms=200 : Pause between chunks}';

    protected $description = 'Copy tickets.qr_code into qr_payload (expand/contract phase 1)';

    public function handle(): int
    {
        $chunk = (int) $this->option('chunk');
        $sleepMs = (int) $this->option('sleep-ms');
        $total = 0;

        do {
            // Each chunk: short transaction, bounded lock footprint.
            $updated = DB::update(
                'UPDATE tickets SET qr_payload = qr_code
                 WHERE qr_payload IS NULL
                 ORDER BY id
                 LIMIT ?',
                [$chunk]
            );

            $total += $updated;
            $this->info("Backfilled {$updated} rows (total {$total})");

            usleep($sleepMs * 1000);   // let checkout traffic through
        } while ($updated > 0);

        $remaining = DB::table('tickets')->whereNull('qr_payload')->count();
        $this->info("Done. Remaining NULL qr_payload rows: {$remaining}");

        return $remaining === 0 ? self::SUCCESS : self::FAILURE;
    }
}
```

Run it once per environment after release N deploys — from a one-off process, not a web request: on the VM model, `dep run` on the primary host or an SSM command; on Fargate (next lecture), `aws ecs run-task` with a command override — the same mechanism that runs migrations. Dispatching it as a queued job (`pdfs`-style, long timeout) also works; the command form keeps progress visible and re-runs trivial — it's idempotent by construction (`WHERE qr_payload IS NULL`).

### 4. Switch, verify, then contract

**Release N+1** deletes the fallback — the accessor becomes `get: fn () => $this->qr_payload` — and *before* it ships, verification is one query and one grep: `SELECT COUNT(*) FROM tickets WHERE qr_payload IS NULL` must be 0 (the backfill command already asserts it), and the codebase must contain no reader of `qr_code` outside the dual-write line. A Pest test pins the schema assumption:

```php
// tests/Feature/TicketQrPayloadTest.php
it('always populates qr_payload on issue', function () {
    $order = Order::factory()->paid()->create();

    app(IssueTicketsForOrder::class)->handle($order);

    expect($order->tickets)->each(
        fn ($ticket) => $ticket->qr_payload->not->toBeNull()
    );
});
```

**Release N+2 — CONTRACT** — ships *at least one release later* (a release you'd be willing to roll back to must not need `qr_code`). It removes the dual-write line and drops the column:

```php
return new class extends Migration
{
    public function up(): void
    {
        // CONTRACT: no running or rollback-reachable code reads qr_code.
        // INSTANT on MySQL ≥ 8.0.29 — asserted, per policy.
        DB::statement('ALTER TABLE tickets DROP COLUMN qr_code, ALGORITHM=INSTANT');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE tickets ADD COLUMN qr_code VARCHAR(255) NULL');
        // Note what down() cannot do: restore the data. §7's asymmetry, live.
    }
};
```

Three PRs, three deploys, zero downtime, rollback-safe at every step. That's the whole trick — and it's not a trick, it's a schedule.

## Real-world best practices

- **Make "compatible one version back" a review question, not a heroic memory.** Every migration PR answers, in its description: *what does currently-running code do the moment this runs?* Additive → fine. Anything else → expand/contract phases named, with the contract PR linked. A checklist in the PR template costs nothing and catches the rename-under-traffic class entirely.
- **Assert DDL algorithms on hot tables.** `ALGORITHM=INSTANT` (or `INPLACE, LOCK=NONE` for index builds) turns "I think this is safe" into "the database refused, good thing it was staging." Guessing is how COPY-tier ALTERs reach production wearing a green checkmark.
- **Backfills are production traffic — budget them like it.** Chunk, commit per chunk, sleep between, make them idempotent and resumable, run them off-peak, and watch replica lag / lock waits while they run. A backfill that races an on-sale is self-sabotage.
- **The worker restart is part of the deploy, not an afterthought.** Whatever the platform — `horizon:terminate` on VMs, task replacement on ECS — the deploy isn't done until every long-lived process runs the new code. Verify it: Horizon's UI shows the master's start time; `/up` shows the web tier's version. Two different "what's running?" questions, both answerable.
- **Prefer roll-forward; earn easy rollback.** Culture roll-forward as the default (keeps the pipeline authoritative), and let expand/contract make rollback *boring* for the cases that need it. Teams get this backwards: they rely on rollback while writing migrations that make rollback impossible.

## Common pitfalls

1. **The one-release rename.** It works flawlessly in dev and on staging's trickle of traffic, so nothing warns you — the failure needs *concurrent old code*, which only production-scale rolling deploys provide. Correct approach: any rename/drop/type-change gets the expand → switch → contract treatment, no exceptions for "small" tables — table size changes the blast radius, not the mechanism.
2. **Sharing `vendor/` or committed config caches across releases "to save time".** It feels like an optimization and quietly reintroduces mixed-code execution — release N's code with release N−1's dependencies, or config compiled from another release's files. Correct approach: per-release `vendor/` and caches built at deploy time; spend the 40 seconds, it's happening beside traffic anyway.
3. **Forgetting the FPM reload (or trusting `validate_timestamps=0` to "notice").** The deploy "succeeds", the symlink is correct, and production serves last week's code from opcache — with everyone staring at the new code in Git. Correct approach: the reload (or `cachetool opcache:reset`) is a pipeline step, and the post-deploy check asserts the *running* version (`/up`'s `APP_VERSION`), not the on-disk one.
4. **Running migrations on every server.** "It's idempotent, Laravel tracks them" — until two hosts race the same pending migration and one dies mid-DDL, leaving the migrations table and the schema disagreeing. Correct approach: a release-phase singleton — one designated host (Deployer `select`), one one-off task (ECS, next lecture), never a boot-time or per-server step.
5. **Trusting `down()` as the production rollback plan.** It's there, it's named "rollback", and it has never once been rehearsed against production data — the first execution of that code path is during an incident, inverting a data transformation it cannot actually invert. Correct approach: §7's policy — roll code back (safe under expand/contract), roll schema *forward* with a new reviewed migration when it truly must move.

## Exercises

1. Classify each as INSTANT, INPLACE, or COPY on MySQL 8.0.36, then verify one with `ALGORITHM=` assertions against your local Compose stack: (a) add nullable `tickets.seat_label VARCHAR(32)`; (b) add an index on `orders.created_at`; (c) change `orders.total` from `INT` to `BIGINT`; (d) drop `users.legacy_notes`. For (c), write the expand/contract plan you'd use instead.
2. Reproduce the stale-worker heisenbug locally: run `php artisan horizon` in one terminal, add a new job class + a route that dispatches it, *don't* restart Horizon, hit the route. Collect the exact exception from `failed_jobs`, then explain — mechanism, not symptom — why `horizon:terminate` prevents it and what resurrects the process afterwards.
3. Extend `deploy.php` with a `tickethub:smoke` task after `tickethub:fpm-reload` that curls `http://localhost/up` *on each host* and fails the deploy on non-200 or a version mismatch against `{{release_name}}`'s commit. Where does Deployer's failure leave the symlink, and what single command completes recovery?
4. The `orders` table needs `orders.status` converted from a `VARCHAR` to a proper `ENUM`-backed state machine with different value names (`pending` → `awaiting_payment`, etc.). Write the full expand/contract plan as a sequence of PRs: migrations (with algorithm assertions), dual-write code, backfill command, verification queries, and the earliest release the contract may ship in. No code needs to run — the plan is the deliverable.
5. **Stretch — rehearse the rollback you claim to have.** On the local Compose stack with seeded data: deploy phase 1 (migrate + backfill), simulate a code rollback by checking out the pre-phase-1 commit, and prove the app still works against the expanded schema (tests + manual pokes). Then try the same rehearsal against the WRONG-way rename and document exactly what breaks and how far the blast radius reaches. Keep both write-ups; they are your team's future "why we do expand/contract" doc.

## What's next

You now know what a correct deploy must do — build beside traffic, flip atomically, migrate once and before the flip, restart every long-lived process, and never ship a migration the previous release can't survive. What you don't have is a machine that does all of it, unattended, on every merge. [Lecture 9.3](03-ecs-fargate-pipeline.md) builds it: TicketHub's CI-built images land on ECS Fargate, the deploy.yml stub from Module 7 becomes a real pipeline, migrations become a one-off task gating the rollout, and the stopped EC2 pair from Module 8 is finally terminated — pain audit items 1 through 4, closed in one lecture.
