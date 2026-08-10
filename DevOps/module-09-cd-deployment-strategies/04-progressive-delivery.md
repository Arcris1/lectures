# Lecture 9.4 — Progressive Delivery

> **Module 9 — Continuous Delivery & Deployment Strategies** · Lecture 4 of 4 · Estimated time: ~90 min

[Lecture 9.3](03-ecs-fargate-pipeline.md) ended with a machine that deploys safely: health-checked rolling updates, a circuit breaker, an asserted version. This lecture starts with the uncomfortable truth about that machine: **it verifies health, not correctness.** A release that prices every VIP ticket at $0.00 passes `/up` flawlessly — FPM answers, the framework boots, HTTP 200s flow — while the rollout marches it to 100% of your users at full automated speed. You've built a system that distributes mistakes efficiently. Progressive delivery is the discipline of shrinking the blast radius of being *wrong*: exposing each change to the fewest users needed to learn the truth about it, with an instant way back. It closes both this module and the loop [Module 1](../module-01-devops-foundations/04-measuring-devops-dora.md) opened with DORA.

## Learning objectives

- Explain the healthy-versus-correct gap and why health checks structurally cannot close it
- Compare rolling, blue/green, canary, and feature flags as one ladder of shrinking blast radius and growing machinery
- Configure CodeDeploy blue/green for ECS — test listener, shifting configs, alarms, auto-rollback — and judge when it earns its complexity
- Ship features behind Laravel Pennant flags with segment-then-percentage rollouts, and change exposure at runtime without deploying
- Build operational kill switches that degrade TicketHub gracefully under load, with a recovery path
- Choose a delivery mechanism per change type using a decision framework, and connect progressive delivery to the DORA metrics

## 1. Healthy is not correct

Every safety mechanism in 9.3 keys off one signal: health checks. `/up` answers "does the framework boot and respond?" — which catches crashes, missing secrets, broken autoloaders, dead FPM pools. It cannot catch: a discount computed backwards, an inventory check inverted, an email template addressing every customer as "Dear null", a query that's correct but 40× slower. **Health checks catch broken; they are blind to wrong.** And wrong is the more common failure — your test suite catches most broken before merge, while wrong is precisely what escapes tests (the test encodes the same misunderstanding the code does).

The rolling deploy makes this worse in one specific way: it's *all-or-nothing on a timer*. Within ~3 minutes, 100% of traffic runs the new code. Your first signal that something is wrong is customers — all of them at once. The fix is not better health checks (deep checks would still miss "wrong prices" — correctness isn't probeable in general). The fix is structural: **expose fewer users first, compare against a baseline, and keep an instant way back.**

That's the ladder, and each rung trades machinery for blast radius:

| Rung | Blast radius of a bad release | Time to revert | New machinery |
|---|---|---|---|
| Rolling (9.3) | 100% at rollout speed | Minutes (redeploy previous revision) | None — you have it |
| Blue/green | 100%, but *after* a verified cutover | Seconds (point back) | 2nd environment, cutover control |
| Canary | 5–10% for a bake window | Seconds (shift back) | Weighted routing + comparison metrics |
| Feature flags | Exactly whom you choose, per feature | Seconds (flip, no deploy) | Flag store, hygiene discipline |

