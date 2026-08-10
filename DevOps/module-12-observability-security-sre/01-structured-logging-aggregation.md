# Lecture 12.1 — Structured Logging & Aggregation

> **Module 12 — Observability, Security & SRE** · Lecture 1 of 5 · Estimated time: ~90 min

TicketHub now runs on a platform you can be proud of: EKS with GitOps, Terraform-born infrastructure, progressive delivery. But when something goes wrong at 19:03 during an on-sale, none of that answers the only question that matters: *what is happening, right now, inside the system?* Answering it is the discipline called observability, and this module builds it in three layers — logs, metrics, traces — then uses them to run the system like an SRE team. This lecture takes the log stream you have had since Module 5 (`LOG_CHANNEL=stderr`) and turns it from text you *read* into data you *query*: structured JSON, request-scoped context that survives the trip through Horizon, a collection pipeline on EKS, and CloudWatch Logs Insights queries that reconstruct one order's entire life in seconds.

## Learning objectives

- Position logs, metrics, and traces as complementary signals and state which questions each answers
- Configure Laravel 12 to emit structured JSON logs to stderr with Monolog, a real log-level policy, and redaction of sensitive keys
- Propagate a correlation ID from nginx through PHP-FPM into queued jobs using Laravel's `Context` facade, and join app logs with access logs on it
- Explain the EKS log pipeline — container stdout, kubelet files, Fluent Bit DaemonSet, CloudWatch Logs — and configure each stage
- Write CloudWatch Logs Insights queries that answer production questions: error rates, one request's story, top exceptions, anomalies
- Control log volume and cost with retention policies and per-environment log levels

## 1. Three signals, one goal

Observability is the ability to ask new questions of a running system without shipping new code to answer them. In practice it rests on three signal types, and confusing them wastes both money and incident time:

| Signal | Shape | The question it answers | Cost model |
|---|---|---|---|
| **Logs** | Discrete, timestamped events with arbitrary detail | *What exactly happened at this point?* | Pay per byte ingested/stored — verbosity is the cost lever |
| **Metrics** | Pre-aggregated numbers over time | *Is it healthy now? What's the trend?* (Lecture 12.2) | Pay per time series — label cardinality is the cost lever |
| **Traces** | A tree of timed spans per request | *Where did the time go, across services?* (Lecture 12.3) | Pay per trace — sampling rate is the cost lever |

We seed this table now and complete it — including "which one do I open first during an incident" — in [Lecture 12.3](03-tracing-apm.md). This lecture is about logs, the oldest signal and the one you already emit. Module 5 applied factor XI (*logs are event streams*): TicketHub writes to stderr, Docker and the kubelet capture it, `kubectl logs` shows it. That solved *transport*. It did not solve *retrieval*: with 6 web pods and 4 Horizon pods, `kubectl logs` is ten separate streams that vanish when pods do. Aggregation plus structure solves retrieval.

## 2. Structured vs unstructured: the same event, twice

Here is a failed order the way most Laravel apps log it:

```
[2026-08-07 12:03:41] production.ERROR: Payment failed for order 48211 (user 8712, gateway timeout after 3 retries)
```

Human-friendly, machine-hostile. To find all gateway timeouts you grep for prose — `grep "gateway timeout"` — and your query breaks the day someone rewords the message. Counting failures per event, or filtering to one user, means regex archaeology. Now the same event structured:

```json
{"message":"Payment failed","context":{"order_id":48211,"gateway":"stripe","reason":"timeout","attempts":3},"level":400,"level_name":"ERROR","channel":"production","datetime":"2026-08-07T12:03:41.512+00:00","extra":{"request_id":"01K20FZ7Q2V4X9J8R3T1B5N6M7","user_id":8712,"route":"orders.pay"}}
```

The message is a stable, short label; every variable is a **field**. Fields enable queries instead of greps:

```
filter message = "Payment failed" and context.gateway = "stripe"
| stats count() by context.reason, bin(15m)
```

That is a question — "Stripe failure reasons in 15-minute buckets" — not a text search. Structure is what makes every later section of this lecture possible: joining app and access logs, following a request into a queue worker, grouping exceptions. The rule: **messages are constant strings; data goes in fields.** If you find yourself interpolating a variable into a log message, you are about to write an ungreppable, unqueryable log line.

