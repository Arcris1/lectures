# Lecture 5.2 — Environment Config & Secrets Hygiene

> **Module 5 — Configuration & the Twelve-Factor App** · Lecture 2 of 3 · Estimated time: ~70 min

[Lecture 5.1](01-twelve-factor-laravel.md) gave factor III one paragraph and a promise. This lecture pays it, because Laravel's config layer is both genuinely elegant and genuinely booby-trapped: the mechanism that makes "config in the environment" fast — `php artisan config:cache` — turns one innocent-looking function call into a bug that *only exists in production*. Nearly every Laravel team ships that bug exactly once. You'll ship it on purpose, watch it fail, then make it structurally impossible to ship again. The second half is hygiene: which values are actually *secrets*, where each lives today, what `APP_KEY` really protects and how to rotate it without logging out every customer, and how a deploy refuses to proceed when required config is missing.

## Learning objectives

- Trace a value from `.env` through phpdotenv and `config/*.php` into `config()`, and state exactly where `config:cache` cuts that path
- Diagnose and permanently fix the classic `env()`-outside-config bug that works locally and returns `null` in production
- Write `.env` files that parse the way you expect — quoting, type coercion, precedence — and maintain `.env.example` as a reviewed contract
- Explain what `APP_KEY` encrypts and signs in Laravel 12, what leaking or changing it costs, and rotate it safely with `APP_PREVIOUS_KEYS`
- Classify values as secrets versus plain config, place each correctly for every current environment, and name the maturity ladder ahead
- Ship a fail-fast `config:validate` artisan command and wire it into the deploy sequence

## 1. How a value actually reaches your code

Laravel configuration is a two-layer pipeline, and every config bug you will ever debug is a failure to respect the boundary between the layers.

