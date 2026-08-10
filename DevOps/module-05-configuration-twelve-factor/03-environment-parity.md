# Lecture 5.3 — Environment Parity

> **Module 5 — Configuration & the Twelve-Factor App** · Lecture 3 of 3 · Estimated time: ~65 min

Factor X — dev/prod parity — got one honest sentence in [Lecture 5.1](01-twelve-factor-laravel.md): TicketHub fails it loudly. Your laptop runs SQLite and a `sync` queue; the VPS runs MySQL 8.0 and Redis. That gap is not a cosmetic difference — it is a machine for manufacturing production-only bugs, and every "works on my machine" story from Module 1 was this machine running as designed.

This lecture makes the gap concrete. You will reproduce real drift failures with their actual error messages — a migration that passes locally and detonates during deploy, a queued job that explodes only under a real queue driver — then make the parity decisions config discipline can close, build seed data worth developing against, and set the rules for a staging environment before it exists. It ends with the argument the whole module has been building toward: what parity work remains when config is done, and why that remainder is exactly what containers solve.

## Learning objectives

- Define the purpose and fidelity contract of TicketHub's three environments: `local`, `staging`, `production`
- Explain twelve-factor's three parity gaps — time, personnel, tools — and map each to a course decision
- Reproduce and fix classic drift failures: SQLite-vs-MySQL schema and query strictness, and sync-vs-Redis job serialization timing
- Configure mail and storage so environments differ by transport config only
- Build seeders and factories that create a rich synthetic local world, and defend the rule that production data never leaves production
- Argue precisely which parity gaps config discipline closes and which require containers

## 1. Three environments, three contracts

[`TICKETHUB.md`](../TICKETHUB.md) defines three environments. Two exist today; one is a promise. What matters now is the *contract* each one signs, because every decision in this lecture serves a contract:

| Environment | Where | Purpose | Fidelity contract |
|---|---|---|---|
| `local` | Your machine (Docker Compose from Module 6) | Iteration speed: edit, run, break, reset | Same *engines* as production — MySQL 8.0, Redis 7, real queue driver, SMTP mail — with synthetic data and test-mode credentials |
| `staging` | AWS, built in Modules 8–9 | Dress rehearsal: every merge to `main` deploys here before production | Same *topology* as production at smaller scale — same services, versions, and deploy pipeline; synthetic data |
| `production` | AWS `ap-southeast-1` | The only environment that matters | Everything else exists to protect it |

Local optimizes for feedback speed and *must be destructible* — `migrate:fresh` without fear. Staging optimizes for realism of *integration* — real AWS services, real deploy mechanics — not realism of scale. Production optimizes for nothing except serving customers. Staging doesn't exist yet, and that's fine: defining its contract now means every choice from here (per-environment config keys, `config:validate` lists, seeders) already anticipates it, so Modules 8–9 assemble it instead of inventing it.

## 2. The three gaps: time, personnel, tools

The twelve-factor manifesto names three gaps that historically separated development from production:

- **The time gap** — code written now deploys weeks later. Big batches mean big, undiagnosable failures. Modules 4 and 9 close this: trunk-based development plus continuous deployment shrink "weeks" to "hours," which is also DORA's lead-time metric from Module 1.
- **The personnel gap** — developers write it, a separate ops team deploys it, and knowledge dies at the handoff. This whole course is the counterargument: you deploy what you write.
- **The tools gap** — SQLite locally, MySQL in production; `sync` locally, Redis in production. This is the gap TicketHub actually has, and it's the subject of the next four sections.

The tools gap is the sneakiest, because everything *works*. SQLite needs no setup; `sync` needs no worker. Each substitution is individually reasonable, and collectively a parallel universe whose physics diverge from production's precisely at the edges — strictness, timing, serialization — where bugs live.

## 3. War story: the database that lied

Laravel's skeleton defaults to SQLite, which is how TicketHub's laptop ended up on it. SQLite is a superb embedded database and a treacherous MySQL impersonator, because it is *dynamically typed*: column types are suggestions ("type affinity"), lengths are decoration, and several MySQL strictness rules simply don't exist. MySQL 8.0 — with the strict `sql_mode` Laravel enables and the server defaults ship — enforces all of them.

