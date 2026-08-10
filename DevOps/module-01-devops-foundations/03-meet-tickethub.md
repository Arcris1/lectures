# Lecture 1.3 — Meet TicketHub

> **Module 1 — DevOps Foundations** · Lecture 3 of 4 · Estimated time: ~60 min

Enough theory about other people's deploys — meet the application you'll carry from a laptop to Kubernetes over the next eleven modules. This lecture walks TicketHub's domain and the code that makes it interesting to operate, boots it the naive way on your machine, then shows precisely — via three concrete failure stories — why "works on my machine" is a systems problem, not an excuse. [`TICKETHUB.md`](../TICKETHUB.md) is the permanent reference for the app's design, pinned versions, and naming; this lecture is the guided tour.

## Learning objectives

- Describe TicketHub's domain model and explain why overselling is the invariant everything else protects
- Read and explain the row-locking reservation transaction, the queued PDF job, and the Laravel 12 scheduler definitions
- Boot TicketHub locally with SQLite and exercise the API from the command line
- Explain three concrete mechanisms behind "works on my machine": runtime version drift, missing platform extensions, and unequal queue drivers
- Define local, staging, and production environments, and the snowflake-server and configuration-drift failure modes
- Outline how TicketHub's architecture evolves module by module through this course

## 1. The domain: selling tickets without selling lies

TicketHub is an event-ticketing API. **Organizers** create **events**; each event has one or more **ticket types** (General Admission, VIP) with a price and a strictly limited quantity. **Customers** place **orders**; an order *reserves* inventory for 15 minutes, and if payment doesn't arrive in time, the reservation expires and the seats return to the pool. On payment, the system issues one **ticket** per admission — QR code, PDF, confirmation email — and organizers receive a nightly sales report. The schema follows directly: `users`, `events`, `ticket_types`, `orders`, `order_items`, `tickets`, plus Laravel's standard `jobs`, `failed_jobs`, and `cache` tables (the database-backed queue stays only until Module 5 moves queues to Redis).

Ticketing was chosen because it refuses to be a toy. One sentence defines the system's honor: **a ticket type must never be oversold.** If Marina Bay Indie Fest has 500 VIP tickets, selling number 501 isn't a bug you apologize for in a changelog — it's a human turned away at a gate, a refund, and an organizer who never returns. And the invariant is hardest to keep exactly when business is best: on-sales concentrate thousands of buyers into the same few seconds, racing for the same rows. That collision of correctness and concurrency makes TicketHub a genuine DevOps teaching vehicle — every workload it needs is one you must learn to operate:

- an **HTTP API** that must scale for spikes and deploy without downtime;
- **queue workers** (Laravel Horizon on Redis, from Module 5) chewing through CPU-heavy PDF generation and email — long-running processes to supervise, scale, and drain gracefully on deploy;
- a **scheduler** — `php artisan schedule:run` every minute — expiring stale reservations and sending nightly reports, which must run *exactly once* even across many servers;
- **MySQL 8.0**, because the invariant lives in transactions and row locks — so migrations under live traffic, backups, and failover all matter;
- **Redis 7** for cache, sessions, and queues; **S3** for PDFs and images, because local disk becomes a lie the day you have two servers; **SES** for email (Mailpit locally).

The invariant quietly reappears in almost every module: deploys must not kill in-flight reservation transactions (Module 9), the scheduler must not double-run `ExpireReservations` across servers (Modules 8 and 11), the database can't be casually restarted mid-on-sale (Module 8). The domain *is* the ops curriculum.

## 2. The code you'll watch evolve

You don't need the whole codebase — it's a standard Laravel 12 application — but three excerpts deserve a line-by-line read now, because nearly every module touches them.

### The reservation transaction

This is the heart of the system: the code path that keeps the invariant. It lives in a single-purpose action class:

```php
<?php

namespace App\Actions;

use App\Exceptions\SoldOutException;
use App\Models\Order;
use App\Models\TicketType;
use Illuminate\Support\Facades\DB;

class ReserveTickets
{
    /**
     * Reserve $quantity tickets of a ticket type for a customer.
     * Inventory is held for 15 minutes; the ExpireReservations command
     * (scheduled every minute) releases unpaid holds.
     */
    public function handle(int $customerId, int $ticketTypeId, int $quantity): Order
    {
        return DB::transaction(function () use ($customerId, $ticketTypeId, $quantity): Order {
            // 1. Lock the inventory row. Concurrent requests for the same
            //    ticket type queue up on this lock until we commit or roll
            //    back — this serialization is what makes the check honest.
            $ticketType = TicketType::query()
                ->whereKey($ticketTypeId)
                ->lockForUpdate()               // SELECT ... FOR UPDATE
                ->firstOrFail();

            // 2. Check availability while holding the lock. Checking before
            //    locking would be a lie: another request could sell the same
            //    seats between our read and our write.
            if ($ticketType->quantity_available < $quantity) {
                throw new SoldOutException(
                    "Only {$ticketType->quantity_available} ticket(s) left for {$ticketType->name}."
                );
            }

            // 3. Take the inventory inside the same transaction.
            $ticketType->decrement('quantity_available', $quantity);

            // 4. Record the hold with its expiry.
            $order = Order::query()->create([
                'user_id'    => $customerId,
                'status'     => 'reserved',
                'expires_at' => now()->addMinutes(15),
            ]);

            $order->items()->create([
                'ticket_type_id' => $ticketType->id,
                'quantity'       => $quantity,
                'unit_price'     => $ticketType->price,
            ]);

            return $order;
        });
    }
}
```

The supporting exception is a plain domain marker:

```php
<?php

namespace App\Exceptions;

use RuntimeException;

class SoldOutException extends RuntimeException
{
}
```

Read the shape carefully: **lock, check, mutate, record — all inside one transaction.** `lockForUpdate()` issues `SELECT ... FOR UPDATE`, so when two buyers race for the last VIP ticket, MySQL forces one transaction to wait at step 1 until the other commits; the loser re-reads an already-decremented `quantity_available`, fails the check, and gets a clean `SoldOutException` instead of a phantom ticket. If anything throws, `DB::transaction()` rolls everything back — no half-created orders, no leaked inventory. Textbook pessimistic locking, bulletproof *on one MySQL server*. File away two forward references: deploys must respect these in-flight transactions (Module 9), and — a fact that matters in about twenty minutes — **SQLite ignores `lockForUpdate()` entirely**, so the naive local setup you're about to run cannot exercise the most important behavior in the codebase.

### The PDF job

After payment, each ticket needs a PDF (QR code, event details). That's CPU-heavy — exactly what must *not* happen inside a web request holding a PHP-FPM worker — so it's a queued job:

```php
<?php

namespace App\Jobs;

use App\Models\Ticket;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Queue\SerializesModels;

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
        // Render the ticket (QR code, event, seat) to PDF and store it.
        // The full implementation arrives as the course progresses; what
        // matters now is the shape: CPU-heavy work, isolated on its own
        // 'pdfs' queue so a burst of renders can't starve order emails.
    }
}
```

Two details are load-bearing. First, `SerializesModels`: pushed to a real queue, the `Ticket` model isn't stored — only its ID — and it's re-fetched when a worker picks the job up, possibly minutes later, possibly on a different machine. Second, `onQueue('pdfs')`: TicketHub runs three named queues — `default`, `pdfs`, `mail` — so slow PDF rendering can be scaled and prioritized independently. Both details are invisible on your laptop right now, and both will bite, on schedule, in Section 4.

### The scheduler

Laravel 12 has no `app/Console/Kernel.php` — if you learned Laravel before version 11, note that scheduled tasks now live in `routes/console.php` via the `Schedule` facade:

```php
<?php

use App\Console\Commands\ExpireReservations;
use App\Console\Commands\SendNightlySalesReports;
use Illuminate\Support\Facades\Schedule;

Schedule::command(ExpireReservations::class)
    ->everyMinute()
    ->withoutOverlapping();

Schedule::command(SendNightlySalesReports::class)
    ->dailyAt('02:00')
    ->timezone('Asia/Singapore');
```

