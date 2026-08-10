# Lecture 12.2 — Metrics, Alerting & SLOs

> **Module 12 — Observability, Security & SRE** · Lecture 2 of 5 · Estimated time: ~100 min

[Lecture 12.1](01-structured-logging-aggregation.md) gave you queryable events. But you cannot stare at a log stream and know whether TicketHub is healthy, and you cannot afford to compute "requests per second, right now, for the last 30 days" by scanning log lines at query time. That job belongs to metrics: cheap, pre-aggregated numbers designed for math. This lecture builds the full stack — Prometheus scraping TicketHub's pods, honest Laravel instrumentation, Grafana dashboards designed as a craft, alerts that page only when users are hurting — and then does the thing that makes it all mean something: defines TicketHub's SLOs, works the error-budget math, and remeasures the DORA metrics you baselined in Module 1.

## Learning objectives

- Explain what metrics are for, how the Prometheus pull model works, and why label cardinality is the cost dimension that governs every instrumentation decision
- Choose correctly between counters, gauges, and histograms, and explain with numbers why averages lie about latency
- Instrument Laravel 12 for Prometheus despite PHP-FPM's per-process memory model, including business metrics and queue-depth gauges
- Write PromQL that answers real production questions: error ratios, p99 latency, saturation, orders per minute
- Design dashboards and alerts around symptoms, not causes, and defend the "every page is actionable and urgent" rule
- Define SLIs and SLOs for TicketHub, compute the error budget, and implement multi-window burn-rate alerts

## 1. What metrics are for

A metric is a number with a name and a timestamp, pre-aggregated at the source: `tickethub_orders_created_total 18423`. No message, no stack trace, no request body. What you give up in detail you get back in economics: a counter costs the same whether it counted ten orders or ten million, and "orders per second over the last week" is arithmetic on a few thousand stored points, not a scan of a billion log lines. Logs answer *what exactly happened at this point*; metrics answer *is it healthy now, and what is the trend* — the questions you ask every minute, forever, and therefore the questions that must be cheap.

The 12.1 signals table said it: for metrics, **cardinality is the cost lever**. Every unique combination of metric name and label values is a separate time series that Prometheus stores and indexes independently. `http_requests_total{route="orders.store", status="201"}` is one series; add a `user_id` label and you mint one series *per user* — millions of series, each nearly worthless. Hold that thought; Section 4 turns it into a rule.

## 2. Frameworks: golden signals, RED, USE

You do not have to invent what to measure. Google's **four golden signals** — latency, traffic, errors, saturation — cover any user-facing system. Two mnemonic refinements split by workload type: **RED** (Rate, Errors, Duration) for request-driven things, **USE** (Utilization, Saturation, Errors) for resources. Mapped onto TicketHub:

| Component | Lens | Watch |
|---|---|---|
| `tickethub-web` | RED | requests/s by route · 5xx ratio · p95/p99 duration |
| `tickethub-horizon` + queues | RED | jobs/s in vs. completed/s · failed jobs · job runtime; **queue depth is the saturation signal** |
| EKS nodes (Karpenter pools) | USE | CPU & memory utilization · CPU throttling · pod evictions |
| RDS `tickethub-prod-mysql` | USE | connections vs. `max_connections` · CPU · IOPS headroom |
| Redis `tickethub-prod-redis` | USE | **memory % (noeviction!)** · connected clients · CPU |
| PHP-FPM pools | USE | active workers vs. pool size — Module 3's `pm.max_children`, now a metric |

If a dashboard panel doesn't answer one of these questions for one of these components, it is probably decoration.

## 3. The Prometheus model

Prometheus inverts what you might expect: instead of apps pushing measurements somewhere, **Prometheus pulls**. Every target exposes a `/metrics` HTTP endpoint in a plain-text *exposition format*, scraped on an interval (we use 30s) into Prometheus's local time-series database (TSDB). What a scrape of `tickethub-web` returns:

```
# HELP tickethub_orders_created_total Orders placed
# TYPE tickethub_orders_created_total counter
tickethub_orders_created_total 18423
# TYPE tickethub_http_request_duration_seconds histogram
tickethub_http_request_duration_seconds_bucket{route="orders.store",method="POST",status="201",le="0.25"} 10412
tickethub_http_request_duration_seconds_bucket{route="orders.store",method="POST",status="201",le="0.5"} 11875
tickethub_http_request_duration_seconds_sum{route="orders.store",method="POST",status="201"} 2712.4
tickethub_http_request_duration_seconds_count{route="orders.store",method="POST",status="201"} 11902
```

Pull has real advantages: Prometheus *knows* when a target is down (the scrape fails — that's the `up` metric, free monitoring of your monitoring), targets need no knowledge of where monitoring lives, and a misbehaving app can't flood the metrics system. On Kubernetes, discovery is declarative: the Prometheus **operator** watches for `ServiceMonitor` resources, which select Services by label; add one and Prometheus starts scraping matching pods, no config reload. Queries use **PromQL**, a language built for exactly one job — math over labeled time series — which you'll write for real in the hands-on.

## 4. Metric types, and the labels rule

Three types cover almost everything, and picking the wrong one produces confidently wrong numbers.

**Counter** — a number that only goes up (resets to zero on restart). Use for anything you count: `tickethub_orders_created_total`, requests, failed jobs. You almost never look at a counter raw; you take its per-second rate: `rate(tickethub_orders_created_total[5m])`. `rate()` handles resets, so restarts don't produce negative spikes.

**Gauge** — a number that goes up and down; a snapshot. Use for current states: queue depth, active FPM workers, memory in use, Horizon supervisor count.

**Histogram** — observations bucketed by threshold, for anything with a *distribution*, above all latency. Each observation increments every bucket whose `le` (less-or-equal) bound it fits under, plus `_sum` and `_count`. From those buckets, `histogram_quantile()` computes percentiles **server-side, across all pods** — something per-pod pre-computed percentiles mathematically cannot give you (you cannot average p99s).

Why not just track average latency? Because **averages lie**. Suppose during an on-sale 90 checkout requests complete in 100 ms and 10 hit lock contention and take 4 s. Mean latency: (90×0.1 + 10×4)/100 = **490 ms** — looks tolerable. But the p99 is **4 seconds**, and one buyer in ten is staring at a spinner long enough to give up mid-purchase. The distribution is bimodal; the mean lands in the valley between the humps where *no actual request lives*. Latency SLOs are therefore always percentile-based, and percentiles need histograms.

And the rule that keeps all of this affordable: **labels are GROUP BY dimensions; IDs live in logs and traces.** A label is worth its cost only if you'll aggregate by it, and only if its value set is *bounded*: `route` (dozens), `method` (a handful), `status` (a handful) — fine. `user_id`, `order_id`, raw URL paths with IDs in them — cardinality explosion: millions of series, a Prometheus instance on its knees, and no query you'd ever run. When you want to know about *one* order, that's 12.1's `extra.order_id` in Logs Insights. Metrics tell you *how many and how fast*; logs tell you *which one*.

## 5. The platform stack on EKS

You install one thing: **kube-prometheus-stack**, a Helm chart deployed via a `helm_release` in the Terraform EKS stack (the Module 10/11 pattern — values in Git, applied through the plan/apply pipeline). It bundles:

- **Prometheus operator** — the controller that turns CRDs (`Prometheus`, `ServiceMonitor`, `PrometheusRule`, `Alertmanager`) into running, configured components. It is why adding a scrape target or alert rule is a Git commit through Argo CD, not a config-file edit.
- **Prometheus** itself — the scraper and TSDB, with a PVC for local retention (15 days is plenty; long-term storage is a later problem).
- **node-exporter** — a DaemonSet exposing host metrics from every node: CPU, memory, disk, network. Your USE signals for nodes.
- **kube-state-metrics** — translates Kubernetes *object* state into metrics: desired vs. available replicas, restart counts, CronJob last-success times. How you alert on "`tickethub-horizon` has fewer ready pods than desired."
- **Grafana** — the dashboard layer, pre-wired to Prometheus. In Lecture 12.3 it becomes the single pane where metrics, logs, and traces link to each other.
- **Alertmanager** — takes firing alerts and handles the human side: deduplication, grouping, routing to PagerDuty or Slack, silences during maintenance.

**The data layer needs an honest asterisk.** RDS and managed ElastiCache publish their metrics to CloudWatch — you can't run an exporter *on* a managed instance. The **CloudWatch exporter** (or the faster YACE variant) polls CloudWatch and re-exposes those metrics to Prometheus, so `tickethub-prod-mysql` CPU and `tickethub-prod-redis` memory land on the same dashboards as everything else — at the cost of CloudWatch API calls and a minute or two of delay. Self-managing MySQL or Redis, you'd run `mysqld_exporter`/`redis_exporter` and get richer, fresher data — one of the genuine trade-offs of managed services from Module 8.

## 6. Dashboards as craft

A dashboard is an argument about what matters, read under stress. Design top-down by audience:

- **Top row: golden signals plus the business.** Requests/s, 5xx ratio, p99 latency, **orders per minute**. An exec — or you at 19:02 during an on-sale — reads row one and knows if the company is okay. Orders/min belongs here because it is what the whole system exists to protect; platform metrics can look healthy while sales crater.
- **Middle rows: per-dependency.** RDS connections and CPU; **Redis memory % — Module 8's noeviction trade-off and its CloudWatch alarm land on this panel**; depth and throughput per queue (`default`/`pdfs`/`mail`). When row one goes red, these rows say *which dependency*.
- **Bottom: capacity and change.** HPA current vs. max replicas, FPM worker utilization, node headroom — and **deploy markers**: Grafana annotations posted by CI at each release, tagged with the sha (Module 7). A p99 step-change starting exactly at a marker closes the "what changed?" investigation before it opens.

The **on-sale dashboard** — the one on the wall at 19:00 — as a spec:

| Row | Panels | The question it answers |
|---|---|---|
| 1 | Orders/min · reservations/min · 5xx ratio · p99 checkout latency | Are we selling? Are buyers hurting? |
| 2 | Reservation→payment conversion · reservation-expiry rate (12.1's warning signal, now a metric) | Is the funnel leaking? |
| 3 | Redis memory % · RDS connections/CPU · queue depth ×3 | Which dependency buckles first? |
| 4 | HPA replicas vs. max · FPM utilization · node capacity vs. Karpenter limits | How much runway is left? |

Dashboards are JSON: keep them in the repo and deploy them with the chart, like everything else in this course.

## 7. Alerting: page on symptoms

The alerting failure mode is not missing alerts — it is **alert fatigue**, the desensitization spiral: too many pages → most need no action → humans learn pages are ignorable → the page that mattered gets acked from bed and slept on. Once a team is desensitized, the pager is worthless no matter how good the rules are. So the philosophy is strict:

**Page on symptoms, not causes.** A symptom is user-visible harm or imminent SLO damage: error ratio burning the budget, checkout p99 through the roof, orders/min at zero during an on-sale. A cause is CPU at 90%, one pod restarting, a node dying. Causes without symptoms wake nobody — the HPA and Karpenter exist precisely so that node-level trouble *doesn't* become user-visible. High CPU at 3 a.m. with a healthy error ratio is the system working.

**Every page must be actionable and urgent.** If the responder's honest reaction is "I'll look tomorrow," it's a ticket. If it's "there's nothing I can do," it's a dashboard panel. Cause-level signals still matter — they become the *diagnostic* layer: Slack notifications, dashboard rows, ticket queues that explain the symptom when a real page fires.

**Alertmanager makes the routing mechanical.** Alerts carry a `severity` label: `page` routes to PagerDuty, `ticket` to a Slack channel reviewed each morning. *Grouping* collapses related alerts (twenty pods failing on one node is one notification, not twenty) and *inhibition* suppresses downstream noise when an upstream alert already fired — if "Redis down" is firing, "queue depth rising" adds nothing but adrenaline.

## 8. SLIs, SLOs, and the error budget

Three terms, precisely:

- **SLI** (indicator): a *measurement* of user-experienced service, almost always a ratio of good events to total events. "Fraction of requests that succeeded."
- **SLO** (objective): your *internal target* for an SLI over a window. "99.9% of requests succeed, per calendar month."
- **SLA** (agreement): an *external contract* with financial penalties, always looser than the SLO so you breach your own target before you breach a customer's contract.

TicketHub's SLOs — chosen, not copied, because targets must reflect what users tolerate and what the business needs:

1. **Availability: 99.9% of API requests succeed (non-5xx), per calendar month.** 4xx is excluded deliberately: a scalper bot hammering login with bad tokens is not a service failure and must not burn budget.
2. **Latency: 99% of requests complete in under 500 ms, per calendar month.** Slow *is* down for a buyer holding a 15-minute reservation.
3. During announced on-sales, the team *watches* tighter thresholds (p99 < 1 s on checkout routes) without changing the contractual SLO — the monthly window already averages over spikes.

**The error budget** is the SLO inverted: 99.9% allowed success means 0.1% allowed *failure*. Over an average month (30.44 days = 43,830 minutes), 0.1% is **43 minutes 49 seconds** of total downtime — or the equivalent spread as partial errors: at 100 req/s steady, about 2.6 million requests/month, so ~2,630 failed requests to "spend." The budget reframes reliability from "never fail" (impossible, and paralyzing) to "fail within an allowance" — and unspent budget is *permission to take risk*.

**Burn-rate alerts** are the modern way to page on the budget. Burn rate = spending speed: 1× consumes exactly the budget over the month; 14.4× burns the whole month's budget in ~2 days. The practice (from Google's SRE workbook) is **multi-window, multi-burn-rate**: page when the error ratio exceeds 14.4× budget over *both* 1 hour and 5 minutes; ticket at 6× over 6 hours and 30 minutes. Why two windows per alert? The long window proves the burn is *sustained* (a 30-second blip won't page); the short window proves it is *still happening* (the alert resolves promptly once you've mitigated, instead of ringing for an hour on stale errors). One window alone is either flappy or sluggish; two gives fast detection *and* fast resolution. Full rules in the hands-on.

**The error-budget policy is the cultural contract** that gives the numbers teeth, agreed with product *before* the first breach: while budget remains, ship aggressively — daily deploys, canaries, experiments. When the month's budget is spent, feature work pauses and the team ships reliability work until the SLI recovers. No blame, no per-incident negotiation — the policy already decided. This is Module 1's speed-versus-stability tension made mechanical: the same number that lets you move fast tells you when to stop.

## Hands-on with TicketHub

### Instrumenting Laravel, honestly

The awkward truth first: PHP-FPM runs many worker processes, each with private memory. A counter incremented in worker 3 is invisible to worker 7, so in-process metric storage — the default in most client examples — silently undercounts. The standard fix with `promphp/prometheus_client_php` is the **Redis storage adapter**: all workers aggregate into Redis, and any worker can render the full picture at scrape time. (The keys are small and bounded — by cardinality, which Section 4 already made you keep low.)

```php
<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Prometheus\CollectorRegistry;
use Prometheus\Storage\Redis;

class MetricsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(CollectorRegistry::class, function () {
            return new CollectorRegistry(new Redis([
                'host' => config('database.redis.default.host'),
                'port' => (int) config('database.redis.default.port'),
            ]));
        });
    }
}
```

The HTTP middleware — route, method, status only (the labels rule):

```php
<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Prometheus\CollectorRegistry;
use Symfony\Component\HttpFoundation\Response;

class RecordHttpMetrics
{
    public function __construct(private CollectorRegistry $registry) {}

    public function handle(Request $request, Closure $next): Response
    {
        $start = microtime(true);
        $response = $next($request);

        $this->registry->getOrRegisterHistogram(
            'tickethub', 'http_request_duration_seconds',
            'HTTP request duration by route',
            ['route', 'method', 'status'],
            [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        )->observe(microtime(true) - $start, [
            $request->route()?->getName() ?? 'unmatched',
            $request->method(),
            (string) $response->getStatusCode(),
        ]);

        return $response;
    }
}
```

Business metrics are first-class, not an afterthought — one line where the order commits (next to 12.1's `Order placed` log):

```php
$this->registry->getOrRegisterCounter(
    'tickethub', 'orders_created_total', 'Orders placed'
)->inc();
```

Queue depth is a gauge, exported by a scheduled command (a metrics *bridge*: Horizon knows the depth; Prometheus needs it exposed):

```php
<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Queue;
use Prometheus\CollectorRegistry;

class ExportQueueMetrics extends Command
{
    protected $signature = 'metrics:export-queues';
    protected $description = 'Export Horizon queue depths as Prometheus gauges';

    public function handle(CollectorRegistry $registry): void
    {
        $gauge = $registry->getOrRegisterGauge(
            'tickethub', 'horizon_queue_depth', 'Jobs waiting', ['queue']
        );

        foreach (['default', 'pdfs', 'mail'] as $queue) {
            $gauge->set(Queue::size($queue), [$queue]);
        }
    }
}
```

Schedule it `everyMinute()` alongside `ExpireReservations`. One-minute resolution is honest and sufficient for a capacity signal.

The `/metrics` endpoint renders the registry:

```php
use Prometheus\CollectorRegistry;
use Prometheus\RenderTextFormat;

Route::get('/metrics', function (CollectorRegistry $registry) {
    $renderer = new RenderTextFormat();

    return response($renderer->render($registry->getMetricFamilySamples()))
        ->header('Content-Type', RenderTextFormat::MIME_TYPE);
});
```

Protect it two ways: the Ingress simply never routes `/metrics` (Prometheus scrapes pod IPs directly, inside the cluster), and nginx belt-and-braces it — in the Module 6 config, `location = /metrics { allow 10.0.0.0/16; deny all; ... }` restricts it to the VPC. Metrics leak topology and business volume; they are not public.

For FPM saturation, run the standard `php-fpm_exporter` as a sidecar in the `tickethub-web` pod reading FPM's status socket — it exposes `phpfpm_active_processes`, `phpfpm_total_processes`, and the `phpfpm_max_children_reached_total` counter: Module 3's tuning knob, finally observable in production.

Finally, discovery — one ServiceMonitor, and the operator does the rest:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: tickethub-web
  namespace: tickethub
  labels:
    release: kube-prometheus-stack   # must match Prometheus's selector
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: tickethub-web
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

### PromQL that answers questions

Each query, with its English translation:

```promql
# 1. 5xx per second, by route — "what is failing, and where?"
sum by (route) (rate(tickethub_http_request_duration_seconds_count{status=~"5.."}[5m]))

# 2. p99 latency across all web pods — "how slow is the slowest 1%?"
histogram_quantile(0.99,
  sum by (le) (rate(tickethub_http_request_duration_seconds_bucket[5m])))

# 3. Error ratio — the availability SLI itself
sum(rate(tickethub_http_request_duration_seconds_count{status=~"5.."}[5m]))
/
sum(rate(tickethub_http_request_duration_seconds_count[5m]))

# 4. Queue depth — is the pdfs queue drowning?
tickethub_horizon_queue_depth{queue="pdfs"}

# 5. Node memory saturation — "are the Karpenter nodes running out?"
1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

# 6. FPM worker utilization — Module 3's pm.max_children as a live number
sum(phpfpm_active_processes) / sum(phpfpm_total_processes)

# 7. Orders per minute — the business, on the same axis as the platform
sum(rate(tickethub_orders_created_total[5m])) * 60
```

Query 3 is worth staring at: that ratio *is* the SLI, and everything in Section 8 is arithmetic on top of it.

### The burn-rate alerts

As a `PrometheusRule`, deployed through the same Git → Argo CD path as everything else. SLO 99.9% → budget ratio 0.001:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tickethub-slo-burn
  namespace: tickethub
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: tickethub-slo
      rules:
        - alert: TicketHubErrorBudgetFastBurn
          expr: |
            ( sum(rate(tickethub_http_request_duration_seconds_count{status=~"5.."}[1h]))
              / sum(rate(tickethub_http_request_duration_seconds_count[1h])) ) > (14.4 * 0.001)
            and
            ( sum(rate(tickethub_http_request_duration_seconds_count{status=~"5.."}[5m]))
              / sum(rate(tickethub_http_request_duration_seconds_count[5m])) ) > (14.4 * 0.001)
          for: 2m
          labels:
            severity: page
          annotations:
            summary: "Error budget burning 14.4x — month's budget gone in ~2 days"
        - alert: TicketHubErrorBudgetSlowBurn
          expr: |
            ( sum(rate(tickethub_http_request_duration_seconds_count{status=~"5.."}[6h]))
              / sum(rate(tickethub_http_request_duration_seconds_count[6h])) ) > (6 * 0.001)
            and
            ( sum(rate(tickethub_http_request_duration_seconds_count{status=~"5.."}[30m]))
              / sum(rate(tickethub_http_request_duration_seconds_count[30m])) ) > (6 * 0.001)
          for: 15m
          labels:
            severity: ticket
          annotations:
            summary: "Sustained elevated errors — budget burning 6x"
```

Alertmanager routes `severity: page` to PagerDuty and `severity: ticket` to Slack. This pair, plus a handful of symptom pages (orders/min at zero during business hours; Redis memory > 90% — Module 8's documented trade-off deserves a page *before* noeviction starts refusing writes), is close to the *entire* paging surface. Under ten page-worthy rules is a feature, not a gap.

### The scoreboard: DORA remeasured

Module 1 measured TicketHub's delivery performance before any of this existed. Eleven modules later, with receipts:

| DORA metric | Module 1 baseline | Now | What did it |
|---|---|---|---|
| Deployment frequency | Monthly | Multiple per day | CI images (M7) · GitOps auto-sync to staging, tag → prod (M9, M11) |
| Lead time for changes | ~3 weeks | Hours | Trunk-based flow (M4) · full pipeline as the only path (M9) |
| Change failure rate | ~30% | <5% | Test/quality gates (M7) · parity via containers (M5–6) · canaries & flags (M9) |
| MTTR | ~4 hours | Minutes | Instant rollback (M9/M11) · kill switches (M9) · **alerts that detect in minutes (this lecture)** |

MTTR deserves the honest footnote: you cannot repair what you haven't detected. Before this lecture, "time to restore" quietly included "time until someone noticed." Burn-rate paging closes that gap — which is why the observability module, not the deployment module, completes the DORA story.

## Real-world best practices

- **Instrument the business, not just the machinery.** Orders/min, reservations/min, conversion — on the same dashboards as CPU. Why: platform metrics can be green while revenue is zero; the business metric is the symptom that always matters.
- **Enforce the labels rule in code review.** Any new label on a high-traffic metric gets asked "is its value set bounded?" Why: cardinality explosions are silent until Prometheus OOMs, and the fix (dropping series) loses history.
- **Alert rules live in Git and deploy like code.** `PrometheusRule` through the values-PR path, reviewed. Why: an unreviewed alert change can silence your pager — an outage of your safety system.
- **Review every page monthly.** Was it actionable? Urgent? Symptom-level? Kill or demote everything that fails. Why: fatigue accrues page by page; pruning is the only antidote.
- **Keep the paging surface small and symptom-shaped.** Burn rates, business-flatline, and the one or two *documented* dependency cliffs (Redis memory under noeviction). Why: every additional page dilutes all the others.
- **Deploy annotations on every dashboard from day one.** Why: "did a release cause this?" is the first question of every regression; markers answer it at a glance.

## Common pitfalls

1. **Averaging latency.** `avg(request_time)` on a dashboard looks reasonable and hides the bimodal truth (Section 4's 490 ms lie). Correct: histograms plus `histogram_quantile` for p95/p99; if you keep a mean panel, label it honestly and never alert on it.
2. **IDs as label values.** `orders_total{order_id="48211"}` feels convenient — one series per order, millions of series, a dead Prometheus. Correct: labels are GROUP BY dimensions; the order lives in logs (12.1) and traces (12.3).
3. **Paging on causes.** "CPU > 80%" pages at 3 a.m. while the HPA handles it; three months later every page gets snoozed. Correct: page on SLO burn and user-visible symptoms; causes go to dashboards and tickets.
4. **In-process metric storage under FPM.** Examples copied from single-process languages silently shard your counters across workers. Correct: the Redis adapter (or an equivalent shared store) — the numbers must survive both process boundaries and pod restarts. Verify by comparing `orders_created_total` deltas against the database count for an hour.
5. **A public `/metrics`.** It leaks routes, traffic volume, and business numbers to anyone who finds it. Correct: never routed by the Ingress, IP-restricted in nginx, scraped only from inside the cluster.
6. **A 100% SLO (or one nobody chose).** 100% means a zero error budget — every blip is a crisis and the policy is meaningless; a copied "three nines" nobody debated has no cultural force. Correct: choose the target with product, write the policy down, revisit when the budget goes chronically unspent or perpetually dry.

## Exercises

1. **Reservation metrics.** Add `tickethub_reservations_created_total` and `tickethub_reservations_expired_total` counters (the metric twin of 12.1's expiry warning), then write the PromQL for the reservation→order conversion ratio over 1 h.
2. **The latency SLO's SLI.** Using the histogram, write the PromQL for "fraction of requests under 500 ms over 30 days" (hint: the `le="0.5"` bucket over `_count`). Check it against the 99% target.
3. **Job-duration histograms.** Instrument `GenerateTicketPdf` with a `tickethub_job_duration_seconds` histogram labeled by job class (bounded!). Graph p95 PDF generation time; decide whether the `pdfs` queue needs more Horizon workers during an on-sale.
4. **Tune the pager.** Trigger the fast-burn alert in staging (a route that returns 500 behind a Pennant flag, plus load). Measure detect→page latency, then confirm the alert *resolves* quickly after you disable the flag — the short window doing its job.
5. **Stretch: capacity math.** Using `phpfpm_active_processes`, node metrics, and orders/min under a staging load test, compute the requests/s at which `tickethub-web` saturates with current `pm.max_children` and HPA limits. Write the one-paragraph capacity statement ("we saturate at ~N× normal load") — you'll want it for Lecture 12.5's on-sale pre-flight.

## What's next

You now know *that* checkout p99 is 2 seconds — the dashboard says so — but nothing on it says *where* those 2 seconds go: nginx? FPM? a slow query? Redis? S3? [Lecture 12.3 — Tracing & APM](03-tracing-apm.md) adds the third signal: OpenTelemetry tracing through Laravel and Horizon, trace IDs joined to 12.1's logs, exemplars linking this lecture's histograms to individual slow traces, and Sentry for error workflow — the full toolkit for *finding* the slow query instead of inferring it.
