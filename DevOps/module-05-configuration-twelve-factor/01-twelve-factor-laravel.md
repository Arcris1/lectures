# Lecture 5.1 — The Twelve-Factor App, Applied to Laravel

> **Module 5 — Configuration & the Twelve-Factor App** · Lecture 1 of 3 · Estimated time: ~75 min

TicketHub works. It survives reboots, serves HTTPS, processes queues. It is also quietly unprepared for what comes next: containers (Module 6), CI-built artifacts (Module 7), managed AWS services (Module 8), and multiple servers (Module 9 onward) all *assume* properties your app doesn't fully have yet — statelessness, config in the environment, disposable processes. This lecture installs them, using the **Twelve-Factor App**: a 2011 methodology from Heroku's engineers that distilled what made apps easy or miserable to run on someone else's platform, and aged into the de-facto contract between applications and modern infrastructure.

This is not a reading lecture. TicketHub changes today: sessions, cache, and queues move fully onto Redis; file handling gets disciplined behind the `Storage` facade; logs start flowing to stderr. Later modules depend on every one of these changes.

## Learning objectives

- State each of the twelve factors and what it demands, concretely, from a Laravel 12 application
- Audit an app for statefulness — sessions, cache, local files, in-process counters — and relocate each into a backing service
- Move TicketHub's sessions, cache, and queues onto Redis, and explain the eviction-policy consequences of sharing one Redis
- Refactor file handling onto the `Storage` facade so local disk and S3 differ by one env var
- Align the timeout chain — job `$timeout`, queue `retry_after`, systemd `TimeoutStopSec` — so graceful shutdown actually is
- Critique twelve-factor honestly: what became canon, and where 2011 shows its age

## 1. Why a 2011 manifesto gates your 2026 stack