`ExpireReservations` (signature `tickethub:expire-reservations`) finds `reserved` orders past their `expires_at` and returns their inventory — the cleanup half of the reservation design; `withoutOverlapping()` stops a slow run stacking on the next minute's. `SendNightlySalesReports` (signature `tickethub:send-nightly-sales-reports`) emails every organizer their day's numbers at 02:00 Singapore time. One process makes this tick: `php artisan schedule:run`, invoked every minute — by you, by cron, eventually by a Kubernetes CronJob (Module 11). "What, exactly, runs the scheduler, and on *which* of our five servers?" is a genuine production design problem this course answers three different ways.

## 3. Environments: local, staging, production

An **environment** is a complete, independent instance of the system — code, configuration, and data — serving a distinct purpose. TicketHub uses the standard three, and this course names them consistently everywhere:

| Environment | Where it runs | Purpose | Who it may hurt |
|---|---|---|---|
| `local` | Your machine (today: `php artisan serve`; from Module 6: Docker Compose) | Fast iteration, experiments, breaking things freely | Nobody |
| `staging` | AWS, mirroring production at smaller scale (`api.staging.tickethub.example`) | Final validation in production-like conditions; every merge to `main` auto-deploys here from Module 9 | Your team's confidence |
| `production` | AWS `ap-southeast-1` (`api.tickethub.example`) | Real customers, real money | Everyone |

The three run the same code with different configuration: local sends mail to Mailpit, production through SES; local tolerates debug pages, production must never show one. Module 5 turns "same code, different config" into formal discipline (twelve-factor), and staging's entire point — catching what local can't — only works to the degree staging *resembles* production. Which raises the obvious question: how similar is your laptop to a production server? Let's find out the way everyone historically found out.

## 4. Three ways "works on my machine" happens

"Works on my machine" isn't a character flaw — it's the predictable result of running the same code on unequal platforms. Here are three true-to-life TicketHub stories, each a different mechanism. All three are set in the near future of the naive VPS deployment you'll build in Modules 2–3; consider them prophecies.

**Story one: the runtime itself diverges.** Priya's laptop runs PHP 8.4 from Homebrew. The production VPS runs Ubuntu 24.04 LTS, whose default `php-fpm` package is PHP **8.3** — nobody chose that; it's what `apt install php-fpm` produced. For months the difference is invisible. Then Priya uses a PHP 8.4 convenience, chaining a method straight onto instantiation without wrapping parentheses:

```php
$code = new TicketCode($ticket)->toString();
```

Every test passes locally. Code review sees nothing — it's valid, current PHP. Friday's `git pull` ships it, and production greets Saturday with:

```
PHP Parse error: syntax error, unexpected token "->" in
/var/www/tickethub/app/Support/TicketCode.php on line 14
```

A *parse* error, so the failure isn't one broken feature — every request touching that file 500s instantly. Nothing in the delivery process compared the two PHP versions, because the platform was assembled by hand on both machines. The durable fix is pinning the runtime in one artifact both environments share — Module 6's Docker image (`php:8.4-fpm` regardless of host OS), with Module 5's parity discipline as the principle.

