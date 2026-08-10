# Lecture 3.3 — Nginx + PHP-FPM: Serving Laravel by Hand

> **Module 3 — Networking & Web Servers** · Lecture 3 of 4 · Estimated time: ~75 min

This is the lecture where TicketHub goes live: [3.1](01-how-the-web-works.md) gave you the network path, [3.2](02-tls-and-certificates.md) gave you HTTPS, and here you build the machinery behind the padlock — nginx receiving requests, PHP-FPM executing Laravel, MySQL and Redis behind them, every piece configured by hand, on purpose. Module 6 packages this stack into containers and Module 9 automates its deploys, but engineers who skip this stage end up configuring Nginx blind and tuning PHP-FPM by superstition. Not you.

## Learning objectives

- Trace a request through nginx's event loop, FastCGI, a PHP-FPM worker, and Laravel's front controller — and explain each hand-off
- Install and verify the full stack on Ubuntu 24.04: nginx, PHP 8.4 FPM with TicketHub's extensions, MySQL 8.0, Redis 7
- Size `pm.max_children` from measured worker memory, choose a process-manager mode deliberately, and predict what pool exhaustion looks like
- Write and defend every line of a production nginx server block for Laravel
- Apply the production `php.ini` deltas — opcache, error handling, upload limits — and state their deploy-time consequences
- Deploy TicketHub by hand and verify it end to end, then use reload semantics correctly for config and code changes

## 1. The request path you are about to build

```
Customer's phone
      │  HTTPS (TCP 443)
      ▼
┌─ nginx worker ────────────────────────────────┐
│  event loop: thousands of sockets per worker  │
│  TLS termination · static files · buffering   │
└──────┬────────────────────────────────────────┘
       │  FastCGI over unix socket /run/php/php8.4-fpm.sock
       ▼
┌─ php-fpm pool "www" ──────────────────────────┐
│  N workers · each runs ONE request at a time  │
└──────┬────────────────────────────────────────┘
       │  executes /var/www/tickethub/public/index.php
       ▼
Laravel: HTTP kernel → router → controller → Eloquent
       │                              │
       ▼                              ▼
MySQL on 127.0.0.1:3306        Redis on 127.0.0.1:6379
```

Two different concurrency models are glued together here, and the glue is where most production behavior comes from. Nginx never executes your PHP; it terminates TLS, serves static files itself, and forwards dynamic requests over **FastCGI** — a binary protocol that carries the request metadata (method, URI, headers, and crucially `SCRIPT_FILENAME`) plus the body to a separate process manager. PHP-FPM (FastCGI Process Manager) owns a pool of PHP workers; each takes one request, boots Laravel, produces a response, then takes the next. We connect the two over a **unix domain socket** rather than TCP port 9000: faster (no network stack), governed by file permissions, and impossible to expose to the internet by accident.

## 2. Why nginx: the event loop vs. one process per connection

The classic Apache model (prefork) pairs each connection with a process: 10,000 open connections means 10,000 processes, most of them idle, each costing megabytes — the famous C10K problem. Nginx inverted this: a few worker processes (one per CPU core), each an **event loop** multiplexing thousands of sockets via the kernel's `epoll`. A worker never blocks on one connection; it services whichever sockets have bytes ready. Memory per connection is kilobytes; 10,000 mostly-idle keep-alive connections are cheap.

This matters doubly for PHP because of **slow clients**. Picture a customer on venue Wi-Fi taking 20 seconds to download a ticket confirmation. If a PHP worker had to spoon-feed that response, it would sit pinned — doing nothing — for 20 seconds. Instead, PHP-FPM hands the full response to nginx in milliseconds and takes the next request; nginx *buffers* it out at the client's pace for near-zero cost. Async edge, synchronous workers: every capacity number in section 4 depends on that split. (Honesty note: modern Apache with `mpm_event` + PHP-FPM works the same way and is fine; nginx won on defaults, config culture and proxy features, and it's what this course and most of the Laravel ecosystem use.)

## 3. Installing the stack

