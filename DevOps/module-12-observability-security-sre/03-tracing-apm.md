# Lecture 12.3 — Tracing & APM

> **Module 12 — Observability, Security & SRE** · Lecture 3 of 5 · Estimated time: ~90 min

Logs ([Lecture 12.1](01-structured-logging-aggregation.md)) tell you *what happened at a point*; metrics ([Lecture 12.2](02-metrics-alerting-slos.md)) tell you *how much and whether it's healthy*. This lecture adds the third signal: distributed tracing shows *where the time went* inside one request as it crosses nginx, PHP-FPM, MySQL, Redis, S3, and a Horizon worker on another node. You will instrument TicketHub with OpenTelemetry, carry a trace across the queue boundary, sample intelligently, join traces to your logs and metrics, add Sentry — then use all of it to solve a real latency regression in minutes.

## Learning objectives

- Explain traces, spans, and W3C context propagation, and state when to open traces before logs or metrics
- Deploy OpenTelemetry auto-instrumentation for Laravel 12 on EKS and read the spans it produces
- Add manual spans around business logic and propagate trace context through Horizon queues
- Design a sampling strategy that keeps errors and slow traces without paying for everything
- Correlate traces with logs and metrics via `trace_id`, Grafana links, and exemplars
- Run Sentry alongside SLO alerting without double-paging anyone

## 1. The question you cannot answer yet

Tuesday, 14:35. Lecture 12.2's dashboard shows p99 latency on `POST /api/v1/orders` at 2.1 seconds — it was 480 ms this morning. The error-rate panel is flat. You pull the slow requests' logs by `request_id`: `Order placed`, `Payment captured`, all `info`, all in order — just… slow.

Metrics told you *that* checkout is slow, and when it started. Logs told you *nothing was wrong* at any point anyone thought to log. Neither can say where two seconds went inside a request that touches nginx, PHP-FPM, MySQL five times, Redis twice, and dispatches three jobs. You could add timing logs around every suspect — ship, wait, read, repeat — but that is shipping code to ask each question, the thing observability was supposed to end. Tracing answers "where did the time go" *structurally*, for every request, without knowing the question in advance.

## 2. Traces and spans: the model

A **trace** is one request's complete story, as a tree. Each node is a **span**: one timed operation — an HTTP request, a SQL query, a queue job — with a start time, duration, parent, and three payloads:

- **Attributes** — key/value facts (`db.statement`, `http.route`, `tickethub.order_id`): the fields you filter on, the role context plays in your logs.
- **Events** — timestamped moments *within* the span (an exception, a retry, a lock acquired).
- **Status** — OK or ERROR, so backends find failed spans without parsing.

Every span carries the same **trace ID**; each has its own **span ID** and its parent's. That is the entire data model — the power is that the tree crosses *process and machine boundaries*, via context propagation: a caller forwards the trace identity in a header. The W3C standard header, raw:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

Four dash-separated fields: version (`00`), the 16-byte trace ID, the calling span's ID (the callee's parent), and flags (`01` = sampled). Any component that receives this header and emits spans with that trace ID joins the tree. It is Lecture 12.1's `X-Request-Id` idea — one ID threading a request through the system — but standardized, hierarchical, and timed. HTTP hops get it free from instrumentation libraries; in Section 5 you carry it somewhere headers don't exist: a Redis queue payload.

## 3. The three signals, completed

Lecture 12.1 seeded this table; here it is completed, with the column that matters during an incident:

| Signal | Shape | The question it answers | Open it first when… |
|---|---|---|---|
| **Metrics** | Aggregated numbers over time | *Is it healthy? How much? Since when?* | Always — the alert landed here; scope the blast radius (which route, dependency, deploy) |
| **Logs** | Discrete events with detail | *What exactly happened to this one?* | You have a specific entity — an order, a user, an exception — and need its story |
| **Traces** | Span tree per request | *Where inside the request did it happen?* | Something is **slow but not failing**, or failing somewhere you can't localize |

The triage flow that falls out, used again in Lecture 12.5's incident: an alert fires (a symptom, per Lecture 12.2) → dashboard to scope it — which route, which dependency, does the start line up with a deploy marker? *Errors* → logs: group the exceptions, read one request's story. *Latency* → traces: open a slow one and read the tree — the time is *in* one of the spans, and the tree says which. Then pivot back to logs for that exact request via the shared ID. Signals are not competitors; they are stages of narrowing.

