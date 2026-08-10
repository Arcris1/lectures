# Lecture 12.5 — SRE in Practice: Incidents & the Capstone

> **Module 12 — Observability, Security & SRE** · Lecture 5 of 5 · Estimated time: ~120 min

You can now see inside TicketHub ([logs](01-structured-logging-aggregation.md), [metrics and SLOs](02-metrics-alerting-slos.md), [traces](03-tracing-apm.md)) and you have hardened it end to end ([DevSecOps](04-devsecops.md)). What remains is the part no tool sells: the human system that runs the technical one. Site Reliability Engineering's founding observation is that production systems fail no matter how well you build them, so reliability must be *engineered* — rotations, severities, runbooks, rehearsals — not wished for. As the SRE book puts it: **hope is not a strategy.** This final lecture builds that human system for TicketHub, runs one full incident through it from page to postmortem, and then hands you the capstone: a production-readiness review you can apply to any application you will ever ship.

## Learning objectives

- Design an on-call rotation, escalation policy, and alert-review ritual that keep both the pager and the people healthy
- Run an incident as a practiced process: severity classification, explicit roles, and mitigation before diagnosis
- Write a blameless postmortem with plural contributing factors, quantified impact, and tracked action items
- Build symptom-titled runbooks and validate the assumptions behind them with gamedays
- Load-test TicketHub with k6 and gate every on-sale behind a pre-flight checklist
- Audit any application against a full production-readiness checklist — the distillation of this course

## 1. Reliability is a discipline, not a hope

Two artifacts from [Lecture 12.2](02-metrics-alerting-slos.md) are the foundation of everything here. The **SLOs** (99.9% availability, 99% of requests under 500 ms) are the objective function: they define, numerically, what "reliable enough" means, so nobody argues about it at 3 a.m. The **error budget** (43 minutes 49 seconds of unavailability per month) is the negotiation instrument: budget healthy → ship fast; budget spent → stop and fix. Everything in this lecture — who gets paged, what counts as SEV1, what a postmortem must produce — flows from defending those two numbers. That is the whole SRE stance: treat operations as a software and engineering problem, with the same rigor you applied to CI in Module 7 or infrastructure in Module 10. Systems that stay up do so because someone *designed* the response to their failure. Hope, again, is not a strategy.

## 2. On-call, humanely

On-call is where reliability engineering meets human physiology, and the math is unforgiving. A weekly rotation with **N** engineers puts each of them on call one week in N. With six people that is ~8.7 weeks a year — sustainable. With four, 13 weeks — the practical floor. Below four, weekly on-call is corrosive: sleep debt, resentment, attrition. If that is your team (and at many small companies it is), be honest instead of heroic: tier the rotation — business-hours pages to the team, overnight to a managed escalation service or a documented "we respond next morning" policy — and set your SLOs to match what you can actually staff. A 99.9% SLO nobody can defend at 4 a.m. is fiction.

Three mechanisms keep a rotation sane:

- **The handoff ritual.** Fifteen minutes at rotation change: open incidents, alerts that fired and why, flaky alerts under investigation, and — critical for TicketHub — the upcoming **on-sale calendar** and any risky changes scheduled. On-call without context is on-call blind.
- **An escalation policy with ack timeouts.** Page primary → no acknowledgment in 5 minutes → page secondary → 5 more minutes → engineering lead. Configured in the paging tool, not tribal knowledge. The point is not distrust; it is that a dead phone battery should not extend an outage.
- **Pager hygiene, enforced.** [Lecture 12.2's](02-metrics-alerting-slos.md) philosophy — page on symptoms, every page actionable and urgent — becomes policy here: pages come from **SLO burn-rate alerts, hard outage signals, and data-integrity signals only** (the oversell detector's `critical` log from [Lecture 12.1](01-structured-logging-aggregation.md), turned into a metric filter, is the canonical third category — an integrity violation is urgent even when the site is "up"). Everything else is a ticket.

Enforcement is a ritual: the **monthly alert review**. List every page from the last month. For each: was it actionable? Did it precede real user impact? A page that fails both tests gets killed or fixed *that meeting* — no backlog. This is the only known cure for alert fatigue, and skipping it is how teams end up sleeping through the real one.

Finally, name the human costs out loud, because unnamed costs get paid by the most conscientious person until they quit: interrupt load is work (on-call weeks are not full feature weeks), a bad night earns the next morning off, and on-call is compensated — allowance or time-off in lieu. Teams that treat the pager as free labor get exactly the on-call quality they pay for.

## 3. Incident response as a practiced process

When the page fires, you do not want to be inventing process. You want to be executing one.

**Severity taxonomy** — agreed in advance, with examples, so classification takes seconds:

