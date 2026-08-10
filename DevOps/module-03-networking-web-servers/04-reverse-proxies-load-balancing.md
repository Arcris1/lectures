# Lecture 3.4 — Reverse Proxies & Load Balancing

> **Module 3 — Networking & Web Servers** · Lecture 4 of 4 · Estimated time: ~65 min

After [Lecture 3.3](03-nginx-php-fpm-laravel.md), TicketHub runs on one VPS — one machine is the entire company. One kernel panic during an on-sale, one deploy gone wrong: total outage. The fix is a **load balancer** in front of multiple app servers, and while the core path of this course won't rent a second VPS (Module 8's AWS ALB does this properly), you must understand the mechanics now — proxies change what your application *sees*, and an unprepared Laravel app breaks behind one in specific, predictable ways. In this lecture you make TicketHub proxy-ready, build the health endpoints a balancer needs, and read a complete nginx load-balancer config line by line.

## Learning objectives

- Distinguish forward from reverse proxies and enumerate what a reverse proxy buys you
- Diagnose the `X-Forwarded-For` / `X-Forwarded-Proto` problem and fix it with Laravel 12's trusted-proxy configuration — including when `'*'` is safe and when it's a vulnerability
- Choose between load-balancing algorithms and between L4 and L7 balancing for a given workload
- Design health checks deliberately: active vs passive, shallow vs deep, and the failure modes of each
- Explain what breaks when one server becomes two — sessions, files, locks, cron — and where the fixes live
- Read and write a production nginx upstream configuration with passive health checks, keepalive, and connection draining

## 1. Proxies: forward and reverse

A proxy is a middleman that terminates a connection and opens a new one on your behalf. Direction is everything. A **forward proxy** stands in front of *clients*: a corporate network routes employees' browsing through it for filtering and caching, and destination servers see the proxy's IP, not the employee's. A **reverse proxy** stands in front of *servers*: clients connect to it believing it *is* the service, and it relays to backend machines the client never sees. Same software, opposite allegiance — nginx plays either role.

You already run a reverse proxy without ceremony: nginx on your VPS terminates TLS and proxies to PHP-FPM over FastCGI. A load balancer is just a reverse proxy with more than one place to send things.

## 2. What a reverse proxy buys you

A proxy hop must earn its place; a reverse proxy earns it several times over:

- **TLS offload.** Certificates live in one place; backends speak plain HTTP on a private network. One renewal to monitor instead of N (the termination decision from [Lecture 3.2](02-tls-and-certificates.md)).
- **Buffering slow clients.** The same trick nginx already plays for PHP-FPM, promoted one tier: app servers hand off responses in milliseconds and the proxy babysits slow phones.
- **Compression and static offload.** gzip, cached static files, and error pages served without touching an app server.
- **Request filtering.** Rate limits, path blocks, body-size limits, and eventually a WAF — enforced before a request costs you a PHP worker.
- **Hiding topology.** One public IP; the app tier, database and Redis live on private addresses (Lecture 3.1's ranges at work). Attack surface shrinks to one hardened front door.
- **The platform for everything else.** Rolling deploys, canary releases, failover, autoscaling — every advanced practice in Modules 8–11 presupposes a traffic layer that can shift load between backends.

The price of admission: your app no longer talks to clients directly, and that breaks two things it believed about the world.

## 3. The X-Forwarded problem — and the real Laravel bug it causes

A reverse proxy terminates the client's TCP connection and opens a *new* one to the backend. Consequence: at the backend, `REMOTE_ADDR` — the one network-level fact PHP gets about its peer — is now **the proxy's IP**. If the proxy terminated TLS, the backend hop was plain HTTP, so the app believes the request was insecure. Proxies record the truth in headers as they forward: `X-Forwarded-For` (the client IP, each hop appending — `198.51.100.7, 10.0.0.5`), `X-Forwarded-Proto` (original scheme), `X-Forwarded-Host`, and nginx's single-value `X-Real-IP`.

Behind a balancer, an unprepared Laravel app produces these exact bugs:

1. **`$request->ip()` returns the load balancer's IP for every request.** Laravel's `throttle` middleware keys rate limits per-IP, so *all customers now share one bucket*. During an on-sale the rate limiter sees one hyperactive "client" and 429s everyone. Audit logs, fraud checks, anything IP-based: garbage.
2. **`url()`, `route()` and redirects generate `http://` links.** The app saw plain HTTP arrive, so every absolute URL it builds is insecure. Redirects bounce users out of HTTPS, and — nastier — **signed URLs break**: TicketHub emails customers a signed ticket-PDF link; the signature is computed over the `http://` URL the app thinks it serves, the customer opens it as `https://`, the check hashes a different string, and every ticket link 403s with `Invalid signature`.

Why doesn't Laravel just read `X-Forwarded-*` and move on? Because **anyone can send those headers**; `curl -H "X-Forwarded-For: 1.2.3.4"` forges them for free. Honoring them from an untrusted peer lets any client impersonate any IP — bye-bye rate limiting and bans. So the framework requires you to declare *which peers are proxies whose headers deserve belief*. In Laravel 12 that declaration lives in `bootstrap/app.php`:

```php
<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware) {
        // Trust only the load-balancer tier. Today (no proxy in front)
        // nothing matches this range, so it is inert. From Module 8 the
        // ALB lives in this VPC range and its headers become trustworthy.
        $middleware->trustProxies(at: [
            '10.0.0.0/16',
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions) {
        //
    })->create();
```

The rule Laravel applies: if `REMOTE_ADDR` is inside a trusted range, believe its `X-Forwarded-*` headers (walking the chain until the first untrusted address, which is the real client). The choice of `at:` is a security decision:

- **A CIDR or explicit list** — correct whenever you know where your proxies live. Ours matches `tickethub-prod-vpc` (`10.0.0.0/16`).
- **`'*'` (trust everyone)** — correct *only* when the app is **not directly reachable**: behind an AWS ALB whose node IPs change constantly, with security groups ensuring nothing else can connect. If clients can reach the app directly, `'*'` lets every client forge its identity — you demonstrate this live in the hands-on.
- AWS ALBs can also convey the client port/proto via their own header set; Laravel supports `$middleware->trustProxies(headers: ...)` for that — Module 8 revisits it.

## 4. Scaling out: algorithms and layers

When one server is not enough you have two directions. **Vertical scaling** — a bigger box — is underrated: zero code changes, no distributed-systems problems, and modern machines go far. But it has a ceiling, a resize usually means downtime, and one box is still one box. **Horizontal scaling** — more boxes behind a balancer — has no practical ceiling and buys fault tolerance, at the price of section 6's statefulness problems. Real answer: scale up until availability or the price curve forces you out, then scale out.

Once traffic must be divided, the balancer needs an algorithm:

| Algorithm | How it decides | When it fits |
|---|---|---|
| Round robin | Next server in rotation | Identical servers, uniform request cost — the default |
| Weighted round robin | Rotation biased by weight | Mixed hardware; canary releases (95/5 splits — Module 9) |
| Least connections | Server with fewest in-flight requests | Uneven request durations — a strong default for PHP app tiers, where a 5s report and a 50ms lookup coexist |
| IP hash | Same client IP → same server | Session stickiness as a crutch (section 6); breaks on mobile network hops and lumps NATed offices onto one server |

Orthogonal to the algorithm is the **layer**. An **L4 balancer** works at TCP: it forwards byte streams, never decrypts, never parses HTTP. Blazing fast and protocol-ignorant — but it cannot route by path or inject `X-Forwarded-For`, and with keep-alive it balances *connections*, not requests, so long-lived connections skew load. An **L7 balancer** speaks HTTP: it terminates TLS, sees each request, routes `/api/*` differently from `/admin/*`, injects headers, retries idempotent failures, balances every request individually. The power costs CPU and means TLS ends at the balancer. Our nginx config below is L7; in AWS terms ALB is L7, NLB is L4 — Module 8 makes the choice concrete.

## 5. Health checks: deciding who deserves traffic

A balancer's second job is refusing to send traffic to a broken backend. Two mechanisms exist:

- **Passive checks** observe real traffic: if requests to a backend fail or time out, stop using it for a while. Free, always current — but real users *are* the probes, so some of them eat the failure. Open-source nginx offers exactly this (`max_fails` / `fail_timeout`).
- **Active checks** probe a health endpoint out-of-band on an interval — failures are detected before users hit them. This is what HAProxy, nginx Plus, and every cloud balancer (including Module 8's ALB) do.

Active checks need an endpoint, and *what that endpoint checks* is a genuine design decision. Laravel 12 ships a **shallow** one: the `/up` route (registered by `health: '/up'` in `bootstrap/app.php`) returns 200 if the framework can boot — proving box, nginx, PHP-FPM and bootstrap alive, touching no dependencies. A **deep** check also probes dependencies. Build one properly — with timeouts short enough that the *check itself* can't hang the prober:

```php
<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;
use Throwable;

class HealthController extends Controller
{
    public function __invoke(): JsonResponse
    {
        $checks = [
            'db'    => $this->check(fn () => DB::select('SELECT 1')),
            'redis' => $this->check(fn () => Redis::connection()->ping()),
        ];

        $healthy = ! in_array(false, $checks, true);

        return response()->json([
            'status' => $healthy ? 'ok' : 'degraded',
            'checks' => $checks,
        ], $healthy ? 200 : 503);
    }

    private function check(callable $probe): bool
    {
        try {
            $probe();

            return true;
        } catch (Throwable) {
            return false;
        }
    }
}
```

Register it in `routes/api.php`, exempt from throttling (balancers probe every few seconds, from several nodes — don't let your own rate limiter mark you unhealthy):

```php
use App\Http\Controllers\HealthController;

Route::get('/health', HealthController::class)
    ->withoutMiddleware('throttle:api');
```

The short timeouts live in `config/database.php` — two seconds for MySQL, one for Redis, instead of defaults long enough to stack probes into a pile-up:

```php
// config/database.php — inside connections.mysql:
'options' => extension_loaded('pdo_mysql') ? array_filter([
    PDO::MYSQL_ATTR_SSL_CA => env('MYSQL_ATTR_SSL_CA'),
    PDO::ATTR_TIMEOUT => 2,
]) : [],

// inside redis.default:
'timeout' => 1.0,
'read_timeout' => 1.0,
```

Now the trade-off the industry keeps relearning: **wire the deep check into your load balancer and you have built an outage amplifier.** MySQL blips for ten seconds → *every* instance's deep check fails *simultaneously* → the balancer removes *all* backends → hard 502/503s for a hiccup the app might have absorbed as a few slow requests. The dependency is shared; its failure says nothing about which instance deserves traffic. The mature pattern: **balancers get the shallow check** (`/up` — "is *this instance* able to serve?"), **monitoring gets the deep check** (`/api/health` — "is the *system* healthy?", alerting humans in Module 12). Passive checks and `fail_timeout` add hysteresis so one flapping probe doesn't yo-yo a backend in and out of rotation.

## 6. The statefulness problem: when one server becomes two

The moment a second app server exists, every piece of state stored *on* a server becomes a bug:

- **Sessions.** With `SESSION_DRIVER=file`, a customer logs in on server A (session file on A's disk); their next request round-robins to B: logged out. Random, infuriating, load-dependent. TicketHub already uses the `database` driver, so both servers share session truth through MySQL — pre-solved, until Module 5 moves it to Redis for performance.
- **Uploaded files.** An organizer uploads an event poster; it lands in server A's `storage/`. Every request served by B 404s the image. Ticket PDFs generated on one box don't exist on the other. Local disk is a lie once you have two servers.
- **Cache and locks.** File caches diverge per server — corrupting anything *correctness*-critical built on cache: rate-limit counters count per-server (a 60/min limit silently becomes 120), and atomic locks don't lock across machines (two servers can both "win" the lock guarding ticket inventory).
- **The scheduler.** `php artisan schedule:run` on two boxes runs everything twice — organizers get two nightly sales reports, reservations expire twice. TicketHub's invariants require *exactly once*.

The real fixes all "move state off the app servers into shared services": sessions and cache to Redis, files to S3-compatible object storage, scheduler locks via a shared store — Module 5 makes those config changes as twelve-factor discipline; Module 8 provisions the managed backends. The tempting non-fix is **sticky sessions** (IP hash or a balancer cookie pinning each user to one server). It "works" — and quietly costs you: load skews, a server crash logs out everyone pinned to it, deploys and autoscaling churn users, and the statefulness is still there, hidden. Use stickiness only as a short, labeled bridge while you do the real fix.

## 7. The load balancer config, line by line

Here is the complete reference config for the day TicketHub has two app servers on a private network (`10.0.0.11`, `10.0.0.12`) with a third box running nginx as the balancer. TLS terminates at the balancer; app vhosts listen on plain `:80` on the private network, as section 2 promised:

```nginx
# /etc/nginx/sites-available/tickethub-lb  — on the balancer box

upstream tickethub_app {
    least_conn;

    server 10.0.0.11:80 max_fails=3 fail_timeout=10s;
    server 10.0.0.12:80 max_fails=3 fail_timeout=10s;
    # server 10.0.0.13:80 down;   # kept out of rotation (draining/maintenance)

    keepalive 32;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name api.tickethub.example;

    ssl_certificate     /etc/letsencrypt/live/api.tickethub.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.tickethub.example/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 10m;

    location / {
        proxy_pass http://tickethub_app;

        proxy_http_version 1.1;
        proxy_set_header Connection "";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 2s;
        proxy_read_timeout    30s;
        proxy_next_upstream   error timeout http_502 http_503;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name api.tickethub.example;
    return 301 https://$host$request_uri;
}
```

- **`upstream`** names the backend pool; `proxy_pass http://tickethub_app` sends requests into it. `least_conn` because PHP request durations vary wildly (section 4).
- **`max_fails=3 fail_timeout=10s`** is open-source nginx's *passive* health checking; `fail_timeout` plays two roles: three failures within a 10s window mark the server down, and it then sits out 10s before one live request tests recovery. Cheap hysteresis, no probe endpoint — and the reason the ALB's *active* checks feel like a luxury in Module 8.
- **`keepalive 32`** maintains a pool of open connections to the backends, skipping a TCP handshake per request. It only functions with the two lines above it: HTTP/1.1 to the upstream and a cleared `Connection` header (otherwise nginx forwards the client's `close`).
- **The four `proxy_set_header` lines are the contract with section 3.** `Host` preserved — or the backend's `server_name` matching and Laravel's URL generation break. `X-Real-IP` gives logs the client address. `X-Forwarded-For` uses `$proxy_add_x_forwarded_for`, which *appends* `$remote_addr` to any incoming chain rather than overwriting — correct through multi-proxy stacks (CDN → LB → app). `X-Forwarded-Proto $scheme` tells Laravel the client really used HTTPS — the signed-URL fix.
- **`proxy_next_upstream`** retries a failed request on the next backend — failover without humans. Nginx deliberately will *not* re-send non-idempotent requests (POST/PATCH) that already reached a backend unless you force it with `non_idempotent`: a timed-out order submission might have committed, and retrying means double-charged customers. Leave the default alone.
- **Draining:** to take `10.0.0.11` out for a deploy, mark it `down` (or remove it) and `nginx -t && systemctl reload nginx`. Reload's graceful semantics (Lecture 3.3) mean old workers finish in-flight requests to that backend while new workers stop selecting it — connections drain, nobody is cut off mid-checkout. Deploy, remove `down`, reload again. Module 8's ALB automates this as "deregistration delay"; Module 9 builds zero-downtime deploys on exactly this move.

The mirror-image change on each app server is small: the vhost listens on `listen 10.0.0.11:80;` (private interface, no TLS — the balancer owns certificates), and ufw allows 80 only from the balancer's address.

## Hands-on with TicketHub

No second server today — but the app must be made proxy-ready now, and the trust mechanics can be demonstrated (and attacked) on the single VPS. You'll also ship the health endpoints Module 8's ALB will consume. Work in your local clone of `tickethub-api`, deploying with the naive loop from Lecture 3.3.

### Step 1 — Add trusted proxies and a diagnostic route

Apply the `bootstrap/app.php` change from section 3 (`trustProxies(at: ['10.0.0.0/16'])`). Then add a *temporary* diagnostic route to `routes/api.php` — it shows what the app believes about each request; it comes out again at the end:

```php
use Illuminate\Http\Request;

Route::get('/whoami', fn (Request $request) => response()->json([
    'ip'     => $request->ip(),
    'secure' => $request->isSecure(),
    'url'    => url('/api/v1/events'),
]));
```

Deploy it (on the VPS):

```
$ cd /var/www/tickethub
$ git pull
$ php artisan optimize
$ sudo systemctl reload php8.4-fpm
```

(Third time you've typed this loop. Modules 4, 7 and 9 exist because of how this feels.)

### Step 2 — Watch Laravel refuse forged headers

From your laptop, ask normally, then lie:

```
$ curl -s https://api.tickethub.example/api/whoami | jq
{
  "ip": "198.51.100.7",
  "secure": true,
  "url": "https://api.tickethub.example/api/v1/events"
}

$ curl -s -H 'X-Forwarded-For: 203.0.113.99' https://api.tickethub.example/api/whoami | jq
{
  "ip": "198.51.100.7",
  "secure": true,
  "url": "https://api.tickethub.example/api/v1/events"
}
```

Your real IP both times. The forged header arrived and Laravel ignored it: `REMOTE_ADDR` (your laptop's public IP) is not inside `10.0.0.0/16`, so its `X-Forwarded-*` claims deserve no belief. Trusted proxies working *correctly* — inert against direct clients today, ready for the real balancer tomorrow.

### Step 3 — Demonstrate why `'*'` is a loaded weapon

Temporarily change the config to `trustProxies(at: '*')`, deploy, and repeat the forgery:

```
$ curl -s -H 'X-Forwarded-For: 203.0.113.99' https://api.tickethub.example/api/whoami | jq
{
  "ip": "203.0.113.99",
  ...
}
```

Any client can now claim any IP — rate limits, bans and audit logs are fiction. The entire argument in one curl: **`'*'` is only acceptable when clients cannot reach the app directly** (private subnets + security groups, Module 8). Our VPS is directly reachable, so revert to the CIDR list and redeploy.

### Step 4 — Ship and exercise the health endpoints

Add `HealthController`, the route, and the two timeout tweaks from section 5; deploy. Then verify both depths:

```
$ curl -i -s https://api.tickethub.example/up | head -1
HTTP/2 200

$ curl -s https://api.tickethub.example/api/health | jq
{
  "status": "ok",
  "checks": {
    "db": true,
    "redis": true
  }
}
```

Now prove the deep check earns its keep — and see exactly why it must not drive a load balancer:

```
$ sudo systemctl stop redis-server        # on the VPS
$ curl -s -o /dev/null -w '%{http_code}\n' https://api.tickethub.example/api/health
503
$ curl -s https://api.tickethub.example/api/health | jq -c .checks
{"db":true,"redis":false}
$ sudo systemctl start redis-server
```

The 503 (a "DevOps status code" from Lecture 3.1 — deliberate unavailability) with a named failing dependency is exactly what you want a *monitoring system* to see and page on. But picture two app servers behind a balancer using this check: Redis hiccups, both instances go "unhealthy" in the same probe cycle, the balancer empties the pool, and a cache blip becomes a total outage. `/up` for the balancer, `/api/health` for the humans.

### Step 5 — Clean up

Remove the `/whoami` route (diagnostic surface you don't leave in production), keep `trustProxies` and the health endpoints permanently, and deploy once more. Final state: proxy-ready, health-checkable at two depths, still one server — with the section-7 config waiting for the day that changes.

## Real-world best practices

- **Make apps proxy-ready before the proxy exists.** Trusted-proxy config, health endpoints, and no reliance on `REMOTE_ADDR` semantics — shipped while the architecture is simple — turn "add a load balancer" from an app change into pure infrastructure. Teams that skip this meet the signed-URL bug in production, during the launch.
- **Trust the narrowest proxy set that works, and treat `'*'` as an architectural claim** — it asserts "nothing can reach this app except proxies." Make the claim true with network controls (private subnets, security groups) before making it in code.
- **Balance on `least_conn` for PHP tiers; keep probes shallow at the balancer and deep in monitoring.** Uneven request durations are the norm in app tiers, and deep-check outage amplification is one of the industry's most-repeated incidents — the pattern costs nothing to get right on day one.
- **Preserve `Host` and append — never overwrite — `X-Forwarded-For`.** `$proxy_add_x_forwarded_for` keeps the chain intact through CDN-plus-LB stacks; overwriting destroys the only record of the real client. Log the chain at the edge — where truth enters the system.
- **Drain, don't drop.** Every planned backend removal goes through `down` + graceful reload (or the ALB's deregistration delay). In-flight checkouts finishing cleanly is the difference between "deploy" and "incident" — Module 9 builds its zero-downtime pipeline on this reflex.
- **Never enable retry of non-idempotent requests at the proxy.** A duplicated `POST /api/v1/orders` is a double-charged customer. If a POST fails ambiguously, surface the error and let idempotency keys (an application concern) handle safe retry.

## Common pitfalls

1. **Trusting `'*'` on a directly reachable app.** Teams copy it from a tutorial written for Heroku or an ALB-only setup, and it works flawlessly — while silently letting every client forge its IP. Correct approach: CIDR of your proxy tier; `'*'` only when network controls make direct access impossible (you proved the attack yourself in Step 3).
2. **Forgetting `proxy_set_header Host $host;`.** Nginx's default sends the *upstream name* (`tickethub_app`) as `Host`, so the backend's `server_name` never matches, the default vhost answers, and Laravel generates URLs for the wrong hostname. People miss it because `proxy_pass` appears to work without it. Correct approach: the four-header block from section 7, as a unit, every time.
3. **Wiring the deep health check into the balancer.** It feels *more* rigorous — "don't send traffic to an instance whose DB is down!" — but the DB is shared, so all instances fail together and the balancer amputates the whole pool. Correct approach: shallow (`/up`) for traffic decisions, deep (`/api/health`) for alerting, with short probe timeouts so checks can't pile up.
4. **Reaching for sticky sessions instead of shared state.** Stickiness makes the login bug vanish in five minutes, so it ships — then a deploy logs out half the users pinned to the recycled server, and load skews 70/30. Correct approach: shared session store (database today, Redis in Module 5), S3 for files; stickiness only as a labeled, temporary bridge.
5. **Testing failover with GETs and concluding retries are safe.** GET retries hide the danger; the first ambiguous POST timeout that gets retried creates a duplicate order (TicketHub's oversell invariant says hello). Correct approach: leave nginx's non-idempotent protection alone, and test failure behavior with writes, not just reads.

## Exercises

1. With trusted proxies set to `['10.0.0.0/16']`, list what `$request->ip()`, `$request->isSecure()`, and `url('/x')` return for (a) a direct HTTPS client and (b) a request forwarded by a future LB at `10.0.0.5` with correct headers. Explain each value in one sentence.
2. Extend `HealthController` with a `storage` check (`Storage::disk('local')->put('health-probe.txt', 'ok')` then delete). Decide — and defend in two sentences — whether it belongs in the balancer's check or only in monitoring's, considering what happens when a disk fills on *one* server of two.
3. On paper, trace a request through CDN → nginx LB → app server, writing `X-Forwarded-For` after each hop for client `198.51.100.7`, CDN node `192.0.2.44`, LB `10.0.0.5`. Which entries does the app believe with `at: ['10.0.0.0/16']`, and what must change when the CDN is added?
4. Simulate passive health checking on one box: add `listen 127.0.0.1:8081;` to the TicketHub server block, then create a local balancer vhost on `127.0.0.1:8080` whose upstream lists `127.0.0.1:8081` plus a dead backend `127.0.0.1:9999 max_fails=1 fail_timeout=30s`. From the VPS, send 20 requests to `:8080` and use the error log to show nginx detecting the dead backend and routing around it. What would real users have experienced?
5. **Stretch — build the real thing:** rent a second cheap VPS for an evening. Replicate the app tier (Lecture 3.3) on it, convert your original box's public vhost into the section-7 balancer config with both backends, and demonstrate: (a) requests alternating under `least_conn`, (b) killing PHP-FPM on one backend while a `curl` loop shows zero failures, (c) a drain-deploy-restore cycle with `down` + reload. Tear it down after — and note how much of tonight's work Module 8's ALB does for you.

## What's next

Module 3 is complete: TicketHub runs live at `https://api.tickethub.example` on a hardened VPS — Nginx, PHP-FPM, MySQL and Redis, TLS that renews itself, proxy-ready and health-checkable. It is also deployed by typing five commands over SSH, with a window where users can see a broken app, and no record of *which* code is running in production. Before automating that away, the team needs disciplined version control: branching, reviews, and releases you can point a pipeline at. That's [Module 4 — Git & Collaboration Workflows](../module-04-git-collaboration/). (The hand-rolled balancer you studied today returns in Module 8 as AWS's managed ALB — same concepts, wearing a console.)