**Story two: the platform is missing pieces.** The nightly sales report formats revenue with `NumberFormatter` (PHP's `intl` extension); ticket PDFs render QR codes through GD. Homebrew's PHP bundles both, so locally everything simply works — Priya never consciously *decided* to depend on them. The minimal install on the VPS has neither, and `composer.json` never declared them, so `composer install` succeeds cheerfully on the server. The bomb waits for the first scheduled 02:00 report:

```
[2026-04-12 02:00:07] production.ERROR: Class "NumberFormatter" not found
{"exception":"[object] (Error(code: 0): Class \"NumberFormatter\" not found
at /var/www/tickethub/app/Reports/SalesReportBuilder.php:42)"}
```

Nobody is awake at 02:00; organizers silently stop receiving reports until someone complains. The immediate fix is `apt install php8.3-intl php8.3-gd` — by hand, on one server; remember that phrase for Section 5. The *systemic* fix is making implicit dependencies explicit so tooling can check them:

```json
"require": {
    "php": "^8.4",
    "ext-gd": "*",
    "ext-intl": "*"
}
```

With that declared, `composer install` on a machine lacking `intl` fails immediately and legibly — *"requires PHP extension ext-intl but it is missing from your platform"* — at deploy time, when a human is watching, instead of at 02:00 when nobody is. Declaring platform requirements is a Module 5 discipline; ultimately the container image (Module 6) carries its own extensions and the whole category of error disappears.

**Story three: development and production don't even run the same *architecture*.** TicketHub's `.env.example` ships `QUEUE_CONNECTION=sync`, so a fresh checkout works with zero extra processes — dispatch a job and it runs inline, right there in the request. Convenient, and quietly poisonous, because sync isn't a queue: it's a subroutine call wearing a queue's interface. Production runs Redis with separate worker processes, and three differences emerge that sync had hidden. Under sync the job runs *now* — with a real queue it runs *later*, when the world may have changed (`SerializesModels` re-fetches the ticket by ID; deleted in between, the worker throws `ModelNotFoundException`). Under sync the job runs *here* — inside the web request, with the authenticated user and request state ambiently available; a worker has none of that, so the innocent `auth()->user()->email` inside a job works all through development and explodes in production with `Call to a member function on null`. And under sync, failure is *loud* (the request 500s) — with a real queue the request succeeds, the failure lands later in a worker log nobody reads, and the symptom is customers phoning about missing tickets. Same code, honestly passing tests, two execution models. The fix is parity again: run a real queue driver locally (Module 5 flips local to Redis; Module 6's Compose stack makes it effortless) so jobs serialize, defer, and fail the same way everywhere.

Three stories, one moral: "works on my machine" always expands to *"works on a platform whose exact composition nobody controls, and we ship to a different one."* The course's answer, built across Modules 5 and 6, is to make the platform itself a versioned artifact.

## 5. Snowflake servers and configuration drift