## 4. OpenTelemetry: instrument once, point anywhere

Tracing used to mean vendor lock-in at the instrumentation layer: instrument for vendor A, re-instrument to switch to B. **OpenTelemetry (OTel)** ended that: two CNCF projects (OpenTracing and OpenCensus) merged into one standard every serious vendor now accepts — the second-largest CNCF project after Kubernetes. Four pieces to keep straight:

- **API** — the interfaces your code calls (`spanBuilder`, `setAttribute`). Application code depends only on this.
- **SDK** — the implementation that buffers, samples, and exports spans; configured by env vars.
- **OTLP** — the wire protocol (gRPC or protobuf-over-HTTP) every OTel component speaks.
- **Collector** — a standalone process that receives OTLP, processes it (batching, sampling, filtering), and exports to any backend.

The consequence: instrument TicketHub *once*, against the API, and choose — or change — your backend by editing Collector config. Tempo today, a commercial APM next year, no application changes. That is why this lecture teaches OTel, not any vendor's agent.

## 5. Instrumenting TicketHub

### What auto-instrumentation gives you free

PHP's OTel story has two layers: the pure-PHP SDK, and the `opentelemetry` C extension enabling **auto-instrumentation** — engine-level function hooks that let contrib packages wrap the framework without touching application code. In the Module 6 Dockerfile:

```dockerfile
RUN pecl install opentelemetry && docker-php-ext-enable opentelemetry
```

```console
$ composer require open-telemetry/sdk open-telemetry/exporter-otlp \
    open-telemetry/opentelemetry-auto-laravel \
    open-telemetry/opentelemetry-auto-pdo \
    open-telemetry/opentelemetry-auto-psr18
```

Configuration is entirely env vars — on EKS, the `tickethub-config` ConfigMap, plus the Downward API to reach the node-local Collector agent (Section 7):

```yaml
env:
  - name: HOST_IP
    valueFrom: { fieldRef: { fieldPath: status.hostIP } }
  - name: OTEL_PHP_AUTOLOAD_ENABLED
    value: "true"
  - name: OTEL_SERVICE_NAME
    value: "tickethub-web"          # "tickethub-horizon" in that Deployment
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: "http://$(HOST_IP):4318"
  - name: OTEL_EXPORTER_OTLP_PROTOCOL
    value: "http/protobuf"
  - name: OTEL_TRACES_SAMPLER
    value: "parentbased_traceidratio"
  - name: OTEL_TRACES_SAMPLER_ARG
    value: "1.0"                    # head sampling — Section 6 explains this choice
```

With no application code changed, you get: a server span per HTTP request, named by route; a span per SQL statement with `db.statement` as an attribute (recorded with placeholders, not bound values — verify before shipping, because an interpolated query puts customer data into your tracing backend); cache and Redis operations via framework hooks; and a client span for every outbound HTTP call, S3 and the payment gateway included. One honest FPM caveat: spans are buffered in-process and batch-exported at request end, adding a few milliseconds after response send — one reason the export target is an agent on the same node, not a remote endpoint.

### Manual spans for business logic

Auto-instrumentation sees infrastructure, not intent. The reservation critical section — the oversell invariant, `SELECT … FOR UPDATE` inside a transaction — deserves its own span, with business attributes:

```php
use OpenTelemetry\API\Globals;
use OpenTelemetry\API\Trace\StatusCode;

$tracer = Globals::tracerProvider()->getTracer('tickethub');

$span = $tracer->spanBuilder('orders.reserve')
    ->setAttribute('tickethub.ticket_type_id', $ticketTypeId)
    ->setAttribute('tickethub.quantity', $quantity)
    ->startSpan();
$scope = $span->activate();

try {
    $order = DB::transaction(fn () => $this->reserveTickets($ticketTypeId, $quantity));
    $span->setAttribute('tickethub.order_id', $order->id);

    return $order;
} catch (Throwable $e) {
    $span->recordException($e);
    $span->setStatus(StatusCode::ERROR, $e->getMessage());
    throw $e;
} finally {
    $scope->detach();
    $span->end();
}
```

`activate()` makes this span the current parent, so the auto-instrumented SQL spans inside the transaction nest under it. The attribute rule inverts Lecture 12.2's: spans are per-request, not time series, so IDs are fine here. Wrap only operations that *mean* something; a manual span around every method is noise you pay to store.