## 3. Laravel logging done properly

Module 5 pointed `LOG_CHANNEL` at a plain stderr channel. Upgrade it to JSON with Monolog's `JsonFormatter` and processors in `config/logging.php`:

```php
use App\Logging\RedactSensitiveContext;
use Monolog\Formatter\JsonFormatter;
use Monolog\Handler\StreamHandler;
use Monolog\Processor\PsrLogMessageProcessor;

'channels' => [
    // ...
    'stderr' => [
        'driver' => 'monolog',
        'level' => env('LOG_LEVEL', 'info'),
        'handler' => StreamHandler::class,
        'formatter' => JsonFormatter::class,
        'with' => [
            'stream' => 'php://stderr',
        ],
        'processors' => [
            PsrLogMessageProcessor::class,   // interpolates {placeholders} per PSR-3
            RedactSensitiveContext::class,   // Section 6
        ],
    ],
],
```

No env change needed — `LOG_CHANNEL=stderr` has been set since Module 5; the channel's *format* changed, which ships like any other code change through the Module 11 pipeline. One line of housekeeping: Monolog's `JsonFormatter` escapes newlines inside values, so a multi-line exception message cannot forge a second, fake log line — log injection via user input is neutralized by the format itself.

### Log levels: a policy, not a vibe

Levels only help if the team agrees what they mean. TicketHub's policy, which you can adopt wholesale:

| Level | Meaning | TicketHub examples |
|---|---|---|
| `debug` | Developer detail; **local/staging only** | SQL bindings, cache hit/miss detail, payload dumps |
| `info` | A state change worth auditing later | Order placed, payment captured, tickets issued, reservation created |
| `warning` | Handled, but odd — no action needed *yet* | Payment retry succeeded, reservation expired holding items, feature-flag fallback used |
| `error` | An operation failed and needs attention | `GenerateTicketPdf` failed after all retries, S3 upload rejected, mail bounce |
| `critical` | Wake someone up | **Overselling detected** — the Module 1 invariant violated; payment captured with no order row |

Two disciplines make the policy work. First, **log at the boundary, once, with context**. When a job fails, log one `error` where the failure is finally handled — with order ID, attempt count, and the exception — not a breadcrumb trail of five partial lines from every layer it bubbled through. Log spam is worse than silence: it buries the line that matters and multiplies your ingest bill. Second, level names gate *routing*: in Lecture 12.2 `critical` will page a human, so anything logged `critical` must genuinely justify a 3 a.m. phone call. If "critical" is common in your logs, it means nothing.

## 4. Context: the thread through every log line

The single highest-leverage logging practice is attaching *request-scoped* context to every line automatically. Laravel 12's `Context` facade does exactly this: anything you `Context::add()` is appended to the `extra` field of **every** subsequent log entry in the request — and, crucially, it is *dehydrated into queued job payloads and rehydrated in the worker*. Set `order_id` in the controller on `tickethub-web`, and the same `order_id` appears in `GenerateTicketPdf`'s log lines on `tickethub-horizon`, on a different node, minutes later. No plumbing through constructors. This is the feature that turns ten pod streams into one narrative.

The middleware that starts every request's context:

```php
<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Context;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

class AssignRequestContext
{
    public function handle(Request $request, Closure $next): Response
    {
        $inbound = $request->headers->get('X-Request-Id', '');

        // Accept only sane inbound IDs (nginx or a trusted caller); otherwise mint a ULID.
        $requestId = preg_match('/^[A-Za-z0-9\-]{8,64}$/', $inbound)
            ? $inbound
            : (string) Str::ulid();

        Context::add([
            'request_id' => $requestId,
            'user_id'    => $request->user()?->id,
            'route'      => $request->route()?->getName(),
        ]);

        $response = $next($request);
        $response->headers->set('X-Request-Id', $requestId);

        return $response;
    }
}
```

Register it in `bootstrap/app.php` for the `api` group, **after** authentication so `user_id` resolves. Then use it in the order flow — note the messages are constants and the data is context:

```php
// App\Http\Controllers\OrderController::store — after the reservation transaction commits
Context::add('order_id', $order->id);
Log::info('Order placed', ['total_cents' => $order->total_cents, 'items' => $order->items->count()]);

Bus::dispatch(new GenerateTicketPdf($ticket)); // Context travels inside the payload
```