**Failure one: the migration that passes locally and kills the deploy.** A teammate adds a column for the signed QR payload from [Lecture 5.2](02-environment-config-secrets.md), and — wanting to prevent duplicates — makes it unique:

```php
Schema::table('tickets', function (Blueprint $table) {
    $table->string('qr_payload', 2048)->unique();
});
```

On the laptop: `php artisan migrate` passes — SQLite happily indexes text of any length. Tests green, PR merged. Then the deploy runs it against MySQL, where a `VARCHAR(2048)` under `utf8mb4` is 8,192 bytes and InnoDB caps index keys at 3,072:

```
$ php artisan migrate --force
  2026_08_12_101500_add_qr_payload_to_tickets ...................... 31ms FAIL

   Illuminate\Database\QueryException

  SQLSTATE[42000]: Syntax error or access violation: 1071 Specified key was
  too long; max key length is 3072 bytes (Connection: mysql, SQL: alter table
  `tickets` add unique `tickets_qr_payload_unique`(`qr_payload`))
```

Production is now mid-deploy with a half-applied migration batch — the exact scenario Module 9's zero-downtime lecture exists to prevent, delivered early by a database your laptop never runs. (The fix: don't index a payload — the ticket's `uuid` is already unique; if you must look up by payload, index a fixed-width SHA-256 digest column.)

**Failure two: silent type fiction.** SQLite ignores `VARCHAR` lengths, so a 300-character seat label inserts fine locally; MySQL strict mode rejects it (`1406 Data too long for column`). Worse than either behavior is the *difference*: locally you never learn your validation rules have a hole, because the database quietly absorbs what production will reject at 8 p.m. on an on-sale night.

**Failure three: query strictness.** MySQL's default `ONLY_FULL_GROUP_BY` (also in Laravel's strict mode) rejects a `SELECT` column that isn't grouped or aggregated. SQLite just picks an arbitrary row. So the nightly sales report — `SendNightlySalesReports` groups orders — can be written, reviewed, and locally verified, then throw `1055 ... not functionally dependent on columns in GROUP BY clause` on its first 02:00 run in production. The hands-on reproduces all three failures with real sessions.

**The decision:** TicketHub development runs **MySQL 8.0 locally, always** — production's engine at production's version. Hand-maintaining local MySQL is exactly the friction that pushed everyone to SQLite, which is why the implementation arrives via Docker Compose in Module 6; until then you keep SQLite *knowingly*, with this lecture as the list of what it hides.

**The honest note:** many teams run their *test suite* on SQLite `:memory:` for speed and accept the risk with open eyes — a defensible trade for pure-logic tests. TicketHub takes the stricter line: CI runs the whole suite against real MySQL 8.0 (Module 7 wires MySQL and Redis service containers into the pipeline), because tests that bless a migration SQLite can't fail are worse than slow tests.

## 4. War story: the queue that ran too soon

`QUEUE_CONNECTION=sync` executes jobs inline: same process, same request, and — critically — same database transaction. Redis executes them in *another process, later*. Between those two worlds sits `SerializesModels`, and it hides a mechanism most Laravel developers learn during an incident: when a job with an Eloquent model is queued, the model is **not** serialized — only its class and ID are. The worker **re-fetches the model fresh from the database** when the job runs.

Now look at TicketHub's payment confirmation, written the obvious way:

```php
public function confirm(Order $order): void
{
    DB::transaction(function () use ($order) {
        $order->update(['status' => 'paid']);

        foreach ($order->items as $item) {
            for ($i = 0; $i < $item->quantity; $i++) {
                $ticket = $order->tickets()->create([
                    'ticket_type_id' => $item->ticket_type_id,
                    'uuid' => (string) Str::uuid(),
                ]);

                GenerateTicketPdf::dispatch($ticket);   // ← inside the transaction
            }
        }
    });

    Mail::to($order->customer)->queue(new OrderConfirmed($order));
}
```

Under `sync`, the dispatch runs the PDF job right there, inside the transaction, where the ticket row is visible. Everything works — you even see PDFs appear while testing. Under Redis, the dispatch pushes to the queue *immediately*, mid-transaction. The worker — a different process, which cannot see uncommitted rows — often picks the job up before `confirm()` commits:

```
Illuminate\Database\Eloquent\ModelNotFoundException:
No query results for model [App\Models\Ticket] 5183
```

