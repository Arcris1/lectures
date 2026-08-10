# Lecture 7.2 — The TicketHub Test Pipeline

> **Module 7 — Continuous Integration with GitHub Actions** · Lecture 2 of 4 · Estimated time: ~65 min

[Lecture 7.1](01-ci-concepts-workflow-anatomy.md) left `ci.yml` running a style check — real, but nobody ships a ticketing platform because the commas were in the right place. The check that earns trust is the test suite, and running it in CI raises questions that "it works on my laptop" never had to answer: which database do the tests talk to, where does configuration come from when there is no `.env`, how do you keep an 8-minute suite from becoming the reason people batch up changes, and what does a coverage number actually promise?

This lecture answers all of them and ends with the complete `tests` job — the single most important status check in the repository. The through-line is a decision you already made: Module 5's parity principle. TicketHub's tests run against **real MySQL 8.0 and real Redis 7** in CI, exactly the engines from Module 6's `compose.yaml` and the ones production will run, because the app's most important behavior — not overselling tickets — lives in database locking semantics that only the real database has.

## Learning objectives

- Decide what belongs in CI's test run for a Laravel API — and what deliberately does not
- Configure MySQL and Redis service containers with health checks, and explain the runner-VM networking model that makes `DB_HOST=127.0.0.1` correct
- Supply test configuration through workflow `env` (no `.env` file), including a generated `APP_KEY`
- Run Pest in parallel with per-process databases and explain what `RefreshDatabase` really does
- Enforce a coverage minimum while explaining honestly what line coverage does and does not measure
- Operate a fast, trustworthy suite: annotations for failures, a policy for flaky tests, a plan for growth

## 1. What to test in CI — the shape of a Laravel suite

Pest (like PHPUnit underneath it) organizes TicketHub's tests into two directories, and they answer different questions:

- **`tests/Unit`** — pure logic, no framework boot, no I/O: order total calculation, promo-code rules, the reservation-expiry cutoff math. Milliseconds each.
- **`tests/Feature`** — the sweet spot for a Laravel API and the bulk of the suite: full HTTP requests through the real stack. One test exercises routing, middleware, validation, controller, Eloquent, and the actual database schema in a few hundred milliseconds:

```php
it('refuses to oversell a ticket type', function () {
    $type = TicketType::factory()->create(['quantity' => 1]);

    actingAs(User::factory()->create())
        ->postJson("/api/events/{$type->event_id}/orders", [
            'items' => [['ticket_type_id' => $type->id, 'quantity' => 1]],
        ])->assertCreated();

    actingAs(User::factory()->create())
        ->postJson("/api/events/{$type->event_id}/orders", [
            'items' => [['ticket_type_id' => $type->id, 'quantity' => 1]],
        ])->assertUnprocessable();   // sold out — the invariant holds
});
```

That second request only fails *correctly* because the checkout code runs `SELECT ... FOR UPDATE` inside a transaction against a database that honors row locks. Which brings us to the parity decision below.

What CI's test run deliberately excludes: **browser/E2E tests** (Laravel Dusk, Playwright). They verify a UI TicketHub's API doesn't have, run an order of magnitude slower, and are the leading source of flakiness in most pipelines. If TicketHub grows a frontend, E2E gets its own workflow with its own (looser) gating — it does not slow down the merge path.

## 2. Real MySQL, real Redis: service containers

The tempting shortcut is SQLite in-memory: zero setup, very fast. Module 5's environment-parity lecture already told you why it's a trap, and TicketHub makes the trap concrete: Laravel's SQLite grammar **silently ignores `lockForUpdate()`** — the query runs, no error, no lock. Your oversell test can pass on SQLite while the code would double-sell under production concurrency. Add MySQL strict mode, `ONLY_FULL_GROUP_BY`, real foreign-key enforcement, JSON column behavior, and decimal precision, and the rule writes itself: **test against the engine you deploy on.** The same argument covers Redis — TicketHub's queues, cache, and atomic locks (reservation expiry uses them) behave like Redis, not like an array driver.