The twelve factors ([12factor.net](https://12factor.net)) answer one question: *what must be true of an app so that a platform — any platform — can run, scale, and replace its processes without knowing anything about its insides?* Heroku needed the answer commercially; Docker, ECS, and Kubernetes inherited it wholesale. When Module 11 tells Kubernetes "run 6 replicas of `tickethub-web`, kill and replace them freely," Kubernetes will simply *assume* factors VI (stateless) and IX (disposable). It has no mechanism to cope with an app that stores sessions on local disk — the app is just broken, intermittently, in production.

So treat the factors as a pre-flight audit, done now while TicketHub runs on one VPS and every fix is cheap. For each factor: the principle, what it means for Laravel 12, and what TicketHub changes.

## 2. Factors I–II: one codebase, declared dependencies

**I. Codebase** — *one codebase tracked in version control, many deploys.* One repo maps to one app; every environment (your laptop, staging, production) is a **deploy** of that same repo, differing only in version and config — never a fork, never "the prod copy with two hotfixes." TicketHub complies: `github.com/tickethub/tickethub-api` is the codebase; local, the VPS, and the staging/production environments to come are deploys of it. The one wrinkle ahead: infrastructure code lives in the same repo until Module 10 splits out `tickethub-infra` — a second codebase because it's a second deployable thing, not a fork of the first.

**II. Dependencies** — *explicitly declare and isolate dependencies; never rely on system-wide packages existing.* For Laravel: `composer.json` declares what you need; **`composer.lock` is the contract** — the exact resolved versions, committed to Git, so every machine installs an identical `vendor/` tree. `vendor/` itself never enters Git (it's derived output, huge, and platform-flavored). Two rules with teeth:

- **Declare platform requirements, including extensions.** Module 1's 02:00 `Class "NumberFormatter" not found` incident happened because `intl` and `gd` were used but never declared. The fix promised then lands now:

```json
"require": {
    "php": "^8.4",
    "ext-gd": "*",
    "ext-intl": "*",
    ...
}
```

  With this, `composer install` on a box missing `intl` fails loudly at deploy time, when a human is watching. Add `"config": {"platform": {"php": "8.4.0"}}` so dependency resolution targets production's PHP even if a teammate's laptop runs something newer. Verify any machine with `composer check-platform-reqs`.

- **`composer install` on servers, never `composer update`.** `install` obeys the lockfile — reproducible. `update` re-resolves against *whatever the internet says today* and rewrites the lock — it is a change to your dependency set and belongs in a PR, reviewed and CI-tested (Module 7), never executed ad hoc on a production box "to fix" something.

TicketHub also gains a real dependency today — `composer require barryvdh/laravel-dompdf` — because factor VI below finally implements `GenerateTicketPdf`. The lockfile diff ships in the same PR. dompdf is also *why* `ext-gd` is declared: it rasterizes the QR image.

## 3. Factors III–IV: config in the environment, services as attachments

**III. Config** — *store config in environment variables; strict separation of config from code.* "Config" means precisely **what varies between deploys**: credentials, hostnames, keys, the app URL, debug mode. What does *not* vary between deploys — routes, queue *names* (`default`, `pdfs`, `mail`), business rules, the 15-minute reservation window — is code, and belongs in it. The litmus test from the manifesto is brutal and useful: could you open-source the repo this minute without leaking a credential? Laravel's config layer is the adapter that makes this clean: `.env` (or real environment variables) feed `config/*.php`, and application code reads `config()` only. The full mechanics — and the classic production bug hiding in them — get all of [Lecture 5.2](02-environment-config-secrets.md).

**IV. Backing services** — *treat databases, queues, caches, mail servers, and object stores as attached resources, swappable by config alone.* The app should not know or care whether MySQL is a local daemon or Amazon RDS — both are "a MySQL at some host with some credentials." TicketHub already passes this test for its database, which is exactly what makes Module 8 painless:

```dotenv
# Today (VPS, Module 3):
DB_HOST=127.0.0.1

# Module 8 (RDS) — the ONLY change:
DB_HOST=tickethub-prod-mysql.abc123xyz.ap-southeast-1.rds.amazonaws.com
```

Same code, same `config/database.php`, different attachment. The identical move awaits Redis (`REDIS_HOST` → `tickethub-prod-redis.…cache.amazonaws.com`), mail (`MAIL_MAILER=log` → `ses`), and files (`FILESYSTEM_DISK=local` → `s3`). A backing service you *can't* swap by config alone is a place where code and environment have fused — factor VI hunts those down.

## 4. Factor V: build, release, run

The principle: strictly separate three stages. **Build** turns the codebase into an executable artifact (install dependencies, compile assets). **Release** combines a build artifact with a deploy's config and gets a number — immutable, listable, rollback-able. **Run** executes processes from a release, and does nothing else.

Now look honestly at TicketHub's current deploy, from Module 3:

```
$ ssh tickethub
$ cd /var/www/tickethub && git pull && composer install --no-dev
```

All three stages collapse onto the production box, *while it serves traffic*. What that costs:

- **Deploys depend on third parties at the worst moment.** If GitHub or Packagist hiccups mid-`composer install`, production is left half-built — old code, new dependencies, or worse.
- **There is no artifact.** Nothing exists that you could deploy to a second server, or roll back to. "The release" is a moving target reconstructed on each box.
- **The server serves mid-mutation state.** Between `git pull` and `composer install` finishing, requests execute new code against old dependencies.
- **Build tooling lives on prod.** Composer, Git credentials, dev headers — attack surface with no runtime purpose.

The course's trajectory maps exactly onto the three stages: Module 7's CI performs **build** (a tested Docker image, tagged `sha-a1b2c3d`); Module 9's pipeline performs **release** (image + environment config, versioned `v1.4.2`) and **run** (ECS starts containers from the release; later, Kubernetes). Nothing is ever built on a production machine again. Until then you keep the naive flow — knowingly, and briefly.

## 5. Factor VI: stateless processes — TicketHub's reckoning

The principle: execute the app as one or more **stateless, share-nothing processes**. Anything worth keeping past a single request or job lives in a backing service; process memory and local disk are scratch space for the duration of one unit of work, nothing more. This is *the* factor — the one that decides whether two servers behind Module 3's load balancer work or produce Heisenbugs, and the one Kubernetes assumes hardest. Time to hunt statefulness through TicketHub, item by item.

**Sessions.** The classic trap is `SESSION_DRIVER=file`: log in on server A, next request lands on B, you're logged out (Lecture 3.4 showed this). TicketHub dodged that by using the `database` driver — correct, but costly: every session touch is a MySQL write, session garbage collection runs as lottery-triggered `DELETE`s, and the table bloats alongside your orders. Redis is the right home — in-memory fast, and expiry is native TTL instead of GC:

```dotenv
SESSION_DRIVER=redis
SESSION_CONNECTION=default
```

**Cache.** `CACHE_STORE=database` works, but it burdens MySQL with ephemera and — the sharper point — several Laravel features are only as shared as the cache store behind them. The rate limiter stores counters in cache: with a per-server cache, "10 checkout attempts per minute" silently becomes "10 *per server*" the day you scale out — during an on-sale, that's your oversell protection diluted. Scheduler guards (`withoutOverlapping()`, and `onOneServer()` when Module 8 needs it) take their locks in the cache store too. Everything moves to Redis:

```dotenv
CACHE_STORE=redis
```

And the on-sale limiter that must count globally, in `app/Providers/AppServiceProvider.php`:

```php
<?php

namespace App\Providers;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        RateLimiter::for('checkout', function (Request $request) {
            return Limit::perMinute(10)->by(
                $request->user()?->id ?? $request->ip()
            );
        });
    }
}
```

Attach with `->middleware('throttle:checkout')` on the order-placement route. Backed by Redis, the count is one truth across every current and future server.

**Queues.** The VPS holds a genuine drift bug, and the hands-on section catches it red-handed: Module 2's unit runs `queue:work redis`, but Module 3's `.env` says `QUEUE_CONNECTION=database` — the app pushes jobs into MySQL's `jobs` table while the worker stares at an empty Redis list. Two sources of truth for one fact, disagreeing. The fix is `QUEUE_CONNECTION=redis` everywhere, making Redis the queue *officially* (as [`TICKETHUB.md`](../TICKETHUB.md) always intended — the `jobs` table retires; `failed_jobs` stays in service).

**Files.** [`TICKETHUB.md`](../TICKETHUB.md) says it plainly: *local disk is a lie once you have 2 servers*. A ticket PDF written to server A's disk is a 404 on server B. The discipline that makes disk → S3 a config change is: **code talks to the `Storage` facade and relative paths only — never `storage_path()`, never absolute paths** — and the default disk comes from `FILESYSTEM_DISK`. Module 1 left `GenerateTicketPdf::handle()` as a stub; here is the implementation, done right:

```php
<?php

namespace App\Jobs;

use App\Models\Ticket;
use Barryvdh\DomPDF\Facade\Pdf;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Storage;

class GenerateTicketPdf implements ShouldQueue
{
    use Queueable;
    use SerializesModels;

    /** Rendering a PDF can take a while; don't let the default kill it. */
    public int $timeout = 120;

    public function __construct(public Ticket $ticket)
    {
        $this->onQueue('pdfs');
    }

    public function handle(): void
    {
        $pdf = Pdf::loadView('tickets.pdf', ['ticket' => $this->ticket])->output();

        $path = "tickets/{$this->ticket->uuid}.pdf";

        Storage::put($path, $pdf);

        $this->ticket->update(['pdf_path' => $path]);
    }
}
```

What you must *not* write — and what the first draft of every Laravel app contains — is `file_put_contents(storage_path("app/tickets/{$this->ticket->uuid}.pdf"), $pdf)`. It works, until the day it's a lie. The refactored job writes through the **default disk**: today `FILESYSTEM_DISK=local` (rooted at `storage/app/private` in Laravel 12), in Module 8 `FILESYSTEM_DISK=s3` with bucket `tickethub-prod-uploads` — and this class does not change. Note the model stores the *relative* path; retrieval goes through `Storage::download($ticket->pdf_path)` or, later, S3 temporary URLs. A small migration adds the column:

```php
Schema::table('tickets', function (Blueprint $table) {
    $table->string('pdf_path')->nullable();
});
```

The same rule applies to event-image uploads (`Storage::putFile('events', $request->file('image'))`, never `$file->move(public_path(...))`) — Exercise 4 makes you fix one.

**What stateless does *not* mean.** Using memory and `/tmp` within one request or one job is fine — render the PDF in memory, write scratch files, clean up. The sin is *expecting state to be there next time*: caching in a static property, counting in APCu, writing a file one process expects another to find. Next time may be another process, another server, another continent.

## 6. Factors VII–IX: port binding, concurrency, disposability

**VII. Port binding** — *the app is self-contained and exports HTTP by binding a port*, rather than living inside an external web server. Honesty required: classic PHP does not work this way. PHP-FPM speaks FastCGI on a socket, and Nginx — a separate, external process — owns the HTTP port. TicketHub is not literally twelve-factor here, and that's a considered choice, not an oversight: the *unit* "Nginx + FPM" behaves like a port-binding app from the outside, and Module 6 packages the pair so the container exports one port. True port-binding PHP exists — Laravel Octane on FrankenPHP or Swoole boots the framework once and serves HTTP directly, with real throughput wins and a real cost: long-lived processes surface every memory leak and static-state bug that FPM's die-after-request model absolves. This course stays on FPM — it's what the overwhelming majority of production Laravel runs, and its shared-nothing-per-request behavior is a *feature* while you're learning ops. Know that Octane exists; reach for it when p99 latency, not architecture, demands it.

**VIII. Concurrency** — *scale out via the process model.* You scale a twelve-factor app by running **more processes**, not by growing one giant one — and different work scales independently. TicketHub already has the shape: FPM web processes (scale `pm.max_children`, Module 3), queue workers (add a second `tickethub-worker-pdfs.service` when PDF renders back up — Module 2's exercise), the scheduler (exactly one — the constraint Modules 8 and 11 sweat over). Because factor VI made processes share-nothing, "more" is trivial: nothing coordinates, nothing syncs. Horizon later supervises worker pools per queue (`default`, `pdfs`, `mail`), and Kubernetes turns "more processes" into a field called `replicas`. Foreshadowing, not today's work — today's work was making it *possible*.

**IX. Disposability** — *processes start fast and shut down gracefully on SIGTERM; treat them as cattle you can kill anytime.* You built most of this in Module 2 without the vocabulary: `systemctl stop tickethub-worker` sends SIGTERM; `queue:work` finishes its current job, then exits; `Restart=always` plus `--max-time=3600` retires workers hourly at job boundaries. Every deploy in Module 9 and every pod eviction in Module 11 is this same dance. But there's a real bug to fix: systemd's default `TimeoutStopSec` is **90 seconds** — after SIGTERM, it waits 90s, then SIGKILLs. `GenerateTicketPdf` declares `$timeout = 120`. A PDF render in its 100th second at deploy time gets SIGKILLed mid-write. The hands-on fixes it, together with its sibling: Laravel's Redis queue `retry_after` (default 90s) decides when a job is *presumed dead and given to another worker* — it must exceed your longest job's timeout or slow jobs get processed twice. The inequality to write on a sticky note: **job `$timeout` < `retry_after` ≤ `TimeoutStopSec`**.

## 7. Factors X–XII: parity, logs, admin processes

**X. Dev/prod parity** — *keep development, staging, and production as similar as possible.* TicketHub currently fails this loudly — SQLite and `sync` queues locally versus MySQL and Redis in production — and Module 1's three "works on my machine" stories were all parity failures. It's a big enough topic that it gets its own lecture: [Lecture 5.3](03-environment-parity.md).

**XI. Logs as event streams** — *the app never manages log files; it writes an unbuffered stream to stdout/stderr, and the environment routes it.* Your app knowing about files, paths, and rotation is a liability: on two servers the files are in two places; in a container they vanish with it. Laravel makes compliance one line — `LOG_CHANNEL=stderr` — and Module 2 already proved the receiving end: journald captures the worker's output, indexed and queryable, precisely *because* it writes to stdout/stderr. One honest wrinkle on the VPS: FPM discards its workers' stderr unless told otherwise, so the pool config needs `catch_workers_output = yes` (and `decorate_workers_output = no` to keep lines clean); web-request logs then land in FPM's log. Interim plumbing — containers make stderr the native path, and Module 12 gives logs their full treatment (JSON structure, correlation IDs, aggregation). Configure the stream discipline *now*; you can't retrofit it during an incident.

**XII. Admin processes** — *run one-off admin tasks in an identical environment, against the same release.* `php artisan migrate`, `tinker`, a data backfill — these must execute with the same code, same config, same dependencies as the running app. On the VPS you get this almost for free: SSH in, `cd /var/www/tickethub`, run artisan — same checkout, same `.env` the workers read. What violates the factor: running a backfill from your *laptop* pointed at the production DB (different code version, different config — the classic way to run last week's logic against today's schema), or the crontab invoking a PHP binary different from FPM's. Migrations deserve one more sentence: twelve-factor treats them as a **release-phase step** — part of every deploy, not an occasional manual event — which is exactly where Module 9's pipeline puts `migrate --force`.

## 8. An honest critique, fifteen years on

Twelve-factor is a 2011 document written to sell a 2011 platform, and you should hold it like an adult. **What became canon:** config in the environment (III), stateless processes (VI), disposability (IX), logs as streams (XI), declared dependencies (II). Containers and Kubernetes didn't just adopt these — they *assume* them so deeply that violating them means fighting your platform forever. A Docker container is, in a real sense, a twelve-factor enforcement device.

**What needs updating:** Port binding (VII) reads as dogma now — process managers, sidecars, and ingress layers made "who owns the socket" an implementation detail, as the FPM discussion showed. "Logs to stdout" was an insight in 2011 and is table stakes now — the hard problems (structure, correlation, sampling, cost) start *after* stdout, and the manifesto is silent on them. Env vars for config aged well; env vars for *secrets* did not — mature platforms inject secrets from dedicated stores with audit trails and rotation ([Lecture 5.2](02-environment-config-secrets.md) builds that ladder). And the manifesto simply has no chapter on the stateful things — your database's failover, backups, and data gravity — because Heroku sold those as managed add-ons; the factors describe the *stateless shell* around a stateful core someone still has to operate (Module 8 makes that someone AWS, deliberately). Kevin Hoffman's *Beyond the Twelve-Factor App* adds telemetry, security, and "API first" — worth a read once this module settles.

None of that diminishes the audit you're about to run. The aged-well factors are exactly the ones TicketHub violates.

## Hands-on with TicketHub

Time to make the changes real on the VPS. First, catch the queue drift bug in the act:

```
$ ssh tickethub
$ cd /var/www/tickethub
$ php artisan tinker --execute="App\Jobs\GenerateTicketPdf::dispatch(App\Models\Ticket::first());"
$ php artisan tinker --execute="var_dump(DB::table('jobs')->count());"
int(1)
$ journalctl -u tickethub-worker -n 3
Aug 09 20:11:42 tickethub-vps php[2381]: INFO  Processing jobs from the [default] queue.
```

The job sits in MySQL; the worker, pinned to `redis` by its `ExecStart`, will never see it. Drain the stranded jobs through the connection they're actually on, then flip the config:

```
$ php artisan queue:work database --stop-when-empty --queue=default,pdfs,mail
  2026-08-09 20:13:05 App\Jobs\GenerateTicketPdf ............ 2s DONE
```

Edit `/var/www/tickethub/.env` (do this in a quiet hour — active sessions in the old store are logged out by the move; Module 9 turns cutovers like this into pipeline steps):

```dotenv
SESSION_DRIVER=redis
SESSION_CONNECTION=default
CACHE_STORE=redis
QUEUE_CONNECTION=redis
REDIS_QUEUE_RETRY_AFTER=180
LOG_CHANNEL=stderr
FILESYSTEM_DISK=local
```

`REDIS_QUEUE_RETRY_AFTER=180` satisfies the inequality from factor IX (longest job timeout is 120). Rebuild the config cache, restart the long-lived processes (FPM re-reads the compiled config per request; workers hold it in memory and must restart), and give the worker its shutdown budget:

```
$ php artisan config:cache
$ sudo systemctl edit tickethub-worker        # add: [Service] newline TimeoutStopSec=150
$ sudo systemctl restart tickethub-worker
```

Enable FPM's stderr capture in `/etc/php/8.4/fpm/pool.d/www.conf` (`catch_workers_output = yes`, `decorate_workers_output = no`), then `sudo systemctl reload php8.4-fpm`. Now verify each moved piece. The drivers:

```
$ php artisan about
  Environment ...................................... production
  Debug Mode .............................................. OFF
  Cache ................................................. redis
  Queue ................................................. redis
  Session ............................................... redis
```

The queue, end to end — dispatch again and watch Redis receive it and the worker consume it:

```
$ php artisan tinker --execute="App\Jobs\GenerateTicketPdf::dispatch(App\Models\Ticket::first());"
$ journalctl -u tickethub-worker -n 2
Aug 09 20:24:18 tickethub-vps php[3155]: 2026-08-09 20:24:18 App\Jobs\GenerateTicketPdf RUNNING
Aug 09 20:24:21 tickethub-vps php[3155]: 2026-08-09 20:24:21 App\Jobs\GenerateTicketPdf 3s DONE
$ php artisan tinker --execute="var_dump(Storage::exists('tickets/'.App\Models\Ticket::first()->uuid.'.pdf'));"
bool(true)
$ ls storage/app/private/tickets/ | head -1
9f3c1a2e-8d41-4f6b-b2aa-1c9e7d5a3f10.pdf
```

And the keys themselves — Laravel prefixes with the app name, so state is legible in `redis-cli`:

```
$ redis-cli --scan --pattern 'tickethub*' | head -3
tickethub_database_queues:pdfs
tickethub_database_tickethub_cache_:hLxq81FSgWQzr0aNe3T6PbYv52KmJdCUwEoRi4A9
tickethub_database_tickethub_cache_:illuminate:queue:restart
```

A queue list, a session (TTL ≈ your `SESSION_LIFETIME`), a cache entry. The `jobs` table is now retired; `failed_jobs` remains in active service. One last decision while everything shares a single Redis: check `maxmemory-policy` is `noeviction` (Redis 7's default) in `/etc/redis/redis.conf` and set an explicit `maxmemory` — an evicting policy like `allkeys-lru` would happily delete *queued jobs* under memory pressure, which for TicketHub means silently unsent tickets. `noeviction` makes memory pressure loud (writes error) instead of quiet. Module 8 resolves the tension properly by splitting cache onto its own ElastiCache with LRU.

Finally, repeat the `.env` changes in your laptop's copy where applicable — though local still runs SQLite and `sync`; [Lecture 5.3](03-environment-parity.md) confronts that head-on.

## Real-world best practices

- **Run the twelve-factor audit on every new service, before first deploy.** A 12-row table (factor / status / action) costs twenty minutes; retrofitting statelessness under traffic costs weekends. Production teams do this as an architecture-review checklist item.
- **The lockfile is built in PRs, executed on servers.** `composer.lock` changes are reviewed diffs with CI runs behind them; servers only ever `composer install --no-dev`. Pin the platform (`config.platform.php`) so resolution can't drift with laptops.
- **One fact, one owner.** The queue-drift bug existed because the connection was stated twice — in the unit file and in `.env`. Let the environment own config; units, crontabs, and (later) Dockerfiles read it rather than restate it.
- **Write the timeout chain down where the team can see it.** `$timeout` (job) < `retry_after` (queue) ≤ `TimeoutStopSec` (supervisor). Three subsystems each hold a timer; every misalignment is either a duplicated job or a corpse. Re-check the chain whenever a job's timeout changes.
- **Choose an eviction policy on purpose.** Cache wants LRU; queues and sessions must never evict. While they share one Redis, `noeviction` + `maxmemory` + monitoring is the only safe compromise — and splitting instances (Module 8) is the real fix. Teams that skip this conversation discover it during their first memory spike, as lost jobs.
- **Stream logs even before you aggregate them.** stderr → journald today, stderr → collector in Module 12. The discipline (no files, no rotation logic, structured events later) must precede the tooling, because you adopt tooling calmly and discover discipline gaps during incidents.

## Common pitfalls

1. **Running `composer update` on a server to fix a deploy.** It feels like a repair; it's an unreviewed dependency upgrade executed in production, and it desyncs the server from the lockfile every CI run trusts. Correct approach: `composer install` only; if the lock is genuinely wrong, fix it in a PR and deploy again.
2. **Declaring victory on "stateless" while a file write hides somewhere.** Teams move sessions and cache, then months later a feature writes `public/exports/report.csv` and the second server 404s it. People miss it because local disk *works* on one box. Correct approach: the `Storage`-facade rule plus a CI guard — `grep -rn "storage_path\|public_path" app/` should return only deliberate, reviewed uses.
3. **Sharing one Redis and "fixing" memory pressure with `allkeys-lru`.** The cache pages stop erroring — and the queue starts silently losing jobs, which for TicketHub is customers without tickets. People do it because the eviction switch is the first Google result for the error. Correct approach: `noeviction`, an explicit `maxmemory`, alerts on memory, separate instances when budget allows.
4. **Treating SIGKILL as a deploy tool.** `kill -9` on a worker mid-`GenerateTicketPdf` leaves a half-written file and a job that redelivers (or worse, doesn't). It happens because TERM "takes too long." Correct approach: fix the timeout chain so TERM *can* finish, and let systemd (later, Kubernetes) do the killing by policy, never by hand.
5. **Reading "config in the environment" as "everything in `.env`."** Queue names, business constants, and route definitions do not vary per deploy; hoisting them into env vars creates untracked, unreviewed behavior switches scattered across servers. Correct approach: env for what differs between deploys; code (and `config/*.php` defaults) for what doesn't.

## Exercises

1. **Map the queue's env surface.** Read `config/queue.php` and the `redis` block of `config/database.php`; list every env var that now influences queue behavior and what its current effective value is. Verify with `php artisan config:show queue`.
2. **A dedicated PDF worker, sized correctly.** Building on Module 2's exercise, create `tickethub-worker-pdfs.service` for the `pdfs` queue. Set its `TimeoutStopSec` from `GenerateTicketPdf::$timeout` using the inequality from factor IX, dispatch a job, and prove a `systemctl stop` mid-job lets it finish (journalctl timestamps are your evidence).
3. **Break the timeout chain on purpose.** Locally, set `REDIS_QUEUE_RETRY_AFTER=30`, give a throwaway job `sleep(45)`, and run two workers on the same queue. Observe the duplicate processing in the logs, explain the mechanism in two sentences, then restore 180.
4. **Purge a `storage_path()` habit.** Write (or imagine inherited) an event-image upload action that calls `$request->file('image')->move(public_path('img/events'))`. Refactor it onto `Storage::putFile()` with the default disk, store the relative path on the event, and state exactly what changes when `FILESYSTEM_DISK` becomes `s3` in Module 8. (Answer: nothing in this code.)
5. **Stretch: audit a stranger.** Take any other app you own or maintain and produce the full 12-row audit table: factor, current status, concrete violation, cheapest fix. Keep it — after Module 6 you'll enjoy crossing off the violations that containerization erases for free.

## What's next

Factor III got one paragraph here and deserves a lecture: Laravel's config layer has a sharp edge — `config:cache` — that turns a harmless-looking `env()` call into a production-only bug, and "put secrets in the environment" raises the question of where secrets *actually* live, today and up the maturity ladder. [Lecture 5.2 — Environment Config & Secrets Hygiene](02-environment-config-secrets.md) covers both, and ships a fail-fast `config:validate` command that every future deploy will run.
