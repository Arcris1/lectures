# Lecture 6.3 — Docker Compose for Local Development

> **Module 6 — Docker & Containerization** · Lecture 3 of 4 · Estimated time: ~85 min

Last lecture ended with you typing `docker network create`, two `docker run` commands, and a handful of `-e` flags — for two containers. TicketHub's real local stack needs eight: app, nginx, MySQL, Redis, Horizon, the scheduler, a mail catcher, and an S3 stand-in. Nobody should type that, and nobody should have to ask a teammate "what flags do you use?" — the answer belongs in the repository. That's Docker Compose: the entire development environment as one declarative, reviewed, versioned file, and the day [`TICKETHUB.md`](../TICKETHUB.md)'s promise — *"local: Docker Compose on the developer machine; parity with prod via containers"* — comes true. New-laptop onboarding becomes `git clone`, `docker compose up`, done.

## Learning objectives

- Explain what Compose adds over `docker run` — declarative desired state, dependency ordering, one lifecycle — and what it deliberately doesn't (production orchestration)
- Extend the production Dockerfile with a `dev` stage (Xdebug, in-container Composer, UID mapping) without contaminating the production image
- Configure bind mounts and a vendor volume overlay so code is live-editable while dependencies stay container-native
- Wire health-checked startup ordering with `depends_on: service_healthy`, and state precisely what it does and doesn't guarantee
- Run Horizon and the scheduler as separate containers from one image, and explain why that's factor VIII made literal
- Achieve full backing-service parity locally: MySQL, Redis, Mailpit for SES, MinIO for S3 — including the S3 code path through `Storage::`

## 1. What Compose is, and the v2 facts

Compose is a client-side tool that reads a YAML file describing **services** (containers to run, from which image or build, with which mounts, env, and dependencies), **volumes**, and **networks** — then drives the Docker Engine to make reality match the file. It's Lecture 6.1's commands, made declarative and idempotent: `docker compose up` creates what's missing, recreates what changed, leaves the rest running. The mental shift is the same one you'll make again with Terraform (Module 10) and Kubernetes (Module 11): *describe the desired state; let the tool compute the commands.* Compose is the smallest member of that family — single-host, no self-healing, no rolling deploys — which is exactly why it's the right size for development. (Some small teams do run production on Compose; this course doesn't, and Module 9 shows what the orchestrators add that justifies their complexity.)

Three current-era facts, because the internet is full of stale Compose content: the command is **`docker compose`** (a CLI plugin, spec-compliant v2) — the separate `docker-compose` Python binary is legacy; the canonical filename is **`compose.yaml`** (`docker-compose.yml` still works); and the top-level **`version:` key is obsolete** — the spec dropped it, and current Compose warns if it's present. If a tutorial starts with `version: "3.8"`, note its age and read on with care.

## 2. The `dev` build target