A paying customer, a failed job, and a bug that is *architecturally invisible* under the local driver. The same mechanism produces a subtler sibling — stale attributes:

```php
$order->discount_cents = 500;                          // in memory only
Mail::to($order->customer)->queue(new OrderConfirmed($order));
// ...the save() happens later, or never
```

`sync` renders the email from the in-memory model — discount visible, looks perfect locally. Redis re-fetches by ID and renders from *the database* — no discount. The rule that falls out: **a queued job may only depend on committed database state.**

**The decisions**, all three of which ship today:

1. **`QUEUE_CONNECTION=redis` locally, always** — with `php artisan queue:listen` running in a second terminal as part of the normal dev loop (it restarts workers on code changes). Like MySQL, the turnkey local Redis arrives with Module 6's Compose stack; production has run workers under systemd since Module 2, with Horizon supervision arriving alongside the containerized stack.
2. **`after_commit => true`** on the Redis queue connection, so dispatches inside a transaction are held until it commits — TicketHub's inventory invariant means *most* meaningful dispatches happen inside transactions:

```php
// config/queue.php — the redis connection
'redis' => [
    'driver' => 'redis',
    'connection' => env('REDIS_QUEUE_CONNECTION', 'default'),
    'queue' => env('REDIS_QUEUE', 'default'),
    'retry_after' => (int) env('REDIS_QUEUE_RETRY_AFTER', 90),
    'block_for' => null,
    'after_commit' => true,   // ← dispatches wait for the surrounding transaction
],
```

3. The code rule above, enforced in review: jobs receive IDs or committed models, never in-memory state you haven't persisted.

## 5. Mail and storage: parity through the same API

Two backing services get parity almost for free, because Laravel's abstractions were built for it — the discipline is simply *never going around them*.