Nginx is already running (Lecture 3.2). Ubuntu 24.04 ships PHP 8.3, and the course pins **PHP 8.4**, so add the standard `ondrej/php` PPA — the de-facto official PHP repository for Ubuntu — then install FPM, the CLI, and the extensions TicketHub actually uses:

```
$ sudo add-apt-repository ppa:ondrej/php
$ sudo apt update
$ sudo apt install -y php8.4-fpm php8.4-cli php8.4-mysql php8.4-redis \
    php8.4-mbstring php8.4-xml php8.4-curl php8.4-zip php8.4-intl \
    php8.4-gd php8.4-bcmath php8.4-opcache
$ php -v
PHP 8.4.11 (cli) (built: ...) (NTS)
$ systemctl is-active php8.4-fpm
active
```

Why each: `php8.4-mysql` is the PDO driver; `mbstring`, `xml`, `curl` and `zip` are framework and Composer table stakes; `intl` formats locale-aware currency; `gd` renders ticket QR codes; `bcmath` does precise money math; `opcache` gets section 6. `php8.4-redis` is **phpredis**, the C extension, pre-packaged so you skip the PECL compile. The alternative, `predis`, is pure PHP via Composer — zero system dependencies, slightly slower. Laravel supports both behind `REDIS_CLIENT`; we use phpredis because the package makes it free and it holds up better under Horizon's load from Module 5 onward.

**MySQL 8.0** comes straight from Ubuntu's repos: `sudo apt install -y mysql-server`. It binds to `127.0.0.1:3306` out of the box — verify with `sudo ss -tlnp | grep 3306`, and now you know why that's non-negotiable (Lecture 3.1). Root access uses socket auth, so `sudo mysql` gets you a shell; create the app's database and user (no `FLUSH PRIVILEGES` needed — that's only for direct edits to the grant tables):

```
$ sudo mysql
mysql> CREATE DATABASE tickethub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
mysql> CREATE USER 'tickethub'@'localhost' IDENTIFIED BY 'use-a-long-random-password-here';
mysql> GRANT ALL PRIVILEGES ON tickethub.* TO 'tickethub'@'localhost';
mysql> EXIT;
```

**Redis 7** likewise: `sudo apt install -y redis-server`, which binds `127.0.0.1` and `::1` only; `redis-cli ping` answering `PONG` is your smoke test. Leave it otherwise untouched for now — memory limits, the `allkeys-lru` eviction policy, and moving Laravel's cache, sessions and queues onto it are Module 5's whole story. Today Redis just needs to exist and be private.

## 4. PHP-FPM pools: where your capacity actually lives

A **pool** is a group of PHP worker processes sharing one config: which user they run as, where they listen, and — the part that decides whether an on-sale survives — how many of them exist. The default pool is defined in `/etc/php/8.4/fpm/pool.d/www.conf`. The lines that matter:

```ini
[www]
user = www-data
group = www-data
listen = /run/php/php8.4-fpm.sock
listen.owner = www-data
listen.group = www-data

pm = dynamic
pm.max_children = 30
pm.start_servers = 10
pm.min_spare_servers = 5
pm.max_spare_servers = 15
pm.max_requests = 500

request_terminate_timeout = 30s
request_slowlog_timeout = 5s
slowlog = /var/log/php8.4-fpm-www.slow.log
```

Workers run as `www-data` (nginx's user — both must access the socket, and workers must write Laravel's `storage/`). `pm` picks the mode: **`dynamic`** floats the worker count between spare thresholds; **`static`** keeps exactly `max_children` alive — no spawn latency, predictable memory, right for a dedicated app box once sized; **`ondemand`** forks on arrival and reaps idlers — for low-traffic or many-tenant boxes where RAM beats latency. We teach `dynamic`; the last exercise races it against `static`. `pm.max_requests = 500` recycles each worker after 500 requests — insurance against slow memory leaks in long-lived PHP processes.

Now the number everyone gets wrong. **`pm.max_children` is your concurrency ceiling**: each worker handles one request at a time, so 30 workers means 30 requests in flight, full stop. Too low wastes the box; too high and combined worker memory exceeds RAM, the OOM killer shoots MySQL or a worker mid-transaction, and the machine convulses. The sizing is arithmetic, not folklore:

```
pm.max_children = (RAM − everything that isn't PHP) / average worker RSS
```

Measure, don't guess. After the app is deployed and warmed (hands-on section), inspect real worker memory:

```
$ ps -o pid,rss,cmd -C php-fpm8.4 --sort=-rss
    PID   RSS CMD
   9211 81944 php-fpm: pool www
   9212 79200 php-fpm: pool www
   9213 76410 php-fpm: pool www
   9210 47520 php-fpm: master process (/etc/php/8.4/fpm/php-fpm.conf)

$ ps -o rss=,cmd= -C php-fpm8.4 | awk '/pool/ {s+=$1; n++} END {printf "%d workers, avg %.0f MB\n", n, s/n/1024}'
3 workers, avg 79 MB
```

On our 4 GB VPS: reserve ~800 MB for MySQL, ~100 MB for Redis, ~350 MB for the OS, nginx and friends, and a ~300 MB safety margin — roughly 2.5 GB remains for PHP. At 79 MB per worker: 2500 / 79 ≈ 31. Set `pm.max_children = 30` and keep the headroom; re-run the measurement after major dependency upgrades, because worker RSS drifts.

**What happens when all 30 are busy?** New connections queue in the listen backlog — remember `Recv-Q` from Lecture 3.1. Users feel it first as *latency*, and FPM logs `server reached pm.max_children setting (30), consider raising it`. If the queue outlasts nginx's patience you serve **504s**; if the backlog overflows or FPM stops accepting, **502s**. That is the anatomy of an on-sale melting a single server: 500 fans arrive in one second, 30 get served, 470 wait, timeouts cascade. A bigger box raises the ceiling, but the real fixes are queues (Module 5) and horizontal scaling ([Lecture 3.4](04-reverse-proxies-load-balancing.md), Module 8).

Two timeouts guard the pool. `request_slowlog_timeout = 5s` writes a **stack trace of any request exceeding 5s** to the slowlog — your first profiler, free; when the API "feels slow" during a spike, it names the controller and query, no APM required. `request_terminate_timeout = 30s` is the hard wall: FPM kills the worker mid-request. It exists because PHP's `max_execution_time` doesn't count time in database calls and other stream waits — a request stuck on a hung connection can outlive it indefinitely; the FPM timeout is wall-clock and always wins. Keep it aligned with nginx's `fastcgi_read_timeout` (default 60s): the tighter decides what users see.

## 5. The nginx server block, line by line