Read it as *shrinking blast radius, growing machinery* — and note the last column is why you climb only as high as each change needs (section 6's framework).

## 2. Blue/green, properly

Blue/green runs **two complete copies** of the service: *blue* (current, serving all traffic) and *green* (new, deployed fully, serving none). You verify green while it costs users nothing — real infrastructure, real config, synthetic or test traffic — then **cut over at the routing layer** in one operation. Rollback is the same operation pointed backwards: seconds, no rebuild, no redeploy, because blue is still running, warm, untouched. The costs are honest and two: **2× capacity during the transition window** (and until you retire blue), and cutover-scale exposure — when you flip, everyone flips, so blue/green without a verification step is just a rolling deploy with better branding.

One thing blue/green does **not** duplicate: **the data layer.** Blue and green share the same RDS, the same Redis. Which means [9.2](02-zero-downtime-laravel-deploys.md)'s contract still binds with no exceptions — the schema must serve *both* versions for the whole window, including the "blue kept warm for rollback" tail. Expand/contract isn't a VM-era technique you've outgrown; it's the invariant every rung of this ladder stands on. A blue/green cutover with a one-release column rename is a rollback button wired to a landmine.

### On ECS: CodeDeploy drives it

ECS delegates blue/green to **CodeDeploy**: the service is created with `--deployment-controller type=CODE_DEPLOY`, two target groups take turns being live, and a second **test listener** (`:8443`) points at green before the real one does. The moving parts, with the config that defines them:

- A CodeDeploy **application** (compute platform ECS) and **deployment group** binding the service to its listener/target-group pair:

```json
{
  "applicationName": "tickethub-staging-api",
  "deploymentGroupName": "tickethub-api-bluegreen",
  "serviceRoleArn": "arn:aws:iam::111122223333:role/tickethub-codedeploy-ecs",
  "ecsServices": [{ "clusterName": "tickethub-staging", "serviceName": "tickethub-api" }],
  "deploymentStyle": { "deploymentType": "BLUE_GREEN", "deploymentOption": "WITH_TRAFFIC_CONTROL" },
  "loadBalancerInfo": {
    "targetGroupPairInfoList": [{
      "targetGroups": [{ "name": "tickethub-staging-tg-blue" }, { "name": "tickethub-staging-tg-green" }],
      "prodTrafficRoute": { "listenerArns": ["arn:aws:elasticloadbalancing:...:listener/app/tickethub-staging-alb/.../443"] },
      "testTrafficRoute": { "listenerArns": ["arn:aws:elasticloadbalancing:...:listener/app/tickethub-staging-alb/.../8443"] }
    }]
  },
  "blueGreenDeploymentConfiguration": {
    "deploymentReadyOption": { "actionOnTimeout": "CONTINUE_DEPLOYMENT" },
    "terminateBlueInstancesOnDeploymentSuccess": { "action": "TERMINATE", "terminationWaitTimeInMinutes": 15 }
  },
  "alarmConfiguration": {
    "enabled": true,
    "alarms": [{ "name": "tickethub-staging-green-5xx-delta" }]
  },
  "autoRollbackConfiguration": {
    "enabled": true,
    "events": ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM"]
  }
}
```

- An **appspec** the pipeline hands CodeDeploy instead of calling `update-service` (the deploy action supports this directly via its `codedeploy-appspec` input):

```yaml
# deploy/ecs/appspec.yaml
version: 0.0
Resources:
  - TargetService:
      Type: AWS::ECS::Service
      Properties:
        TaskDefinition: <TASK_DEFINITION>        # filled by the deploy action
        LoadBalancerInfo:
          ContainerName: nginx
          ContainerPort: 80
```

- A **shifting config** deciding how production traffic moves once you proceed: `CodeDeployDefault.ECSAllAtOnce` (classic blue/green: one flip), `ECSLinear10PercentEvery1Minutes` (steady ramp), or `ECSCanary10Percent5Minutes` (10%, hold, then the rest — blue/green and canary are the *same machinery* with different schedules, which is why AWS ships them as one feature).

The flow you get: green tasks launch behind the test listener → you (or an automated hook) verify against `https://api.staging.tickethub.example:8443` — real service, real data tier, zero customers → traffic shifts per the config → the **bake time** begins, during which the `alarmConfiguration` alarms are armed and any breach triggers **automatic rollback** (traffic re-points at blue, still warm for `terminationWaitTimeInMinutes`) → blue terminates and green is the new blue.

**The honest note:** CodeDeploy-ECS adds real moving parts — a second target group, a service role, an appspec, a deployment group, a differently-shaped pipeline step, and a service that must be *created* with the CODE_DEPLOY controller (it's immutable after creation — adopting it means recreating the service). Many teams get 90% of the value from what you already have: circuit-breaker rolling for mechanical safety plus flag-based canaries (section 4) for correctness risk. This course wires CodeDeploy **in staging, as a lab** (exercise 4 walks the service recreation), not as TicketHub's default path — and section 6's framework chooses per-change rather than crowning one mechanism forever.

## 3. Canary: a few users tell you the truth

A canary sends a small slice of real traffic — 5–10% — to the new version and *compares it against the old before proceeding*. Two implementations, different trade-offs:

**Infrastructure canary:** route by weight — ALB weighted target groups (90/10 across two TGs) or CodeDeploy's canary presets automate exactly this. Strengths: covers *everything* in the release (framework upgrades, dependency bumps, config changes — things no flag can wrap). Weaknesses: the slice is random per-request (session stickiness needs forwarding-cookie care), infrastructure-grained (one canary at a time), and needs the routing machinery above.

**Application canary via flags** (next section): the new *code path* ships dark inside the normal rolling deploy; a flag exposes it to chosen users. Strengths: cheap (no routing changes), **per-user targeting** (internal staff first — a slice you can talk to), many independent canaries at once. Weakness: only covers what you wrapped — a flag can't canary a PHP upgrade.

Either way, hear this clearly: **a canary without comparison metrics is theater.** Sending 10% of traffic somewhere you're not measuring is just a smaller outage. During the bake you watch *deltas*, canary versus baseline: **error-rate delta** (5xx and exception rates), **p99 latency delta** (the tail betrays slow queries the median hides — Module 3's queueing lesson again), and — the one teams skip — **the business metric**: for TicketHub, *orders completed per minute*. A checkout regression that throws no errors and adds no latency still shows up as orders/min sagging on the canary side; nothing else will catch it. Honest dependency naming: real side-by-side dashboards arrive with [Module 12](../module-12-observability-security-sre/02-metrics-alerting-slos.md)'s Prometheus/Grafana; the interim floor is CloudWatch, and here is the 5xx-delta alarm the deployment group above references:

```console
$ aws cloudwatch put-metric-alarm \
    --alarm-name tickethub-staging-green-5xx-delta \
    --alarm-description "Green TG serving elevated 5xx during bake (Lecture 9.4)" \
    --namespace AWS/ApplicationELB --metric-name HTTPCode_Target_5XX_Count \
    --dimensions Name=TargetGroup,Value=targetgroup/tickethub-staging-tg-green/1a2b3c4d5e6f7a8b \
                 Name=LoadBalancer,Value=app/tickethub-staging-alb/50dc6c495c0c9188 \
    --statistic Sum --period 60 --evaluation-periods 3 --datapoints-to-alarm 2 \
    --threshold 5 --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching
```

Crude — an absolute count, not a true baseline-relative delta — but it turns "bake time" from a euphemism for waiting into an armed tripwire, and Module 12 replaces it with the real thing.

## 4. Feature flags with Laravel Pennant

Flags complete the idea 9.1 planted: **deploy ≠ release.** Code ships dark inside boring rolling deploys; *exposure* becomes a runtime decision, per-user, reversible in seconds without touching the pipeline. Laravel's first-party answer is **Pennant**:

```console
$ composer require laravel/pennant
$ php artisan vendor:publish --provider="Laravel\Pennant\PennantServiceProvider"
$ php artisan migrate   # creates the `features` table
```

The **database driver** (the default) is the point for us: resolved flag values persist per-scope in MySQL, which means *changing* them at runtime changes behavior across every task and worker — no deploy, no config cache rebuild. (The `array` driver is for tests.)

### The promo-codes feature finally ships

Narrative payoff four modules in the making: Module 4 built `feat/145-promo-codes` and released `v1.6.0` with "promo-codes groundwork (dark, flag off)". That code has been deploying harmlessly ever since. Now it releases — progressively. Definitions live in a service provider:

```php
<?php
// app/Providers/FeatureServiceProvider.php

namespace App\Providers;

use App\Models\User;
use Illuminate\Support\Lottery;
use Illuminate\Support\ServiceProvider;
use Laravel\Pennant\Feature;

class FeatureServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        // feature.* — release flags: new functionality, temporary by design.
        // Rollout: internal organizers first, then a percentage of everyone.
        Feature::define('feature.promo-codes', function (User $user): mixed {
            // Segment 1: our own organizers — people we can talk to
            // when something is off, before any customer sees it.
            if ($user->isOrganizer() && $user->is_internal) {
                return true;
            }

            // Segment 2: percentage rollout. Lottery runs ONCE per user;
            // the database driver stores the outcome, so each user's
            // experience is sticky, not a coin flip per request.
            return Lottery::odds(10, 100);
        });

        // ops.* — kill switches: guard load-bearing behavior, default ON,
        // flipped off under operational stress. Global scope (not per-user).
        Feature::define('ops.pdf-generation', fn (mixed $scope) => true);
    }
}
```

The checks, at the two places exposure decisions belong — routing and the code path itself:

```php
// routes/api.php — the endpoint simply doesn't exist for unflagged users
use Laravel\Pennant\Middleware\EnsureFeaturesAreActive;

Route::post('/orders/{order}/promo-code', [PromoCodeController::class, 'store'])
    ->middleware(['auth:sanctum', EnsureFeaturesAreActive::using('feature.promo-codes')]);
```

```php
// app/Http/Controllers/PromoCodeController.php (excerpt) — checkout totals
// consult the same flag, so no unflagged path can price with a promo
public function store(Request $request, Order $order): JsonResponse
{
    abort_unless(Feature::active('feature.promo-codes'), 404);

    $validated = $request->validate(['code' => ['required', 'string', 'exists:promo_codes,code']]);

    $order = app(ApplyPromoCode::class)->handle($order, $validated['code']);

    return response()->json(OrderResource::make($order));
}
```

(`EnsureFeaturesAreActive` returns 400 by default; the in-controller `abort_unless(..., 404)` keeps the endpoint invisible rather than tantalizing. Belt and braces, because middleware lists get edited.)

**Changing exposure without deploying — the point.** The define closure sets the *default* for first resolution; runtime overrides live in the database and win:

```console
$ aws ecs execute-command --cluster tickethub-staging --task <task-id> \
    --container app --interactive --command "php artisan tinker"
> Feature::for(User::internalOrganizers()->get())->activate('feature.promo-codes');
> // widen the lottery: change odds in code is a deploy — but forcing outcomes isn't:
> Feature::activateForEveryone('feature.promo-codes');    // 100%, right now
> Feature::deactivateForEveryone('feature.promo-codes');  // the instant undo
```

One cache subtlety, stated honestly: raising `Lottery::odds` in code *is* a deploy (it's a closure), and already-resolved users keep their stored value until you `php artisan pennant:purge feature.promo-codes` — purging clears stored resolutions so the new definition re-rolls. Pennant also memoizes per-process; long-lived Horizon workers should flush between jobs (below) or they'll honor a kill switch one job late.

### Kill switches: degrade on purpose

Release flags manage *new* behavior; **ops flags** manage *load-bearing* behavior. TicketHub's worked example: during a heavy on-sale, `GenerateTicketPdf` (CPU-heavy, `pdfs` queue) competes for resources exactly when checkout must not slow down. The professional move is a documented degradation: **orders keep completing, PDFs pause, nothing is lost, recovery is one command.** The flag check goes where PDFs are *enqueued*:

```php
<?php
// app/Listeners/QueueTicketPdfGeneration.php — on OrderPaid

namespace App\Listeners;

use App\Events\OrderPaid;
use App\Jobs\GenerateTicketPdf;
use Laravel\Pennant\Feature;

class QueueTicketPdfGeneration
{
    public function handle(OrderPaid $event): void
    {
        // Long-lived worker: re-read flags per job, not per process lifetime.
        Feature::flushCache();

        if (! Feature::active('ops.pdf-generation')) {
            // Degraded mode: skip the enqueue. Tickets carry no pdf_path,
            // which IS the backlog marker — no extra state to maintain.
            // Customers already have their QR codes; the email says
            // "your printable PDF is on its way."
            return;
        }

        foreach ($event->order->tickets as $ticket) {
            GenerateTicketPdf::dispatch($ticket)->onQueue('pdfs');
        }
    }
}
```

```php
<?php
// app/Console/Commands/GeneratePendingPdfs.php — the recovery path

namespace App\Console\Commands;

use App\Jobs\GenerateTicketPdf;
use App\Models\Ticket;
use Illuminate\Console\Command;

class GeneratePendingPdfs extends Command
{
    protected $signature = 'tickethub:generate-pending-pdfs {--chunk=200}';

    protected $description = 'Backfill PDFs skipped while ops.pdf-generation was off';

    public function handle(): int
    {
        $dispatched = 0;

        Ticket::whereNull('pdf_path')
            ->whereRelation('order', 'status', 'paid')
            ->chunkById((int) $this->option('chunk'), function ($tickets) use (&$dispatched) {
                foreach ($tickets as $ticket) {
                    GenerateTicketPdf::dispatch($ticket)->onQueue('pdfs');
                    $dispatched++;
                }
            });

        $this->info("Dispatched {$dispatched} PDF jobs to the pdfs queue.");

        return self::SUCCESS;
    }
}
```

The on-sale runbook writes itself: queue depth climbing and checkout p99 rising → `Feature::deactivateForEveryone('ops.pdf-generation')` (tinker via ECS Exec — announced, per the ritual) → on-sale ends → flip it back on → `php artisan tickethub:generate-pending-pdfs` → Horizon chews through the backlog. Orders never slowed. `GenerateTicketPdf` is naturally idempotent-friendly (skip if `pdf_path` set) so the recovery can't double-generate. *Degrading on purpose beats failing by surprise* — that sentence is most of SRE, three modules early.

### Flag hygiene: flags are debt

Every flag is a fork in your codebase that someone must eventually collapse — treat each as **borrowed complexity with a repayment plan**:

- **Naming**: prefixes declare intent and lifecycle — `feature.*` (temporary by design; dies at 100%) vs `ops.*` (permanent, documented in runbooks). Nobody should have to ask which kind a flag is.
- **Birth certificate**: at creation, every flag gets an owner and a removal ticket (the `feature.promo-codes` PR links issue #163, "remove promo-codes flag after 2 weeks at 100%"). A flag without a removal ticket is a permanent flag that hasn't admitted it yet.
- **Quarterly audit**: list every flag (`features` table + grep), and for each: still needed? at 100% for a month? → delete the flag *and both code branches*. Dead flags whose branches nobody dares remove are how codebases fossilize.
- **Test both branches** — the flag doubles your paths, and the *off* path is the one production reverts to under stress (Pennant's `array` driver in tests makes this free):

```php
// tests/Feature/PromoCodeFlagTest.php (Pest)
use App\Models\{Order, PromoCode, User};
use Laravel\Pennant\Feature;

it('applies a promo code when the flag is active', function () {
    Feature::activate('feature.promo-codes');
    $order = Order::factory()->pending()->create();
    PromoCode::factory()->create(['code' => 'EARLYBIRD', 'percent_off' => 10]);

    $this->actingAs($order->customer)
        ->postJson("/api/orders/{$order->id}/promo-code", ['code' => 'EARLYBIRD'])
        ->assertOk()
        ->assertJsonPath('data.discount_percent', 10);
});

it('hides the endpoint entirely when the flag is inactive', function () {
    Feature::deactivate('feature.promo-codes');
    $order = Order::factory()->pending()->create();

    $this->actingAs($order->customer)
        ->postJson("/api/orders/{$order->id}/promo-code", ['code' => 'EARLYBIRD'])
        ->assertNotFound();
});
```

**Dark launch**, one paragraph because you'll want it someday: run the new path on real traffic and *discard its result* — when TicketHub eventually rewrites the reservation engine, the flag runs both engines side by side, serves the old answer, and logs disagreements. Weeks of real-traffic validation with zero user exposure; the cutover, when it comes, is a formality with data behind it. It's the canary idea taken to its logical extreme: blast radius zero, learning maximal.

## 5. The decision framework

One mechanism per shop is dogma; one mechanism per *change* is engineering. TicketHub's table — argue with it, then write your own team's version down:

| Change type | Dominant risk | Mechanism |
|---|---|---|
| Routine code, bug fixes, refactors | Broken (crashes) | Rolling + circuit breaker (9.3's default) — tests and health checks cover it |
| New user-facing feature | Wrong (correctness/UX) | Ship dark in rolling deploys; **flag canary** — internal segment → percentage → 100% → delete flag |
| Checkout/pricing/inventory logic | Wrong, expensively | Flag canary **with business-metric watch** (orders/min delta); smallest segments, longest bake |
| Runtime/platform upgrade (PHP 8.5, Laravel 13, base image) | Broken, unflaggable | **Blue/green** (CodeDeploy lab config) — verify on the test listener, bake with alarms, instant cutback |
| Load-risky behavior (PDF storms, report fan-out) | Operational (capacity) | **`ops.*` kill switch** + recovery command, rehearsed before the on-sale, in the runbook |
| Core-engine rewrite | Wrong, catastrophically | **Dark launch** compare, then flag rollout |
| **Any schema change** | Overlap window | **Expand/contract, regardless of everything above** — 9.2 binds every row of this table |

That last row is deliberately redundant: no delivery mechanism on this ladder relaxes the schema contract, because they all share one database across versions.

And the DORA loop closes. Module 1 posed the paradox: elite teams deploy *more often* with *fewer* failures — how? This table is how. **Change failure rate** falls because failures surface at 10% exposure or behind a flag, where they often don't count as failures at all — just canaries that told the truth. **MTTR** collapses because recovery is a flag flip or a pointer swap — seconds, not an emergency deploy. And with failure cheap and recovery instant, nothing justifies batching changes anymore, so **deployment frequency** rises and **lead time** falls — which shrinks batch size, which makes each deploy safer still. The virtuous cycle isn't a slogan; it's this module's machinery, operating.

## Hands-on with TicketHub

⚠️ **Cost check:** Pennant is code (free). The CloudWatch alarm is $0.10/mo. The CodeDeploy blue/green **lab** (exercise 4) adds a second target group (free) and briefly 2× api tasks during deployments (~cents at staging size; CodeDeploy itself is free for ECS). Nothing here changes the keep/teardown posture from 9.3.

The Pennant work is one PR on the normal pipeline — which is itself the lesson: progressive delivery ships via boring deploys.

1. **Install and wire Pennant** — the `composer require`, publish, and migration from section 4. The migration is additive (a new `features` table): expand/contract trivially satisfied. Register `FeatureServiceProvider` in `bootstrap/providers.php`, add `PENNANT_STORE=database` to the SSM parameter set (`aws ssm put-parameter --name /tickethub/staging/env/PENNANT_STORE --type String --value database`) and to the task definition's `secrets` list — config through the platform, per 9.3.
2. **Commit the feature code**: the provider, routes/controller guard, listener, recovery command, and both-branches tests from section 4. Merge; watch the rolling deploy ship it all *dark* — staging behaves identically, which you can prove with the smoke test's unchanged `/up` and a 404 from the promo endpoint.
3. **Run the rollout from a shell** (ECS Exec + tinker, announced): activate for the internal-organizer segment; confirm one internal user gets 200s and a fresh customer account gets 404s. Then `Feature::activateForEveryone`; then practice the undo. Total deploys required: zero — *that's* the deliverable.
4. **Rehearse the kill switch end to end** in staging: seed an order flow, flip `ops.pdf-generation` off, complete an order (assert: order `paid`, tickets issued, no `pdfs` jobs in Horizon), flip on, run `tickethub:generate-pending-pdfs`, watch Horizon drain the backlog and `pdf_path` fill in. Ten minutes now; during a real on-sale, this rehearsal *is* the difference between a runbook and a prayer.
5. **Arm the interim alarm** — the `put-metric-alarm` from section 3 (point it at `tickethub-staging-tg-ip` until the blue/green lab creates the green TG).

## Real-world best practices

- **Let the change choose the mechanism.** Teams that canary everything drown in ceremony for typo fixes; teams that roll everything ship pricing bugs to 100%. The framework table on the wall — literally — keeps the choice a 10-second decision made consistently, and reviewable in the PR description.
- **No canary without a comparison, no bake without an armed alarm.** Traffic-splitting you aren't measuring is risk redistribution, not risk reduction. Minimum viable: the 5xx alarm wired to auto-rollback; real bar: error, p99, and business-metric deltas side by side (Module 12 builds it — until then, smaller segments and longer soaks compensate for thinner eyes).
- **Watch the business metric during any risky bake.** Orders/min is TicketHub's heartbeat; every product has one. It's the only signal that catches *wrong-but-healthy*, and it's the one engineers forget because it lives in a product dashboard, not an ops one. Put it on the same screen.
- **Kill switches are built before the load, rehearsed before the incident.** A degradation path invented at 2 a.m. mid-on-sale is improvisation with production data. Each `ops.*` flag ships with its recovery command, a runbook entry, and a calendar rehearsal — 9.1's break-glass discipline, applied to load.
- **Enforce flag hygiene structurally, not aspirationally.** Owner + removal ticket at birth, prefixes with meaning, the quarterly audit on the calendar, both branches tested. The teams drowning in 400 undocumented flags got there one "temporary" flag at a time — the ratchet only turns one way unless something turns it back.

## Common pitfalls

1. **Trusting the ladder to relax the schema contract.** "We're blue/green now — we can just rename the column, blue keeps the old code." Blue and green share one database; the rename breaks *blue* the moment it runs, which is exactly the version your rollback button points at. Correct approach: expand/contract for every schema change, every rung, forever (9.2's rule has no exceptions on this ladder).
2. **Canarying without stickiness or comparison.** A user bounces between old and new checkout on alternate requests (cart drawn by one version, submitted to another), and nobody's watching the delta anyway — the canary "passes" by not being observed. Correct approach: per-user assignment (flags give it free; weighted TGs need sticky sessions) and armed comparison metrics before the first percent shifts.
3. **Flag checks scattered at every layer.** The same feature checked in the route, the controller, three Blade-or-resource spots, and a job — flip the flag and some checks memoized, one was inverted, and the feature half-exists. Correct approach: one check at the boundary (middleware/entry point) plus at most one guard at the money path; the flag's *surface* should be as small as its blast radius.
4. **The permanent "temporary" flag.** Six months later `feature.promo-codes` is still checked on every request, nobody remembers if `false` is even a valid state, and a database hiccup resolves everyone to the off branch you stopped testing in March. Correct approach: hygiene's removal ticket, the quarterly audit, and CI running both branches until the flag dies on schedule.
5. **Adopting CodeDeploy blue/green because a conference said so.** It lands as a half-configured deployment group, a test listener no automation actually probes, and a scarier pipeline nobody fully understands — more risk, imported in the name of safety. Correct approach: the honest note from section 2 — circuit-breaker rolling + flag canaries until a change class (platform upgrades, mostly) genuinely needs routing-layer control; adopt it as a rehearsed lab first, exactly like this course does.

## Exercises

1. Classify each change with the framework table and one sentence of justification: (a) upgrading the base image to PHP 8.5; (b) a new "transfer ticket to a friend" feature; (c) rewriting inventory reservation from row locks to Redis-based holds; (d) a fix for a typo in the order-confirmed email; (e) adding an index to `orders.created_at`.
2. Extend the rollout: add a `feature.promo-codes` segment for *organizers of a specific event* (scope the feature to `Event` rather than `User` — Pennant scopes are arbitrary models) so one pilot event gets promo codes before any global percentage. Sketch the define closure and the check-site changes.
3. Build the second kill switch: `ops.nightly-reports` guarding `SendNightlySalesReports` (skip the send, log the skip), plus a `tickethub:send-missed-reports {date}` recovery command. Write the runbook entry: when to flip it, what customers see, how to recover, how to verify recovery.
4. **The blue/green lab:** recreate `tickethub-api` with `--deployment-controller type=CODE_DEPLOY` (staging can take the brief disruption — write down why production couldn't, and what that implies about *when* to adopt controllers). Create `tg-blue`/`tg-green`, the `:8443` test listener, the service role, and the deployment group from section 2; switch the workflow's api deploy step to the appspec path; run one deploy with `ECSCanary10Percent5Minutes` and watch the shift in the CodeDeploy console. Then trip the 5xx alarm during a bake (a temporary route that 500s) and document the auto-rollback timeline.
5. **Stretch — dark-launch harness.** Prototype the reservation-engine dark launch: a `feature.reservation-engine-v2` flag, a decorator that runs both the current `ReserveInventory` action and a stubbed v2, compares results, serves v1's answer, and logs mismatches with full context to a dedicated channel. Include a Pest test proving a v2 disagreement can never affect the served response. This harness pattern — run both, serve old, log deltas — is one of the highest-trust tools in platform engineering; keep it.

## What's next

Module 9 is complete, and so is the promise from Module 1: TicketHub deploys on every merge, promotes by approval, rolls out without downtime, and can now expose change as carefully as each change deserves — with the DORA loop closed by machinery instead of aspiration. What's left is the confession from 8.4's pain audit, item 5: all of this — cluster, services, target groups, alarms, roles — exists as CLI commands in scrollback and hand-edited console state. [Module 10 — Infrastructure as Code with Terraform](../module-10-terraform-iac/) fixes that: every AWS resource becomes reviewed, versioned code, the production environment finally gets built (enabling the deploy job you wrote disabled), and infrastructure changes start flowing through pull requests exactly like the application code they support.