And the proof, from production — two pods, one story, one key:

```json
{"message":"Order placed","context":{"total_cents":118000,"items":2},"level_name":"INFO","datetime":"2026-08-07T12:03:40.918+00:00","extra":{"request_id":"01K20FZ7Q2V4X9J8R3T1B5N6M7","user_id":8712,"route":"orders.store","order_id":48211}}
{"message":"Ticket PDF generated","context":{"ticket_id":91442,"bytes":184230,"ms":2140},"level_name":"INFO","datetime":"2026-08-07T12:03:47.101+00:00","extra":{"request_id":"01K20FZ7Q2V4X9J8R3T1B5N6M7","user_id":8712,"route":"orders.store","order_id":48211}}
```

The first line came from a `tickethub-web` pod, the second from `tickethub-horizon` on a spot node. Same `request_id`, same `order_id` — hydrated from the job payload, not re-plumbed by you.

## 5. Correlation end-to-end: nginx joins the party

The app now tags its own lines — but the first record of every request is nginx's access log, and it should carry the *same* ID. Make nginx the ID's origin: if the client sent none, nginx mints one; either way it logs it and forwards it to PHP-FPM, where the middleware above accepts it. Update the Module 6 nginx image's config (`docker/nginx/default.conf`; the `map` lives at `http` context):

```nginx
# Reuse an inbound X-Request-Id, else use nginx's built-in unique ID.
map $http_x_request_id $req_id {
    default $http_x_request_id;
    ""      $request_id;
}

log_format json_access escape=json '{'
    '"time":"$time_iso8601",'
    '"request_id":"$req_id",'
    '"remote_addr":"$remote_addr",'
    '"method":"$request_method",'
    '"uri":"$request_uri",'
    '"status":$status,'
    '"bytes_sent":$body_bytes_sent,'
    '"request_time":$request_time,'
    '"upstream_time":"$upstream_response_time"'
'}';

server {
    listen 8080;
    root /var/www/html/public;
    access_log /dev/stdout json_access;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass 127.0.0.1:9000;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        fastcgi_param HTTP_X_REQUEST_ID $req_id;   # PHP sees it as the X-Request-Id header
    }
}
```

Now the access log line (`request_time: 0.412`) and every app log line share `request_id` — you can join "which requests were slow" with "what the app was doing during them". The ALB adds its own trace header upstream; we standardize on `X-Request-Id` because it survives the whole chain we control.

## 6. What not to log

Logs outlive requests and are readable by everyone with CloudWatch access — treat them as a **data store with an audience**, and write a policy:

- **No PII in log lines.** `user_id: 8712`, never `email: ana@example.com` or names. IDs join to the database when someone with the right access needs the person; log lines should not *be* the leak.
- **Never** card numbers (PAN), CVVs, payment tokens, passwords, session tokens, `Authorization` headers, or full request bodies. This is not just hygiene — card data in logs drags your log platform into PCI scope.
- Enforce it in code, because policy without enforcement is a wish. A Monolog processor that masks known-sensitive keys anywhere in the context tree:

```php
<?php

namespace App\Logging;

use Monolog\LogRecord;
use Monolog\Processor\ProcessorInterface;

class RedactSensitiveContext implements ProcessorInterface
{
    private const REDACT = ['password', 'password_confirmation', 'card_number',
        'cvv', 'token', 'secret', 'authorization', 'api_key'];

    public function __invoke(LogRecord $record): LogRecord
    {
        return $record->with(context: $this->mask($record->context));
    }

    private function mask(array $data): array
    {
        foreach ($data as $key => $value) {
            if (is_array($value)) {
                $data[$key] = $this->mask($value);
            } elseif (in_array(strtolower((string) $key), self::REDACT, true)) {
                $data[$key] = '[REDACTED]';
            }
        }

        return $data;
    }
}
```

It is a safety net, not a substitute for not logging secrets in the first place — a processor cannot mask a card number someone interpolated into a message string.

## 7. Queue and Horizon logging