**Layer 1 — the environment.** At boot, Laravel hands `.env` to [phpdotenv](https://github.com/vlucas/phpdotenv), which parses it and merges the values into the process environment. The `env()` helper reads from that merged view. Crucially, phpdotenv is *immutable*: a variable that already exists in the real process environment is **not** overwritten by `.env`. Hold that thought for section 3.

**Layer 2 — the config repository.** During the same boot, every file in `config/` is evaluated once; each returns a plain PHP array, merged into an in-memory repository keyed by filename. `config('services.stripe.secret')` means "the `['stripe']['secret']` element of what `config/services.php` returned." This repository — not the environment — is what application code reads.

The only place the layers touch is inside the config files themselves:

```php
// config/services.php — the ONLY place env() belongs
'stripe' => [
    'key' => env('STRIPE_KEY'),
    'secret' => env('STRIPE_SECRET'),
],
```

```php
// Anywhere in app/ — read the repository, never the environment
$secret = config('services.stripe.secret');
```

Why two layers? **Structure and defaults** — the config file gives every value a home and a sane default, so the environment carries only deviations. **One audited seam** — everything the environment can do to your app is enumerable by reading `config/`. And **cacheability** — layer 2 can be compiled to one file and layer 1 skipped entirely. That last property is a real performance win and a loaded gun.

So, the rule, enforced forever: **`env()` may be called only inside `config/*.php`. All application code — controllers, jobs, services, middleware, views — reads `config()`.** Not a style preference; a correctness requirement.

## 2. `config:cache`, and the bug it hands every team once

`php artisan config:cache` boots the framework, evaluates every `config/*.php` file *with the environment fully loaded*, and writes the entire resolved repository to one file: `bootstrap/cache/config.php`. Every subsequent boot loads that file and **skips `.env` loading entirely** — no phpdotenv, one `require`. Hundreds of `env()` calls collapse into one opcache-friendly array, and a release gets frozen, known config — a factor V property Module 9's pipeline will formalize.

The consequence: with config cached, `env()` sees only the *real* process environment. On the VPS, where every value lives in `.env` and nowhere else, **`env('ANYTHING')` returns `null`**. And in [Lecture 5.1's](01-twelve-factor-laravel.md) hands-on you started running `config:cache` on the VPS. The gun is loaded.

Watch the classic misfire. TicketHub is finally taking payments, and a well-meaning teammate wires up Stripe like this:

```php
<?php

namespace App\Services;

use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;

class StripeGateway
{
    /**
     * Create a PaymentIntent for an order total (smallest currency unit).
     */
    public function createPaymentIntent(int $amountCents, string $currency = 'usd'): Response
    {
        return Http::withToken(env('STRIPE_SECRET'))   // ← the bug
            ->asForm()
            ->post('https://api.stripe.com/v1/payment_intents', [
                'amount' => $amountCents,
                'currency' => $currency,
                'automatic_payment_methods[enabled]' => 'true',
            ])
            ->throw();
    }
}
```

On the laptop this works perfectly — local config isn't cached, so `env('STRIPE_SECRET')` returns the test key. Tests pass; review approves — the call *looks* idiomatic. Then it deploys, `config:cache` runs, and the first customer to check out produces this in the FPM log:

```
$ sudo tail -n 4 /var/log/php8.4-fpm.log
[2026-08-09 21:04:11] production.ERROR: HTTP request returned status code 401:
{"error":{"message":"You did not provide an API key. You need to provide your
API key in the Authorization header, using Bearer auth ...","type":"invalid_request_error"}}
```

Three properties make this a classic. It is **silent** — nothing failed at boot; `null` just flowed into a header. It is **production-only** — the one environment that caches config is the one you didn't test. And it is **intermittent across platforms**: where a variable exists as a *real* env var (containers, CI), `env()` still resolves it even with config cached. A function whose behavior depends on *how the environment was delivered* is not a function application code may call.

The fix is mechanical. Give the value a home in the repository — `config/services.php` is the conventional home for third-party credentials:

```php
// config/services.php
'stripe' => [
    'key' => env('STRIPE_KEY'),
    'secret' => env('STRIPE_SECRET'),
    'webhook_secret' => env('STRIPE_WEBHOOK_SECRET'),
],
```

Then read the repository:

```php
return Http::withToken(config('services.stripe.secret'))
```

Cached or not, `config()` always works, because the cache *is* the repository. The hands-on ships this properly, plus the enforcement that keeps it fixed.

## 3. Dotenv mechanics: parsing, types, precedence

`.env` looks like shell syntax but isn't — phpdotenv has its own rules, and secrets are exactly the values that trip them:

```dotenv
APP_NAME=TicketHub                 # fine: single token, no specials
APP_NAME="TicketHub API"           # spaces require quotes
MAIL_FROM_NAME="${APP_NAME}"       # ${VAR} expansion works inside double quotes
DB_PASSWORD=s3cret#2026            # DANGER: '#' can start a comment — value truncated
DB_PASSWORD="s3cret#2026"          # correct: quote anything with # $ " ' or spaces
WELCOME="Line one\nLine two"       # double quotes interpret \n; single quotes don't
```

The `#`-truncation failure is nasty because generated passwords often contain `#` or `$`: authentication fails in exactly one environment while the value *looks* right in the file. Adopt the blanket rule — quote any value that isn't a plain single token. Laravel's `env()` also coerces on the way out: `"true"`/`"false"` become booleans, `"null"` becomes `null`, `"empty"` becomes `''` — which is why `APP_DEBUG=false` is a real boolean and not a truthy string.

**Precedence: real environment variables always beat `.env`.** Because phpdotenv won't overwrite existing variables, anything set at the process level wins:

```
$ STRIPE_SECRET=sk_test_from_process_env php artisan tinker --execute="echo config('services.stripe.secret');"
sk_test_from_process_env
```

Today that's a party trick. From Module 6 on it is the entire mechanism: containers, GitHub Actions, ECS, and Kubernetes all inject *real* env vars, and `.env` — if present at all — merely fills gaps. One nuance to carry forward: with config cached, precedence was settled *at cache time*. That is why containerized Laravel re-runs `config:cache` in its entrypoint at startup, after the platform has injected the environment — Module 6 builds exactly that.

When config misbehaves, three commands and one diagnostic settle every argument:

| Symptom | Do this |
|---|---|
| "What value is the app *actually* using?" | `php artisan config:show services` — shows the resolved repository (it prints secrets: never paste output into chat or tickets) |
| "I changed `.env` and nothing happened" | Config is cached: `config:cache` to refresh (deploy targets) or `config:clear` to return to live reads (local) |
| "Is config cached right now?" | `php artisan about` — the `Config` row reads `CACHED` or `NOT CACHED` |
| "Workers still see old values" | They hold config in memory — `sudo systemctl restart tickethub-worker` (from 5.1) |

## 4. `.env.example` is a contract, not a courtesy

`.env` never enters Git — Module 4 put it in `.gitignore` on day one. But the *set of variables the app needs* is real, load-bearing knowledge that must live somewhere reviewable. That somewhere is `.env.example`, with four properties:

- **Complete.** Every variable the app reads appears, even usually-empty ones. A variable that exists only in one engineer's `.env` and on the production server is tribal knowledge waiting to become a 2 a.m. incident.
- **Commented.** Each non-obvious entry says what it does and where to get a value — the file doubles as onboarding docs.
- **Safe defaults.** Local-appropriate values for everything non-secret, so a fresh clone boots; secrets present but **empty** — never real values, not even "harmless" staging ones (Module 4's bots don't read labels).
- **Updated in the same PR that adds the variable.** The reviewer checklist line: *"New env var? Then `.env.example`, the `config/*.php` entry, and — if required — the `config:validate` list all changed in this diff."* Config drift enters through the gap between "code merged" and "example updated."

Here is the block the hands-on adds for payments:

```dotenv
# --- Payments (Stripe) -------------------------------------------------
# Test-mode keys: https://dashboard.stripe.com/test/apikeys
# STRIPE_KEY is the publishable key (safe for browsers).
# STRIPE_SECRET and STRIPE_WEBHOOK_SECRET are secrets — never commit values.
STRIPE_KEY=pk_test_replace_me
STRIPE_SECRET=
STRIPE_WEBHOOK_SECRET=
```

The cheap test that keeps the contract honest: on a fresh clone, `cp .env.example .env`, generate a key, migrate, seed. If the app doesn't boot, the example is incomplete — fix it now, while you remember what was missing.

## 5. `APP_KEY`: the secret Laravel itself depends on

`APP_KEY` is a random 32-byte key (stored base64-encoded) that Laravel 12 uses for symmetric encryption (AES-256-CBC) and signing. Concretely, it protects:

- **Every cookie Laravel issues** — the `EncryptCookies` middleware encrypts them all by default, including the session cookie that identifies a logged-in user
- **Session payloads**, if you enable `SESSION_ENCRYPT=true` (TicketHub leaves this off; the cookie is the sensitive part)
- **Anything through `Crypt::` / `encrypt()`** and every **encrypted Eloquent cast** (`'encrypted'`, `'encrypted:array'`, …)
- **Signed URLs** — `URL::signedRoute()` / `temporarySignedRoute()` append an HMAC computed with `APP_KEY`. TicketHub's ticket QR codes encode exactly such a signed verification URL — the key is what makes a QR code unforgeable

What it does *not* touch: passwords, which are bcrypt-hashed with no key involved. A leaked `APP_KEY` reveals no passwords; a changed one invalidates none.

Generate with `php artisan key:generate` (writes `.env` in place; asks confirmation in production). `--show` prints a key without writing — you'll want that during rotation.

The two failure modes drive the operational rules. **If `APP_KEY` leaks**, an attacker can decrypt captured cookies and impersonate sessions, can forge signed URLs — for TicketHub, *mint valid ticket QR codes* — and, combined with a database leak, decrypt every encrypted cast. Treat it as a sev-1 secret. **If `APP_KEY` changes without ceremony**, every cookie in the wild becomes undecryptable — all users logged out at once — and every encrypted cast throws a `DecryptException` on read. That fear is why teams never rotate, which is the wrong lesson.

The right lesson is Laravel 12's rotation mechanism:

```dotenv
APP_KEY=base64:JDoXGNVryqCkGE0jJZKzGP1DdlyQzmRHkVjjDruQpDE=
APP_PREVIOUS_KEYS=base64:2A1BUYaJRrLhpzUikDo3vjK4T5T24rBoSpDoI9zVSnM=
```

Encryption and signing always use `APP_KEY`; decryption tries `APP_KEY` first, then each comma-separated entry in `APP_PREVIOUS_KEYS`. Rotate by moving the old key into the previous list and putting a fresh key in `APP_KEY`: existing sessions keep working, old ciphertext keeps decrypting, everything newly written uses the new key. Then, at leisure, re-encrypt long-lived data and — after the session lifetime plus a margin — drop the previous key. Two cautions: long-lived signed URLs (like printed QR codes) are HMACs of a specific key, so verify after rotation that outstanding links still validate on your Laravel version, and regenerate them if not; and rotation only helps if rehearsed — the hands-on runs the drill.

## 6. `APP_DEBUG=false`, because the error page is a dossier

With `APP_DEBUG=true`, an unhandled exception renders Laravel's debug page: exception class and message, a code excerpt around the failing line, the full stack trace with absolute paths, **every request header** (including `Authorization` bearer tokens and cookies), routing details, and the request body. The *messages themselves* leak too: a `QueryException` embeds the full SQL with bindings substituted — customer emails in a `WHERE` clause, your schema in the `SELECT` — and a failed connection prints `Access denied for user 'tickethub'@'127.0.0.1'`, handing over the DB username and topology.

History says it gets worse: older debug stacks (Whoops) dumped the entire environment — `.env` included — onto the page, and Ignition's debug mode had CVE-2021-3129, an unauthenticated remote-code-execution hole. That era trained a generation of scanners, and they never stopped:

```
$ sudo grep -E "\.env|_ignition" /var/log/nginx/access.log | tail -3
185.220.101.34 - - [09/Aug/2026:19:41:07 +0000] "GET /.env HTTP/1.1" 404 153 "-" "Mozilla/5.0"
185.220.101.34 - - [09/Aug/2026:19:41:08 +0000] "POST /_ignition/execute-solution HTTP/1.1" 404 153 "-" "Mozilla/5.0"
103.94.157.21 - - [09/Aug/2026:20:02:44 +0000] "GET /.env.backup HTTP/1.1" 404 153 "-" "curl/8.5.0"
```

Those 404s are Module 3's Nginx config earning its keep (dotfiles refused, only `index.php` executed) — but the probes are permanent background radiation, and they are why this lecture is paranoid about where `.env` contents can surface.

The rule is absolute: **`APP_DEBUG=false` in production, always.** Failures render a bland 500; the detail goes to logs (stderr → journald today, aggregation in Module 12), where it belongs. Humans forget absolute rules, so `config:validate` below enforces this one mechanically.

## 7. Secrets: definition, lifecycle, and where they live

A **secret** is any value that *grants access or capability*: if it leaks, someone can do something — read your database, charge cards, sign QR codes, send mail as you. Everything else in the environment is **plain config**: it varies between deploys but grants nothing. The distinction matters because secrets and config have different storage, sharing, and rotation rules:

| Value | Class | Why |
|---|---|---|
| `DB_PASSWORD`, `STRIPE_SECRET`, `STRIPE_WEBHOOK_SECRET`, `APP_KEY`, `AWS_SECRET_ACCESS_KEY`, SMTP credentials | **Secret** | Each grants a capability to whoever holds it |
| `STRIPE_KEY` (`pk_…`) | Config (public by design) | The *publishable* key ships to browsers; it's env because it varies test/live — the `KEY`/`SECRET` naming is a classification trap |
| `APP_URL`, `AWS_DEFAULT_REGION`, `MAIL_FROM_ADDRESS`, `APP_DEBUG` | Plain config | Varies between deploys; grants nothing |
| Queue names, the 15-minute reservation window, routes | Code | Doesn't vary between deploys at all — [Lecture 5.1](01-twelve-factor-laravel.md), factor III |

Secrets then obey three lifecycle rules, each anchored to a module:

1. **Never in Git.** You rehearsed the failure in Module 4: if a secret is ever pushed, *rotate it first, then* scrub history with `git filter-repo` — rewriting never un-leaks anything; rotation does.
2. **Never in images.** A Docker image is an archive anyone with pull access can unpack; a secret baked into a layer is published, not deployed. Module 6's `.dockerignore` excludes `.env` from the build context on day one.
3. **Never in logs.** Stack traces, request dumps, and chatty debug lines love to embed tokens. Module 12 adds structured logging with redaction; until then, the discipline is not logging request bodies or config wholesale.

**Where secrets live today** — an interim posture, stated honestly. On your laptop: `.env`, holding *test-mode* credentials only, so a stolen laptop costs embarrassment, not money. On the VPS: `.env` owned `deploy:www-data`, mode `640` — deploy edits it, FPM's group reads it, nobody else can — behind an app root tightened to `750` so other local users can't traverse in at all. Note that `bootstrap/cache/config.php` *is your `.env`, compiled*: every secret in plaintext, sheltering behind the same wall. (Some teams run `.env` at `600` with only the cached config group-readable — tighter, but it breaks the moment anything boots uncached; `640` is the robust interim.)

And the ladder ahead, so you know today's posture is a stage, not the standard:

| Stage | Where secrets live | How they reach the app | Module |
|---|---|---|---|
| Local (today) | `.env` on the laptop — test-mode values only | phpdotenv at boot | now |
| VPS (today) | `.env`, `deploy:www-data`, mode `640`, behind a `750` app root | phpdotenv, compiled into cached config at deploy | now |
| Containers | Runtime-injected env vars — never baked into the image | Compose `env_file` / `-e`; `.dockerignore` keeps `.env` out | 6 |
| AWS (ECS era) | SSM Parameter Store (SecureString) and Secrets Manager | Task definition `secrets` → injected as env at container start | 8–9 |
| Kubernetes | AWS Secrets Manager, synced by External Secrets | `tickethub-secrets` Secret → env/file mounts | 11 |
| Mature posture | All of the above + rotation schedules, access audit, log redaction | — | 12 |

Each rung adds what the previous lacked: central storage, per-secret access control, an audit trail, rotation without touching servers. The `.env` era has none of the four — acceptable at one VPS, and exactly what you outgrow first.

## Hands-on with TicketHub

**1. Load the trap, then spring it.** On the laptop, add test keys to `.env`, create `app/Services/StripeGateway.php` exactly as broken in section 2, and prove it "works":

```
$ php artisan tinker --execute="var_dump(env('STRIPE_SECRET'));"
string(37) "sk_test_tickethub_fake_key_do_not_use"
```

Commit, push, deploy the current naive way, adding live keys to the VPS `.env` by hand. Then watch production disagree with your laptop:

```
$ ssh tickethub
$ cd /var/www/tickethub && git pull --ff-only && composer install --no-dev
$ php artisan config:cache
$ php artisan tinker --execute="var_dump(env('STRIPE_SECRET'), config('services.stripe.secret'));"
NULL
NULL
```

Cached config, so `.env` never loaded: `env()` is `null`, and `config()` is `null` too because no config file maps it yet. This double-`NULL` *is* the outage from section 2, caught in a terminal instead of a checkout.

**2. Fix it structurally.** Add the `stripe` block to `config/services.php`, switch the gateway to `config('services.stripe.secret')`, and update `.env.example` with the commented payments block — all in one PR, per the contract. Deploy, re-cache, verify:

```
$ php artisan config:cache && php artisan tinker --execute="var_dump(env('STRIPE_SECRET'), config('services.stripe.secret'));"
NULL
string(37) "sk_live_tickethub_fake_key_do_not_use"
$ php artisan config:show services
  services ...............................................................
  stripe.key ................................................ pk_live_51Hf...
  stripe.secret ............................................. sk_live_51Hf...
  stripe.webhook_secret ..................................... whsec_dK92...
```

`env()` is *still* `null` in production — and now it doesn't matter, which is the whole point of the config layer.

**3. Make the rule mechanical.** One grep answers "did anyone call `env()` outside `config/`":

```
$ grep -rn "env(" app/ --include="*.php"
$
```

Empty output or the build fails — Module 7 adds exactly this (plus Larastan) as a required PR check. Run it now to catch strays from Modules 1–4.

**4. Lock the files down.** Check what the VPS currently exposes, then apply section 7's posture:

```
$ ls -l /var/www/tickethub/.env
-rw-r--r-- 1 deploy deploy 1482 Aug  9 20:31 /var/www/tickethub/.env
$ sudo chown deploy:www-data /var/www/tickethub/.env
$ sudo chmod 640 /var/www/tickethub/.env
$ sudo chown deploy:www-data /var/www/tickethub
$ sudo chmod 750 /var/www/tickethub
```

`www-data` (Nginx, FPM, the worker) traverses via group; any other account now hits a wall at the app root — which also shields the cached config and everything inside.

**5. Rehearse the key rotation.** Encrypt a canary under the current key, rotate, prove old ciphertext still opens:

```
$ php artisan tinker --execute="echo Crypt::encryptString('rotation-proof');"
eyJpdiI6IjRRbGF2TmpZQ3M0Snc2c1Bxc2xkQmc9PSIsInZhbHVlIjoi...
$ php artisan key:generate --show
base64:JDoXGNVryqCkGE0jJZKzGP1DdlyQzmRHkVjjDruQpDE=
```

Edit `.env`: move the old `APP_KEY` value into `APP_PREVIOUS_KEYS`, paste the new key into `APP_KEY` (`--show` avoided `key:generate` overwriting the file before you'd staged the old key). Then:

```
$ php artisan config:cache
$ php artisan tinker --execute="echo Crypt::decryptString('eyJpdiI6IjRRbGF2TmpZQ3M0Snc2c1Bxc2xkQmc9PSIsInZhbHVlIjoi...');"
rotation-proof
```

Logged-in users never noticed: their cookies decrypt via the previous key, and their next response re-encrypts with the new one. Leave both keys in place — removing the previous key is a deliberate later step, after re-encrypting persisted data and letting sessions age out.

**6. Ship `config:validate`.** The command that makes "deploy with broken config" impossible. Laravel 12 auto-discovers it in `app/Console/Commands/`:

```php
<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;

class ValidateConfig extends Command
{
    protected $signature = 'config:validate';

    protected $description = 'Fail fast when required configuration is missing or unsafe for this environment';

    /**
     * Config keys (repository keys — never env var names) that must be
     * non-empty in every environment.
     *
     * @var list<string>
     */
    private array $requiredEverywhere = [
        'app.key',
        'app.url',
        'database.connections.mysql.host',
        'database.connections.mysql.database',
        'database.connections.mysql.username',
        'redis.default.host',
        'queue.connections.redis.retry_after',
    ];

    /**
     * Additionally required in staging and production.
     *
     * @var list<string>
     */
    private array $requiredInProduction = [
        'database.connections.mysql.password',
        'services.stripe.key',
        'services.stripe.secret',
        'mail.from.address',
    ];

    public function handle(): int
    {
        $required = $this->requiredEverywhere;

        if (app()->environment(['staging', 'production'])) {
            $required = [...$required, ...$this->requiredInProduction];
        }

        $problems = collect($required)
            ->filter(fn (string $key) => blank(config($key)))
            ->map(fn (string $key) => "Missing required config value: {$key}")
            ->values();

        if (app()->environment('production') && config('app.debug')) {
            $problems->push('APP_DEBUG is true in production. Error pages would leak internals.');
        }

        if ($problems->isNotEmpty()) {
            $problems->each(fn (string $problem) => $this->error($problem));

            return self::FAILURE;
        }

        $this->info(sprintf(
            'Config OK: %d required values present in the "%s" environment.',
            count($required),
            app()->environment(),
        ));

        return self::SUCCESS;
    }
}
```

Deploy it, then prove both paths on the VPS — success first, then sabotage:

```
$ php artisan config:validate
Config OK: 11 required values present in the "production" environment.
$ sed -i 's/^STRIPE_SECRET=.*/STRIPE_SECRET=/' .env && php artisan config:cache
$ php artisan config:validate; echo "exit: $?"
Missing required config value: services.stripe.secret
exit: 1
```

Restore the value, re-cache, and write the command into its permanent home — the deploy sequence, *after* caching (so it validates the compiled truth the app will read) and *before* migrations (so a broken deploy stops without touching the database):

```
$ git pull --ff-only
$ composer install --no-dev
$ php artisan config:cache
$ php artisan config:validate     # ← new: non-zero exit aborts the deploy here
$ php artisan migrate --force
$ sudo systemctl restart tickethub-worker
```

Today that sequence is your fingers; from Module 9 it is a pipeline, and this line is why a mis-configured release never reaches `migrate`.

## Real-world best practices

- **Enforce "`env()` only in `config/`" mechanically, not culturally.** A grep gate or Larastan rule in CI (Module 7) costs minutes; relying on reviewers to spot an idiomatic-looking call costs an outage per new hire. Properties you keep are properties a machine checks.
- **Cache and validate on every deploy; never cache in local dev.** Production always runs compiled config (`php artisan optimize` bundles this from Module 9 on); laptops never do, because a stale local cache wastes hours on "impossible" behavior. The environments differ here *on purpose* — cached config is a release property, not a dev convenience.
- **Treat `bootstrap/cache/config.php` with `.env`-level paranoia.** It is the same secrets, compiled. Permissions, backup excludes, and Module 6's `.dockerignore` must cover both files, not just the famous one.
- **Classify by capability, not by name.** `STRIPE_KEY` is public; `STRIPE_SECRET` is not; `APP_KEY` outranks both. A five-minute classification pass over `.env.example` decides storage, sharing, and rotation policy for every value — skip it and you'll guard harmless values while pasting dangerous ones into Slack.
- **Rehearse rotation before you need it.** `APP_PREVIOUS_KEYS` makes rotation boring, and the drill takes ten minutes. Teams that never rehearse discover mid-leak that rotation means "log out every user and corrupt encrypted data," so they don't rotate — which is how a leaked key stays valid for years.
- **Keep secrets out of every side channel.** `config:show` output, tinker sessions in shared terminals, screenshots, CI logs, error trackers. Disciplined storage is worth zero if the value leaks through observability — Module 12 closes that loop with redaction.

## Common pitfalls

1. **Calling `env()` in application code because it works on your machine.** It does — until config is cached where you didn't test. People do it because the call reads naturally and nothing breaks locally. Correct approach: the section 1 rule, the grep gate, and a `config/*.php` entry for every value the app reads.
2. **Running `config:cache` locally to "match production," then losing an afternoon.** Every `.env` edit silently stops working and `env()` returns `null` in tinker. Correct approach: never cache in dev; if debugging cache behavior, do it deliberately and `config:clear` afterward — `php artisan about` tells you which state you're in.
3. **Editing `.env` on the server and reloading nothing.** With cached config the edit changes *nothing*; without it, FPM picks it up but the worker holding config in memory doesn't. Either way two components now disagree about reality. Correct approach: the deploy sequence, every time — re-cache, validate, restart long-lived processes.
4. **Unquoted special characters silently truncating a secret.** A password containing `#` or spaces parses shorter, and authentication fails in exactly one environment with credentials that "look identical." Correct approach: quote everything that isn't a plain single token; verify with `config:show`, not eyeballs.
5. **Closures or objects in config files.** `config:cache` serializes with `var_export()`, so the first deploy after adding a closure dies with "Your configuration files are not serializable." Correct approach: config holds scalars and arrays; put behavior behind class-strings the code resolves.
6. **Sharing "the real `.env`" over Slack or a zip to onboard someone.** Every copy is an uncontrolled, unexpiring credential store, and revoking access later means rotating everything anyway. Correct approach: `.env.example` plus a proper secrets channel (password manager today, Parameter Store from Module 8) — and if a real file escaped, Module 4's order: rotate first, then clean up.

## Exercises

1. **Map the surface.** Using `php artisan config:show database` and `config:show queue`, list every env var feeding those files on the VPS with its classification (secret / config / shouldn't-be-env-at-all) and where it will live at the Module 8 rung of the ladder. You should find `REDIS_QUEUE_RETRY_AFTER` from 5.1 — argue whether it is config or code.
2. **Add a variable end-to-end.** TicketHub must verify `STRIPE_WEBHOOK_SECRET` on incoming webhooks. Do the full contract in one PR: `.env` (both machines), `.env.example` with a comment, `config/services.php`, a `config()` read-site, and the `config:validate` production list. Review against section 4's four properties.
3. **Break it, diagnose it, write it down.** On the laptop, cache config, change a `.env` value, and watch the app ignore it; probe with `env()`, `config()`, `config:show`, and `about` until the state is obvious; then `config:clear`. Write the five-line diagnosis flow you'd hand a junior at 2 a.m., and note why container platforms re-cache at start instead of never caching.
4. **Harden `config:validate`.** Extend it: fail if `app.key` doesn't start with `base64:` or decodes to fewer than 32 bytes; fail in production when `logging.default` isn't `stderr` (protecting 5.1's decision); add a `--warn` flag that reports without failing. Keep exit codes honest — CI will trust them in Module 7.
5. **Stretch: production key rotation, end to end.** Write and execute a runbook that rotates `APP_KEY` on the VPS with zero logouts: pre-checks (encrypted-cast inventory, outstanding signed QR URLs), the `APP_PREVIOUS_KEYS` rotation, verification (a logged-in curl session surviving it), the re-encryption plan, criteria for removing the old key, and rollback steps. Keep it in the repo under `docs/runbooks/` — it becomes a Module 12 artifact.

## What's next

Config now flows through one audited seam, secrets have homes and a rotation story, and deploys fail fast when either is broken. But a correctness problem remains in plain sight: your laptop runs SQLite and a `sync` queue while production runs MySQL and Redis, so entire *classes* of bugs — schema rules, query strictness, job serialization timing — are invisible until they reach the VPS. [Lecture 5.3 — Environment Parity](03-environment-parity.md) reproduces those failures with real error messages, makes the parity decisions config alone can close, and builds the honest argument for why the remaining gaps hand you to Module 6 and containers.