GitHub Actions makes this cheap with **service containers**: containers the runner starts before your steps and destroys after. Declared per job:

```yaml
services:
  mysql:
    image: mysql:8.0
    env:
      MYSQL_ROOT_PASSWORD: secret          # throwaway container, lives ~3 minutes
      MYSQL_DATABASE: tickethub_test
    ports:
      - 3306:3306
    options: >-
      --health-cmd="mysqladmin ping --silent"
      --health-interval=10s
      --health-timeout=5s
      --health-retries=5
  redis:
    image: redis:7
    ports:
      - 6379:6379
    options: >-
      --health-cmd="redis-cli ping"
      --health-interval=10s
      --health-timeout=5s
      --health-retries=5
```

Read the anatomy: same pinned images as `compose.yaml` (parity again); `MYSQL_DATABASE` pre-creates the test database; `ports` **publishes** container ports onto the runner VM; and `options` are raw `docker create` flags — here, health checks. The health checks are not decoration: **the runner waits for every service to report healthy before your first step runs.** MySQL 8.0 takes 10–20 seconds to initialize; without a health check your migration step races it and loses, intermittently — the classic "CI fails every fifth run at 9 a.m." mystery. (Yes, `mysqladmin ping` answers "alive" even when credentials are wrong — it checks the server is up, which is all we need.)

Notice what is *not* here: no Mailpit, no MinIO, unlike Module 6's compose stack. The principle: **keep real what your logic depends on (MySQL, Redis); fake what you only assert about (mail, storage).** Tests assert "an email would have been sent" via `MAIL_MAILER=array` and "a PDF would exist" via `Storage::fake()` — faster, and the assertions are about *your* behavior, not the fake's.

## 3. The networking model — where everyone trips

In Module 6, your app was a container on the compose network, so it reached the database at `DB_HOST=mysql` — Docker's DNS resolving the service name. Muscle memory now tells you to write `DB_HOST=mysql` in CI. **It will fail with `getaddrinfo for mysql failed`**, and the reason is the single most important mental-model shift of this lecture:

**Your job's steps do not run in a container. They run directly on the runner VM.** The services are containers, sitting on a Docker network your PHP process is *not* part of. The bridge between the two worlds is the `ports:` publication — exactly like hitting `localhost:8080` from your laptop to reach a compose service. Side by side:

| | Module 6 `compose.yaml` (local dev) | GitHub Actions `services:` (CI) |
|---|---|---|
| Where your PHP runs | Inside the `app` container, on the compose network | Directly on the runner VM (installed by `setup-php`) |
| Where MySQL runs | `mysql` container, same network | `mysql` container, published to the VM |
| How PHP finds MySQL | Docker DNS: service name | Published port on the VM's loopback |
| `DB_HOST` | `mysql` | `127.0.0.1` |
| `REDIS_HOST` | `redis` | `127.0.0.1` |