| Severity | Definition | TicketHub examples |
|---|---|---|
| **SEV1** | User-visible outage or data-integrity risk | Checkout down or failing at scale; **overselling detected**; payments captured without orders |
| **SEV2** | Degraded service; SLO under threat | PDF delivery backlog > 30 min; p99 breaching the latency SLO; elevated errors on one route |
| **SEV3** | Minor; no current user impact | One pod crash-looping with capacity headroom; nightly sales report failed |

**Roles.** The single most important discipline in incident response: the **Incident Commander (IC) coordinates and does not debug.** The moment the IC opens a terminal, nobody is tracking the big picture, mitigations run unsequenced, and the status page goes stale. The IC assigns work, keeps the timeline, and makes the calls. An **ops lead** does the technical investigation and executes mitigations. A **comms lead** owns the status page and stakeholder updates. Small-team reality: at 2 a.m. one person wears all three hats — but they wear them *knowingly*, and hand off the moment backup arrives. The roles exist even when one head holds them.

**The flow:**

1. **Declare early.** Declaring a SEV2 that turns out to be nothing costs ten minutes; not declaring one that turns out to be real costs the whole response. Downgrading is cheap.
2. **Open a channel** (`#inc-2026-08-15-checkout`) — one place for the timeline, so the postmortem writes itself.
3. **Mitigate first, diagnose second.** This is the inversion that trips up good engineers: your instinct is to find the root cause, but users are hurting *now*. Restore service, then investigate at leisure. This course has been quietly building your mitigation menu all along:

| Mitigation | Mechanism | From |
|---|---|---|
| Roll back the release | `git revert` on the values repo → Argo CD syncs the previous image | Module 11 |
| Turn the feature off | Pennant kill switch (e.g. disable PDF generation) | Module 9 |
| Add capacity | Scale the Deployment / HPA max; Karpenter provisions nodes | Modules 9, 11 |
| Shed load / stop the bleeding | Maintenance mode, rate-limit tightening at the WAF | Modules 9, 12.4 |

   **MTTR is a mitigation metric, not a diagnosis metric.** The clock stops when users are fine, not when you understand why they weren't.
4. **Status-page honesty.** "We are investigating elevated checkout errors" within minutes beats silence followed by a novel. Customers forgive outages; they do not forgive being lied to by an all-green status page.
5. **Resolve, then hand off to the postmortem** — resolution is not the end of the incident, it is the end of its first phase.

## 4. Blameless postmortems

A postmortem exists to make the *system* — technical and human — less likely to fail the same way, and blamelessness is what makes that possible: the engineer who typed the command is your best witness, and witnesses stop talking the moment testimony becomes confession. Blameless does **not** mean consequence-free — the accountability question shifts from "who made the mistake?" to "what allowed a normal human action to become an outage?", which is John Allspaw's framing and the harder, more useful question. If your postmortem's fix is "be more careful," you have not found a fix.

Norms that make the culture real: every SEV1/SEV2 gets a postmortem within a week, while memory is fresh; it is reviewed in a standing meeting where the interesting question is the contributing factors, not the timeline recitation; and the health metric of the whole practice is the **action-item completion rate**. A team that writes beautiful postmortems and completes 20% of the actions is doing theater — the same incident will return, and the second postmortem will be angrier.

Structurally, one rule matters most: **reject the singular "root cause."** Real incidents are conjunctions — a sizing assumption *and* a missing forecast *and* a stale load model, none sufficient alone. Hunting for The One Cause produces shallow fixes and, usually, a person to pin it on. You will see this in the worked postmortem below, which is also your template.

## 5. Runbooks: written for your 3 a.m. self

A runbook is a document a stressed, half-awake engineer can execute without thinking. Four properties make one good:

- **Symptom-titled.** "Queue backlog growing," not "Horizon operations guide." You search by what you see, not by subsystem.
- **A first-five-minutes decision tree.** Which dashboard, which query, which fork in the road — before any deep theory.
- **Copy-paste commands with real names.** `kubectl -n tickethub get pods -l app=tickethub-horizon`, not `kubectl get pods -l app=<your-worker>`. Placeholders at 3 a.m. are landmines.
- **An explicit when-to-escalate line.** Runbooks that never say "stop and page X" trap juniors in heroics.

TicketHub's runbook index, one per alert or ritual:

| Runbook | Trigger |
|---|---|
| Queue backlog growing | Queue-depth alert (12.2) — written in full below |
| Redis memory approaching limit | Module 8's CloudWatch memory alarm |
| RDS failover / connection errors | DB error-rate alert |
| Deploy stuck / Argo CD out of sync | Sync failure notification (M11) |
| Certificate or DNS failure | Cert expiry / external-dns errors (M11) |
| On-sale pre-flight | Scheduled — run before every major on-sale (Section 7) |