Replace the placeholder config from Lecture 3.2. Final form of `/etc/nginx/sites-available/tickethub`:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name api.tickethub.example;

    root /var/www/tickethub/public;
    index index.php;

    # --- TLS (issued in Lecture 3.2) ---
    ssl_certificate     /etc/letsencrypt/live/api.tickethub.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.tickethub.example/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    access_log /var/log/nginx/tickethub.access.log;
    error_log  /var/log/nginx/tickethub.error.log;

    client_max_body_size 10m;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=31536000" always;

    gzip on;
    gzip_types application/json application/vnd.api+json text/plain text/css application/javascript;
    gzip_min_length 1024;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass unix:/run/php/php8.4-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        fastcgi_hide_header X-Powered-By;
    }

    location ~ /\.(?!well-known) {
        deny all;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name api.tickethub.example;
    return 301 https://$host$request_uri;
}
```

The load-bearing lines:

- **`root /var/www/tickethub/public;`** — `public/`, **never the repository root**. The repo root holds `.env` (your database password), `storage/` and all source. Point `root` one directory too high and `https://api.tickethub.example/.env` serves your secrets as plain text — the most catastrophic Laravel misconfiguration, and scanners request `/.env` from every new HTTPS host within hours of its certificate hitting public CT logs. `public/` exists to be the only web-exposed directory; by design it contains one PHP file, `index.php`.
- **`try_files $uri $uri/ /index.php?$query_string;`** — the front-controller pattern. For each request nginx tries, in order: (1) a real file at that path — static assets get served by the event loop, PHP never wakes up; (2) a directory; (3) otherwise, *internally rewrite* to `/index.php` carrying the original query string, which lands in the PHP location block. Every Laravel route on earth is case 3. Drop `?$query_string` and pagination like `/api/v1/events?page=2` silently loses its parameters.
- **The `location ~ \.php$` block** — the FastCGI bridge. `include fastcgi_params` maps request metadata into what PHP sees as `$_SERVER`; `fastcgi_pass` names the FPM socket; `SCRIPT_FILENAME` tells FPM *which file to execute*. We build it from `$realpath_root` (symlinks resolved) instead of the conventional `$document_root`: identical today, but Module 9 turns the app path into a symlink switched atomically between releases, and `$realpath_root` prevents opcache serving a Frankenstein mix of old and new code across a deploy. Costs nothing now, prevents a legendary bug later. `fastcgi_hide_header X-Powered-By` stops advertising the PHP version.
- **`location ~ /\.(?!well-known)`** — deny dotfiles (`.git` if anyone ever clones carelessly, `.htaccess`, editor droppings), with an exception for `/.well-known/` so ACME renewal and similar standards keep working.
- **`client_max_body_size 10m;`** — nginx's outermost body limit. The default 1 MB would reject event-poster uploads with a bare `413` before PHP ever saw them. This value must be ≥ PHP's `post_max_size` (next section) so the limits fail in a predictable order.
- **Security headers** — `X-Frame-Options` (no clickjacking iframes), `X-Content-Type-Options: nosniff` (browsers must not second-guess `Content-Type`), plus the HSTS header carried over from 3.2. `always` makes nginx attach them to error responses too.
- **gzip for JSON** — nginx compresses only `text/html` by default; API payloads are JSON, which compresses 5–10×. `gzip_min_length` skips tiny bodies where headers would outweigh the savings.
- **Per-vhost logs** — `tickethub.access.log` / `tickethub.error.log`. The error log is where 502/504 causes are spelled out; the access log becomes structured JSON in Module 12. Ubuntu's logrotate config already rotates both.

## 6. Production php.ini: the deltas that matter

Never edit `/etc/php/8.4/fpm/php.ini` directly — package upgrades will want to replace it, and your changes become undiffable archaeology. Drop overrides in a dedicated file, loaded last:

```ini
; /etc/php/8.4/fpm/conf.d/99-tickethub.ini — production overrides

expose_php = Off
display_errors = Off
log_errors = On
memory_limit = 256M

upload_max_filesize = 8M
post_max_size = 10M

opcache.enable = 1
opcache.memory_consumption = 192
opcache.interned_strings_buffer = 16
opcache.max_accelerated_files = 20000
opcache.validate_timestamps = 0

realpath_cache_size = 4096K
realpath_cache_ttl = 600
```

- **`expose_php = Off` / `display_errors = Off` / `log_errors = On`** — don't advertise the PHP version; never print stack traces into responses (they leak paths, queries, sometimes credentials — `APP_DEBUG=false` is Laravel's layer of the same rule, and you want both); do write errors to the log, because "display off, log off" is how teams end up debugging blind.
- **`memory_limit = 256M`** — a per-request *ceiling*, not an allocation; typical requests use a fraction of it. The pool math in section 4 uses measured average RSS, while this limit caps the pathological request so one runaway report can't eat the box.
- **`upload_max_filesize` ≤ `post_max_size` ≤ `client_max_body_size`** — three gates, outermost first. `post_max_size` covers the *whole* body (files plus form fields), so it must exceed `upload_max_filesize`; nginx's limit must be ≥ both or requests die at the door with a 413 that PHP never logs. Ours: 8M file, 10M body, 10m at nginx.
- **opcache** — without it PHP re-compiles every source file to opcodes on every request; with it, opcodes live in shared memory across all workers. It is *the* PHP performance setting. 192 MB fits TicketHub plus vendor code (`max_accelerated_files` sits above the ~15k files Laravel + dependencies contain). The consequential line is **`opcache.validate_timestamps = 0`**: PHP stops checking files for changes — maximum speed, and **deployed code changes are invisible until PHP-FPM reloads**. That becomes a mandatory deploy step in the hands-on; the opcache/release interplay is a whole topic in Module 9. (In development, leave it at 1.)
- **`realpath_cache_*`** — PHP caches resolved filesystem paths; Laravel touches hundreds of files per request, so a bigger, longer-lived cache eliminates thousands of `stat()` calls. (It also interacts with symlink-based deploys — another thread Module 9 picks up.)