The production image is wrong for development in three precise ways: `validate_timestamps=0` would hide your edits (the very setting that's *correct* for immutable images — Lecture 6.2), there's no debugger, and there's no Composer. The fix is not a second Dockerfile — it's a fourth stage appended to the existing one, `FROM app`, so dev is *production plus tooling*, never a parallel universe:

```dockerfile
########################################################################
# Stage 4: dev — local development image (never deployed)
########################################################################
FROM app AS dev

USER root

# Xdebug: a dev-only tool, in a dev-only stage.
RUN pecl install xdebug \
    && docker-php-ext-enable xdebug \
    && rm -rf /tmp/pear

COPY docker/php/xdebug.ini "$PHP_INI_DIR/conf.d/zz-xdebug.ini"

# Dev reads code live from a bind mount: turn timestamp validation back on
# and let Composer run inside the container.
RUN echo "opcache.validate_timestamps = 1" > "$PHP_INI_DIR/conf.d/zzz-opcache-dev.ini"
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

# On Linux, make www-data match the host user so bind-mounted files are
# writable both ways. On macOS/Windows, Docker Desktop maps ownership.
ARG UID=1000
ARG GID=1000
RUN groupmod -o -g "$GID" www-data \
    && usermod -o -u "$UID" www-data \
    && mkdir -p /var/www/.composer \
    && chown -R www-data:www-data /var/www/html /var/www/.composer

USER www-data
```

With `docker/php/xdebug.ini` alongside the other ini files:

```ini
; docker/php/xdebug.ini — dev stage only, never in the production image
xdebug.mode = debug
xdebug.start_with_request = trigger
xdebug.client_host = host.docker.internal
xdebug.client_port = 9003
```

Two things here deserve real understanding. **Xdebug's direction:** your IDE doesn't connect *to* the container — Xdebug connects *out* to your IDE, so it needs a name for "the machine hosting Docker." Docker Desktop provides `host.docker.internal`; on Linux it exists only if you add it (the compose file below does, via `extra_hosts: host-gateway`). `start_with_request = trigger` keeps Xdebug dormant unless a request carries the trigger cookie/param — always-on debugging roughly doubles request time.

**The UID/GID dance is a Linux-only ownership problem worth understanding before it bites.** A bind mount does no translation: files your host user (UID 1000, typically) owns appear in the container owned by UID 1000; files the container's `www-data` (UID 33 in Debian) creates appear on your host owned by UID 33 — suddenly `storage/logs/laravel.log` isn't yours to delete. The dev stage remaps `www-data` to build-arg UID/GID (default 1000) so both sides agree. On macOS and Windows, Docker Desktop's file sharing translates ownership automatically and the args can stay at their defaults. If your Linux UID isn't 1000, set `UID`/`GID` where Compose reads variable interpolations — its `.env` file, which is conveniently the same `.env` Laravel reads.

One structural consequence of appending this stage: the Dockerfile's *last* stage is now `dev`, and a bare `docker build .` builds the last stage by default. From today, production builds must say what they mean: **`docker build --target app`** — which is precisely what CI will do in Module 7, and a habit ("always name your target") worth adopting the same day the footgun appears.

## 3. The services, one decision at a time

**`app`** — builds the `dev` target, tagged `tickethub-api:dev` so other services can reuse the image. Its volumes are the heart of the dev experience:

```yaml
volumes:
  - .:/var/www/html
  - vendor:/var/www/html/vendor
```

The bind mount makes the container run *your working tree* — edit in your IDE, the next request executes the new code, no rebuild (that's what the dev stage's `validate_timestamps=1` re-enabled). The second line is the **vendor volume overlay**, a pattern worth learning as a pattern: a named volume mounted *deeper* than the bind mount shadows that subdirectory, so `/var/www/html` is your host tree *except* `vendor/`, which is container-native. Two reasons. Correctness: `vendor/` must match the runtime that executes it — a `vendor/` built by macOS PHP doesn't belong under Linux PHP (platform-specific packages and compiled-classmap paths differ). Performance: on macOS, bind-mount file sharing has real per-file overhead, and `vendor/` is ~20,000 files the framework touches constantly; moving them into a volume (native filesystem inside the VM) is the single biggest Compose-on-Mac speedup. On first use Docker seeds the volume from the image's `vendor/` — production dependencies, which is why the first-boot ritual in the hands-on includes one `composer install` to add dev packages (Pest lives in `require-dev`, and the image build excluded it on purpose).

`environment: APP_ENV: local` rides alongside for one subtle reason: the entrypoint's config-cache guard reads the *process* environment, and Laravel gives real environment variables precedence over `.env` — so this one variable both skips production-style caching and can never be accidentally overridden by a stale `.env` line. Everything else comes from `.env` via the bind mount, exactly as on the VPS.

**`nginx`** — the stock `nginx:1.26-alpine` image with two read-only bind mounts: the same `docker/nginx/default.conf` the production image bakes in, and `./public` for statics. In dev you *want* these live — edit the nginx conf and `docker compose restart nginx` applies it; Vite writes `public/build` and nginx serves it instantly. Building the Lecture 6.2 nginx image here would freeze both at build time and couple every `up` to the app image's existence; the baked image is a *deploy* artifact (CI builds it in Module 7 with `APP_IMAGE` pinned to the exact sha tag). Same config, two delivery mechanisms, each right for its environment. Port `127.0.0.1:8080:80`, practicing Lecture 6.1's bind-address discipline.

**`mysql`** — `mysql:8.0` (the pinned engine — and the exact image CI's service containers use in Module 7, parity end to end), a named volume for `/var/lib/mysql`, and the initialization env vars from Lecture 6.1. The `command:` flags pin server defaults to `utf8mb4`/`utf8mb4_unicode_ci`, matching Module 3's `CREATE DATABASE` and Laravel's config — MySQL 8.0's built-in default collation differs (`utf8mb4_0900_ai_ci`), and you want databases someone creates by hand inside this container to collate like production, not like the server's whim. The healthcheck is the piece everything else leans on:

```yaml
healthcheck:
  test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
  interval: 5s
  timeout: 3s
  retries: 10
  start_period: 30s
```

MySQL takes 10–30 seconds to initialize on first boot (you watched it in Lecture 6.1); `start_period` gives it that long before failures count against `retries`. `mysqladmin ping` answers "alive" once the server accepts connections — even with wrong credentials, which is fine: "up," not "authenticated," is the question here (Module 7 makes the same point about CI service containers).

**`redis`** — `redis:7-alpine`, healthcheck `redis-cli ping` → `PONG`. No volume: losing local cache/sessions on recreate is harmless, and dev queues are drained continuously by Horizon sitting next door.

**`horizon` and `scheduler`** — Module 5's factor VIII (*scale by process type*), no longer a diagram but literal lines of YAML: the **same image**, different `command`, separate containers with separate logs, restarts, and lifecycles:

```yaml
horizon:
  image: tickethub-api:dev
  command: ["php", "artisan", "horizon"]
```

The `command:` overrides the image's `CMD` (`php-fpm`) while the shared ENTRYPOINT still runs — one setup path for every process type, as designed in Lecture 6.2. Exec-form arrays, for the same signal reasons as ever. Three details on these two services carry real teaching weight:

- **`healthcheck: disable: true`** — an easy-to-miss consequence of "one image, many process types": these containers *inherit* the image's HEALTHCHECK, which probes FPM on port 9000 — and neither runs FPM. Without this line, Compose dutifully reports your perfectly healthy Horizon as `(unhealthy)` forever. Inherited config cuts both ways; audit what your base ships.
- **`stop_grace_period: 150s`** on Horizon — Compose's `TimeoutStopSec`. Module 5's timeout chain (`$timeout` 120 < `retry_after` 180, supervisor budget 150) transfers intact: SIGTERM lands, Horizon stops taking work and drains in-flight jobs (pcntl — the extension the image installed for exactly this), and only a job overrunning its own limits meets SIGKILL. The default 10 seconds would guillotine a 2-minute PDF render on every `down`.
- **`schedule:work`** for the scheduler — the foreground, dev-appropriate sibling of cron's `schedule:run`: one process, ticking every minute, logs in `docker compose logs`. Production wants the run-once-per-minute-exactly-once semantics this doesn't provide across replicas — that's cron on one box today, and a proper CronJob in Module 11; Modules 9/11 own that story.

**`mailpit`** — factor X applied to email. `axllent/mailpit` accepts SMTP on 1025 and shows every message in a web UI on 8025. Laravel points at it with ordinary mail config — `MAIL_MAILER=smtp`, `MAIL_HOST=mailpit`, `MAIL_PORT=1025` — meaning the *real* SMTP code path runs locally (not `MAIL_MAILER=log`'s bypass), and switching to SES in Module 8 is a config change into an already-exercised path. Only the UI port publishes to your host; the app reaches SMTP over the internal network.

**`minio` and `minio-init`** — the payoff of Module 5's `Storage::` discipline. MinIO speaks the S3 API against a local volume; Laravel's stock `s3` disk (`config/filesystems.php`) is already parameterized for it — read it and note the two knobs that make third-party S3 endpoints work:

```php
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
    'report' => false,
],
```

`endpoint` aims the SDK at `http://minio:9000` instead of AWS; `use_path_style_endpoint=true` puts the bucket in the URL path (`minio:9000/tickethub-local/…`) rather than a DNS subdomain (`tickethub-local.minio` — which nothing would resolve). Real S3 uses virtual-host style; MinIO needs path style; one env var separates them. `minio-init` is a **one-shot init service** — the `minio/mc` client container that waits for MinIO to be healthy, creates the bucket idempotently (`mc mb --ignore-existing`), and exits; Compose leaves it exited, and `mc` is exactly the S3 console you'll want for poking at buckets anyway. This "tiny container that prepares a backing service, then exits" pattern recurs for the rest of your career (Kubernetes init containers are its formalization).

## 4. Ordering, DNS, and what `depends_on` really promises

Plain `depends_on: [app]` orders *starts*. The long form gates on state:

```yaml
depends_on:
  mysql:
    condition: service_healthy
```

The app container isn't created until MySQL's healthcheck passes — which kills the classic race where the app boots in two seconds, MySQL initializes for twenty, and the first `migrate` dies on `Connection refused`. (A third condition, `service_completed_successfully`, gates on one-shot services like `minio-init` finishing — useful when something must not start before seeding completes.)

Know the limits, though, because they're not fine print: `service_healthy` is a *startup* gate, not a lifetime guarantee. It says nothing after start — restart MySQL mid-session and the app learns via connection errors, exactly as production apps do when RDS fails over (Module 8). Application-level resilience — connection retry, queue `retry_after`, jobs that tolerate re-runs (Module 5) — is still the real defense; `depends_on` just makes *cold boot* deterministic. Orchestrators go further in the same direction: Kubernetes has no `depends_on` at all and expects apps to converge — another reason not to let local dev teach your app bad manners.

Networking you get for free: Compose creates a project network and connects every service; Docker's embedded DNS (a resolver at `127.0.0.11` inside each container — the DNS chapter of Module 3, now running in your namespace) answers **service names**: `mysql`, `redis`, `app`, `mailpit`, `minio`. That's why `.env` says `DB_HOST=mysql` and the nginx conf says `fastcgi_pass app:9000` with no `--network-alias` flags anywhere. Names in config, addresses resolved at runtime — the same indirection every later platform provides, from ECS service discovery to Kubernetes Services.

## 5. The complete `compose.yaml`

At the repo root, per [`TICKETHUB.md`](../TICKETHUB.md):

```yaml
services:
  app:
    build:
      context: .
      target: dev
      args:
        UID: ${UID:-1000}
        GID: ${GID:-1000}
    image: tickethub-api:dev
    volumes:
      - .:/var/www/html
      - vendor:/var/www/html/vendor
    environment:
      APP_ENV: local
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy

  nginx:
    image: nginx:1.26-alpine
    ports:
      - "127.0.0.1:8080:80"
    volumes:
      - ./docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
      - ./public:/var/www/html/public:ro
    depends_on:
      - app

  horizon:
    image: tickethub-api:dev
    command: ["php", "artisan", "horizon"]
    stop_grace_period: 150s
    healthcheck:
      disable: true
    volumes:
      - .:/var/www/html
      - vendor:/var/www/html/vendor
    environment:
      APP_ENV: local
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy

  scheduler:
    image: tickethub-api:dev
    command: ["php", "artisan", "schedule:work"]
    healthcheck:
      disable: true
    volumes:
      - .:/var/www/html
      - vendor:/var/www/html/vendor
    environment:
      APP_ENV: local
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy

  mysql:
    image: mysql:8.0
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: tickethub
      MYSQL_USER: tickethub
      MYSQL_PASSWORD: secret
    ports:
      - "127.0.0.1:3306:3306"
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 30s

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  mailpit:
    image: axllent/mailpit
    ports:
      - "127.0.0.1:8025:8025"

  minio:
    image: minio/minio
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: tickethub
      MINIO_ROOT_PASSWORD: tickethub-local
    ports:
      - "127.0.0.1:9000:9000"
      - "127.0.0.1:9001:9001"
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:9000/minio/health/live"]
      interval: 5s
      timeout: 3s
      retries: 10

  minio-init:
    image: minio/mc
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        mc alias set local http://minio:9000 tickethub tickethub-local &&
        mc mb --ignore-existing local/tickethub-local &&
        echo "bucket tickethub-local ready"
    restart: "no"

volumes:
  vendor:
  mysql-data:
  minio-data:
```

Hard-coded dev credentials (`secret`, `tickethub-local`) are fine *here and only here*: this file describes throwaway local infrastructure, bound to loopback, holding seed data — committing it is the point. The moment a value would differ per environment or matter if leaked, it's config, and Module 5's rules apply. (MinIO publishes API port 9000 on the host for `aws` CLI experiments and presigned URLs — no clash with FPM's 9000, which never publishes to the host at all; if some other tool on your machine already owns a host port, the override file in section 6 is the fix, not an edit to this shared file.) One naming note: containers get project-prefixed names (`tickethub-api-app-1`) from the project (directory) name; *service* names are what you type and what DNS resolves.

And the matching local `.env` — every line a service name from this file:

```dotenv
APP_NAME=TicketHub
APP_ENV=local
APP_KEY=base64:GENERATED_BY_ARTISAN
APP_DEBUG=true
APP_URL=http://localhost:8080

LOG_CHANNEL=stderr

DB_CONNECTION=mysql
DB_HOST=mysql
DB_PORT=3306
DB_DATABASE=tickethub
DB_USERNAME=tickethub
DB_PASSWORD=secret

SESSION_DRIVER=redis
CACHE_STORE=redis
QUEUE_CONNECTION=redis
REDIS_CLIENT=phpredis
REDIS_HOST=redis
REDIS_PORT=6379

MAIL_MAILER=smtp
MAIL_HOST=mailpit
MAIL_PORT=1025
MAIL_FROM_ADDRESS=tickets@tickethub.example

FILESYSTEM_DISK=s3
AWS_ACCESS_KEY_ID=tickethub
AWS_SECRET_ACCESS_KEY=tickethub-local
AWS_DEFAULT_REGION=ap-southeast-1
AWS_BUCKET=tickethub-local
AWS_ENDPOINT=http://minio:9000
AWS_USE_PATH_STYLE_ENDPOINT=true
```

## Hands-on with TicketHub

Two one-time installs belong in this PR, both run *inside* the container the moment it exists — but first, bring the stack up:

```
$ docker compose up -d --build
[+] Building 8.4s (30/30) FINISHED
 => [app dev 1/6] FROM docker.io/library/php:8.4-fpm …
[+] Running 12/12
 ✔ Network tickethub-api_default         Created
 ✔ Volume "tickethub-api_mysql-data"     Created
 ✔ Volume "tickethub-api_vendor"         Created
 ✔ Volume "tickethub-api_minio-data"     Created
 ✔ Container tickethub-api-mysql-1       Healthy
 ✔ Container tickethub-api-redis-1       Healthy
 ✔ Container tickethub-api-minio-1       Healthy
 ✔ Container tickethub-api-minio-init-1  Exited
 ✔ Container tickethub-api-mailpit-1     Started
 ✔ Container tickethub-api-app-1         Started
 ✔ Container tickethub-api-nginx-1       Started
 ✔ Container tickethub-api-scheduler-1   Started
```

Read the ordering in the output: databases reach `Healthy` before the app *starts*; `minio-init` ran and `Exited` after creating the bucket (its logs confirm: `docker compose logs minio-init` → `Bucket created successfully`). Now the first-boot ritual — dev dependencies into the vendor volume (seeded from the image with `--no-dev`, remember), Horizon into the project (promised since Module 5; its `pcntl` requirement is why the image ships that extension), and the S3 flysystem adapter (the `s3` driver's one extra package):

```
$ docker compose exec app composer install
Installing dependencies from lock file (including require-dev)
Package operations: 33 installs, 0 updates, 0 removals
  …
$ docker compose exec app composer require laravel/horizon league/flysystem-aws-s3-v3
$ docker compose exec app php artisan horizon:install
$ docker compose up -d horizon
```

Notice `composer require` ran with no `--ignore-platform-req` flags: *this* PHP is the real 8.4 with the real extensions — platform checks pass on their merits, unlike Lecture 6.2's build sandbox. Configure Horizon's supervisors for the three queues from [`TICKETHUB.md`](../TICKETHUB.md) (`default`, `pdfs`, `mail`) in `config/horizon.php` — supervision policy as reviewable code now, replacing the VPS's systemd worker units; Horizon's own tuning gets proper treatment when queues are under production load. Then migrate, seed, and test — the exact commands Module 7 will run in CI, which is the parity argument in executable form:

```
$ docker compose exec app php artisan migrate:fresh --seed
  Dropping all tables ............................ 91ms DONE
   INFO  Preparing database.
  …
$ docker compose exec app php artisan test
   PASS  Tests\Feature\OrderTest
  ✓ a reservation expires after fifteen minutes
  Tests:    42 passed (118 assertions)
```

Now walk the parity you just bought. **Queues and mail:** dispatch a real order-confirmation flow from tinker and watch it traverse Redis → Horizon → SMTP → Mailpit:

```
$ docker compose exec app php artisan tinker --execute="Mail::to('customer@example.test')->queue(new App\Mail\OrderConfirmed(App\Models\Order::first()));"
$ docker compose logs --tail=2 horizon
horizon-1  | 2026-08-09 15:12:41 App\Mail\OrderConfirmed ....... RUNNING
horizon-1  | 2026-08-09 15:12:42 App\Mail\OrderConfirmed .... 380ms DONE
```

Open `http://localhost:8025` — the rendered email is sitting in Mailpit. **Files, through the genuine S3 code path** — the `Storage::put()` in `GenerateTicketPdf` (Module 5) now performs real multipart S3 uploads, locally:

```
$ docker compose exec app php artisan tinker --execute="Storage::put('tickets/parity-proof.pdf', 'hello'); var_dump(Storage::exists('tickets/parity-proof.pdf'));"
bool(true)
$ docker compose run --rm minio-init mc ls -r local/tickethub-local
[2026-08-09 15:14:02 UTC]     5B tickets/parity-proof.pdf
```

When Module 8 supplies real S3, this entire surface changes by *removing* `AWS_ENDPOINT` and rotating credentials. That's what "parity drives us to containers" meant.

**The daily loop**, which is now the whole job: `docker compose up -d` in the morning (add `--build` after Dockerfile or dependency changes); `docker compose logs -f app horizon` while working (aggregated, service-labeled streams — factor XI paying rent); `docker compose exec app php artisan …` for every artisan need; `docker compose ps` when something's off; and at day's end, nothing — or `docker compose down` (containers and network removed, **volumes kept**: your database survives). The flag to respect is **`down -v`**: it deletes the named volumes — database, MinIO data, vendor — which is sometimes exactly what you want (pristine rebuild, or re-seeding the vendor volume after image changes, since **volumes seed once and never update from the image again**) and otherwise a self-inflicted data wipe. Muscle memory: `down` is routine; `down -v` is a decision.

**`compose.override.yaml`** handles the machine-specific leftovers. Compose automatically merges it over `compose.yaml` if present; it's gitignored, so personal quirks never pollute the shared file. The canonical example — some other project already owns a host port on your machine:

```yaml
# compose.override.yaml — personal, machine-specific tweaks (gitignored)
services:
  nginx:
    ports: !override
      - "127.0.0.1:8081:80"
```

The `!override` tag matters: merge semantics *append* list entries by default, so without it you'd be adding a second port mapping (including the conflicting one) rather than replacing. Check your merged result anytime with `docker compose config` — it prints the final, fully-resolved file, and reading it is how you debug any "why is Compose doing that" mystery.

## Real-world best practices

- **The compose file is part of the codebase — review it like code.** A new service, a changed healthcheck, a port exposure: all change every teammate's machine *and* document the app's real dependencies (this file is Module 5's factor IV list, executable). Teams that treat it as one dev's scratchpad get fifteen divergent stacks and "works on my Compose."
- **Mirror pinned production versions exactly** — `mysql:8.0`, `redis:7-alpine` here; the same pins in CI services (Module 7) and in RDS/ElastiCache (Module 8). Engine upgrades happen as one PR that moves every environment through review, never by a local image drifting ahead. Parity is a workflow, not a wish.
- **Keep the dev/prod delta small and legible.** Everything dev-specific lives in exactly three places you can point to: the `dev` stage, the compose file, `.env`. If you find yourself adding `if (app()->environment('local'))` branches in application code to survive the local stack, the stack is wrong, not the code.
- **Let the exit gates teach you.** `service_healthy` for cold-boot ordering, `service_completed_successfully` for init work — but never let `depends_on` substitute for app-level retry, because your next platform won't have it. If your app only boots when ordering is perfect, you've built local-only reliability.
- **Give every one-shot job the `minio-init` shape:** idempotent (`--ignore-existing`), loud on success, `restart: "no"`. Seeding, bucket creation, license fetching — the pattern generalizes, and idempotency is what lets you run `up` twice without fear.
- **Use Laravel Sail for what it is.** Sail is this lecture, prebuilt: a published `compose.yaml` and dev Dockerfile maintained by the Laravel team — a completely respectable choice, especially solo. This course built the file by hand because you'll spend Modules 9–11 maintaining exactly these decisions on real platforms, where nobody publishes the file for you. Use Sail freely; the difference now is you can read what it generated, eject when it constrains you, and debug it when it breaks.

## Common pitfalls

1. **`DB_HOST=127.0.0.1` inside a container.** The classic — Lecture 6.1 warned that each net namespace has its own localhost, and this is where everyone meets it: the app container dials *itself* and gets `Connection refused` while MySQL sits healthy one DNS name away. Correct approach: service names (`mysql`, `redis`, `minio`) between containers; `127.0.0.1` only from host tools through published ports. (And enjoy the irony: Module 7's CI inverts it again — steps run *on* the runner VM, so there it's `127.0.0.1` after all. Know which side of the namespace you're on.)
2. **A stale vendor volume after image or lockfile changes.** Named volumes seed from the image once, then never again — so a rebuilt image's fresh `vendor/` is silently shadowed by the old volume, and you chase phantom "class not found" errors for code you *know* is in the lockfile. Correct approach: after dependency changes, `composer install` *inside* the container (updates the volume in place); for a truly weird state, `docker compose down -v` and re-seed. Diagnose with `composer show` inside vs. `composer.lock`.
3. **Editing `compose.yaml` for personal, machine-local needs.** The port remap or extra tool service works — then gets committed, and now the *team's* stack carries one person's laptop quirks (or worse, their conflict with *your* laptop). Correct approach: `compose.override.yaml`, gitignored, with `!override` where replacement (not append) is intended; verify with `docker compose config`.
4. **Running one-off artisan/composer commands on the host out of habit.** Host PHP may differ in version, extensions, and reachable hostnames (`mysql` resolves only inside the network) — so results differ from what the app experiences, subtly and sometimes silently. Correct approach: `docker compose exec app …` is the only PHP that counts locally; make it a shell alias on day one.
5. **Treating `(unhealthy)` or a hanging `down` as noise.** Both have precise causes you now know: an inherited HEALTHCHECK on a non-FPM container (disable it), and a `stop_grace_period`/signal-path issue on a worker that won't drain (fix the chain, don't `kill -9` — Module 2's rule survives containerization). Correct approach: every status Compose shows is a claim about your config; chase the ones that surprise you, because the same surprise costs more in Module 9.

## Exercises

1. Trace startup ordering: `docker compose down`, then `docker compose up -d` and immediately `docker compose ps` in a second terminal, repeatedly. Record the order services reach `Healthy`/`Started`/`Exited`, and draw the dependency graph the conditions create. Which services could start in parallel, and why?
2. Break DNS on purpose: set `DB_HOST=127.0.0.1` in `.env`, run `docker compose exec app php artisan migrate:status`, and capture the exact error. Then run `docker compose exec app getent hosts mysql` and explain what answered, with what address, referencing Module 3's DNS lecture. Restore the service name.
3. Prove the Xdebug path: set a breakpoint on the `/up` route in your IDE, enable it to listen, and trigger a request with the Xdebug trigger param through `localhost:8080`. Explain — direction of connection included — how the packet got from a container to your IDE, on your OS specifically (Linux readers: what did `host-gateway` become?).
4. Test the data lifecycle claims: `migrate:fresh --seed`, note an order's ID; `docker compose down` then `up -d` — is it there? `docker compose down -v` then `up -d` — now what exists, in *each* stateful service (MySQL, MinIO, vendor volume)? Reconcile each answer with section 3's decisions about which services got volumes and why Redis deliberately didn't.
5. **Stretch:** add a `node` service for Vite's dev server (`node:22-alpine`, `command: ["npm", "run", "dev"]`, the same bind mount + a `node_modules` volume overlay — justify that overlay yourself). Wire Vite's HMR port through to the host, get hot module replacement working end to end, and document the two `vite.config.js` settings the containerized setup forced you to learn about (`server.host` and HMR's client-facing host — why does each exist?).

## What's next

TicketHub now builds an immutable production artifact and develops against a full-parity local stack — but the artifact still lives only on your machine, where no deployment can reach it. The last lecture of this module gives images a home and a lifecycle: ECR as the registry, a tagging strategy where the Git SHA is the only truth and `latest` is banned, lifecycle policies that keep storage costs flat, and vulnerability scanning — including the uncomfortable fact that a perfect Dockerfile inherits new CVEs while you sleep. Continue to [Lecture 6.4 — Registries & the Image Lifecycle](04-registries-image-lifecycle.md).