The confusing footnote that explains contradictory blog posts: if a job specifies a `container:` to run its *steps* inside, those steps join the same Docker network as the services and the service-name form (`DB_HOST=mysql`) becomes correct again. We run steps on the VM — `setup-php` is faster and simpler than maintaining a CI image — so for this course: **`127.0.0.1`, always.** (Fixed `3306:3306` publishing is fine on a throwaway VM; if a port were already taken you'd publish a random port and read it back as `${{ job.services.mysql.ports['3306'] }}`.)

## 4. Configuration without `.env`

There is no `.env` file in CI, and you will not create one — Module 5 was emphatic that config enters via the environment, and the workflow *is* an environment. Declare it at job scope:

```yaml
env:
  APP_ENV: testing
  DB_CONNECTION: mysql
  DB_HOST: 127.0.0.1
  DB_PORT: 3306
  DB_DATABASE: tickethub_test
  DB_USERNAME: root
  DB_PASSWORD: secret
  REDIS_HOST: 127.0.0.1
  REDIS_PORT: 6379
  CACHE_STORE: redis        # atomic locks & rate limiting behave like production
  QUEUE_CONNECTION: redis   # jobs are Queue::fake()d or run via a real Redis queue
  MAIL_MAILER: array        # assert on Mail::assertSent(), deliver nothing
  FILESYSTEM_DISK: local    # tests use Storage::fake() for the S3-bound disks
```

Two subtleties worth owning:

**`APP_KEY`.** Laravel needs one to boot. It is a *test* key protecting throwaway data, so secrecy isn't the issue — but committing a fixed key into YAML invites someone to copy it somewhere that matters. Cleaner: generate a fresh one per run. `php artisan key:generate --show` prints a key without touching any file; append it to `$GITHUB_ENV` (Lecture 7.1) and every later step sees it:

```yaml
- name: Generate application key
  run: echo "APP_KEY=$(php artisan key:generate --show)" >> "$GITHUB_ENV"
```

**Who wins: workflow `env` or `phpunit.xml`?** Laravel ships defaults in `phpunit.xml` (`<env name="QUEUE_CONNECTION" value="sync"/>`, etc.). PHPUnit only applies those when the variable is **not already set** — a real environment variable takes precedence unless the XML says `force="true"`. So the block above genuinely overrides `phpunit.xml` in CI, while your laptop (no such variables exported) keeps the XML defaults. This is the behavior you want — workflow as CI's source of truth — but it bites people who edit `phpunit.xml`, see no change in CI, and start doubting reality. Now you know where to look.

## 5. PHP setup: extensions and the coverage driver

The `setup-php` step must install the same extension set as Module 6's production image — a test run that green-lights code which then fatals in the container on a missing extension is parity theater:

```yaml
- name: Set up PHP 8.4
  uses: shivammathur/setup-php@v2
  with:
    php-version: '8.4'
    extensions: mbstring, intl, gd, bcmath, pdo_mysql, redis, pcntl
    coverage: pcov
```

`coverage: pcov` deserves its own paragraph because the default choice, Xdebug, quietly doubles pipelines. Two coverage drivers exist: **Xdebug** — a full debugging engine (step debugging, branch/path coverage) whose coverage mode typically slows a suite 2–5x — and **PCOV** — a driver that does line coverage only and nothing else, at single-digit-percent overhead; roughly **5x faster** where it counts. CI needs line coverage and speed: PCOV. Your laptop, when you're stepping through a gnarly checkout bug, wants Xdebug. Different tools, different places. (When you *don't* need coverage — Lecture 7.1's quality job — `coverage: none` disables both.)

Composer caching is the identical pattern from Lecture 7.1 (`cache-files-dir`, key on `hashFiles('composer.lock')`, prefix `restore-keys`), so it appears in the final YAML without re-explanation.

## 6. Migrate before you test

With dependencies installed and MySQL healthy, run the migrations explicitly:

```yaml
- name: Run migrations
  run: php artisan migrate --force
```

Isn't this redundant — doesn't `RefreshDatabase` migrate anyway? Yes, and you run it anyway, for a reason your laptop hides: **every CI run migrates a pristine database from zero.** Your local MySQL has accumulated two years of incremental migrations; whether the full chain still runs cleanly from nothing — the exact thing a new environment, a new teammate, and Module 9's deploys will do — is only proven here. When someone edits an old migration or a rename breaks ordering, *this* step fails with a clear migration error instead of 400 tests failing with table-not-found noise. `--force` skips the are-you-sure prompt reserved for production environments; in a non-interactive runner, prompts are hangs, so make it a habit.

```text
   INFO  Preparing database.
  Creating migration table .............................................. 21ms DONE
   INFO  Running migrations.
  0001_01_01_000000_create_users_table .................................. 38ms DONE
  2025_11_02_141210_create_events_table ................................. 22ms DONE
  2025_11_02_141255_create_ticket_types_table ........................... 25ms DONE
  2025_11_09_090412_create_orders_table ................................. 31ms DONE
  ...
```

## 7. Parallel testing: using all the cores you're paying for

`php artisan test` runs the suite serially — one process, one test at a time, while the runner's other cores idle. TicketHub's ~640 tests take about 7½ minutes serially. The fix is built in:

```console
$ php artisan test --parallel
```

Under the hood this launches **Paratest**, which starts one worker process per CPU core (override with `--processes=N`). Each worker gets an environment variable **`TEST_TOKEN`** (`1`, `2`, …), and Laravel's parallel-testing integration uses it to solve the obvious catastrophe — multiple processes truncating each other's tables — by giving **each process its own database**: it takes your configured name and appends `_test_{token}`. With `DB_DATABASE=tickethub_test`, worker 1 creates and migrates `tickethub_test_test_1`, worker 2 `tickethub_test_test_2`, and so on. (Yes, the doubled `_test` is Laravel mechanically suffixing whatever base name you configured; teams bothered by it name the base database `tickethub` so workers get `tickethub_test_1..N`. Cosmetic either way.) Two operational notes: the DB user must be able to `CREATE DATABASE` — our `root` can; a locked-down user needs that grant — and on your laptop Laravel remembers created test databases between runs (`--recreate-databases` forces a rebuild after schema changes), while in CI every runner is fresh, so creation happens every run and stale-schema bugs are impossible.

This is also the moment to be precise about **`RefreshDatabase`**, because "it refreshes the database" hides the mechanics: per *process*, it runs the migrations **once**, then wraps **each test** in a database transaction rolled back at test end. Tests are isolated at transaction speed, not `migrate:fresh` speed. Corollaries: with 4 workers you pay for 4 migrations per run (visible in the timing); and code under test that itself manipulates transactions in exotic ways can collide with the wrapping transaction — TicketHub's `DB::transaction()` blocks nest fine (Laravel uses savepoints), but know the mechanism before you meet the edge case.

The payoff on a 4-vCPU public-repo runner, for our illustrative suite:

| Run mode | Wall time |
|---|---|
| `php artisan test` (serial) | ~7m 40s |
| `php artisan test --parallel` (4 processes) | ~2m 20s |
| `--parallel` + coverage (PCOV) | ~2m 45s |

Same tests, same assertions, five minutes returned to every push, forever. (On a 2-vCPU private-repo runner expect ~2x serial improvement, not 4x — parallelism can't exceed cores.)

## 8. Coverage: enforce it, and be honest about it

Pest reports coverage and can gate on it:

```console
$ php artisan test --parallel --coverage --min=80
  ...
  Tests:    643 passed (2,118 assertions)
  Duration: 164.20s
  Parallel: 4 processes

  Cov:    83.4%
```

Drop below the bar and the run fails — `ERROR  Code coverage below expected: 78.1%. Minimum: 80.0%.` — which makes coverage a *check*, not a dashboard nobody opens. Before you enforce it, be clear-eyed about the metric. **Line coverage measures which lines executed during tests. Nothing more.** A test that calls checkout and asserts nothing covers every line and verifies zero behavior; 100% coverage proves your tests *ran* the code, not that they'd *catch a bug* in it. The number is far more meaningful in the other direction: an **uncovered** line is a *fact* — no test would notice if it broke. Coverage's real job is showing you where the holes are (`--coverage` prints per-file percentages; the HTML report shows the exact red lines).

So hold the gate with two rules production teams converge on. **Ratchet, don't worship:** set `--min` just below today's truth (TicketHub: 80 against an actual 83.4) so it catches *regression* — a big untested feature landing — and raise it as real coverage rises. Never set an aspirational 95 that today's 83 can't meet; the team will learn to bypass the gate, and a bypassed gate teaches that all gates are optional. And prefer **diff coverage** as the per-PR signal — "are the lines *this PR adds* tested?" — which is actionable ("your new `applyPromoCode()` has no tests") where the global number is diffuse. That needs an external service (Codecov, Qlty) rather than a Pest flag; wiring one is this lecture's stretch exercise, and worth it once the team is past three people.

Publish the evidence either way — generate the HTML report and attach it as an artifact (Lecture 7.1's other persistence mechanism):

```yaml
- name: Upload coverage report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: coverage-report
    path: coverage-report
    retention-days: 7
```

## 9. Failures people can read, and the flaky-test policy

A red X that requires spelunking raw logs adds minutes to every failure. Two cheap improvements. First, Pest's console output is already excellent — the failing test, the assertion diff, the file and line land in the step log. Second, if you want failures surfaced as PR annotations on the exact test file lines, have Paratest write JUnit XML and feed it to a reporter action (needs `checks: write` — escalate on the job, per Lecture 7.1):

```yaml
      - name: Run tests
        run: php artisan test --parallel --coverage --min=80 --log-junit=junit.xml
      - name: Publish test report
        uses: dorny/test-reporter@v1
        if: always()
        with:
          name: pest-results
          path: junit.xml
          reporter: java-junit
```

Keep this optional — the suite must stand alone; reporters decorate.

Now the policy question every team eventually faces: a test that fails one run in twenty, passes on re-run. The reflex is auto-retry — run failures twice, only report persistent reds. **Resist it as a default.** A flaky test is one of two things: a broken test (shared state, time dependence, order dependence) or — worse and common in TicketHub's domain — a **real race condition** in the code, exactly the class of bug that oversells tickets under load. Auto-retry silences both indistinguishably; you've configured your pipeline to hide its most valuable finding. (Pest's `--retry` flag is a *local* convenience — it re-runs previously failed tests first for fast iteration — not an excuse.) The honest workflow: **quarantine and track.** Tag it `->group('quarantine')`, exclude the group in CI (`--exclude-group=quarantine`), and open an issue with an owner and a deadline in the same commit. The suite stays trustworthy, the debt stays visible, and a team rule caps it: more than a handful quarantined, or one older than two sprints — fix or delete. An ignored test is already deleted; quarantine just stops it lying to you meanwhile.

**On speed budgets:** this course holds the whole pipeline under ~10 minutes, tests well inside it — beyond that, people batch changes and the integrate-daily loop from Lecture 7.1 corrodes. When a suite genuinely outgrows one runner (30+ minutes parallel), the next tool is **sharding**: a `matrix` splits the suite across jobs — coarsely by `--testsuite=Unit|Feature`, or with a shard-aware splitter — each shard a parallel runner. It buys near-linear speedup at the cost of N× service containers and matrix-suffixed check names (`tests (Feature)` — remember that when Lecture 7.3 makes check names load-bearing). File it under "nice problem, not today's."

## Hands-on with TicketHub

Assemble the pieces into the `tests` job. Everything below goes into the existing `.github/workflows/ci.yml` from Lecture 7.1, alongside the `quality` job — they share no state and run in parallel on separate VMs. The complete job:

```yaml
  tests:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: secret
          MYSQL_DATABASE: tickethub_test
        ports:
          - 3306:3306
        options: >-
          --health-cmd="mysqladmin ping --silent"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd="redis-cli ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5

    env:
      APP_ENV: testing
      DB_CONNECTION: mysql
      DB_HOST: 127.0.0.1
      DB_PORT: 3306
      DB_DATABASE: tickethub_test
      DB_USERNAME: root
      DB_PASSWORD: secret
      REDIS_HOST: 127.0.0.1
      REDIS_PORT: 6379
      CACHE_STORE: redis
      QUEUE_CONNECTION: redis
      MAIL_MAILER: array
      FILESYSTEM_DISK: local

    steps:
      - uses: actions/checkout@v4

      - name: Set up PHP 8.4
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.4'
          extensions: mbstring, intl, gd, bcmath, pdo_mysql, redis, pcntl
          coverage: pcov

      - name: Determine Composer cache directory
        id: composer-cache
        run: echo "dir=$(composer config cache-files-dir)" >> "$GITHUB_OUTPUT"

      - name: Cache Composer downloads
        uses: actions/cache@v4
        with:
          path: ${{ steps.composer-cache.outputs.dir }}
          key: composer-${{ runner.os }}-${{ hashFiles('composer.lock') }}
          restore-keys: composer-${{ runner.os }}-

      - name: Install dependencies
        run: composer install --prefer-dist --no-progress --no-interaction

      - name: Generate application key
        run: echo "APP_KEY=$(php artisan key:generate --show)" >> "$GITHUB_ENV"

      - name: Run migrations
        run: php artisan migrate --force

      - name: Run tests (parallel, with coverage)
        run: php artisan test --parallel --coverage --min=80 --coverage-html=coverage-report

      - name: Upload coverage report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage-report
          retention-days: 7
```

Push it on a branch and open the PR:

```console
$ git switch -c ci/test-pipeline
$ git add .github/workflows/ci.yml
$ git commit -m "ci: add tests job with MySQL/Redis services, parallel Pest, coverage"
$ git push -u origin ci/test-pipeline
$ gh pr create --fill && gh run watch
```

Read the run the way you learned in Lecture 7.1. Before your first step, an **Initialize containers** section shows the services starting and the runner honoring the health checks — this is your race-condition insurance:

```text
Starting mysql service container
Starting redis service container
Waiting for all services to be ready
mysql service is starting, waiting 12.4 seconds before checking again.
redis service is healthy.
mysql service is healthy.
```

Then the by-now-familiar rhythm — PHP 8.4 with pcov (~15 s), cache hit, install (~8 s warm), key generated, migrations against the pristine `tickethub_test` (~4 s) — and the main event:

```text
   PASS  Tests\Feature\Orders\PlaceOrderTest
  ✓ it reserves inventory for fifteen minutes                              0.31s
  ✓ it refuses to oversell a ticket type                                   0.27s
  ✓ it expires unpaid reservations                                         0.24s
  ...

  Tests:    643 passed (2,118 assertions)
  Duration: 164.20s
  Parallel: 4 processes

  Cov:    83.4%
```

Total job time on a warm cache: about four minutes. Check the artifact list on the run page — `coverage-report` is downloadable; open `index.html` locally and look for red in `app/Services/Checkout/` before an exercise asks you to.

Two experiments before you merge, because feeling failure modes beats reading about them. **One:** change `DB_HOST` to `mysql` — compose muscle memory — push, and collect the error that section 3 predicted (`SQLSTATE[HY000] [2002] php_network_getaddresses: getaddrinfo for mysql failed`). Revert. **Two:** comment out the MySQL `options:` block and re-run a few times; when the migration step wins the race it works, and eventually you'll catch `Connection refused` — the intermittent failure whose permanent fix is the health check, not a `sleep 15`. Restore it, get green, merge. Every PR now runs the suite against production's engines.

## Real-world best practices

- **Make the tests job the check the team trusts most.** That means zero tolerance for "it's red but it's fine": every red is either a real bug (fix), a broken test (fix), or flaky (quarantine + issue, same day). Teams that let ambiguity live in test results end up bypassing the gate — and then the gate is decoration. Trust is the entire product of this job.
- **Keep CI's engine versions pinned to production's, and upgrade through a PR.** `mysql:8.0` and `redis:7` here must move in lockstep with `compose.yaml` (Module 6) and, later, RDS and ElastiCache (Module 8). An engine upgrade becomes an ordinary reviewed change that runs the whole suite against the new version *before* any environment feels it — parity as a workflow, not a poster.
- **Budget the suite, and treat the budget like an SLO.** Elite teams watch test-suite duration like a product metric: when the p50 crosses the budget (ours: ~5 minutes for `tests`), someone is assigned to profile it (`--profile` lists the slowest tests) before it drifts to 20. Slow suites don't arrive; they accumulate.
- **Prefer factories + `RefreshDatabase` over seeded fixture dumps.** Each test builds exactly the world it needs; there's no shared fixture file that 400 tests depend on and nobody dares change. The transaction-rollback isolation you get is also what makes parallel workers safe.
- **Don't chase a coverage number with assertion-free tests.** Reviewers should treat a test with no meaningful assertions as a defect, coverage notwithstanding — it converts the one honest signal (uncovered = untested) into noise. Ratchet the minimum; celebrate deleted dead code (coverage rises for free) over ritual tests.

## Common pitfalls

1. **`DB_HOST=mysql` in CI.** Compose muscle memory, applied where steps run on the VM rather than on the Docker network. The correct approach is section 3's model: services are published ports, so `127.0.0.1` — unless you deliberately run steps in a `container:`, which we don't.
2. **No health checks on service containers.** The workflow works four runs out of five, then fails with `Connection refused` when MySQL's init loses the race — and people "fix" it with `sleep 20`, which is both slow and still a guess. Correct approach: `--health-cmd` options so the runner *waits for healthy*, deterministically.
3. **Editing `phpunit.xml` and wondering why CI ignores it.** Real environment variables beat `<env>` entries (unless `force="true"`), and the workflow sets real ones. People burn an afternoon on this. Correct approach: treat the workflow `env` block as CI's source of truth; keep `phpunit.xml` as local defaults; use `force` only for values that must never vary.
4. **Xdebug as the CI coverage driver.** It's what the tutorial had, and it silently makes every run 2–5x longer — pure waste when nothing in CI step-debugs. Correct approach: `coverage: pcov` in CI; keep Xdebug on your laptop where its debugger earns its overhead.
5. **Setting `--min` above reality.** An aspirational 95 against an actual 83 makes every PR red on arrival, and humans respond by neutering the gate (lowering it in the same PR, or worse, padding with assertion-free tests). Correct approach: ratchet — enforce slightly below today's number, raise it as truth rises.
6. **Auto-retrying flaky tests to keep the pipeline green.** It works — the pipeline goes green — and it systematically hides race conditions, the exact bug class that ruins a ticket on-sale. Correct approach: section 9's quarantine-and-track policy; retries are for humans investigating, not for pipelines concealing.

## Exercises

1. **Read your coverage.** Download the `coverage-report` artifact from a green run and find the three least-covered files in `app/`. For each, decide: does it need tests, or is it trivial glue? Write the one test that most reduces real risk.
2. **Break parity, observe the value.** On a branch, point the suite at SQLite (`DB_CONNECTION=sqlite`, `DB_DATABASE=:memory:`, drop the service containers) and run the oversell test locally. Confirm it still passes — then explain in one paragraph why that pass is worthless and what it would have hidden. Delete the branch with prejudice.
3. **Profile and parallelize.** Run `php artisan test --profile` locally and list the 5 slowest tests. Then compare `--parallel` wall time with `--processes=2` vs the default on your machine. Where does the speedup stop scaling, and why (cores? migration overhead per process?)?
4. **Grant-limited database user.** Replace `root` in the service container with a dedicated `tickethub_ci` user (create it via `MYSQL_USER`/`MYSQL_PASSWORD` env plus an init step granting `CREATE`). Get parallel testing working again and write down every grant it actually needed — you'll reuse this thinking when Module 8 creates RDS users.
5. **Stretch — diff coverage.** Sign up for Codecov's free tier, add its uploader action gated behind `if: github.event_name == 'pull_request'`, upload the clover/XML output (`--coverage-clover=coverage.xml`), and open a PR that adds an untested method. Compare what the PR comment tells you against the global `--min` gate, and write a three-sentence recommendation: which gate should block, and at what threshold?

## What's next

The pipeline now proves TicketHub *behaves* correctly. It says nothing about whether the code is *sound*: style drift, `null` dereferences waiting for the right input, a dependency with a published CVE. Machines catch all three, and [Lecture 7.3 — Code Quality Gates](03-code-quality-gates.md) wires them in: Pint properly, PHPStan with Larastan (including a real bug in TicketHub's report code), `composer audit` and Dependabot — then flips the switch Module 4 left waiting and makes `tests` and `quality` **required** checks on `main`.