### Carrying the trace through the queue

Here is the differentiator. When `OrderController` dispatches `GenerateTicketPdf`, the job runs seconds later, in `tickethub-horizon`, on a different node. No HTTP hop, so no `traceparent` header — unless you put the context in the payload yourself, exactly as `Context` did for logs in Lecture 12.1. Producer side, a small trait:

```php
use OpenTelemetry\API\Trace\Propagation\TraceContextPropagator;

trait CarriesTraceContext
{
    public array $traceContext = [];

    public function withTraceContext(): static
    {
        TraceContextPropagator::getInstance()->inject($this->traceContext);

        return $this;
    }
}
```

`inject()` serializes the current span's identity into the array — literally the `traceparent` string as a payload field. Consumer side, a job middleware restores it and opens a span with the checkout request as its *remote parent*:

```php
use OpenTelemetry\API\Globals;
use OpenTelemetry\API\Trace\SpanKind;
use OpenTelemetry\API\Trace\StatusCode;
use OpenTelemetry\API\Trace\Propagation\TraceContextPropagator;

class ContinueTrace
{
    public function handle(object $job, Closure $next): mixed
    {
        $parent = TraceContextPropagator::getInstance()->extract($job->traceContext ?? []);

        $span = Globals::tracerProvider()->getTracer('tickethub')
            ->spanBuilder('job '.$job::class)
            ->setParent($parent)
            ->setSpanKind(SpanKind::KIND_CONSUMER)
            ->startSpan();
        $scope = $span->activate();

        try {
            return $next($job);
        } catch (Throwable $e) {
            $span->recordException($e);
            $span->setStatus(StatusCode::ERROR);
            throw $e;
        } finally {
            $scope->detach();
            $span->end();
        }
    }
}
```

Dispatch becomes `Bus::dispatch((new GenerateTicketPdf($ticket))->withTraceContext())`, and the PDF job's spans — render, S3 upload — appear *in the checkout trace*, minutes and machines apart. (The contrib package can automate this; you built it by hand once so it is never magic to you.)

## 6. Sampling: keep what matters

Traces are the priciest signal per unit; Lecture 12.1's cost table named the lever — sampling rate. Two mechanisms, opposite trade-offs:

- **Head sampling** decides at trace *start*, in the app. `TraceIdRatioBased(0.10)` keeps a deterministic 10% by hashing the trace ID (`parentbased`: children obey the root's decision, so every service keeps the *same* 10%). Cheap — unsampled requests never build or export spans. Blind — the decision predates the outcome, so it drops 90% of your errors and slowest requests: exactly the traces worth keeping.
- **Tail sampling** decides at trace *end*, in the Collector, after seeing the whole tree: keep every error, everything slow, a small baseline of normal traffic. Informed, but the app must export everything and the Collector must buffer complete traces while deciding.

The two interact in a way people miss: tail sampling can only keep what head sampling let through. Head at 10% plus "tail keeps all errors" keeps *10% of errors*. So TicketHub's policy: head at `1.0` (export everything — fine at TicketHub's traffic), and the tail policy does the real dropping: **all errors, everything over 1.5 s, 10% of the rest**. If an on-sale makes exporting everything too heavy, dial `OTEL_TRACES_SAMPLER_ARG` down and accept, knowingly, that the error guarantee weakens with it. The knob exists; the point is choosing its value on purpose.

## 7. The Collector on EKS

The Collector runs in two roles; TicketHub uses both. As an **agent** — a DaemonSet, one pod per node, the Fluent Bit pattern — it receives OTLP from local pods on `4318`, batches, forwards. As a **gateway** — a small Deployment — it makes fleet-wide decisions. Tail sampling *must* live in the gateway: judging a whole trace needs every span in one process, and a trace's spans come from web and Horizon pods on different nodes, so per-node agents never see complete traces. The gateway pipeline:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
      http:

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
  tail_sampling:
    decision_wait: 10s        # buffer window: spans arriving later than this miss the trace
    policies:
      - name: keep-all-errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: keep-slow
        type: latency
        latency: { threshold_ms: 1500 }
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 10 }
  batch:
    timeout: 5s

exporters:
  otlp/tempo:
    endpoint: tempo.observability.svc:4317
    tls:
      insecure: true          # in-cluster; mTLS is the hardening step

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch]
      exporters: [otlp/tempo]