Workers fail silently if you let them. Three practices close the gap. First, Horizon already tags jobs with related models — its dashboard search is your first stop for "what happened to order 48211's jobs". Second, log job *outcomes* at the boundary (Section 3's rule): the `failed()` method on a job runs after all retries are exhausted — one `error`, full context:

```php
// App\Jobs\GenerateTicketPdf
public function failed(?Throwable $exception): void
{
    Log::error('Ticket PDF generation failed permanently', [
        'ticket_id' => $this->ticket->id,
        'exception' => $exception?->getMessage(),
    ]);
}
```

Third, for fleet-wide visibility, listen once for `JobFailed` in a service provider and log it with the job name and connection — Context data set before dispatch is already in the entry. Do **not** log every `JobProcessed` at `info` in production: at 50 PDF jobs/second during an on-sale, that is pure ingest cost. Lecture 12.2 measures queue throughput with metrics — the correct signal for "how many".

## 8. Collection on EKS: stdout to queryable in four hops

Where do stderr lines physically go? Each container's stdout/stderr is captured by the container runtime; the kubelet writes it to the node at `/var/log/containers/<pod>_<namespace>_<container>-<id>.log` with one JSON-ish CRI-framed line per log line. Files rotate and die with pods — so a **collector DaemonSet** (one pod per node, a pattern you know from Module 11) tails those files, enriches each record with pod metadata, and ships it to a backend.

The lightweight standard collector is **Fluent Bit** (C, a few MB of RAM per node). Two honest backend paths:

- **CloudWatch Logs** via the `aws-for-fluent-bit` distribution — the course path: zero new stateful infrastructure, IAM via IRSA (Module 11), pay-per-use, and Logs Insights is a genuinely good query engine. Its weaknesses: cost at high volume and a query UI nobody loves.
- **Loki + Grafana** — the OSS path: Loki indexes only labels (cheap), stores chunks in S3, and queries with LogQL inside Grafana, which pairs beautifully with the metrics stack we build in Lecture 12.2. The price is running Loki yourself. We take CloudWatch now and revisit Grafana as the single pane of glass in Lectures 12.2–12.3.

Deploy `aws-for-fluent-bit` with a Helm release from the Terraform EKS stack (Module 10/11 pattern), its service account bound by IRSA to a role allowing `logs:CreateLogStream`/`logs:PutLogEvents`. The parts of the config that matter:

```ini
[INPUT]
    Name              tail
    Tag               app.*
    Path              /var/log/containers/*_tickethub_*.log
    multiline.parser  cri
    Mem_Buf_Limit     50MB

[FILTER]
    Name                kubernetes
    Match               app.*
    Merge_Log           On          # parse the JSON app line into top-level fields
    Keep_Log            Off
    Labels              On          # attach pod labels (app, version)

[OUTPUT]
    Name                cloudwatch_logs
    Match               app.*
    region              ap-southeast-1
    log_group_name      /eks/tickethub-prod/app
    log_stream_prefix   pod-
    auto_create_group   On
```

The `kubernetes` filter is the magic: it looks up each file's pod via the API, attaches `kubernetes.pod_name`, `namespace`, `labels.app`, and — because `Merge_Log On` and our app emits JSON — merges `message`, `level_name`, `context.*`, `extra.*` into queryable top-level fields. The nginx access lines from the same pods are JSON too, so they merge identically. Cluster components (Argo CD, controllers) go to their own log group via a second input; keep app logs clean.

### Organization, retention, and the bill

One log group per cluster per concern: `/eks/tickethub-prod/app`, `/eks/tickethub-staging/app`, `/eks/tickethub-prod/platform`. CloudWatch charges roughly $0.50–0.70/GB **ingested** (region-dependent) plus ~$0.03/GB-month stored, plus per-GB-scanned for Insights queries. Ingest is the big number — and storage is *forever by default*. Set retention the day you create the group, in Terraform:

```hcl
resource "aws_cloudwatch_log_group" "app" {
  name              = "/eks/tickethub-prod/app"
  retention_in_days = 30
}
```

Thirty days covers incident response and short-term analysis. If compliance needs more, export to S3 (`tickethub-prod-backups` lifecycle rules from Module 8 apply) — S3 at ~$0.023/GB-month is where old logs belong, not CloudWatch.

The other cost lever is verbosity: `LOG_LEVEL` lives in the `tickethub-config` ConfigMap per environment — `debug` in staging, `info` in production. A forgotten `LOG_LEVEL=debug` in production is a **debug storm**: 10–20× line volume, a proportionally bigger ingest bill, and — worse — signal drowned in noise exactly when you need it. Treat the production value as change-controlled config (it flows through the values-PR path from Module 11 anyway).

## Hands-on with TicketHub

Everything above is deployed: JSON logs, context middleware, nginx format, Fluent Bit shipping to `/eks/tickethub-prod/app`. Now collect the payoff — Logs Insights, real questions. (Console → CloudWatch → Logs Insights, or `aws logs start-query`.)

**1. Error rate by route, over time** — "is something failing, and where?":

```
fields @timestamp
| filter level_name = "ERROR"
| stats count(*) as errors by bin(5m) as t, extra.route
| sort t desc
```

```
t                     extra.route      errors
2026-08-07 12:05:00   orders.pay       14
2026-08-07 12:05:00   orders.store     2
2026-08-07 12:00:00   orders.pay       11
```

**2. One request's complete story, across web and Horizon** — the correlation payoff:

```
fields @timestamp, kubernetes.pod_name, level_name, message, extra.order_id
| filter extra.request_id = "01K20FZ7Q2V4X9J8R3T1B5N6M7"
| sort @timestamp asc
```

```
12:03:40.918  tickethub-web-7f9c4-x2m4p      INFO   Order placed            48211
12:03:41.240  tickethub-web-7f9c4-x2m4p      INFO   Payment captured        48211
12:03:47.101  tickethub-horizon-6b8d5-qhw92  INFO   Ticket PDF generated    48211
12:03:47.410  tickethub-horizon-6b8d5-qhw92  INFO   Confirmation mail sent  48211
```

**3. Top exceptions, grouped** — "what's actually breaking this week?":

```
fields @timestamp
| filter level_name in ["ERROR", "CRITICAL"]
| stats count(*) as occurrences, count_distinct(extra.request_id) as requests by message
| sort occurrences desc
| limit 10
```

**4. Reservation-expiry anomalies** — the `warning` policy from Section 3 earning its keep. `ExpireReservations` logs `Reservation expired with items` with `context.items`; a spike means checkout friction or payment trouble:

```
fields @timestamp
| filter message = "Reservation expired with items"
| stats count(*) as expiries, sum(context.items) as tickets_released by bin(1h)
| sort bin(1h) desc
```

A baseline of ~40/hour jumping to 400/hour at 19:00 is a finding — before a single customer complains.

**5. The support-ticket walkthrough.** Ticket: *"Customer paid for order 48377, never got tickets."* One query:

```
fields @timestamp, kubernetes.pod_name, level_name, message, context.reason
| filter extra.order_id = 48377
| sort @timestamp asc
```

```
11:14:02.114  tickethub-web-7f9c4-l8k2n      INFO   Order placed
11:14:02.610  tickethub-web-7f9c4-l8k2n      INFO   Payment captured
11:14:09.302  tickethub-horizon-6b8d5-qhw92  ERROR  Ticket PDF upload failed        s3_access_denied
11:14:41.518  tickethub-horizon-6b8d5-qhw92  ERROR  Ticket PDF upload failed        s3_access_denied
11:15:44.190  tickethub-horizon-6b8d5-qhw92  ERROR  Ticket PDF generation failed permanently
```

The narrative reads itself: payment fine, PDF job failed all retries on S3 `AccessDenied` — and the timestamp sits minutes after yesterday's IAM refactor in `tickethub-infra` touched the `tickethub-prod-app` role's S3 policy. Fix the policy via a Terraform PR (Module 10), retry from Horizon's failed-jobs tab, customer has tickets — root cause in minutes. In the Module 2 era this was `ssh` + `grep` across rotated files on one VPS and an afternoon of guessing; the difference is not effort, it is *structure*.

## Real-world best practices

- **Make the log schema a team contract.** Agree on field names (`order_id`, not `orderId` in one service and `oid` in another) and constant messages; put examples in the repo docs. Why: queries and alerts are written against field names — schema drift silently breaks them.
- **Correlation ID from the edge, always.** Generate at the outermost component you control (nginx), echo it in responses, include it in error pages and support tooling. Why: it turns every support ticket into a one-query investigation instead of a timestamp hunt.
- **Audit-worthy business events get `info` logs even when nothing is wrong.** Order placed, payment captured, tickets issued, refund processed. Why: half of log value is *reconstruction* — proving what happened and when — not debugging.
- **Set retention and a monthly ingest budget review.** 30 days hot, S3 for anything compliance needs. Why: log bills grow silently and linearly with traffic; teams discover five-figure CloudWatch bills a quarter late.
- **Keep `debug` compiled out of production behavior, not sprinkled with `if` checks.** `LOG_LEVEL=info` in the prod ConfigMap does this for free. Why: debug logs are for humans at a keyboard; in production they are cost and noise.
- **Test your redaction.** A Pest test that logs a payload containing `password` and asserts the captured record shows `[REDACTED]`. Why: the processor is security-relevant code; regressions must fail CI, not leak in prod.

## Common pitfalls

1. **Interpolating data into log messages.** `Log::info("Order {$order->id} placed")` feels natural after years of `echo`-style debugging. But it makes every message unique — ungroupable, unqueryable. Correct: constant message, data in context: `Log::info('Order placed', ['order_id' => $order->id])` (or `Context::add`).
2. **Logging inside loops and retries at `error`.** People log where the exception is *visible*, so three retries produce three errors plus a final one — alert noise and quadruple counting. Correct: log attempts at `debug`/`warning` if at all; one `error` at the boundary (`failed()`) when the operation has definitively failed.
3. **Trusting inbound correlation IDs blindly.** Copying any `X-Request-Id` a client sends invites junk and log injection into a joined field. Correct: validate the format (the middleware's regex), overwrite anything invalid; only nginx and trusted upstreams get pass-through.
4. **Leaving CloudWatch retention at "Never expire".** The default. Nobody notices because the cost accrues at $0.03/GB-month — until three years of debug storms cost more than the RDS instance. Correct: Terraform-set retention on every group; S3 for archives.
5. **Logging the request body "just in case".** It feels like free debugging insurance until a password, card number, or bearer token lands in a log line — now it's an incident (and Lecture 12.4's problem). Correct: log IDs and derived facts; rely on the redaction processor as a net, not a strategy.
6. **Treating `kubectl logs` as the production workflow.** It works in the demo, so teams never finish the pipeline; then a crash-looping pod's evidence dies with it. Correct: the DaemonSet pipeline is the source of truth; `kubectl logs` is for live tailing during interactive debugging only.

## Exercises

1. **Slow-request visibility.** Add a terminable middleware that logs `warning` with `duration_ms` when a request exceeds 1 s. Write the Insights query showing slow requests per route per 15 minutes. Confirm `request_id` lets you jump from a slow access-log line to the app's view of the same request.
2. **Redaction proof.** Write a Pest test that logs `['card_number' => '4242424242424242', 'nested' => ['token' => 'abc']]` and asserts both values are `[REDACTED]` in the formatted output. Then try to sneak a secret past the processor via the message string — and write the one-sentence policy lesson.
3. **Context through a queued mail.** Dispatch `OrderConfirmed` (queued on `default`) from a controller after `Context::add('order_id', ...)`. Prove via Insights that the mail-sending log lines on `tickethub-horizon` carry the same `request_id` and `order_id`.
4. **Expiry anomaly alarm.** Using the reservation-expiry query, create a CloudWatch metric filter counting `Reservation expired with items` per 5 minutes and an alarm at 5× baseline. (A taste of logs→metrics — Lecture 12.2 does it properly.)
5. **Stretch: the OSS path.** Deploy Loki (`grafana/loki` chart, S3 storage) and a second Fluent Bit output to it. Re-run query 2 in LogQL. Compare: query ergonomics, cost model, operational burden. Keep it in staging — it becomes useful again in Lecture 12.3.

## What's next

Logs answer *what happened at this point* — but you cannot watch a log stream and know whether TicketHub is healthy, and you cannot afford to compute "requests per second" by counting log lines at query time. [Lecture 12.2 — Metrics, Alerting & SLOs](02-metrics-alerting-slos.md) adds the numeric signal: Prometheus scraping TicketHub's pods, golden-signal dashboards in Grafana, alerts designed to page only when users are hurting, and the SLOs and error budgets that finally make Module 1's speed-vs-stability bargain mechanical.