**Mail.** Locally you want every message actually *sent* — through the full Mailable render pipeline — but delivered nowhere. That is [Mailpit](https://github.com/axllent/mailpit): a fake SMTP server that captures everything and shows it in a web UI at `http://localhost:8025`. Same `Mail::` code path as production, different transport:

```dotenv
# local — Mailpit catches everything (ships in Module 6's Compose stack)
MAIL_MAILER=smtp
MAIL_HOST=127.0.0.1
MAIL_PORT=1025
MAIL_FROM_ADDRESS=tickets@tickethub.example
MAIL_FROM_NAME="${APP_NAME}"
```

Production today still uses `MAIL_MAILER=log` — the honest Module 3 interim — and becomes `ses` in Module 8. The point is that `OrderConfirmed` never knows or cares: one Mailable, three transports, chosen by config. Mailpit also removes the classic dev horror of accidentally emailing real customers from a laptop holding a production-ish database — which, per section 7, you should never have anyway.

**Storage.** [Lecture 5.1's](01-twelve-factor-laravel.md) `Storage` facade discipline was this lecture's setup: code addresses a *disk*, config decides what the disk is. The two blocks sit side by side in `config/filesystems.php`, and swapping is one env var:

```php
'local' => [
    'driver' => 'local',
    'root' => storage_path('app/private'),
    'serve' => true,
    'throw' => false,
],

's3' => [
    'driver' => 's3',
    'key' => env('AWS_ACCESS_KEY_ID'),
    'secret' => env('AWS_SECRET_ACCESS_KEY'),
    'region' => env('AWS_DEFAULT_REGION'),
    'bucket' => env('AWS_BUCKET'),
    'url' => env('AWS_URL'),
    'endpoint' => env('AWS_ENDPOINT'),
    'use_path_style_endpoint' => env('AWS_USE_PATH_STYLE_ENDPOINT', false),
    'throw' => false,
],
```

`FILESYSTEM_DISK=local` today; `s3` with bucket `tickethub-prod-uploads` in Module 8. Note `endpoint` and `use_path_style_endpoint`: they exist so an S3-*compatible* server can stand in — which is exactly what MinIO does in Module 6's Compose stack, giving local development the real S3 API (temporary URLs, visibility, multipart) against a container. Flysystem makes the code identical; only credentials and endpoint differ.

## 6. Runtime drift: the gap config cannot close

One drift category survives everything this module has done. Your laptop runs PHP 8.4 from Homebrew or apt with one set of extensions; the VPS runs PHP 8.4 from Ubuntu's packages with another. Different patch versions, different ICU (so `intl` collates and formats differently), different extension availability — Module 1's 02:00 `NumberFormatter` incident was exactly this. `composer.json`'s platform requirements ([Lecture 5.1](01-twelve-factor-laravel.md)) make missing extensions fail *loudly*, which is progress — but declaring a requirement is not shipping a runtime. The same applies to MySQL and Redis point versions, and to Nginx and FPM configuration, which exist on the VPS but have no local counterpart at all.

Config files cannot fix this, because it isn't configuration — it's *what is installed*. Park it; section 9 collects the debt.

## 7. Seed data: a rich synthetic world

Parity of engines is necessary but not sufficient: an empty database is its own parity failure. Developers test what the seeded world lets them test — with three events and no orders, nobody notices the N+1 on the listings endpoint, nobody exercises `ExpireReservations`, nobody hits the oversell guard. TicketHub's answer is a `DevSeeder` that builds the states that matter:

```php
<?php

namespace Database\Seeders;

use App\Models\Event;
use App\Models\Order;
use App\Models\TicketType;
use App\Models\User;
use Illuminate\Database\Seeder;

class DevSeeder extends Seeder
{
    /**
     * A rich local world: every state a developer needs daily.
     */
    public function run(): void
    {
        // Organizers with a spread of upcoming events.
        User::factory()->organizer()->count(5)
            ->has(
                Event::factory()->count(3)
                    ->has(TicketType::factory()->count(2), 'ticketTypes'),
                'events',
            )
            ->create();

        // THE test case: a hot on-sale with scarce inventory.
        $onSale = Event::factory()->onSale()
            ->for(User::factory()->organizer(), 'organizer')
            ->create(['name' => 'Midnight Arena Tour']);

        TicketType::factory()->for($onSale)->create([
            'name' => 'General Admission', 'price_cents' => 250_00, 'quantity' => 500,
        ]);
        TicketType::factory()->for($onSale)->create([
            'name' => 'VIP', 'price_cents' => 900_00, 'quantity' => 8,  // exercises the oversell guard
        ]);

        // Paid orders with issued tickets, and expired unpaid reservations
        // so ExpireReservations always has real work.
        Order::factory()->count(20)->paid()->create();
        Order::factory()->count(15)->expiredReservation()->create();
    }
}
```

The states live in factories, which makes them a *shared vocabulary* — the same `onSale()` your seeder uses is the one your Pest tests and (later) staging seeds use:

```php
// database/factories/EventFactory.php
public function onSale(): static
{
    return $this->state(fn (array $attributes) => [
        'on_sale_at' => now()->subHour(),
        'starts_at' => now()->addDays(30),
    ]);
}

// database/factories/OrderFactory.php
public function expiredReservation(): static
{
    return $this->state(fn (array $attributes) => [
        'status' => 'reserved',
        'reserved_until' => now()->subMinutes(30),
    ]);
}
```

Staging follows the same strategy at larger counts: seeded with **synthetic** data from these same factories, refreshed when it drifts. Which raises the question every team eventually asks: *why not just load a production dump? It's so much more realistic.*

**The production data rule: production data never leaves production.** A dump of TicketHub's database is names, emails, and purchase histories — personal data in the GDPR sense. Every copy multiplies breach surface (laptops get stolen; dumps land in Slack and forgotten folders) and silently breaks legal obligations: a customer's deletion request cannot reach a `.sql` file on a developer's desktop. One honest caveat: anonymized-subset pipelines — engineered, reviewed jobs that extract a slice, mask every personal field, and load it somewhere controlled — are a real practice, occasionally the only way to reproduce a data-shape-dependent bug. Treat them as a *last resort with an owner and an audit trail*, never a convenience. Synthetic data answers 95% of needs at 0% of the risk; factories that generate realistic *shapes* (hot events, long tails, weird names) close most of the rest.

## 8. Staging discipline and preview environments

When staging arrives in Modules 8–9, it will be small — a cheaper RDS instance, fewer containers — but topologically faithful: the same services, the same versions, and above all **the same deploy pipeline**. Deploy mechanics need parity too; a staging you deploy by hand rehearses nothing about the release that will hit production.

The cultural rule matters more than the infrastructure: **staging is not a playground.** From Module 9 on, every merge to `main` deploys to staging, and production releases are promotions of what staging validated — which means a broken staging *blocks every release*. Treat a red staging like a production incident with a longer fuse. The corollaries: no hand-edited config (that's drift, and it converts staging's green checkmark into a lie), no half-deployed experiment branches, no "I'll just test this weird thing directly on staging." Changes reach staging through the pipeline or not at all.

The industry's current answer to "but where do I test my weird thing?" is **preview environments**: an ephemeral per-pull-request deployment — own database, cache, and URL, seeded synthetically, destroyed on merge. Reviewers click a link instead of imagining behavior; nothing shared breaks. The trade-offs are real: every open PR carries infrastructure cost, spin-up time becomes review latency, third parties need per-environment configuration (Stripe test keys, webhook endpoints), and seed freshness becomes one more pipeline to maintain. Honest scoping: this course builds every piece a preview system needs — images (Module 6), CI (Module 7), infrastructure as code (Module 10), per-environment config and secrets (this module) — but does not assemble the feature itself. When you meet preview environments at work, you'll recognize every component.

## 9. The limits of parity — and the argument for containers

Two limits first, so parity stays a tool rather than a religion. **Scale costs money:** staging's RDS being smaller than production's is fine and normal. But know what you lose: query *plans* depend on data volume and statistics, so a query that's fast against staging's ten thousand orders may choose a different index — or a table scan — against production's ten million. Performance conclusions require production-shaped volume, a deliberate occasional exercise, not a standing environment. **Third parties don't do parity:** Stripe's test mode approximates live behavior, not its rate limits or dispute flows. Accepted gaps — as long as they're *known*, written down, and nobody claims staging proved what it cannot prove.

Now collect the module's ledger. Every parity fix so far was **config discipline**: sessions, cache, and queues onto Redis (5.1); storage behind a facade with swappable disks (5.1); one audited seam for environment config and secrets (5.2); MySQL and Redis locally, `after_commit`, Mailpit, seeders (this lecture). All of it — every line — was `.env` values, `config/` entries, and code that respects them.

What remains is precisely what no `.env` can express: which OS, which PHP build with which extensions and which ICU, which MySQL and Redis point versions, which Nginx and FPM configuration. Today those are five artifacts of *how each machine was set up*. A container image makes them artifacts of *the codebase*: one Dockerfile declares the runtime, and laptop, CI, staging, and production execute byte-for-byte the same one. Factor X's tools gap doesn't get managed at that point — it gets deleted. That is Module 6, and you now know exactly why it's next.

## Hands-on with TicketHub

**1. Audit the drift.** On the laptop, then the VPS:

```
$ php artisan about
  Environment ............................................ local
  ...
  Cache Driver ........................................ database
  Database ............................................ sqlite
  Queue Connection ........................................ sync
  Session Driver ...................................... database
```

The VPS (from 5.1) answers `mysql` / `redis` / `redis` / `redis`. Four drivers, four disagreements — this is the lecture in one screenshot.

**2. Prove the database lies.** SQLite first, on the laptop:

```
$ sqlite3 /tmp/parity-demo.db
sqlite> CREATE TABLE tickets_demo (qr_payload VARCHAR(2048), UNIQUE(qr_payload));
sqlite> CREATE TABLE seats_demo (label VARCHAR(10));
sqlite> INSERT INTO seats_demo VALUES (hex(zeroblob(150)));
sqlite> SELECT length(label) FROM seats_demo;
300
```

An "impossible" index accepted, and 300 characters resting comfortably in a `VARCHAR(10)` — the 10 was decorative. (We couldn't even use `REPEAT()` to build the string; SQLite doesn't have it. Function drift is its own hazard.) Now the same statements against production's engine, in a scratch schema on the VPS:

```
$ ssh tickethub
$ sudo mysql
mysql> CREATE DATABASE tickethub_scratch; USE tickethub_scratch;
mysql> CREATE TABLE tickets_demo (qr_payload VARCHAR(2048), UNIQUE KEY (qr_payload));
ERROR 1071 (42000): Specified key was too long; max key length is 3072 bytes
mysql> CREATE TABLE seats_demo (label VARCHAR(10));
mysql> INSERT INTO seats_demo VALUES (REPEAT('A', 300));
ERROR 1406 (22001): Data too long for column 'label' at row 1
mysql> SELECT status, created_at, COUNT(*) FROM tickethub.orders GROUP BY status;
ERROR 1055 (42000): Expression #2 of SELECT list is not in GROUP BY clause and
contains nonaggregated column 'tickethub.orders.created_at' which is not
functionally dependent on columns in GROUP BY clause; this is incompatible
with sql_mode=only_full_group_by
mysql> DROP DATABASE tickethub_scratch;
```

Three statements SQLite blessed, three production rejections — including the sales-report query shape from section 3.

**3. Reproduce and fix the queue-timing bug.** The VPS already runs the real queue driver, so section 4's race is reproducible on demand. In tinker, dispatch inside a deliberately slow transaction:

```
$ cd /var/www/tickethub && php artisan tinker
> use App\Jobs\GenerateTicketPdf;
> use App\Models\Ticket;
> DB::transaction(function () {
      $clone = Ticket::first()->replicate(['pdf_path']);
      $clone->uuid = (string) Str::uuid();
      $clone->save();
      GenerateTicketPdf::dispatch($clone);
      sleep(10);                 // the rest of a busy confirm() flow
  });
```

The worker pops the job within a few seconds — mid-`sleep`, pre-commit:

```
$ journalctl -u tickethub-worker -n 3
Aug 09 21:37:02 tickethub-vps php[3155]: 2026-08-09 21:37:02 App\Jobs\GenerateTicketPdf ... RUNNING
Aug 09 21:37:02 tickethub-vps php[3155]: 2026-08-09 21:37:02 App\Jobs\GenerateTicketPdf ... 87ms FAIL
Aug 09 21:37:02 tickethub-vps php[3155]: Illuminate\Database\Eloquent\ModelNotFoundException:
No query results for model [App\Models\Ticket] 5183
```

Apply the fix on the laptop — `'after_commit' => true` in `config/queue.php` as in section 4 — commit, and deploy with the full 5.2 sequence (pull, install, `config:cache`, `config:validate`, restart worker). Re-run the tinker experiment: this time journalctl shows the job starting *ten seconds after* dispatch — after the commit — and finishing `DONE`. Clean up the failed job with `php artisan queue:flush`.

**4. Build the local world.** Create `DevSeeder` and the factory states from section 7, then:

```
$ php artisan migrate:fresh --seed --seeder=DevSeeder
  Dropping all tables .............................................. 38ms DONE
  ...
   INFO  Seeding database.
$ php artisan serve &
$ curl -s localhost:8000/api/events | jq '.data[0].name'
"Midnight Arena Tour"
```

Yes — today this seeds SQLite; the seeder is engine-agnostic on purpose, and the same command fills local MySQL the day Compose lands.

**5. Encode the decisions in the contract.** Per [Lecture 5.2's](02-environment-config-secrets.md) discipline, this lecture's decisions belong in `.env.example`, in the same PR:

```dotenv
# --- Local stack: Module 6's Docker Compose provides all of these -------
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=tickethub
DB_USERNAME=tickethub
DB_PASSWORD=secret            # local-only credential; real ones never ship here

SESSION_DRIVER=redis
CACHE_STORE=redis
QUEUE_CONNECTION=redis
REDIS_HOST=127.0.0.1

MAIL_MAILER=smtp              # Mailpit: catches all mail, UI at http://localhost:8025
MAIL_HOST=127.0.0.1
MAIL_PORT=1025

FILESYSTEM_DISK=local         # s3 in production (Module 8); MinIO locally from Module 6
```

A fresh clone now *describes* the parity-correct world even before the tooling to run it arrives — Module 6's `compose.yaml` will satisfy this file line by line.

## Real-world best practices

- **Run the same engines locally as in production — same major.minor, always.** The cost is Docker RAM; the payoff is deleting the entire "worked on SQLite" bug class. Teams that skip this pay for it in exactly the incidents sections 3 and 4 staged, usually during their busiest hour.
- **Make the rich world one command.** `migrate:fresh --seed --seeder=DevSeeder` must always work and always include the hard states — hot on-sale, scarce inventory, expired reservations — because developers only ever test the states the seeder gives them. An afternoon invested in seeders repays itself every day, for every engineer.
- **Keep factories as the single vocabulary of state.** Tests, local seeds, and staging seeds all speak `Event::factory()->onSale()`. Divergent hand-rolled fixtures are how "passes tests, fails staging" happens with no drift in sight.
- **Write the production-data rule down and give it teeth.** "No production data on laptops or shared environments" is policy, with the anonymized-pipeline exception documented, owned, and audited. The rule survives contact with deadlines only if it was agreed before the deadline.
- **Deploy staging with the production pipeline, from day one.** The deploy process is part of the system under test; a hand-deployed staging validates the app while leaving the riskiest component — the release mechanics — unrehearsed.
- **Name your accepted parity gaps.** Smaller staging instances, test-mode Stripe, synthetic data volume: fine — *written down*, so nobody claims staging proved performance at scale or live-payment behavior. An unknown gap is a trap; a documented gap is an engineering decision.

## Common pitfalls

1. **Trusting a green local run on SQLite.** People do it because the suite is fast and setup is zero. The schema, strictness, and query semantics you validated are not production's — as three real error messages just showed. Correct approach: real MySQL locally (Module 6) and in CI (Module 7); SQLite only as a conscious, documented speed trade for pure-logic tests.
2. **Leaving `QUEUE_CONNECTION=sync` "for simplicity."** Everything appears to work — that is the trap: sync executes inside your transaction with your in-memory objects, structurally hiding serialization and timing bugs. Correct approach: `redis` locally with `queue:listen` running, `after_commit => true`, and the committed-state rule from section 4.
3. **Seeding staging (or a laptop) with a production dump.** It feels rigorous — "real data!" — and it is a privacy breach with a legal blast radius, plus a standing temptation to email real customers from a test box. Correct approach: synthetic data from shared factories; an engineered, audited anonymization pipeline in the rare case shape-fidelity truly requires it.
4. **Treating staging as a scratchpad.** Hand-edited config and half-tested branches feel harmless until staging's green means nothing and a broken staging blocks Friday's release. Correct approach: changes reach staging only through the pipeline; red staging is an incident; experiments get preview environments or a laptop.
5. **Extrapolating performance from staging.** The query was instant — against 1% of production's rows, where the optimizer chose a different plan. People do it because the environments look identical. Correct approach: capacity and query-plan questions get their own exercise with production-shaped volume, and `EXPLAIN` is read knowing statistics drive it.

## Exercises

1. **The parity ledger.** Build a table of every backing service and driver: local value, production value, gap, and which module closes it (`about` on both machines is your source). Keep it in the repo — it becomes the checklist Module 6's Compose stack must satisfy.
2. **Coercion hunt.** Find three TicketHub columns where SQLite would accept data MySQL rejects (length overflow, wrong type, invalid date). For each, write the failing insert, the MySQL error you expect, and the validation rule that stops the value before any database sees it. Decide: is app-layer validation *instead of* or *as well as* database strictness?
3. **Extend the world.** Add `soldOut()` and `sellingOutNow()` (< 10 tickets left, on sale) event states to the factories and seeder. Then use `sellingOutNow` to manually probe the oversell invariant: two terminals, two simultaneous checkout requests for the last ticket, and an explanation of what the row locks from [`TICKETHUB.md`](../TICKETHUB.md) did.
4. **After-commit audit.** Find every `dispatch()` in the codebase and classify it: inside a transaction, dependent on just-mutated state, or clean. With `after_commit => true` now global, identify any job that *should* dispatch immediately (none? say why) and write the two-sentence dispatch rule for TicketHub's `CONTRIBUTING.md`.
5. **Stretch: design a preview-environment system on paper.** For each requirement — per-PR app instance, database, cache, seeded data, URL/TLS, secrets, teardown on merge, cost controls — name the mechanism you'd use and the module of this course that teaches it. Identify the two hardest problems (hint: data lifecycle and third-party webhooks) and propose a mitigation for each. Revisit your design after Module 10 and grade it.

## What's next

Module 5 is complete: TicketHub is stateless where it must be, configured through one audited seam, honest about its secrets, and — as of this lecture — committed to running production's engines everywhere, with a seeded world worth developing in. What config could close is closed. What remains open is the runtime itself: the OS, the PHP build, the extensions, the service versions that no `.env` can pin. [Module 6 — Docker & Containerization](../module-06-docker/) closes exactly that gap, by making the runtime an artifact of the codebase — and everything this module enforced (config from the environment, stateless processes, logs to stderr, `.env` kept out of build contexts) is precisely what makes TicketHub containerizable without a rewrite.