Apply pool and ini changes with `sudo systemctl reload php8.4-fpm`.

## Hands-on with TicketHub

Everything is installed; time to put the app on the box via the **deliberately naive deploy** — clone, install, configure by hand. It will work. Feel how many steps it takes and how many chances to make a mistake: that feeling is the syllabus for Modules 4 through 9.

### Deploy

Create the directory, owned by `deploy` (Module 2's unprivileged user — code is never owned by root or by the web server):

```
$ sudo mkdir -p /var/www/tickethub
$ sudo chown deploy:deploy /var/www/tickethub
$ git clone https://github.com/tickethub/tickethub-api.git /var/www/tickethub
Cloning into '/var/www/tickethub'...
$ cd /var/www/tickethub
```

Install Composer (the installer script keeps you current regardless of distro packaging — verify its hash per getcomposer.org/download; make that a habit), then production dependencies:

```
$ php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');"
$ sudo php composer-setup.php --install-dir=/usr/local/bin --filename=composer
$ rm composer-setup.php
$ composer install --no-dev --optimize-autoloader
Installing dependencies from lock file
Package operations: 118 installs, 0 updates, 0 removals
  ...
Generating optimized autoload files
```

`--no-dev` keeps Pest, Faker and friends off the production box — less disk, less attack surface, and dev tooling has no business near real data. `--optimize-autoloader` pre-builds the class map so autoloading skips filesystem scans.

Configure the environment — copy the template, generate the encryption key, then edit:

```
$ cp .env.example .env
$ php artisan key:generate
```

```dotenv
APP_NAME=TicketHub
APP_ENV=production
APP_KEY=base64:GENERATED_BY_ARTISAN
APP_DEBUG=false
APP_URL=https://api.tickethub.example

DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=tickethub
DB_USERNAME=tickethub
DB_PASSWORD=use-a-long-random-password-here

SESSION_DRIVER=database
QUEUE_CONNECTION=database
CACHE_STORE=database

REDIS_CLIENT=phpredis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
```

`APP_DEBUG=false` is not optional — debug pages print config and stack traces to strangers. Sessions, cache and queue ride MySQL for now; Module 5 makes the case for Redis and moves them deliberately. The `REDIS_*` block is ready for that day.

Permissions, the Module 2 recap in two lines — FPM runs as `www-data` and must write logs, compiled views, caches:

```
$ sudo chown -R deploy:www-data storage bootstrap/cache
$ sudo chmod -R 775 storage bootstrap/cache
```

Migrate (Laravel demands `--force` in production — it's the "yes, I mean this database" flag):

```
$ php artisan migrate --force
   INFO  Preparing database.
  Creating migration table ...................... 20ms DONE
   INFO  Running migrations.
  0001_01_01_000000_create_users_table .......... 41ms DONE
  0001_01_01_000001_create_cache_table .......... 18ms DONE
  0001_01_01_000002_create_jobs_table ........... 27ms DONE
  2026_01_15_000000_create_events_table ......... 22ms DONE
  2026_01_15_000001_create_ticket_types_table ... 19ms DONE
  2026_01_16_000000_create_orders_table ......... 25ms DONE
  2026_01_16_000001_create_order_items_table .... 21ms DONE
  2026_01_17_000000_create_tickets_table ........ 24ms DONE
```

Cache the framework's bootstrap work:

```
$ php artisan optimize
   INFO  Caching framework bootstrap, configuration, and metadata.
  config .................. 32ms DONE
  events .................. 12ms DONE
  routes .................. 28ms DONE
  views ................... 85ms DONE
```

`config:cache` collapses every config file plus `.env` into one compiled file — after this, `env()` calls outside `config/` return null, a sharp edge Module 5 examines properly. `route:cache` matters most for APIs: route registration happens once, not per request. The undo button is `php artisan optimize:clear`.

Finally, install the section-5 server block and the section-4/6 FPM changes, then reload both services:

```
$ sudo nginx -t && sudo systemctl reload nginx
$ sudo systemctl reload php8.4-fpm
```

### Verify end to end

```
$ curl -i https://api.tickethub.example/up
HTTP/2 200
content-type: text/html; charset=UTF-8
...
$ curl -s https://api.tickethub.example/api/v1/events
{"data":[]}
```

`/up` is Laravel 12's built-in health route ([Lecture 3.4](04-reverse-proxies-load-balancing.md) builds on it). And `{"data":[]}` is beautiful: DNS resolved, TLS terminated, nginx routed by `Host`, `try_files` fell through to `index.php`, FastCGI crossed the socket, a worker booted Laravel from opcache, Eloquent queried an empty `events` table over `127.0.0.1:3306`, and JSON came back with a 200. Every layer of this module, in one empty array.

### Break it, on purpose

You'll meet 502 in production; meet it here first:

```
$ sudo systemctl stop php8.4-fpm
$ curl -i https://api.tickethub.example/api/v1/events
HTTP/2 502
$ sudo tail -1 /var/log/nginx/tickethub.error.log
2026/08/09 13:22:41 [crit] 9013#9013: *44 connect() to unix:/run/php/php8.4-fpm.sock failed
(2: No such file or directory) while connecting to upstream, client: 198.51.100.7,
server: api.tickethub.example, request: "GET /api/v1/events HTTP/2.0",
upstream: "fastcgi://unix:/run/php/php8.4-fpm.sock:"
```

The error log names the failing upstream exactly — why "502 → read the nginx *error* log" beats "502 → restart nginx" every time. `sudo systemctl start php8.4-fpm` and confirm the 200 returns. Adjacent case for your mental map: MySQL down produces a Laravel **500** (app running, throwing), not a 502 (app unreachable). Status codes localize faults.

### Reload vs. restart — the semantics that keep you at zero downtime

- **nginx**: `reload` sends SIGHUP; the master validates config, spawns new workers, and old workers finish their in-flight requests before exiting — zero dropped connections. `restart` tears everything down mid-request. Config change → `nginx -t && systemctl reload nginx`, always in that order; a reload with broken config is refused (old workers continue), but a *restart* with broken config leaves nginx down.
- **PHP-FPM**: `reload` is graceful too — workers complete their current request, then respawn with fresh config **and a fresh opcache**. With `validate_timestamps=0`, reload is *how code changes become visible*. `restart` kills in-flight requests: a customer mid-checkout gets a 502.

Your complete naive deploy loop for every future change, until Module 9 replaces it:

```
$ cd /var/www/tickethub
$ git pull
$ composer install --no-dev --optimize-autoloader
$ php artisan migrate --force
$ php artisan optimize
$ sudo systemctl reload php8.4-fpm
```

Notice the window: between `git pull` and the FPM reload, files on disk and opcodes in memory disagree, caches may be stale, and a migration might land before the code that uses it. On a busy site, requests in that window can fail. That queasiness is correct — hold onto it until Module 9 eliminates the window entirely.

## Real-world best practices

- **`public/` as docroot, verified mechanically.** Don't trust convention — add `curl -s -o /dev/null -w "%{http_code}" https://api.tickethub.example/.env` (expect 403/404) to your smoke checks. Scanners try it within hours; you should try it first.
- **Size worker pools from measurement, on a schedule.** Worker RSS drifts with dependency upgrades. Re-measure quarterly and after major releases, keep 20–30% RAM headroom, and treat "server reached pm.max_children" log lines as a capacity alert (Module 12 makes it a real one), not noise.
- **Reload is the only deploy verb.** Restarts are for emergencies and binary upgrades. Teams that bake `reload` into muscle memory (and scripts) stop causing self-inflicted 502 blips.
- **All customization lives in your own files** — `sites-available/tickethub`, `conf.d/99-tickethub.ini`, edited pool config — never scattered edits to distro defaults. Diffable, upgrade-safe, and in Module 6 these exact files migrate into the repo under `docker/`, becoming code.
- **Slowlog on from day one.** `request_slowlog_timeout = 5s` costs nothing and hands you a stack trace for every slow request. Most teams add APM after their first mystery slowdown; the slowlog is the free tier you can have before the mystery.
- **opcache with `validate_timestamps=0` is the production standard** — but only alongside deploy discipline that reloads FPM. Half-adopting (timestamps off, reload forgotten) produces "ghost deploys" and erodes trust in the whole pipeline.

## Common pitfalls

1. **Pointing `root` at the repository instead of `public/`.** Generic vhost templates say `root /var/www/myapp`, and it *appears* to work after enough creative rewrites. The result is `.env` and `storage/` served over HTTPS. Correct approach: `root /var/www/tickethub/public`, no exceptions, plus the `/.env` smoke check.
2. **Keeping the default `pm.max_children = 5`.** The default exists so FPM starts on tiny machines; nobody warns you it's a toy value. The first modest spike brings queueing and 502/504s on a box at 15% CPU — convincing people to pay for a bigger toy. Correct approach: the section-4 math, from measured RSS.
3. **Deploying and "nothing changed."** With `validate_timestamps=0`, `git pull` updates disk while opcache keeps executing the old opcodes. Teams conclude caching is haunted and switch validation back on in production, paying a stat-storm on every request forever. Correct approach: keep `0`, make `systemctl reload php8.4-fpm` a scripted, unskippable deploy step.
4. **`chmod -R 777 storage` to silence a permission error.** It's the top search result and it works instantly — by making application logs and compiled views world-writable on a shared box. Correct approach (Module 2): owner `deploy`, group `www-data`, mode 775 on `storage/` and `bootstrap/cache/` only.
5. **Restarting services to apply config.** Habit from desktop software; every restart drops in-flight requests — during an on-sale, failed checkouts. Correct approach: `nginx -t && systemctl reload nginx`, `systemctl reload php8.4-fpm`; reserve restart for changed sockets/binaries, and know *why* when you do.

## Exercises

1. Re-run the Lecture 3.1 audit: `sudo ss -tlnp` and `sudo ss -xlp | grep php`. Explain every socket now present, and why PHP-FPM appears in the second command but not the first.
2. Warm the app (`for i in {1..50}; do curl -s https://api.tickethub.example/api/v1/events > /dev/null; done`), measure average worker RSS with the `ps`/`awk` one-liner, compute `pm.max_children` for *your* box's RAM, apply it, reload FPM, and confirm the FPM log shows no `max_children` warnings under a second warm-up run.
3. Add a temporary route that calls `sleep(3)` in `routes/api.php`, drop `request_slowlog_timeout` to `2s`, hit the route, and read the stack trace in `/var/log/php8.4-fpm-www.slow.log`. Remove the route afterward — and deploy the removal correctly (which service needs a reload, and why?).
4. Build the failure map: stop `mysql`, then `php8.4-fpm`, then `nginx` (one at a time, restoring between), curl the API each time, and record status/behavior. Produce a three-line table mapping symptom → failed layer → first log file to read.
5. **Stretch:** benchmark `pm = dynamic` vs `pm = static` with `pm.max_children` at your computed value: `ab -n 2000 -c 40 https://api.tickethub.example/api/v1/events` (install `apache2-utils`). Compare requests/sec, p95 latency, and memory before/during. Write three sentences on when static wins, and what you'd watch before switching production to it.

## What's next

TicketHub is live: one hardened VPS serving HTTPS, a tuned PHP-FPM pool, a database only the box itself can reach. It is also one machine — one kernel panic away from total outage. The final lecture introduces the layer that fixes that: reverse proxies and load balancing, including the header-forwarding trap that breaks Laravel behind every proxy and the health checks that decide who gets traffic. Continue to [Lecture 3.4 — Reverse Proxies & Load Balancing](04-reverse-proxies-load-balancing.md).