```

`memory_limiter` runs first for a reason: tail sampling buffers traces in RAM, and without a limiter a spike turns the telemetry pipeline into the thing that OOMs during the incident it should be explaining. Both roles deploy via the `opentelemetry-collector` Helm chart from the same Terraform stack as Lecture 12.2's monitoring.

## 8. Choosing a backend

**Grafana Tempo** — the course choice. Loki's philosophy applied to traces: index almost nothing, store compressed blocks in S3, query by trace ID or TraceQL. Operationally light, cheap at rest, and it plugs into Lecture 12.2's Grafana, making Section 9's cross-signal linking native. Trade-off: attribute search is younger and weaker than a commercial APM's.

**Jaeger** — the CNCF veteran, excellent UI, OTLP-native. Fully capable, but you operate its storage yourself, and pairing with Grafana means a second UI rather than one pane.

**AWS X-Ray** — fully managed, integrates with ALB and Lambda, reachable via AWS's Collector distro (ADOT). Honestly: the PHP path is the ecosystem's least polished, the query language proprietary, and it pulls you away from the Grafana-centered setup you have. Right for Lambda-heavy AWS shops; not for TicketHub.

**Commercial APMs** (Datadog, New Relic, Honeycomb) — said plainly: *better products* than what you can self-host — richer search, anomaly detection, polished workflows — at real money, typically per-host or per-GB. A small team should seriously consider buying instead of building; three engineer-days a month operating an observability stack pays for a lot of SaaS. This course self-hosts because you must understand the machinery to evaluate the vendors — not because self-hosting is morally superior.

## 9. Correlation: the payoff

Three signals are three silos until they share keys. The key is `trace_id`, and Lecture 12.1's `AssignRequestContext` middleware already has the place for it — one new line:

```php
use OpenTelemetry\API\Trace\Span;

Context::add('trace_id', Span::getCurrent()->getContext()->getTraceId());
```

Now every log line — web *and* Horizon, since `Context` dehydrates into job payloads — carries the trace ID next to `request_id`. The joins:

- **Logs → traces.** Any suspicious log line hands you a `trace_id`; paste it into Tempo and the tree opens. On the staging Loki (Lecture 12.1, exercise 5 — useful again, as promised), Grafana's *derived fields* make the ID a click: log line → trace, no copy-paste. On the CloudWatch path the join is manual but just as real.
- **Traces → logs.** Grafana's trace view links each span to a logs query scoped to its service and time range — "this span is slow" to "what was the app saying meanwhile" in one click.
- **Metrics → traces.** *Exemplars* attach trace IDs to histogram buckets, so Lecture 12.2's p99 panel shows dots you click to land on an actual slow trace. Honesty: exemplar support in the PHP Prometheus client is thin today, so TicketHub's practical bridge is TraceQL — searching Tempo for exactly the traces the panel aggregates: `{resource.service.name="tickethub-web" && name="POST /api/v1/orders" && duration > 2s}`.

## 10. Sentry: errors as a workflow

One gap remains. Traces are an *analysis* tool — you go look. Exceptions deserve a *workflow*: something that groups every occurrence of one error into one issue, notifies once (not 4,000 times), tracks which release introduced it, and knows assigned/resolved/regressed. That is error tracking; Sentry is the standard:

```console
$ composer require sentry/sentry-laravel
```

```php
// config/sentry.php
'dsn' => env('SENTRY_LARAVEL_DSN'),          // via External Secrets, like every secret since Module 11
'release' => env('APP_VERSION'),             // the git SHA baked into the image in Module 7
'environment' => env('APP_ENV'),
'traces_sample_rate' => 0.0,                 // tracing lives in OTel; Sentry does errors
```

Every captured exception arrives with request context, user ID, and *breadcrumbs* — the queries, cache calls, and log lines preceding the failure. The `release` line is Module 7's tagging discipline paying off: Sentry marks each issue *first seen in v1.4.3*, and "what broke this?" collapses to one release's diff.

Draw the routing boundary deliberately, or you will get paged twice for one problem: **Sentry notifies the team channel** — new issue, regression, spike — as work to triage in working hours. **Only SLO burn-rate alerts page** (Lecture 12.2). An exception that does not threaten the SLO is not an emergency; one that does will page you through the budget math, with Sentry waiting as the diagnostic. One system owns the pager.

## Hands-on with TicketHub

Everything above is deployed: extension and packages in the image, env in the ConfigMaps, agent and gateway via Terraform, Tempo storing to S3, Sentry wired. Now read what it captures.

### One checkout, as a span tree

`POST /api/v1/orders` — Lecture 12.1's 412 ms request, now as structure (ms):

```
trace 9f6d20c1a44be8730d55f1a02c4e77b1
tickethub-web  POST /api/v1/orders ······································ 412
├─ middleware App\Http\Middleware\AssignRequestContext ··················   1
├─ orders.reserve  {tickethub.order_id: 48211, tickethub.quantity: 2} ··· 118
│  ├─ sql SELECT * FROM `ticket_types` WHERE `id` = ? FOR UPDATE ········   9
│  ├─ sql INSERT INTO `orders` (...) ····································   3
│  ├─ sql INSERT INTO `order_items` (...) ·······························   2
│  └─ sql COMMIT ························································ 101
├─ http POST payments.example/v1/charges ································ 244
├─ redis SET tickethub_session:… ········································   1
└─ queue.publish GenerateTicketPdf → pdfs ·······························   1

