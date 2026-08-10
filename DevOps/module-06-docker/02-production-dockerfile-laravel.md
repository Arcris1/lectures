# Lecture 6.2 — A Production-Grade Dockerfile for Laravel

> **Module 6 — Docker & Containerization** · Lecture 2 of 4 · Estimated time: ~90 min

This is the lecture where TicketHub gets its build artifact. Module 5's factor V demanded a strict build → release → run separation and admitted the VPS has none; today you write the **build**: a `Dockerfile` that turns any Git commit into an immutable, non-root, self-monitoring image containing everything Module 3 installed by hand — with zero manual steps. It's the most-leveraged file in the rest of the course: Module 7's CI builds it on every PR, Module 9 deploys it to ECS, Module 11 schedules it on Kubernetes. Every line earns its place today, because you'll live with every line for six modules.

## Learning objectives

- Use each core Dockerfile instruction with precise semantics — including ENV vs ARG, EXPOSE as documentation, and exec-form vs shell-form signal delivery
- Exploit layer caching deliberately by ordering instructions from least- to most-frequently changing
- Write a `.dockerignore` that protects both build performance and secrets, and explain why it's non-negotiable
- Assemble a multi-stage build — Composer stage, asset stage, runtime stage — and justify every boundary
- Produce a hardened PHP-FPM image: pinned extensions, production opcache, non-root user, working FPM healthcheck, and an entrypoint that caches config at runtime, not build time
- Build the companion nginx image and run the two-container pair by hand, end to end

## 1. The build contract: context, instructions, layers

`docker build` takes two inputs: a `Dockerfile` (the recipe) and a **build context** (the files the recipe may use — everything under the directory you pass, almost always `.`). The client tars the context to the builder; `COPY` can only reach into that tarball. Each instruction produces a layer or a piece of image config, in order. The instructions that matter, with the semantics people get wrong:

- **`FROM image[:tag] [AS name]`** — the starting layer stack. Everything you don't write, you inherit from here: users, env vars, default command, *and vulnerabilities* (Lecture 6.4 returns to that).
- **`RUN cmd`** — executes during *build*, snapshots the filesystem delta as a layer. A `RUN rm` in a later instruction hides files but shrinks nothing — the bytes live on in the earlier layer (Lecture 6.1's whiteouts). Hence the rule below: create and clean up *in the same `RUN`*.
- **`COPY src dst`** — copies from build context into the image. **`ADD`** looks similar and you should essentially never use it: it also auto-extracts tar archives and fetches URLs — surprise behaviors with an incident history. `COPY` does one thing; prefer it always.
- **`WORKDIR /path`** — sets (and creates) the working directory for subsequent instructions and the running container.
- **`ENV`** vs **`ARG`** — the one everyone confuses. `ARG` is a *build-time* variable, gone from the final container; `ENV` is baked into image config and present at runtime in every container. So: build knobs are ARGs, runtime facts are ENVs — and **secrets are neither**, because both are recoverable from the image (`docker history`, `docker inspect`). Runtime secrets arrive as runtime environment, exactly as Module 5 configured.
- **`EXPOSE 9000`** — pure documentation. It publishes nothing (only `-p` does); it records intent for humans and tooling reading `docker inspect`.
- **`USER`** — which user subsequent instructions and the container process run as. Defaults to root; section 5 fixes that.
- **`HEALTHCHECK`** — a command Docker runs in the container on an interval, flipping status between `healthy`/`unhealthy`. Compose consumes it (`depends_on: condition: service_healthy`, next lecture); Kubernetes ignores it in favor of its own probes (Module 11).
- **`ENTRYPOINT` and `CMD`** — together, the container's argv: ENTRYPOINT the fixed prefix, CMD the default (overridable) suffix. With `ENTRYPOINT ["entrypoint.sh"]` and `CMD ["php-fpm"]`, plain `docker run image` executes `entrypoint.sh php-fpm`; `docker run image php artisan horizon` executes `entrypoint.sh php artisan horizon` — one image, many process types, one shared setup path. TicketHub's pattern from here to Kubernetes.

And the detail separating production Dockerfiles from tutorials: **exec form vs shell form.** `CMD ["php-fpm"]` (exec form) makes `php-fpm` PID 1. `CMD php-fpm` (shell form) makes `/bin/sh -c "php-fpm"` PID 1 — and `sh` does **not** forward signals to its children. `docker stop` then signals a shell that ignores it, waits out the 10-second grace, and SIGKILLs everything: Module 2's guillotine, Module 5's broken disposability, every deploy a hard kill. Rule: **exec form (JSON array), always.** The hands-on proves it with a stopwatch.

## 2. Layer caching: the ordering rule

The builder caches every layer. On rebuild, an instruction reuses its cached layer if the instruction is unchanged *and* every prior layer hit — for `COPY`, "unchanged" means the copied files' checksums. **The first miss invalidates everything after it.** That sentence dictates Dockerfile structure: order instructions from least- to most-frequently changing, so a routine source edit misses as late as possible.

For Laravel, the expensive step is `composer install` and its inputs are just two files. So: copy `composer.json` + `composer.lock` alone, install, *then* copy the source. Edit a controller and rebuild — dependencies come from cache; only the source copy and cheap steps re-run:

```
$ docker build -t tickethub-api:dev .
…
#17 [vendor 3/6] COPY composer.json composer.lock ./
#17 CACHED
#19 [vendor 4/6] RUN composer install --no-dev --no-scripts --no-autoloader …
#19 CACHED
#21 [vendor 5/6] COPY . .
#22 [vendor 6/6] RUN composer dump-autoload --optimize --classmap-authoritative …
#23 [app  2/12] RUN apt-get update && apt-get install -y --no-install-recommends …
#23 CACHED
```

A 2-minute build becomes ~10 seconds. The same rule shapes the runtime stage below (system packages → ini files → vendor → source, in that order) and pays again in Module 7, where CI build minutes are money.

## 3. `.dockerignore` first — performance and secrets

Before writing the Dockerfile, control what the build can even see. Without a `.dockerignore`, `COPY . .` ships your entire working tree: `.git` history, `node_modules`, local `vendor`, logs — hundreds of megabytes per build, cache misses from files that should never matter, and, far worse, **`.env` copied into an image layer**. A layer is a tarball anyone with pull access can open; push it to a registry and your `APP_KEY` and database password are published. This file is a security control, not an optimization. TicketHub's, at the repo root, complete:

```gitignore
# --- VCS & project meta: context bloat, cache poison ---
.git
.github
.gitattributes
.gitignore
README.md

# --- Secrets: must never enter an image layer ---
.env
.env.*

# --- Produced by build stages, never copied from the host ---
vendor/
node_modules/
public/build/
public/hot
public/storage

# --- Runtime state, not build input (keeps the empty skeleton dirs) ---
storage/app/private/*
storage/app/public/*
storage/framework/cache/*
storage/framework/sessions/*
storage/framework/testing/*
storage/framework/views/*
storage/logs/*

# --- Tests and tooling the runtime never executes ---
tests/
phpunit.xml
.phpunit.cache
.phpunit.result.cache

# --- Docker's own files: editing them must not invalidate COPY . . ---
Dockerfile
.dockerignore
compose.yaml
compose.override.yaml

# --- Editor and OS noise ---
.idea
.vscode
.DS_Store
```

Notes: `vendor/` and `node_modules/` are excluded because the *build stages* produce them from lockfiles — copying a macOS-flavored `vendor/` into a Linux image is a classic "works locally" bug. The `storage/**/*` patterns exclude *contents* while keeping the empty skeleton the image needs. Excluding `.env` is defense-in-depth, not the whole defense — nothing environment-specific belongs in the image at all, which section 6 enforces. Result: the context drops to kilobytes, visible in the build output as `transferring context: 28.79kB`.

## 4. Choosing the base image, honestly

`FROM` is the biggest single decision. The official `php` images come in two families: **Debian** (`php:8.4-fpm`, currently "bookworm") and **Alpine** (`php:8.4-fpm-alpine`). Alpine is dramatically smaller (~80 MB vs ~500 MB of base userland): faster pulls, smaller attack surface. The cost: Alpine uses **musl** libc instead of glibc, and the places PHP notices are exactly the annoying ones — `intl`/ICU behavior differences, occasional musl-only bugs in C extensions, DNS edge cases, native dependencies that assume glibc. Debian is also what your VPS's `ondrej/php` packages build against — closest parity with everything since Module 3.

The course chooses **`php:8.4-fpm` (Debian bookworm)**: compatibility and parity over megabytes that, as Lecture 6.4 shows, mostly deduplicate in the registry anyway. If you know your dependency surface and will own the musl caveats, Alpine is a legitimate, common choice — a trade-off, not a commandment. What's *not* legitimate: `FROM ubuntu` + apt-installing PHP by hand (re-implementing the official images, badly), or `FROM php:latest` (an unpinned major-version time bomb).

One inheritance worth knowing — the official FPM image already ships container-correct plumbing. Look inside:

```
$ docker run --rm php:8.4-fpm cat /usr/local/etc/php-fpm.d/docker.conf
[global]
error_log = /proc/self/fd/2
…
[www]
access.log = /proc/self/fd/2

clear_env = no

catch_workers_output = yes
decorate_workers_output = no

; default listen address for easy override in later php-fpm.d/*.conf files
listen = 9000
```

Read it with Module 5 eyes: logs to stderr (factor XI — the `catch_workers_output` you configured by hand on the VPS), `clear_env = no` so workers see the container's environment (factor III — without it, `DB_HOST` would never reach your code), and FPM on **TCP 9000** instead of a unix socket — the why comes in section 7. The image also sets `WORKDIR /var/www/html`, `EXPOSE 9000`, `CMD ["php-fpm"]`, and — a lovely detail — `STOPSIGNAL SIGQUIT`: FPM's *graceful* stop (finish in-flight requests, then exit). `docker stop` on this image drops zero requests, provided nothing breaks the signal path (section 6).

## 5. The multi-stage build, stage by stage

A production image must contain the app plus its runtime — and *nothing else*. But producing the app needs Composer, Node, npm caches: build tooling with no business existing in production (Module 5's point about the VPS, again: build tooling on prod is attack surface). **Multi-stage builds** resolve the tension: several `FROM` stages in one Dockerfile, later stages `COPY --from=` earlier ones, and only the final stage ships.

**Stage `vendor`** runs Composer in Composer's own image:

```dockerfile
FROM composer:2 AS vendor

WORKDIR /app

COPY composer.json composer.lock ./

RUN composer install \
      --no-dev \
      --no-scripts \
      --no-autoloader \
      --prefer-dist \
      --no-interaction \
      --no-progress \
      --ignore-platform-req=ext-gd \
      --ignore-platform-req=ext-intl \
      --ignore-platform-req=ext-pcntl

COPY . .

RUN composer dump-autoload \
      --optimize \
      --classmap-authoritative \
      --no-dev \
      --no-scripts
```

Two flag clusters need real explanation. **`--no-scripts` / `--no-autoloader` on install:** at that point only the two manifests exist — there *is no `artisan`* — yet Laravel's composer scripts call `@php artisan package:discover`. Skipping both makes manifests-first caching possible; after `COPY . .`, `dump-autoload --optimize --classmap-authoritative` builds the production autoloader — a complete classmap with `file_exists()` fallbacks disabled, correct precisely because the image is immutable: no class can appear that the map doesn't know. **The sandbox is not your runtime:** the `composer:2` image currently runs PHP 8.5 and lacks `gd`/`intl`/`pcntl` — hence the `--ignore-platform-req` flags, hence `--no-scripts` on the dump too (nothing artisan-flavored runs here; Laravel rebuilds its package manifest on first real boot), and hence the payoff of Module 5's `config.platform.php = 8.4.0`, which pins dependency *resolution* to production's PHP no matter what builds it. The requirements still get enforced where they're true: the runtime stage really has the extensions, and CI (Module 7) tests against them.

**Stage `assets`** (printed in full in section 8) does the same for the front end on `node:22-alpine`: manifests first, `npm ci`, then `npm run build` — and the whole Node toolchain evaporates after copy-out. `npm ci`, not `npm install`: it installs exactly the lockfile and fails loudly on drift — the npm spelling of Module 5's "install, never update, outside a PR."

**Stage `app`** is the runtime. First, extensions — Module 3's list (`pdo_mysql`, `bcmath`, `intl`, `gd`, `zip`, `pcntl` for Horizon's signal handling, plus PECL `redis`) — compiled in **one `RUN`** with `--no-install-recommends` and the apt cache removed *in the same instruction* (section 1: a later `rm` shrinks nothing). One deliberate omission: no `opcache` in the list — the 8.4 images ship it compiled and enabled (`php -v` says so); what's missing is *production configuration*, which is our job:

```dockerfile
RUN mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY docker/php/app.ini      "$PHP_INI_DIR/conf.d/zz-app.ini"
COPY docker/php/opcache.ini  "$PHP_INI_DIR/conf.d/zz-opcache.ini"
COPY docker/php/pool.conf    /usr/local/etc/php-fpm.d/zzz-tickethub.conf
```

The image ships *no* active `php.ini` — only the two templates — so step one activates `php.ini-production` (`display_errors=Off`, `expose_php=Off`: Module 3's hygiene, upstream-maintained). Then TicketHub's overrides, now **files in the repo** instead of hand-edits on a server — Module 3's "this config becomes code under `docker/`" promise, kept. `docker/php/app.ini` is the familiar list (`memory_limit=256M`, upload limits, realpath cache). `docker/php/opcache.ini` is the payoff moment:

```ini
; docker/php/opcache.ini — production opcache, Module 3's settings.
; validate_timestamps=0 is safe here forever: the code in this image
; can never change, so there is nothing to re-validate.

opcache.enable = 1
opcache.memory_consumption = 192
opcache.interned_strings_buffer = 16
opcache.max_accelerated_files = 20000
opcache.validate_timestamps = 0
```

On the VPS, `validate_timestamps=0` came with a ritual — forget the FPM reload and you deploy ghosts. In an immutable image the failure mode is *structurally gone*: code changes mean a new image means a new FPM. The setting Module 3 taught you to fear is now simply, permanently correct. `docker/php/pool.conf` (installed as `zzz-tickethub.conf` — FPM loads pool files alphabetically, and it must land after the image's `docker.conf`) sets modest worker counts (laptop-sized; Module 3's `pm.max_children` arithmetic returns against real container memory limits in Modules 9 and 11) plus one new line, `ping.path = /ping`: FPM's built-in liveness endpoint, for the healthcheck below.

Now the app itself, cache-ordered, and the ownership decision:

```dockerfile
WORKDIR /var/www/html

COPY --chown=www-data:www-data --from=vendor /app/vendor ./vendor
COPY --chown=www-data:www-data . .
COPY --chown=www-data:www-data --from=assets /app/public/build ./public/build

USER www-data
```

**`USER www-data` makes this a non-root image.** By default every container process runs as root — and per Lecture 6.1, user namespaces aren't remapping anything by default, so container-root is kernel-root with blinkers on. An attacker exploiting a PHP RCE in a root container starts with UID 0; here they start as `www-data` — Module 2's blast-radius logic — and increasingly it's not optional: hardened Kubernetes clusters (Module 11) enforce `runAsNonRoot` and refuse root images. `COPY --chown` exists because plain `COPY` creates root-owned files `www-data` couldn't write; chowning *in the copy* avoids the doubled layer a separate `RUN chown -R` would re-record. Honest nuance: chowning all the source to `www-data` is the simple, common approach; the stricter posture keeps code root-owned (the runtime user can't modify the app) and grants `www-data` only `storage/` and `bootstrap/cache/`. We take the simple road today and note the hardening in best practices.

Which raises the right question: **how does an immutable image handle `storage/`, which Laravel writes to?** The image carries only the empty skeleton; the *contents* are runtime state. Locally the writable layer absorbs them (disposable, fine — real state left `storage/` in Module 5: sessions to Redis, files to `Storage::`/S3); in later deployments a volume mounts over it. Since volumes mount empty and `.dockerignore` ships no contents, something must guarantee the skeleton at start — the entrypoint's first job, next section.

Finally the healthcheck. FPM speaks FastCGI, not HTTP — `curl` can't ask it anything — so `cgi-fcgi` (package `libfcgi-bin`, in the apt list for exactly this) performs a real FastCGI request to the pool's `/ping` endpoint, which answers `pong` from the FPM master:

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD SCRIPT_NAME=/ping SCRIPT_FILENAME=/ping REQUEST_METHOD=GET \
        cgi-fcgi -bind -connect 127.0.0.1:9000 | grep -q pong || exit 1
```

This checks *the right thing*: not "is a process alive" but "is FPM answering FastCGI on 9000" — dead master, wedged listener, pool too saturated to ping all show up. Compose gates startup ordering on it next lecture; Kubernetes ignores it and uses probes (Module 11) — both by design.

## 6. The entrypoint: runtime work at runtime

`docker/entrypoint.sh`, complete:

```sh
#!/bin/sh
# docker/entrypoint.sh — runs as PID 1 before handing off to the real
# process. Keep it fast and boring: every container start pays this cost.
set -e

# Volumes mount empty and the writable layer starts fresh; recreate the
# directory skeleton Laravel expects before anything writes to it.
mkdir -p \
    storage/app/public \
    storage/framework/cache/data \
    storage/framework/sessions \
    storage/framework/views \
    storage/logs

# public/storage -> storage/app/public, once.
[ -L public/storage ] || php artisan storage:link

# Laravel's caches are RUNTIME artifacts: they embed this environment's
# config, which the image must not contain. Cache here, never at build.
if [ "${APP_ENV:-production}" != "local" ]; then
    php artisan config:cache
    php artisan route:cache
    php artisan view:cache
fi

# Replace this shell with the real process (php-fpm, horizon, ...) so it
# becomes PID 1 and receives signals directly.
exec "$@"
```

Three decisions here define how TicketHub deploys forever:

**Config caching happens at container start, not image build.** The temptation is obvious — `RUN php artisan config:cache`, "optimizing" the image. It's a trap with two jaws: `config:cache` snapshots *environment values into a PHP file* (Lecture 5.2), and at build time the environment is empty — or, catastrophically worse, a baked-in `.env`, giving one image one environment's config and secrets everywhere it goes, un-overridable, because Laravel ignores the environment entirely once a config cache exists. The correct model: **the image is environment-free; each container captures *its* environment into a cache at startup.** Same artifact for staging and production, differing only in injected env — factor V, exactly. (`route:cache`/`view:cache` are env-independent and could bake at build; keeping the trio together is simpler and costs milliseconds per start. `route:cache` requires controller-based routes — TicketHub's API has no closures.)

**`exec "$@"` is one line doing load-bearing work.** Without `exec`, the shell stays PID 1 with `php-fpm` as its child — and section 1 told you what a shell PID 1 does with SIGQUIT: nothing. Every `docker stop` would time out into SIGKILL, dropping mid-checkout requests. `exec` *replaces* the shell with the real process: `php-fpm` becomes PID 1, receives `STOPSIGNAL` directly, and shuts down gracefully. Entrypoint scripts without `exec` are the single most common self-inflicted signal bug in containerized PHP.

**Migrations are deliberately absent.** `php artisan migrate --force` in the entrypoint feels convenient and is wrong three ways. Concurrency: two replicas starting simultaneously (Module 9) means two migrators racing. Coupling: a bad migration becomes a crash-looping *app* — every restart re-fails it, turning "release blocked" into "service down, restarting forever." Semantics: Module 5 named migrations a **release-phase** step — run once per release, by the pipeline, between "new image exists" and "new containers take traffic" — not a start-phase step run N times per scale-up. Module 9 gives them that formal home; until then you run them explicitly, as on the VPS.

## 7. The nginx side: two images, one commit

On the VPS, nginx and FPM shared a machine and a unix socket. In containers they're separate processes in separate mount and network namespaces — a socket *file* has no sane place to live — so the pair talks **TCP**: `fastcgi_pass app:9000`, `app` being a DNS name for the app container (Docker's embedded DNS, formalized by Compose next lecture). Here is Module 3's server block with the environment differences made explicit — `docker/nginx/default.conf`:

```nginx
# docker/nginx/default.conf — Module 3's server block, adapted for containers.

server {
    # Plain HTTP. TLS terminates in front of the container:
    # nowhere (local dev), later the ALB (Module 8).
    listen 80;
    server_name _;

    root /var/www/html/public;
    index index.php;

    # The nginx image symlinks these to the container's stdout/stderr.
    access_log /var/log/nginx/access.log;
    error_log  /var/log/nginx/error.log;

    client_max_body_size 10m;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    gzip on;
    gzip_types application/json application/vnd.api+json text/plain text/css application/javascript;
    gzip_min_length 1024;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        include fastcgi_params;
        # TCP to the app container's FPM — no shared unix socket between
        # containers. "app" resolves via Docker's internal DNS.
        fastcgi_pass app:9000;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        fastcgi_hide_header X-Powered-By;
    }

    location ~ /\.(?!well-known) {
        deny all;
    }
}
```

What changed and why: TLS is gone — certificates and the 301 redirect belong to whatever terminates TLS *in front of* the containers (nothing locally; the ALB from Module 8 onward), so the container speaks plain HTTP on 80 and HSTS moves out with the certs. `server_name _`, because containers are reached by service name or load balancer, not Host-header vhosting. Logs go to the container streams (the nginx image pre-links the log paths — factor XI again). Everything else — front controller `try_files`, `$realpath_root`, the dotfile deny, body-size and gzip settings — survives verbatim from Module 3.

The subtle requirement: nginx checks `try_files $uri` against **its own** filesystem and computes `SCRIPT_FILENAME` from **its own** paths, while FPM executes that path on **the app container's** filesystem. So nginx needs `public/` (to serve statics itself — its whole reason for existing, per Module 3), the app needs everything, and **the paths must agree** (`/var/www/html` in both). Hence a second, tiny image that copies `public/` *out of the app image*, so both tiers always ship the same commit — `docker/nginx/Dockerfile`:

```dockerfile
# docker/nginx/Dockerfile — TicketHub's web tier.
# Build context: docker/nginx/  ->  docker build -t tickethub-nginx:dev docker/nginx

# Which app image to take static files from. CI overrides this with the
# exact sha- tag it just built, so both images always ship the same commit.
ARG APP_IMAGE=tickethub-api:dev

FROM ${APP_IMAGE} AS app

FROM nginx:1.26-alpine

COPY default.conf /etc/nginx/conf.d/default.conf

# public/ from the app image: index.php, built assets, favicon — so nginx
# can serve static files itself and paths match the app container exactly.
COPY --from=app /var/www/html/public /var/www/html/public
```

(Alpine without the section-4 hand-wringing: nginx has no PHP-extension surface — exactly the "know your dependency surface" case where Alpine's 77 MB wins outright.) This **two-image pattern** — app container + web container, deployed as a unit — is not a local-dev artifact: it's the shape TicketHub keeps as an ECS task (Module 9) and a Kubernetes pod (Module 11). You're building the production topology on your laptop.

## 8. The complete Dockerfile

The repo-root `Dockerfile`, assembled and annotated:

```dockerfile
# syntax=docker/dockerfile:1

########################################################################
# Stage 1: vendor — resolve PHP dependencies with Composer
########################################################################
FROM composer:2 AS vendor

WORKDIR /app

# Manifests first: this layer only rebuilds when dependencies change.
COPY composer.json composer.lock ./

RUN composer install \
      --no-dev \
      --no-scripts \
      --no-autoloader \
      --prefer-dist \
      --no-interaction \
      --no-progress \
      --ignore-platform-req=ext-gd \
      --ignore-platform-req=ext-intl \
      --ignore-platform-req=ext-pcntl

# Now the source, and an optimized autoloader that can see app/ classes.
COPY . .

RUN composer dump-autoload \
      --optimize \
      --classmap-authoritative \
      --no-dev \
      --no-scripts

########################################################################
# Stage 2: assets — build front-end assets with Vite
########################################################################
FROM node:22-alpine AS assets

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY vite.config.js ./
COPY resources/ resources/
RUN npm run build

########################################################################
# Stage 3: app — the production PHP-FPM runtime
########################################################################
FROM php:8.4-fpm AS app

# System libraries + PHP extensions (Module 3's list), one layer.
# --no-install-recommends and the same-RUN cleanup keep the layer lean;
# opcache is already compiled and enabled in the 8.4 images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libfcgi-bin \
        libfreetype-dev \
        libicu-dev \
        libjpeg62-turbo-dev \
        libpng-dev \
        libzip-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" \
        bcmath \
        gd \
        intl \
        pcntl \
        pdo_mysql \
        zip \
    && pecl install redis \
    && docker-php-ext-enable redis \
    && rm -rf /var/lib/apt/lists/* /tmp/pear

# Production php.ini as the base, then TicketHub's overrides (in-repo
# config, Module 3's files turned into code).
RUN mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY docker/php/app.ini      "$PHP_INI_DIR/conf.d/zz-app.ini"
COPY docker/php/opcache.ini  "$PHP_INI_DIR/conf.d/zz-opcache.ini"
COPY docker/php/pool.conf    /usr/local/etc/php-fpm.d/zzz-tickethub.conf

WORKDIR /var/www/html

# Dependencies and assets from the earlier stages, then the source —
# ordered so routine code edits invalidate as little cache as possible.
COPY --chown=www-data:www-data --from=vendor /app/vendor ./vendor
COPY --chown=www-data:www-data . .
COPY --chown=www-data:www-data --from=assets /app/public/build ./public/build

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Non-root from here on: build steps above ran as root, the app never does.
USER www-data

# Documentation, not a firewall rule: FPM listens on 9000/tcp.
EXPOSE 9000

# Real FastCGI liveness: asks the FPM master for /ping, expects "pong".
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD SCRIPT_NAME=/ping SCRIPT_FILENAME=/ping REQUEST_METHOD=GET \
        cgi-fcgi -bind -connect 127.0.0.1:9000 | grep -q pong || exit 1

# entrypoint.sh runs setup, then `exec "$@"` hands PID 1 to CMD.
# Same image runs php-fpm, horizon, or artisan — swap CMD, keep setup.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["php-fpm"]
```

## Hands-on with TicketHub

Build it. First build compiles extensions (~2 minutes); every later build rides the cache:

```
$ docker build -t tickethub-api:dev .
[+] Building 142.6s (24/24) FINISHED
 => [internal] load build definition from Dockerfile
 => => transferring dockerfile: 2.87kB
 => [internal] load build context
 => => transferring context: 28.79kB
 => [vendor 4/6] RUN composer install --no-dev --no-scripts --no-autoloader …
 => [assets 4/7] RUN npm ci
 => [app  2/12] RUN apt-get update && apt-get install -y --no-install-recom…  123.2s
 => [app  8/12] COPY --chown=www-data:www-data --from=vendor /app/vendor ./vendor
 => [app  9/12] COPY --chown=www-data:www-data . .
 => exporting to image
 => => naming to docker.io/library/tickethub-api:dev
$ docker build -t tickethub-nginx:dev docker/nginx
[+] Building 1.9s (9/9) FINISHED
```

Note `transferring context: 28.79kB` — the `.dockerignore` at work. Now run the pair by hand, once, so nothing Compose automates next lecture is magic. The containers need a shared network for `app:9000` to resolve (the *default* bridge network has no DNS; user-created networks do), and the app needs its runtime environment — watch how little that is, and where it comes from (flags today; Compose tomorrow; task definitions and Secrets later):

```
$ docker network create tickethub-local
$ docker run --rm tickethub-api:dev php artisan key:generate --show
base64:WmxuX6fQKeKny5kZxzN0HZbhBz3FQxCPbGVlFxBimyQ=
$ docker run -d --name tickethub-app --network tickethub-local --network-alias app \
    -e APP_NAME=TicketHub -e APP_ENV=production -e APP_DEBUG=false \
    -e APP_KEY=base64:WmxuX6fQKeKny5kZxzN0HZbhBz3FQxCPbGVlFxBimyQ= \
    -e LOG_CHANNEL=stderr \
    tickethub-api:dev
4f3bf79fae8f…
$ docker run -d --name tickethub-nginx --network tickethub-local \
    -p 127.0.0.1:8080:80 tickethub-nginx:dev
ded860ca6085…
```

(`--network-alias app` provides the DNS name the nginx config expects — Compose will derive it from the service name.) Verify the full path — request → nginx → FastCGI over TCP → FPM → Laravel:

```
$ curl -si http://localhost:8080/up | head -3
HTTP/1.1 200 OK
Server: nginx/1.26.3
Content-Type: text/html; charset=utf-8
$ docker ps --format '{{.Names}}\t{{.Status}}'
tickethub-nginx   Up About a minute
tickethub-app     Up About a minute (healthy)
$ docker logs tickethub-app
   INFO  The [public/storage] link has been connected to [storage/app/public].
   INFO  Configuration cached successfully.
   INFO  Routes cached successfully.
   INFO  Blade templates cached successfully.
[09-Aug-2026 14:39:12] NOTICE: fpm is running, pid 1
[09-Aug-2026 14:39:12] NOTICE: ready to handle connections
172.22.0.3 -  09/Aug/2026:14:40:31 +0000 "GET /index.php" 200
```

Read that log like the course taught you: the entrypoint's runtime caching ran against *this container's* env; then **`fpm is running, pid 1`** — the `exec` handoff, verified; then an access line on stderr from another container's IP. `(healthy)` is the cgi-fcgi ping passing. Endpoints needing MySQL will fail, correctly — backing services are Compose's job next lecture; `/up` needs none. Now the signal payoff, with a stopwatch:

```
$ time docker stop tickethub-app
tickethub-app  0.31s total
$ docker logs tickethub-app | tail -2
[09-Aug-2026 14:40:57] NOTICE: Finishing ...
[09-Aug-2026 14:40:57] NOTICE: exiting, bye-bye!
```

0.3 seconds: SIGQUIT reached PID 1 (= FPM, thanks to `exec`), which finished in-flight requests and left. Sabotage it as an experiment — drop the `exec` from the entrypoint's last line, rebuild, and `docker stop` takes the full 10 seconds before SIGKILL: draining deploys versus dropped checkouts, in one shell builtin. Restore it. Finally, measure what you built:

```
$ docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}'
REPOSITORY        TAG        SIZE
tickethub-api     dev        897MB
tickethub-nginx   dev        77.4MB
php               8.4-fpm    707MB
$ docker history tickethub-api:dev --format '{{.Size}}\t{{.CreatedBy}}' | head -6
20.5kB  RUN chmod +x /usr/local/bin/entrypoint.sh
217kB   COPY --chown=www-data:www-data /app/public/build ./public/build
803kB   COPY --chown=www-data:www-data . .
47MB    COPY --chown=www-data:www-data /app/vendor ./vendor
105MB   RUN apt-get update && apt-get install -y --no-install-recommends …
```

`docker history` itemizes the bill: 707 MB inherited base, a 105 MB extensions layer (the same-RUN `rm -rf /var/lib/apt/lists/*` already saved ~20 MB; skipping `--no-install-recommends` would cost tens more), 47 MB vendor, under 1 MB of actual TicketHub. For contrast: the naive single-stage version — Composer and Node in the runtime, `node_modules` and dev-dependencies aboard, no cleanup — lands around 1.4 GB with a worse attack surface; the Alpine road ends nearer 350 MB if you accept the musl caveats. Your code being kilobytes atop stable megabytes is also what makes registry pushes cheap (Lecture 6.4: unchanged layers never re-upload). Clean up — Compose replaces all of this next lecture:

```
$ docker rm -f tickethub-app tickethub-nginx && docker network rm tickethub-local
```

## Real-world best practices

- **One process type per container, one image for all of them.** FPM, Horizon, scheduler run as *separate containers* from the *same image* with different CMDs — never a supervisor stuffing them into one container. Preserves factor VIII scaling and per-process logs/limits; the ENTRYPOINT/CMD pattern makes it free; Compose, ECS, and Kubernetes all expect exactly this shape.
- **The image is environment-free, and you can prove it.** `docker run --rm tickethub-api:dev env` shows no `DB_*`, no `APP_KEY`, no cached config. Teams add a CI check for this (Module 12 formalizes it); a leaked-`.env` image means full secret rotation, not a rebuild.
- **Rebuild the same layer, not a fatter one.** New system deps go into the *existing* apt `RUN`, never a fresh `RUN apt-get install` below it (which adds a layer while the old one still ships). Watch `docker history` sizes in review the way you watch bundle sizes.
- **Harden ownership when the team is ready:** code root-owned and read-only, `www-data` writable only on `storage/` and `bootstrap/cache/` — an attacker who owns the runtime user still can't edit the app. Kubernetes' `readOnlyRootFilesystem` (Module 11) is the same idea, platform-enforced.
- **Healthcheck the protocol, not the process.** `pgrep php-fpm` passes while the listener is wedged; the cgi-fcgi `/ping` asks the actual FastCGI question the way nginx will. Module 3's load-balancer checks and Module 11's probes follow the same principle: interrogate the serving path, not the process table.
- **Never `:latest`, in `FROM` or anywhere else.** `php:8.4-fpm` drifts only within the 8.4 patch line — deliberate, bounded, managed by rebuilds and scanning in Lecture 6.4. `php:latest` is an unreviewed major upgrade scheduled for the worst possible moment.

## Common pitfalls

1. **Baking `.env` (or a config cache) into the image.** It "works", ships, and now the registry holds your production secrets and staging runs production config — the image can never change environments again. People do it because the app errors without env at build-time steps they shouldn't be running anyway. Correct approach: `.env*` in `.dockerignore`, config-cache in the entrypoint, secrets only as runtime environment.
2. **Shell-form CMD, or an entrypoint without `exec`.** Everything *appears* fine — the app runs — but every stop is a 10-second timeout plus SIGKILL: dropped requests each deploy, mysterious 137s, Horizon jobs guillotined mid-PDF. People miss it because the failure only shows at shutdown, and nobody watches shutdowns. Correct approach: JSON-array ENTRYPOINT/CMD, `exec "$@"` last, verified with `time docker stop` (<1 s) and `pid 1` in the logs.
3. **`COPY . .` before `composer install`.** The build works, so nothing seems wrong — but every source edit invalidates the dependency layer: 2-minute rebuilds forever, CI bills to match. The naive order matches how you'd do it by hand, which is why it's everywhere. Correct approach: manifests → install → source; confirm with `CACHED` lines after touching one file.
4. **Running migrations from the entrypoint.** Convenient for one laptop container; a race with two replicas; a crash-loop generator when a migration fails (the app can't even start while ops fixes the schema). Correct approach: migrations are a release-phase step, run once per release by the pipeline — Module 9 wires it; until then, run them deliberately.
5. **"Optimizing" with `RUN rm` in a separate instruction.** `RUN apt-get install …` then `RUN rm -rf /var/lib/apt/lists/*` yields an image *larger* than no cleanup at all — the delete is a fresh layer of whiteouts atop intact bytes. Layers are invisible until you read `docker history`. Correct approach: create and clean in the same `RUN`; measure, don't intuit.
6. **Extension drift between environments.** An extension present in CI's `setup-php` (Module 7) but not the Dockerfile — or vice versa — yields green tests and a fataling container. Correct approach: the Dockerfile's list is the single source of truth, and `composer.json`'s `ext-*` requirements (Module 5) make any mismatch fail loudly at install time — precisely why they're declared.

## Exercises

1. Rebuild after `touch app/Providers/AppServiceProvider.php`, then after `touch composer.json`. For each, list which stages hit cache and which re-ran, and explain both results with section 2's rule (careful: what does `touch` change, and what does the `COPY` cache key actually hash?).
2. Verify the image is environment-free and non-root: `docker run --rm tickethub-api:dev env`, `… whoami`, and `docker inspect -f '{{.Config.User}} {{.Config.StopSignal}}' tickethub-api:dev`. One sentence per output on why it must be so.
3. Do the sabotage experiment properly: remove `exec`, rebuild, measure `time docker stop` before and after, and check whether the broken variant's logs show `Finishing ...`. Explain the signal path in both cases, PID by PID. Restore `exec`.
4. The stricter-ownership variant: make source root-owned (plain `COPY`), chowning only `storage/` and `bootstrap/cache/` to `www-data`. Rebuild, run, find what breaks (hint: the entrypoint performs more than one kind of write — read its first two actions carefully), fix the entrypoint, and prove `/up` still returns 200.
5. **Stretch:** build `tickethub-api:alpine` from `php:8.4-fpm-alpine` — extensions via `apk` plus `docker-php-ext-install` (research the Alpine dev-library names; expect friction around `intl` and `gd`, and find which apk package provides `cgi-fcgi`). Compare sizes, rerun the hands-on verification, and write a three-sentence recommendation: should TicketHub switch, and what would you test first?

## What's next

TicketHub now has a production-grade image — but your daily loop can't be "rebuild the image for every code change," and the app still needs MySQL, Redis, mail, and S3 around it. The next lecture turns the whole stack into one declarative, versioned file: `compose.yaml`, with a bind-mounted `dev` build target, health-gated startup ordering, Horizon and the scheduler as separate containers, Mailpit for factor-X mail parity, and MinIO standing in for S3 so even your `Storage::` code paths run for real. One command up, one command down. Continue to [Lecture 6.3 — Docker Compose for Local Development](03-docker-compose-local-dev.md).