Runbooks rot. Every incident where a runbook was used ends with a review: did it work? Fix it while the pain is fresh — and better yet, *rehearse* them before incidents do it for you. Which is what gamedays are.

## 6. Gamedays: rehearsing failure

A gameday is a scheduled, controlled failure exercise. It is not "break production for sport" — it is **testing your assumptions about failure** the way Pest tests your assumptions about code. Three rules keep it honest: **hypothesis-driven** (write down what you expect *before* pulling the lever), **blast-radius-limited** (one failure at a time, a rollback plan in hand), and **staging-first** (production chaos is for teams with years of practice and regulator-grade confidence — that is not you yet, and that is fine).

TicketHub's gameday script, run in staging under synthetic load (Section 7's k6 script at low intensity):

1. **Kill all Horizon pods:** `kubectl -n tickethub delete pods -l app=tickethub-horizon`. Hypothesis: pods reschedule within 60 s, queued jobs resume with zero loss (they live in Redis, not the pods — Module 8's whole point), the queue-depth alert fires if backlog crosses threshold. Verify each claim.
2. **Kill one web pod under load.** Hypothesis: no 5xx beyond a blip — readiness probes and ALB deregistration drain (Module 11) absorb it.
3. **Fail Redis** (reboot the staging node). Hypothesis: cache misses fall through to MySQL (slower, alive), sessions drop (users re-login — the documented cost), queue workers reconnect and resume. This is the scary one — which is exactly why you run it in staging *before* the day it happens in production at 19:02.

Every mismatch between hypothesis and outcome is a finding — usually cheaper than the incident that would have found it for you.

## 7. Load testing: the on-sale ritual

For most apps load testing is good practice. For a ticketing platform it is **existential**: your entire year's traffic distribution is spikes you can see coming on a calendar. Walking into a stadium on-sale without a load test is walking into a known exam without studying.

The tool is [k6](https://k6.io) — load scenarios as code, thresholds as pass/fail gates. TicketHub's on-sale simulation drives the real user journey — browse, reserve, confirm — with think times, because 5,000 users clicking like humans and 5,000 requests in a flat line stress completely different things:

```javascript
// load/onsale.js — run: k6 run -e BASE=https://api.staging.tickethub.example load/onsale.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    onsale: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 500 },   // doors open
        { duration: '1m', target: 5000 },  // the 19:00 stampede
        { duration: '10m', target: 5000 }, // sustained peak
        { duration: '2m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<500'],   // the latency SLO, enforced as a gate
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const BASE = __ENV.BASE;

export default function () {
  const events = http.get(`${BASE}/api/v1/events`);
  check(events, { 'browse ok': (r) => r.status === 200 });
  sleep(Math.random() * 3 + 1);                      // reading the listing

  const event = http.get(`${BASE}/api/v1/events/101`);
  check(event, { 'detail ok': (r) => r.status === 200 });
  sleep(Math.random() * 5 + 2);                      // choosing tickets

  const order = http.post(`${BASE}/api/v1/orders`, JSON.stringify({
    event_id: 101,
    items: [{ ticket_type_id: 501, quantity: 2 }],
  }), { headers: { 'Content-Type': 'application/json' } });
  const reserved = check(order, { 'reserved': (r) => r.status === 201 });
  sleep(Math.random() * 8 + 4);                      // entering payment details

  if (reserved) {
    const pay = http.post(
      `${BASE}/api/v1/orders/${order.json('data.id')}/payment`,
      JSON.stringify({ method: 'test_card' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    check(pay, { 'confirmed': (r) => r.status === 200 });
  }
}
```

Run it against **staging**, and carry Module 5's parity honesty with you: staging's RDS and Redis are smaller than production's, so absolute numbers do not transfer — *shapes* do. A p99 knee at 3,500 VUs on staging tells you where production's knee is proportionally; a lock pile-up on `SELECT ... FOR UPDATE` reservations shows up at any scale. Extrapolate capacity, never copy numbers.

The ritual completes with the **on-sale pre-flight checklist**, run the morning of every major sale: scheduled scaling armed so capacity is up *before* 19:00 (Module 9 — HPAs react in minutes; stampedes take seconds); **Redis memory headroom forecast** checked against expected attendance (you will watch this line item earn its place in the postmortem below); error budget healthy — if the month's budget is nearly spent, the on-sale is the wrong day to also ship a release; on-call staffed and aware, with the runbook index open.

## 8. Cost: reliability's sibling

Cost is an SRE concern for the same reason reliability is: both are invisible until they hurt, both are controlled by ritual rather than heroics, and they share instrumentation. TicketHub's **monthly cost review**, thirty minutes, calendar-scheduled:

- **Cost Explorer, grouped by tag.** Module 8's tagging discipline pays out here: cost per environment and per component, not one undifferentiated bill.
- **Rightsizing from real metrics.** Lecture 12.2's utilization dashboards answer "are the requests/limits honest?" — pods requesting 1 CPU and using 200m are paid-for idleness, and Karpenter consolidation (Module 11) can only pack what you honestly declare.
- **Spot coverage.** What fraction of `tickethub-horizon` hours ran on spot? It was built to drain gracefully precisely so this number can be high.
- **S3 lifecycle.** Ticket PDFs from 2024 belong in Infrequent Access or Glacier (Module 8's lifecycle rules — verify they still match reality).
- **Unit economics.** Divide monthly infrastructure cost by orders completed: **cost per order**. This is the number the business understands — "$0.04 per order, down from $0.07" lands in a way "we rightsized the node group" never will.

One line of automation backs the ritual: AWS Cost Anomaly Detection alerts on unusual spend, so a forgotten load-test cluster costs you a day, not a quarter.

## Hands-on with TicketHub

Everything above, exercised at once. This is the incident this module has been foreshadowing since Module 8 documented a trade-off and Lecture 12.1 promised you 19:03 would come.

### The incident: 19:00, stadium on-sale

A 55,000-seat stadium show goes on sale at 19:00. The team ran the pre-flight — scheduled scaling armed, budget healthy, on-call staffed — but the Redis headroom line did not exist yet. Here is the timeline as it happened, reconstructed from the incident channel:

- **19:00** — On-sale opens. Orders/min climbs past 900. All dashboards green.
- **19:02** — **Page:** `TicketHubHighErrorBurnRate` — the fast-burn alert (14.4× budget burn over 1h/5m windows, [Lecture 12.2](02-metrics-alerting-slos.md)). The on-call engineer acks in 90 seconds.
- **19:04** — **SEV1 declared** (checkout failing at scale), `#inc-2026-08-15-onsale` opened. One engineer holds IC + ops hats; a second joins at 19:09 and takes ops.
- **19:05** — Dashboards: orders/min cratering (940 → 210), p99 checkout latency 8 s, 5xx concentrated on `orders.store` and `orders.pay`. Middle row: **Redis memory 100%** — Module 8's CloudWatch memory alarm firing in parallel.
- **19:07** — Logs, pivoted by `trace_id` from an exemplar trace (Lectures [12.1](01-structured-logging-aggregation.md)/[12.3](03-tracing-apm.md)): every failing request dies on a session write — `OOM command not allowed when used memory > 'maxmemory'`. Diagnosis in three minutes, because every signal joins on the same IDs.
- **19:08** — The team recognizes the shape: this is **Module 8's documented trade-off surfacing exactly as designed.** Redis runs `noeviction` because the queues live there — eviction would silently destroy jobs. The designed failure mode: when memory fills, *writes error loudly* instead. Cache and session writes are failing; the **queued jobs already in Redis are safe**, which is precisely what the policy bought.
- **19:10** — Mitigation 1: **Pennant kill switch** disables PDF generation (Module 9). PDF enqueues stop; queue keys stop growing; customers can get PDFs later — they cannot checkout later.
- **19:12** — Mitigation 2: ElastiCache scale-up to the next node size initiated. ETA ~15 min — capacity is the fix, but not a fast one.
- **19:14** — Mitigation 3, from the Redis-memory runbook's documented option: **flush the rate-limiter keyspace** (`SCAN`+`UNLINK` on `rate_limit:*`) — ~19% of used memory, safe to lose (limits reset for a few minutes), frees headroom *now*. Session writes begin succeeding.
- **19:18** — Error rate falling. Comms lead posts status update #2 ("degraded checkout, recovering").
- **19:31** — Scale-up completes; memory at 46%. Orders/min back above 800. **Recovering.**
- **19:39** — Kill switch re-enabled; `php artisan tickets:generate-pending-pdfs` (the Module 9 backfill command) drains the PDF gap.
- **19:47** — Error rate at baseline for 10 sustained minutes. **Resolved.** SEV1 closed; postmortem scheduled.

Twenty-seven minutes of degraded checkout — painful, and also the payoff of four modules of preparation: a two-minute detection, a three-minute diagnosis, and a mitigation menu that existed before it was needed.

### The postmortem

The complete document, one week later. This is TicketHub's template — steal it.

---

**Postmortem: Checkout degradation during stadium on-sale — 2026-08-15**

**Status:** Reviewed 2026-08-21 · **Severity:** SEV1 · **Duration:** 19:02–19:47 (45 min, ~27 min user-facing degradation)

**Summary.** During the highest-traffic on-sale in TicketHub's history, Redis reached its memory limit. Under the configured `noeviction` policy, cache and session writes failed with OOM errors, degrading checkout for ~27 minutes. Queued jobs were preserved by design. Mitigated by disabling PDF generation via kill switch, flushing the rate-limiter keyspace, and scaling ElastiCache.

**Impact.**
- ~1,850 failed checkout attempts; an estimated **620 orders lost or abandoned** (~$54,000 GMV at risk; some customers returned and completed later).
- **Error budget:** ~26 minutes of the monthly 43m 49s consumed — **59% of the month's budget in one evening.** Under the error-budget policy, feature releases pause until the [12.2] reliability actions below land.
- No overselling, no data corruption, no job loss.

**Timeline** (evidence linked in the incident channel: dashboard snapshots, Logs Insights queries, trace IDs): *as reconstructed above, 19:00–19:47.*

**Contributing factors** — plural, deliberately. No single root cause is listed, because no single factor was sufficient:

1. **Sizing assumption:** Redis was sized in Module 8 for steady-state traffic plus normal event on-sales; the memory model was never revisited for a 55k-seat venue (~4.5× the previous largest).
2. **Missing forecast:** the on-sale pre-flight checklist had no Redis memory headroom check — the one metric that would have predicted this at 10:00 that morning.
3. **Stale load model:** the last k6 run modeled a 12k venue; the stadium's concurrency profile was never simulated.
4. **Shared keyspace:** cache, sessions, queues, and rate-limiter share one Redis, so cache/session bloat starved a critical dependency (sessions) — a coupling documented as a cost-saving trade-off in Module 8 and never revisited as scale grew.

**What went well.** Fast-burn alert paged within 2 minutes of impact. Trace→log correlation produced a diagnosis in ~3 minutes. The kill switch and backfill command worked exactly as built. `noeviction` did its job: zero queued jobs lost. The Redis-memory runbook's rate-limiter-flush option was pre-documented as safe, so it was executed without a debate under fire.

**Action items.**

| # | Action | Owner | Due | Status |
|---|---|---|---|---|
| 1 | Redis capacity model: forecast memory from expected attendance; add headroom check to on-sale pre-flight runbook | Priya | 2026-08-28 | Done |
| 2 | **Split Redis: separate cache/session instance from queue instance** — cashes Module 8's documented trade-off; cache Redis moves to `allkeys-lru` where eviction is *correct* | Marcus | 2026-09-12 | In progress (Terraform PR open) |
| 3 | Refresh k6 load model per venue class; stadium-class run required before stadium-class on-sales | Dana | 2026-09-05 | Done |
| 4 | Alert on Redis memory at 75% *forecast-relative* before on-sales, not only the 90% static alarm | Priya | 2026-09-05 | Done |

**Lessons.** The system failed exactly the way its documentation said it would — which means the gap was not knowledge but *ritual*: nothing forced the documented trade-off to be re-evaluated as stakes grew. Checklists exist to carry knowledge across the gap between the person who wrote it and the person running the on-sale.

---

Note what the document does *not* contain: a name attached to blame, and a singular root cause. Factor 4 is the interesting one — action item 2 finally pays down a trade-off the course made knowingly four modules ago. Good postmortems close old loops.

### Runbook: "Queue backlog growing"

The complete artifact — the template all six runbooks in the index follow.

---

**Runbook: Queue backlog growing**

**Symptom:** `TicketHubQueueBacklogGrowing` alert (queue depth rising for 10 min — [12.2's](02-metrics-alerting-slos.md) exported gauge), or Horizon dashboard showing wait-time growth.

**First 5 minutes:**

1. Which queue? Grafana → TicketHub dashboard → queue-depth panel, split by queue (`default` / `pdfs` / `mail`). `pdfs` backlog is SEV3-ish (PDFs are async by design); `default`/`mail` backlog delays confirmations — treat as SEV2.
2. Rate in vs rate out: is depth growing because arrivals spiked, or because processing stopped? Compare jobs/min processed (Horizon dashboard) against depth growth.
3. Are workers alive?

```bash
kubectl -n tickethub get pods -l app=tickethub-horizon
kubectl -n tickethub logs -l app=tickethub-horizon --tail=50 --prefix
```

**Cause tree:**

- **A. Workers crash-looping** (`CrashLoopBackOff` / restarts climbing):
  ```bash
  kubectl -n tickethub describe pod <pod>   # OOMKilled? Probe failures?
  ```
  - OOMKilled → a job's memory blew the limit (PDF jobs are the usual suspect). Short-term: raise the limit via values-PR; if a deploy correlates (check the deploy marker on the dashboard), **roll back via Argo CD git revert (M11)**.
  - Config/exception on boot → read the stack trace; almost always a bad env/secret change — revert it.
- **B. Poison job** (workers up, throughput near zero, same job ID retrying in Horizon → Failed/Pending):
  - Horizon dashboard → find the recurring job → delete or hold it.
  - If it is PDF generation misbehaving broadly: **kill switch off (M9)**, fix, then `php artisan tickets:generate-pending-pdfs`.
- **C. Legit spike** (workers healthy, processing at full rate, arrivals simply higher — on-sale day?):
  ```bash
  kubectl -n tickethub scale deployment tickethub-horizon --replicas=8
  ```
  Karpenter provisions spot capacity within minutes (M11). Confirm rate-out now exceeds rate-in; depth should peak and fall.

**Escalate when:** depth still growing 15 minutes after mitigation, `default` or `mail` queues are affected and customer confirmations are delayed > 10 min, or you see cause A with no correlated deploy (unknown trigger). Page secondary on-call.

---

### The capstone: the production-readiness review

This checklist is the course, distilled. Every box is a verifiable question — not "do you care about security" but "can you demonstrate X, right now." Run it against TicketHub and every box ticks; run it against *your* application and the unticked boxes are your roadmap, in priority order of what hurts first. Module references point to where each capability was built.

**Source & CI**
- [ ] Is `main` protected — PRs, review, required status checks? (M4)
- [ ] Does every PR run tests, static analysis, and lint automatically? (M7)
- [ ] Do dependency and secret scans run in CI, with push protection on? (M7, M12.4)
- [ ] Is every production image built by CI, tagged with the Git SHA, never `latest`? (M6–7)
- [ ] Does CI authenticate to the cloud via OIDC — zero long-lived keys in secrets? (M7)
- [ ] Are third-party actions pinned by SHA? (M12.4)

**Config & secrets**
- [ ] Is all config in the environment, none in code — and does the same image run in every environment? (M5)
- [ ] Are secrets in a manager (not Git, not CI variables), synced to the runtime? (M8, M11)
- [ ] Can you rotate the app key and DB password, and have you *done* it? (M12.4)
- [ ] Is config cached in production and rebuilt on deploy? (M5, M9)
- [ ] Do staging and production differ only in values, not in shape? (M5)

**Containers**
- [ ] Multi-stage build, non-root user, pinned base image? (M6)
- [ ] Are images scanned for vulnerabilities on every build, with a severity gate? (M6–7)
- [ ] Weekly base-image refresh rebuilding and redeploying automatically? (M12.4)
- [ ] SBOM generated and stored per image? (M12.4)
- [ ] Images signed in CI and verified at admission? (M12.4)
- [ ] Read-only root filesystem, capabilities dropped, privilege escalation off? (M12.4)

**Infrastructure**
- [ ] Is every resource in Terraform — could you rebuild the environment from the repo? (M10)
- [ ] Terraform plans on PR, applies on merge, with drift detection? (M10)
- [ ] Private subnets for data stores; security groups least-privilege? (M8)
- [ ] IAM per workload (IRSA), no shared god-roles? (M8, M11)
- [ ] NetworkPolicies default-deny in the app namespace? (M12.4)
- [ ] Are you alerted on cost anomalies, and is everything tagged? (M8, M12.5)

**Deployment**
- [ ] Is the pipeline the *only* path to production — no SSH deploys, no console edits? (M9)
- [ ] Zero-downtime deploys verified under live traffic? (M9)
- [ ] Can you roll back in < 5 minutes without SSH? (M9, M11)
- [ ] Is deployment pull-based GitOps — cluster state visible as a diff against Git? (M11)
- [ ] Do migrations run safely under traffic (expand/contract, no destructive-in-place)? (M9)
- [ ] Can you turn off a risky feature without deploying? (M9)

**Data**
- [ ] Automated backups, with a *tested* restore — when did you last actually restore? (M8)
- [ ] Is the queue backend configured so jobs survive worker death and memory pressure? (M8)
- [ ] Do scheduled tasks run exactly once across all replicas? (M11)
- [ ] Are file uploads on object storage, never local disk? (M8)
- [ ] Is the oversell invariant enforced in the database, not just the app? (M1, TICKETHUB.md)

**Observability**
- [ ] Structured JSON logs, aggregated, queryable, with retention set? (M12.1)
- [ ] Correlation ID from edge through queues — one query tells one request's story? (M12.1)
- [ ] Golden-signal metrics plus business metrics (orders/min), on a dashboard an exec can read? (M12.2)
- [ ] SLOs defined, error budget computed, burn-rate alerts wired to a pager? (M12.2)
- [ ] Distributed traces with log/metric correlation; exceptions tracked per release? (M12.3)
- [ ] Do deploys appear as markers on dashboards? (M12.2)

**Security**
- [ ] Dependency update automation with a merge policy? (M12.4)
- [ ] SAST beyond types (pattern-level, e.g. injection shapes)? (M12.4)
- [ ] Rate limiting on auth and order endpoints; WAF at the edge? (M12.4)
- [ ] OWASP API Top-10 reviewed against your routes within the last year? (M12.4)
- [ ] Pod Security Standards enforced on the namespace? (M12.4)
- [ ] MFA everywhere that matters; no shared human credentials? (M8)

**Incident readiness**
- [ ] On-call rotation with escalation and ack timeouts — configured, not tribal? (M12.5)
- [ ] Severity definitions and roles agreed *before* the next incident? (M12.5)
- [ ] Symptom-titled runbooks for your top alerts, exercised in the last quarter? (M12.5)
- [ ] Blameless postmortem template in use, action-item completion tracked? (M12.5)
- [ ] Load test representing real traffic, run before known peaks? (M12.5)
- [ ] Monthly alert review and cost review on the calendar? (M12.5)

Fifty-six boxes. If you tick forty, you are ahead of most production systems on the internet. The unticked ones are not shame — they are a backlog with module numbers attached.

### The architecture retrospective

Before the course ends, walk the road backwards — because every stage you passed through is somebody's *correct destination*.

**The VPS (Modules 2–3).** One Ubuntu box, Nginx + PHP-FPM, MySQL alongside, deployed by `git pull`. It taught you what every abstraction above it hides: processes, permissions, sockets, the request path. And it remains the right endpoint for side projects, internal tools, and small products: a VPS with automated backups, monitoring, and a deploy script is a *legitimate production architecture*, not a confession of failure.

**EC2 + ALB + managed data (Module 8).** The move that mattered here was not the compute — it was handing MySQL and Redis to people whose whole job is running them, and putting a load balancer in front so one machine's death stops being an outage. Right endpoint for teams that need durability and redundancy but not orchestration.

**ECS Fargate (Module 9).** Containers without servers: the platform schedules, restarts, and scales, and you never patch a host again. Honestly, this is the right endpoint for *most small teams* — TicketHub could have stopped here and thrived for years.

**EKS + GitOps (Modules 10–11).** Kubernetes earned its place only when the surrounding practice did: Terraform-born clusters, Helm charts, Argo CD reconciling Git to reality, Karpenter shaping the fleet. Right when you have multiple teams or services, need the ecosystem (operators, service meshes, the observability stack of this module), or are building a platform for others.

The anti-cargo-cult closing, stated plainly: **a single VPS with backups and monitoring beats a mismanaged EKS cluster** — in reliability, in cost, and in sleep. Kubernetes does not make you advanced; *operating whatever you run well* makes you advanced. Choose the stage your team can genuinely operate at 3 a.m., and move up only when the pain of staying is real and specific.

## Real-world best practices

- **Practice the response, not just the system.** Gamedays, restore drills, rotation-tested runbooks. Why: the first time you execute a procedure should never be during a SEV1 — rehearsal converts panic into muscle memory.
- **Protect the IC role even on a team of three.** Someone names themselves IC out loud, even mid-debugging. Why: uncoordinated mitigation is how one incident becomes two (the classic: two engineers "fixing" the same system in opposite directions).
- **Treat runbooks and postmortems as code-adjacent artifacts.** In the repo, PR-reviewed, linked from alerts. Why: documents nobody can find at 3 a.m. do not exist; documents in Git are one click from the alert that needs them.
- **Track action-item completion as a first-class metric.** Review it monthly next to the DORA numbers. Why: it is the difference between a learning organization and one that writes essays about its recurring outages.
- **Schedule reliability's rituals or lose them.** Alert review, cost review, load tests before peaks, quarterly restore drill — on the calendar, owned. Why: rituals are how discipline survives busy quarters; anything "when we get time" is already dead.
- **Spend your error budget on purpose.** A healthy budget is permission to ship aggressively, not a trophy to preserve. Why: 100% reliability is the wrong target — it means you are paying for reliability your users cannot perceive with velocity they would.

## Common pitfalls

1. **Diagnosing before mitigating.** Engineers chase root cause while users can't check out, because finding causes is the skill they are proudest of. Why it's wrong: MTTR measures restoration, and cause-hunting can happen calmly *after*. Correct: hit the mitigation menu first — revert, kill switch, scale — then investigate on a green dashboard.
2. **The IC who debugs.** The most senior engineer declares themselves IC, then disappears into a terminal; coordination and comms die. Correct: the IC touches no keyboard except the timeline. If they are truly the only person who can fix it, they hand the IC hat to someone else — explicitly.
3. **Postmortems with a single root cause (and quietly, a single person).** "Root cause: the Redis instance was undersized" hides the missing forecast, the stale load model, and the unrevisited trade-off — so only one of four factors gets fixed. Correct: contributing factors, plural, and a fix per factor.
4. **Runbooks written by experts for experts.** "Check if Redis is the problem" — *how?* The author knew; the 3 a.m. reader doesn't. Correct: exact commands, real resource names, explicit decision points, an escalation line. Test: could the newest team member execute it alone?
5. **Load-testing an empty system with unrealistic traffic.** A flat GET-storm against a cold staging environment with 100 rows validates nothing about lock contention on reservations. Correct: production-shaped data volume, the real user journey with think times, and extrapolation with parity limits stated out loud.
6. **On-call heroics as culture.** One person acks everything, never complains, and the rotation "works" — until they resign and the team discovers nobody else can operate the system. Correct: rotation math, paid on-call, monthly alert review, and treating a page-free week as the goal, not a slow news day.

## Exercises

1. **Severity taxonomy.** Write SEV1/2/3 definitions for an app you own, with two concrete examples each. Classify: a stuck cron, a 20-minute p99 breach, a data-integrity violation affecting one record.
2. **A second runbook.** Using the template above, write "Redis memory approaching limit" for TicketHub — decision tree, real commands, the rate-limiter-flush option with its documented trade-off, escalation line. Cross-check it against the worked incident: would it have shaved minutes?
3. **Run the gameday.** Execute Section 6's three-scenario script in staging under k6 load. Write hypotheses first; record outcomes; file every mismatch as an issue.
4. **Postmortem an old ghost.** Take a real past incident from your work (or the worked one here, from memory) and write the full postmortem using the template — timeline, quantified impact, at least three contributing factors, owned action items. Notice where "root cause" thinking pulls at you.
5. **Stretch: the full review.** Run the 56-box production-readiness review against an application you own. Produce a gap list ranked by (risk × effort), pick the top three, and implement them — each maps to a module you can revisit. This is the course becoming your practice.

## What's next

There is no next lecture — but there is a scoreboard to settle. Module 1 measured TicketHub's delivery performance and made a promise; twelve modules later, remeasured in [Lecture 12.2](02-metrics-alerting-slos.md):

| DORA metric | Module 1 baseline | Now |
|---|---|---|
| Deployment frequency | Monthly | Daily or more, on demand |
| Lead time for changes | ~3 weeks | Hours |
| Change failure rate | ~30% | < 5% |
| Time to restore (MTTR) | ~4 hours | Minutes |

Those numbers were never the goal — they are the *shadow* of everything you built: trunk-based flow and CI (M4, M7), one artifact through every environment (M5–6), pipelines as the only path to production (M9), infrastructure from code (M10), GitOps with instant rollback (M11), and the observability and rituals of this module that let you ship fast *because* you can see and recover fast. Speed and stability were never a trade-off; that was Module 1's claim, and now you hold the receipts.

Where next: read **Accelerate** (Forsgren, Humble, Kim) for the evidence behind this course's worldview; Google's **Site Reliability Engineering** and **The Site Reliability Workbook** (free online) for depth on Lectures 12.2 and 12.5; **Designing Data-Intensive Applications** (Kleppmann) when the data layer becomes your frontier; **Release It!** (Nygard) for failure patterns you have not met yet. For practice: run the capstone review against a real app and close its gaps — that is worth more than any tutorial. On certifications, honestly: CKA and the AWS certs validate what you know to employers, but **certs validate, projects teach** — you now have the project. And stay in the water: SREcon and KubeCon talks are free online, and the CNCF and Laravel communities are where this knowledge keeps moving.

One more thing, and then you're done. In Module 1, Lecture 1, TicketHub was a Laravel app on a laptop and "works on my machine" was the punchline. You have since carried it — by hand, then by pipeline — through a VPS, EC2, containers, Fargate, Terraform, and Kubernetes, and tonight you watched it survive a stadium on-sale with a two-minute detection and a practiced response. Nothing about that was magic. It was the loop from Lecture 1.2 — build, release, operate, learn — traversed honestly, one module at a time, until operating in production became something you *do* rather than something you fear. You can take an application from a laptop to production, and you can run it there. The loop is closed. Now go open it again on something of your own.