Now name the disease behind all three stories. A **snowflake server** (Martin Fowler's term) is one whose configuration is unique and unreproducible — assembled over years of SSH sessions, apt installs, edited configs, and midnight fixes that live nowhere but the machine itself. Ask "could we rebuild this box from scratch by Friday?" and the honest answer is a nervous laugh: the server *is* its own only documentation.

**Configuration drift** is how snowflakes form: each hand-applied change moves the machine further from any known state — and from its siblings. You've watched it twice already: Marcus's hand-added index in Lecture 1.1 (production's schema drifted, and a migration written against the documented state failed against the real one), and story two's emergency `apt install php8.3-intl` (now production has an extension staging lacks — the *next* surprise is already loaded). Drift compounds: the more a server drifts, the scarier it is to touch, so changes get made minimally and manually, which drifts it further — ending in a machine everyone fears and nobody can recreate, a single point of failure made of sediment.

The remedies form a ladder this course climbs rung by rung: document the setup (weak — docs drift too); script it (better — Modules 2–3, where you build the VPS by hand precisely to feel this pain); bake it into images (Docker, Module 6 — the platform becomes a build artifact); declare it as code with an enforcing tool (Terraform, Module 10 — drift becomes a *detectable diff* instead of an anecdote); finally, make infrastructure immutable with Git as the only writer (GitOps, Module 11 — hand-edits don't persist because machines are replaced, not repaired). Every rung exists because someone lived the rung below.

## 6. The promise: TicketHub's road to production

Here is the whole course as one table — where TicketHub runs after each stage (from [`TICKETHUB.md`](../TICKETHUB.md), section 7):

| After module | TicketHub runs as |
|---|---|
| 3 | One Ubuntu VPS, Nginx + PHP-FPM, MySQL and Redis on the same box, deployed by `git pull` (deliberately naive) |
| 6 | Containers everywhere locally; production still the VPS |
| 8 | EC2 + ALB, RDS, ElastiCache, S3 — still deployed semi-manually |
| 9 | ECS Fargate, fully automated deploys from GitHub Actions, zero downtime |
| 10 | Identical, but every AWS resource is Terraform-managed |
| 11 | EKS with Helm + Argo CD (GitOps) |
| 12 | Same platform + full observability, security scanning, SLOs, runbooks |

Read it as a story, because each row is caused by the previous row's pain. The **VPS** (Module 3) is where you learn what a running Laravel app *is* — Nginx talking to PHP-FPM, systemd keeping workers alive, cron firing the scheduler — and where you accumulate firsthand every problem this lecture described: snowflake, drift, `git pull` deploys, one box holding everything. **Containers** (Module 6) answer Section 4 by making the platform a versioned artifact — locally first, because local is where the pain is cheapest to fix. **EC2 + ALB with managed services** (Module 8) splits the one box apart — database to RDS, cache to ElastiCache, files to S3 — so machines become disposable and the Saturday spike has somewhere to scale; deploys stay human-driven, and you'll feel what that costs. **ECS Fargate** (Module 9) is the payoff row: the pipeline becomes the only path to production, deploys become boring, and the Friday-night genre of incident structurally can't happen. **Terraform** (Module 10) does to infrastructure what Git did to code — the whole AWS estate becomes reviewable, diffable, reproducible text. **EKS with GitOps** (Module 11) trades ECS's simplicity for the industry-standard orchestrator and pull-based deployment. And **Module 12** adds what makes it production rather than merely deployed: telemetry, SLOs, security scanning, runbooks — the return loop from Lecture 1.1's definition, fully built. The deliberately painful early stages aren't filler; they're why you'll understand *why* each later tool exists — the difference between operating a platform and cargo-culting one.

## Hands-on with TicketHub

### First boot, the naive way

Time to run it. You need PHP 8.4, Composer 2.7+, and Git — nothing else; SQLite keeps the first boot trivial (we've already admitted what that convenience costs). Verify the runtime first — story one made the case:

```bash
$ php -v
PHP 8.4.6 (cli) (built: Apr 10 2026 11:24:03) (NTS)
$ composer --version
Composer version 2.8.5 2026-01-21 10:23:19
```

Clone and install (`github.com/tickethub/tickethub-api` is the course's placeholder org — use your own fork):

```bash
$ git clone https://github.com/tickethub/tickethub-api.git
$ cd tickethub-api
$ composer install
Installing dependencies from lock file (including require-dev)
Verifying lock file contents can be installed on current platform.
Package operations: 114 installs, 0 updates, 0 removals
  ...
Generating optimized autoload files
```

Configuration comes from `.env`, never committed, always copied from the tracked example (Module 5 explains this split rigorously):

```bash
$ cp .env.example .env
$ php artisan key:generate
   INFO  Application key set successfully.
```

Migrate and seed. The `.env.example` points `DB_CONNECTION=sqlite`, and Laravel offers to create the missing database file — say yes:

```bash
$ php artisan migrate --seed

   WARN  The SQLite database configured for this application does not exist: database/database.sqlite.

 ┌ Would you like to create it? ────────────────────────────────┐
 │ Yes                                                          │
 └──────────────────────────────────────────────────────────────┘

   INFO  Preparing database.

  Creating migration table ................................ 4ms DONE

   INFO  Running migrations.

  0001_01_01_000000_create_users_table ................... 12ms DONE
  0001_01_01_000001_create_cache_table .................... 3ms DONE
  0001_01_01_000002_create_jobs_table ..................... 5ms DONE
  2026_01_10_000000_create_events_table ................... 4ms DONE
  2026_01_10_000100_create_ticket_types_table ............. 5ms DONE
  2026_01_12_000000_create_orders_table ................... 6ms DONE
  2026_01_12_000100_create_order_items_table .............. 4ms DONE
  2026_01_14_000000_create_tickets_table .................. 6ms DONE

   INFO  Seeding database.
```

Serve and hit the API:

```bash
$ php artisan serve
   INFO  Server running on [http://127.0.0.1:8000].
```

From a second terminal:

```bash
$ curl -s http://127.0.0.1:8000/api/v1/events
```

```json
{
  "data": [
    {
      "id": 1,
      "name": "Marina Bay Indie Fest 2026",
      "venue": "Marina Bay Open Grounds, Singapore",
      "starts_at": "2026-11-21T18:00:00+08:00",
      "ticket_types": [
        { "id": 1, "name": "General Admission", "price": "89.00", "quantity_available": 5000 },
        { "id": 2, "name": "VIP", "price": "249.00", "quantity_available": 500 }
      ]
    },
    {
      "id": 2,
      "name": "Laravel Live Asia 2027",
      "venue": "Suntec Convention Centre, Singapore",
      "starts_at": "2027-03-12T09:00:00+08:00",
      "ticket_types": [
        { "id": 3, "name": "Conference Pass", "price": "399.00", "quantity_available": 1200 }
      ]
    }
  ]
}
```

(Output formatted for readability.) TicketHub is alive on your machine. Poke the scheduler too — this is the `routes/console.php` from Section 2, rendered by the framework:

```bash
$ php artisan schedule:list
  * * * * *  php artisan tickethub:expire-reservations ........... Next Due: 1 minute from now
  0 2 * * *  php artisan tickethub:send-nightly-sales-reports .... Next Due: 11 hours from now
```

Nothing *invokes* `schedule:run` every minute on your laptop — locally you'd run `php artisan schedule:work` when you care. Who invokes it in production, exactly once across many machines, is a question you now know to keep asking.

### Reproduce story three yourself

Don't take Section 4's word for the queue-driver trap — watch it. With `QUEUE_CONNECTION=sync` (your fresh `.env`'s default), dispatch the PDF job from Tinker; the seeder created a sample paid order with issued tickets for exactly this kind of poking:

```bash
$ php artisan tinker
> App\Jobs\GenerateTicketPdf::dispatch(App\Models\Ticket::first());
= Illuminate\Foundation\Bus\PendingDispatch {#6021}
> DB::table('jobs')->count();
= 0
```

The job already ran — inline, inside your Tinker process, before `dispatch()` even returned. No queue, no serialization, no separate worker: a subroutine call. Now edit `.env`, set `QUEUE_CONNECTION=database`, and repeat:

```bash
$ php artisan tinker
> App\Jobs\GenerateTicketPdf::dispatch(App\Models\Ticket::first());
= Illuminate\Foundation\Bus\PendingDispatch {#6021}
> DB::table('jobs')->count();
= 1
> DB::table('jobs')->value('queue');
= "pdfs"
```

Now the dispatch stored a serialized *description* of the job — the payload records the class and the ticket's **ID** (`SerializesModels` at work), not the model — and nothing will execute it until a worker asks. Prove even that has sharp edges:

```bash
$ php artisan queue:work --stop-when-empty
   INFO  Processing jobs from the [default] queue.
```

It exits without touching your job — it watched the `default` queue, and `GenerateTicketPdf` sits on `pdfs`. The worker must be told:

```bash
$ php artisan queue:work --queue=pdfs --stop-when-empty
   INFO  Processing jobs from the [pdfs] queue.
  2026-08-09 13:42:11 App\Jobs\GenerateTicketPdf ................ RUNNING
  2026-08-09 13:42:12 App\Jobs\GenerateTicketPdf ............ 1s DONE
```

In five minutes you've met every mechanism from story three: deferred execution, model re-fetching by ID, jobs stranded on unwatched queues, and workers as separate processes that must be *run by something* — which is why production needs Horizon under supervision (Modules 2, 5, 6), not a developer remembering a flag. Set `QUEUE_CONNECTION` back to `sync`, and log today's date and your exact PHP version into the `tickethub-notes` journal from Lecture 1.1 — evidence for a later module, when we diff your machine against the server.

## Real-world best practices

- **Declare every platform requirement in `composer.json`.** `"php": "^8.4"` plus every `ext-*` you touch, so installs fail loudly on wrong platforms instead of production failing quietly at 02:00. Teams add `config.platform.php` too, pinning what dependency resolution assumes regardless of which machine runs `composer update`. The cheapest parity insurance there is.
- **Treat `.env.example` as a maintained contract.** Every variable the app reads, present and commented, updated in the same PR that introduces it. Why: onboarding and deploys fail on the *missing* variable, and the example file is the only place the full set is visible in review.
- **Keep first boot under five minutes, honestly.** A short, tested path from clone to running app (most teams wrap it in one script or `composer run setup`). Why: setup friction is where drift between developers' machines begins — everyone "fixes" their own boot differently, and each fix is a private snowflake.
- **Match engines where behavior matters, early.** SQLite for a first boot is fine; testing reservation code against an engine that ignores `lockForUpdate()` is not. Run the real MySQL/Redis locally the moment invariants depend on engine behavior — trivial after Module 6's Compose stack, enforced with real services in Module 7's CI.
- **Exercise the asynchronous paths in development.** Run a real queue driver and an actual worker locally at least before every release; sync mode structurally cannot surface serialization, ordering, or context bugs. Why: the worst queue bugs don't error — they succeed at the wrong time with the wrong data.
- **Seed data that resembles production shape.** Five thousand tickets for the festival, not five — realistic seeders catch N+1 queries and slow paths on laptops, where they cost nothing. A seeded demo order for poking (as used above) pays for itself weekly.

## Common pitfalls

1. **Reading "it runs locally" as "it works."** The mistake: treating a green local run as verification while sync queues, SQLite, and a bundled-everything PHP quietly skip the hard parts. Why people make it: the differences are invisible until load or time exposes them. Correct approach: know your local lies (this lecture's list is a start) and close the gaps deliberately — parity in Module 5, containers in Module 6.
2. **Letting the dev database engine diverge from production's.** The mistake: months of development on SQLite while production runs MySQL 8.0. Why: SQLite is zero-setup, and Laravel makes switching look free. Correct approach: the moment code depends on engine behavior — locks, strict mode, collation — develop and test against MySQL; TicketHub's core transaction makes that day one.
3. **Depending on PHP extensions you never declared.** The mistake: using `intl`, `gd`, `pcntl` because your laptop happens to have them. Why: dev bundles include so much that dependence is unconscious. Correct approach: declare in `composer.json` the moment you use one; audit with `composer check-platform-reqs` on the target machine.
4. **Fixing production by hand "just this once."** The mistake: SSH in, install the package, edit the config, move on. Why: it's genuinely the fastest fix at 02:00. Correct approach: if you must hot-fix, record it and re-apply through the proper channel (repo, image, later Terraform) the same week — an unrecorded fix is drift with a delay fuse. Modules 10–11 make the proper channel faster than SSH, which is how this pitfall actually dies.
5. **Testing against toy data.** The mistake: seeders with three rows, then shock when production behaves differently. Why: small seeds are quick to write and fast to run. Correct approach: seed production-shaped data (thousands of tickets, expired and active reservations mixed) and keep one rich demo scenario for manual poking.

## Exercises

1. **Walk the API.** With the app served, use `curl` to fetch the event list and a single event's detail endpoint (`/api/v1/events/1`). Then check `php artisan route:list --path=api` and note which routes exist that you haven't exercised.
2. **Watch a reservation die.** In Tinker, create a reservation via `App\Actions\ReserveTickets`, set its `expires_at` into the past (`$order->update(['expires_at' => now()->subMinute()])`), run `php artisan tickethub:expire-reservations`, and verify the status changed and `quantity_available` went back up. You've just manually done the scheduler's every-minute job.
3. **Read a queue payload.** With `QUEUE_CONNECTION=database`, dispatch `GenerateTicketPdf` again and inspect `DB::table('jobs')->value('payload')` in Tinker. Find the job class, the queue name, and how the `Ticket` is represented; explain in one paragraph why that representation makes story three's `ModelNotFoundException` possible.
4. **Trace the race.** On paper, walk two concurrent requests buying the final VIP ticket through `ReserveTickets` — first with `lockForUpdate()`, then pretending the lock line was deleted. Show the interleaving where the unlocked version sells 501 of 500, and explain why running this experiment on SQLite would tell you nothing.
5. **Stretch — audit a real project.** Take any Laravel project you own. List every PHP extension it actually uses (`composer check-platform-reqs`, compared against `php -m`), verify each is declared in `composer.json`, and fix the gaps. Then write down every difference between your machine and wherever it runs in production — PHP version, extensions, database engine, queue driver. That list is your personal "works on my machine" risk register; keep it for Module 5.

## What's next

TicketHub now runs on your machine, and you know precisely which conveniences are lying to you — the throwaway queue, the lock-ignoring database, the platform assembled by accident. One lecture remains in this module: before we start fixing anything, we need instruments. [Lecture 1.4](04-measuring-devops-dora.md) introduces the four DORA metrics — the industry's standard gauges for delivery performance — establishes TicketHub's ugly "before" numbers under the naive workflow, and sets the targets the next eleven modules will hit.