tickethub-horizon  job App\Jobs\GenerateTicketPdf  (starts +5.9 s) ······ 2140
├─ pdf.render  {tickethub.ticket_id: 91442} ····························· 1820
└─ http PUT s3.ap-southeast-1.amazonaws.com/tickethub-prod-uploads/… ····  318
```

Read what the tree teaches that no log could: the reservation is 17 ms of work and 101 ms of `COMMIT` — fsync under load, which nobody would think to log; the payment gateway costs 244 ms of every checkout; and the PDF job, on a spot node six seconds later, is *in the same tree* thanks to Section 5's trait — `Context` for logs, `traceparent` for spans, riding the same payload.

### The investigation: two seconds, found

Back to Section 1's regression.

**14:20** — Argo CD syncs `v1.4.3` to production; the CI annotation lands on the dashboard as a deploy marker (Lecture 12.2).

**14:35** — the p99 panel for `orders.store` breaks upward from 480 ms toward 2.1 s, starting at the marker. Error rate flat; the slow-burn SLO alert opens a ticket, nobody is paged — degraded, not down.

**14:41** — latency symptom, so per Section 3: traces first. TraceQL for slow checkouts returns dozens of hits; open one:

```
tickethub-web  POST /api/v1/orders ······································ 2140
├─ orders.reserve ·······················································  121
├─ http POST payments.example/v1/charges ································  239
├─ sql SELECT * FROM `tickets` WHERE `order_id` = ? ·····················    3
├─ sql SELECT * FROM `ticket_types` WHERE `id` = ? ······················   38
├─ sql SELECT * FROM `ticket_types` WHERE `id` = ? ······················   35
├─ sql SELECT * FROM `ticket_types` WHERE `id` = ? ······················   41
│  … 37 more identical spans ············································ ~1400
└─ queue.publish OrderConfirmed → mail ··································    1
```

Forty near-identical single-row `SELECT`s between payment capture and mail dispatch: an N+1, unmistakable in a span tree, invisible in an average. Reservation and payment are innocent.

**14:48** — `git diff v1.4.2..v1.4.3` on `OrderConfirmed`: the release added a per-ticket detail section to the confirmation email, and the mailable's constructor builds that data by iterating `$order->tickets`, touching `$ticket->ticketType->event` on each — the refactor dropped the eager load, so every ticket lazy-loads *inside the HTTP request, at dispatch time*. Forty tickets, forty queries, ~1.4 s.

**14:55** — the fix is one line before the mailable is constructed:

```php
$order->load('tickets.ticketType.event');   // 3 queries, any order size
```

**15:10** — the fix ships to the canary slice first (Module 9). Canary p99 drops under 500 ms while stable pods still show 2.1 s — the two lines diverging on the same panel *is* the verification. Promote, watch the marker, close the ticket.

Fifty minutes from regression to verified fix, most of it CI time. Metrics said *something* and *when*; the deploy marker said *what changed*; the trace said *where*; git said *why*; the canary said *fixed*. No SSH, no guessing. This is what the three signals are *for*.

## Real-world best practices

- **Instrument automatically first, manually sparingly.** Auto covers 90% of the value at zero code cost; add manual spans only where there is business meaning. Why: hand-instrumented span sprawl is unmaintained code *and* a storage bill.
- **Treat span and attribute naming as a contract, like the log schema.** `tickethub.*` for business attributes, OTel semantic conventions for the rest. Why: TraceQL queries and dashboards are written against names; drift breaks them silently — Lecture 12.1's lesson again.
- **Propagate context through every async boundary, not just HTTP.** Queues today; scheduled commands and webhooks tomorrow. Why: a trace that dies at the queue explains only the cheap half of TicketHub's work.
- **Never sample blind if you can sample informed.** Tail-keep errors and slow traces; let the baseline be the sampled part. Why: dropped traces are only missed during an incident — exactly when they were the ones you needed.
- **Verify what auto-instrumentation records before trusting it.** Read real spans for `db.statement` contents and header attributes. Why: a backend full of interpolated customer data is Lecture 12.1's "what not to log" failure at a new address — and Lecture 12.4's problem.
- **Route errors and pages to different systems on purpose.** Sentry → channel; SLO burn → pager; write it down. Why: double-paging is alert fatigue (Lecture 12.2), and fatigue kills paging systems faster than outages do.

## Common pitfalls

1. **Tracing as a replacement for logs or metrics.** Teams deploy an APM and stop investing in the other signals — but sampled traces cannot count things (you dropped 90%), and spans carry less detail than a log line. Correct: three signals, three jobs, joined by `trace_id`; Section 3's table is a division of labor.
2. **Head sampling at 10% while believing you "keep all errors".** The tail policy reads convincingly; nobody notices the app already dropped nine of ten error traces before export. Correct: tail filters *what arrives* — export everything if the tail policy is your keep-guarantee.
3. **Tail sampling in the DaemonSet agent.** Works in dev, where one node sees every span; in production a trace's spans land on different agents and every cross-node trace is judged half-blind. Correct: agents batch and forward; the gateway samples.
4. **Unbounded span attributes.** Someone attaches the serialized order payload "for debugging" and every trace carries kilobytes of PII into the backend. Correct: IDs and scalar facts; the payload lives in the database, reachable *by* the ID — the logging rule again.
5. **Forgetting the FPM export cost.** Pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at a remote host adds a round-trip to every request's shutdown; a wobbly telemetry endpoint becomes user-visible latency. Correct: export to the node-local agent; let the Collector own the WAN.
6. **Letting Sentry page.** Teams wire it to PagerDuty "to be safe" and get woken by a bot's `TypeError` that threatens no SLO. Correct: Sentry informs, budgets page — one pager owner.

## Exercises

1. **Read a trace cold.** Trace `GET /api/v1/events/{event}` in staging. Identify each span's source (auto vs manual), find the slowest, and answer from the tree alone: is this endpoint's time in PHP, MySQL, or Redis?
2. **Instrument the scheduler.** Add a manual span around `ExpireReservations` with `tickethub.reservations_expired` as an attribute (the CronJob gets the same OTel env). Find one night's runs in Tempo; confirm the exception path sets ERROR status via `recordException`.
3. **Prove the queue propagation.** Dispatch `GenerateTicketPdf` with `withTraceContext()` and find the job span inside the checkout trace. Remove the trait call, dispatch again, find the orphan trace — and write one sentence on what an orphan costs during an incident.
4. **Tune the tail.** Add a tail-sampling policy keeping 100% of checkout-route traces during a load test (Lecture 12.5 formalizes the test). Measure stored-trace volume before and after; state the policy's cost in traces/hour.
5. **Stretch: one pane of glass.** On the staging Loki, configure Grafana derived fields so `trace_id` in a log line links to the Tempo trace, and the Tempo span links back to scoped logs. Demo the loop — metrics panel → slow trace → span → logs — in under a minute. This is the workflow Lecture 12.5's incident assumes.

## What's next

TicketHub is now observable in all three dimensions: you can detect, scope, and localize failure in minutes. But everything you have built — pipelines, images, clusters — is also an attack surface, and the automation that ships your code can ship an attacker's. [Lecture 12.4 — DevSecOps](04-devsecops.md) turns on the delivery system itself: threat-modeling the pipeline, scanning dependencies and images, signing what you ship, hardening the runtime — security as a property of the platform, not a gate at the end.
