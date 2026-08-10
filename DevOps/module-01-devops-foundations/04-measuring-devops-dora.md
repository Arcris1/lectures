# Lecture 1.4 — Measuring DevOps: DORA Metrics

> **Module 1 — DevOps Foundations** · Lecture 4 of 4 · Estimated time: ~50 min

Lecture 1.1 named Measurement as a CALMS pillar; Lecture 1.2 showed you a value stream whose 6.6% flow efficiency surprised everyone involved. That surprise is the point: humans are terrible at perceiving delivery performance, so improving it requires instruments, not impressions. This lecture gives you the industry's standard instrument panel — the four DORA metrics — teaches you what the research behind them actually proved, shows how to collect them with nothing fancier than Git, GitHub, and PHP, and establishes TicketHub's honest "before" numbers so the rest of the course has something to beat. It also teaches you how these metrics go wrong, because a misused metric is worse than no metric at all.

## Learning objectives

- Explain why delivery performance must be measured rather than felt, and what the DORA research program actually demonstrated
- Define the four key metrics precisely — deployment frequency, lead time for changes, change failure rate, time to restore — plus the fifth, reliability
- Place a team against the elite/high/medium/low benchmark tiers and explain why speed and stability correlate instead of trading off
- Instrument a GitHub-based Laravel workflow to collect each metric, accepting imperfect data in exchange for consistent trends
- Recognize Goodhart's law and the standard metric abuses: weaponization, gaming, and cross-team comparison
- Compute TicketHub's baseline numbers and state the targets this course will reach

## 1. Feedback needs instruments

Ask a team "how's your delivery?" and you'll get feelings — usually recency-weighted feelings about the last incident or the last smooth week. Ask "how long does a merged change take to reach production, at the median?" and most teams simply don't know. That gap matters because every improvement this course makes is a claim about cause and effect — *containerizing will reduce environment failures; pipelines will shorten lead time* — and claims about effects need before-and-after numbers or they're just aesthetics. A pilot doesn't fly by feel in clouds; instruments exist because perception fails precisely when conditions are bad.

The reason four particular numbers became the industry standard is a genuinely unusual research effort. Starting in 2014, the **State of DevOps** reports — driven by **Nicole Forsgren, Jez Humble, and Gene Kim** under the DORA (DevOps Research and Assessment) banner — surveyed tens of thousands of professionals across thousands of organizations, applying real statistical rigor (cluster analysis, structural equation modeling) to a field previously run on conference anecdotes. The 2018 book **Accelerate** consolidated the findings; Google acquired DORA the same year and continues the annual reports. The headline result: a small set of delivery metrics reliably separates high-performing organizations from low ones, and those metrics *predict organizational outcomes* — profitability, market share, employee retention — not just engineering comfort. That evidence chain, from "deploy more often" to "the business does better," is why you can defend these metrics to a CFO, and it is the strongest empirical footing anything in DevOps stands on.

## 2. The four key metrics — and the fifth

Two of the metrics measure **throughput** (how fast change flows), two measure **stability** (what happens when it lands). Precision matters here — vague definitions are how metrics get gamed and argued about — so learn the exact start and stop points.

**Deployment frequency.** How often your organization successfully deploys to production. "Successfully" excludes attempts you rolled back before completion; "production" means real users. This is really a proxy for **batch size** (Lecture 1.2): a team deploying ten times a day is necessarily deploying tiny, low-risk batches; a team deploying quarterly is necessarily heaving 147-file crates over the wall.

**Lead time for changes.** The time from a change being **committed** to that change **running successfully in production**. Note what this does *not* include: the time from idea to first commit (that's the fuzzy front end of Lecture 1.2's value stream — important, but measured separately). Lead time captures the delivery machine's efficiency: review latency, CI duration, release queues, deploy windows. In the promo-codes VSM, everything from step 4 onward was lead time — roughly three weeks for thirteen hours of work.

**Change failure rate (CFR).** The percentage of production deployments that cause a failure requiring remediation — a rollback, a hotfix, a patch, an incident response. Two definitional edges to fix in writing before you measure: the *numerator* counts deployments-that-degraded-service (not bug reports, not near-misses), and the *denominator* counts all production deployments including hotfixes. A team that deploys 6 times and breaks production twice has a CFR of 33% no matter how good the apologies were.

**Time to restore service.** When a production failure occurs, how long until service is restored for users — from *impact start* (or detection; pick one and write it down) to *restored*, which may mean rolled back, hot-fixed, or flagged off — restored does not mean root-caused. You'll see this called MTTR (mean time to restore); the 2023 report renamed it "failed deployment recovery time" and narrowed it to deployment-caused failures, which is a reminder that the reports evolve — the concept, speed of recovery, is stable.

**The fifth: reliability.** From 2021 the reports added an operational dimension — whether your service actually meets the expectations users and the business have of it (availability, latency, correctness), typically expressed as SLO attainment. The first four measure the *delivery* of change; reliability measures the *running system's* ongoing performance, and it's the bridge to SRE practice. Module 12 builds TicketHub's SLOs; until then we track the classic four.

Notice the deliberate tension in the set: two metrics reward pushing change faster, two punish you if that change breaks things, and you report all four together. Any one of them alone is trivially gameable; the *set* is honest. That design is not an accident, as Section 4 explains.

## 3. What good looks like: the benchmark tiers

Each annual report clusters respondents into performance tiers. Exact boundaries wobble from year to year with the survey population, so treat this table — a consolidation of the most commonly cited ranges — as calibration, not scripture:

| Metric | Elite | High | Medium | Low |
|---|---|---|---|---|
| Deployment frequency | On demand — multiple deploys per day | Daily to weekly | Weekly to monthly | Less than monthly |
| Lead time for changes | Less than one day | One day to one week | One week to one month | One month to six months, or more |
| Change failure rate | ~5% | ~10% | ~15% | 30–45%+ |
| Time to restore | Less than one hour | Less than one day | One day to one week | More than one week |

Two readings of this table matter more than the numbers. First: the spread is enormous — elite teams deploy *hundreds of times more often* than low performers with *dramatically better* stability. This is not a 20% optimization; it's a different way of working. Second: the tiers are not a league table for shaming — they're a mirror. Most teams reading this course start medium-to-low, which is simply where the naive workflow puts you regardless of talent. TicketHub's own numbers, computed in the hands-on below, land exactly there: roughly 1.5 deploys a month, three-week lead times, a third of deploys causing trouble, four hours to recover. Those numbers are the *system's* output — the Friday windows, the release batching, the manual steps — produced by the same structure you dissected in Lectures 1.1 and 1.2.

## 4. The Accelerate insight: speed and stability travel together

Here is the finding that justifies this entire course, so read it twice. Common sense says speed and stability trade off — deploy more often, break more things; want stability, slow down. That intuition is the entire justification for release freezes, change advisory boards, and the Friday-night window. **The DORA research found it is empirically false.** The teams that deploy most frequently *also* have the lowest change failure rates and the fastest recovery. Speed and stability are not opposite ends of a dial; they cluster together, both driven by the same underlying capabilities.

The mechanism, once you see it, is almost obvious. Small batches (high frequency) mean each deploy carries less risk and is trivially diagnosable and reversible — so failures are rarer *and* shorter. Fast pipelines (short lead time) mean a fix travels to production in minutes, collapsing restore time. And the automation that enables both — comprehensive tests, one-command deploys, instant rollback — is itself the thing that prevents the manual-step failures that dominate incidents (recall that Friday night's outage was two parts drift and forgotten steps, zero parts bad code). Meanwhile the "careful" strategy compounds in the other direction: rare deploys grow batches, big batches fail more, failures justify more caution — the doom loop from Lecture 1.1, now with data. Accelerate even quantified the gatekeeping instinct directly: external change-approval boards were correlated with *worse* stability and worse throughput — they add lead time without subtracting risk, because a committee reading a change list catches almost nothing a test suite wouldn't.

So when the CTO from our Friday story responds to an outage with a freeze and an approval board, he isn't being conservative — he's driving the metrics in the wrong direction on both axes. The evidence-backed response is the opposite: smaller batches, more automation, faster feedback. That is the argument you must be able to make from data, calmly, in a meeting full of scared people, and it's why this lecture exists.

## 5. Measuring in practice: GitHub + Laravel

The theory is survey-based; your practice will be event-based. For a Laravel team on GitHub — TicketHub's situation from Module 4 onward — each metric maps to data you already generate:

**Deployment events.** The source of truth is the thing that deploys. Once Module 9 gives TicketHub a `deploy.yml` workflow, its completion *is* the event: timestamp, Git SHA, environment, outcome. GitHub records these (queryable via `gh api repos/tickethub/tickethub-api/deployments` or `gh run list --workflow deploy.yml`), or your workflow's last step can append one row to a log it owns. Before automation exists, a shared file updated at each deploy works — the discipline, not the plumbing, is the requirement.

**Lead time.** For each deploy, you need the commit timestamps of what shipped. The pragmatic version most teams use: **PR merged-at → deploy finished-at**, both available from the GitHub API, medianed weekly. Purists start the clock at first commit; that's fine too — what matters is picking one definition and never silently changing it.

**Change failures and restore time.** These need a human decision — *was that a failure?* — recorded somewhere queryable. The lightweight standard: a GitHub issue labeled `incident`, opened when impact starts (backdated honestly), closed when service is restored, body linking the deploy that caused it. CFR is then `incidents-linked-to-deploys / deploys`; restore time is close-minus-open. Module 12 upgrades this with real alerting timestamps, which remove the human memory problem of "when did it actually start?"

An honest note before you build any of this: **perfect measurement matters far less than consistent trend.** Merged-at versus first-commit-at, detection versus impact start — every definition has edge cases, and teams have wasted quarters building measurement platforms before improving anything. A CSV and a script, updated with discipline and reviewed monthly, beats a beautiful dashboard nobody trusts. Measure crudely, consistently, and immediately; refine when the crude version starts driving decisions. The hands-on below is exactly that crude, sufficient version.

## 6. When measures become targets: Goodhart's law and other traps

> "When a measure becomes a target, it ceases to be a good measure." — Goodhart's law (in Marilyn Strathern's phrasing)

The four metrics are diagnostic instruments. The moment you attach consequences directly to the numbers, people optimize the numbers instead of the system, and the instrument breaks. The classic failure modes:

**Weaponizing metrics against individuals.** Publishing per-developer deploy counts, putting lead time in performance reviews. This is doubly wrong: the research measures *system* capability (review latency and release queues are not individual properties), and the predictable result is fear-driven data corruption — the person who stops reporting incidents has improved their CFR. Metrics describe the machine, never the operators.

**Gaming.** A deployment-frequency target produces twenty no-op deploys on Friday afternoon; a lead-time target produces rubber-stamp reviews; a CFR target produces incidents reclassified as "degradations" that mysteriously don't count. Gaming is not a character flaw of your engineers — it is the *guaranteed* response to targets on proxies. The defenses: report the four together (the set resists gaming better than any member — no-op deploys don't move lead time; skipped review shows up in CFR), keep stakes on trends rather than thresholds, and always ask *what practice changed* to move a number.

**Comparing teams.** A dashboard ranking Team Payments against Team Search invites every distortion above at team scale, while ignoring that they ship different risk profiles on different stacks against different constraints. The valid comparison is a team against its own history. (Industry tiers like Section 3's are for calibration — "there's a much better way of working" — not for quarterly rankings.)

For completeness, know **SPACE** — the framework Forsgren and colleagues published in 2021 for *developer productivity* specifically: Satisfaction & well-being, Performance, Activity, Communication & collaboration, Efficiency & flow. Its core argument complements DORA: productivity is multidimensional, no single metric captures it, and any measurement scheme should combine a few metrics across different dimensions, including at least one human one (satisfaction). If someone proposes measuring developers by commit count, SPACE is the citable rebuttal. For this course, DORA's four measure TicketHub's *delivery system*, and that's the scope we'll track.

## Hands-on with TicketHub

Time to establish the baseline the whole course will be judged against. TicketHub's pre-DevOps team kept no metrics, of course — but Git tags, the release calendar, and two painful incident writeups (you built one of them in Lecture 1.1) let us reconstruct January through April 2026. You'll encode the raw events as two CSV files and compute the four metrics with plain PHP — deliberately humble tooling, per Section 5.

Create a working directory (or use your `tickethub-notes` journal repo) with `deploys.csv` — one row per production deployment, with the timestamp of the earliest commit in the batch, when it deployed, and whether it caused a production failure:

```csv
tag,first_commit_at,deployed_at,failed
v2026.01,2025-12-16T10:00:00+08:00,2026-01-09T23:30:00+08:00,0
v2026.02,2026-01-15T09:00:00+08:00,2026-02-06T23:35:00+08:00,0
v2026.03,2026-01-23T14:00:00+08:00,2026-03-06T23:04:00+08:00,1
v2026.03.1,2026-03-07T09:30:00+08:00,2026-03-07T11:20:00+08:00,0
v2026.04,2026-03-12T11:00:00+08:00,2026-04-03T23:02:00+08:00,1
v2026.04.1,2026-04-04T08:05:00+08:00,2026-04-04T10:15:00+08:00,0
```

You know these rows: `v2026.03` is the Friday-night deploy from Lecture 1.1, carrying commits six weeks old; `v2026.04` shipped the PHP 8.4 syntax that Ubuntu's PHP 8.3 refused to parse (Lecture 1.3, story one); the `.1` releases are the morning-after hotfixes. And `incidents.csv`, from the incident writeups:

```csv
id,started_at,restored_at,caused_by
INC-1,2026-03-06T23:04:00+08:00,2026-03-07T01:51:00+08:00,v2026.03
INC-2,2026-04-04T07:58:00+08:00,2026-04-04T13:11:00+08:00,v2026.04
```

Now the instrument. Save this as `dora.php` — complete, dependency-free PHP 8.4:

```php
<?php

declare(strict_types=1);

/**
 * dora.php — compute the four key DORA metrics from delivery logs.
 * Usage: php dora.php deploys.csv incidents.csv
 */

const WINDOW_START = '2026-01-01T00:00:00+08:00';
const WINDOW_END   = '2026-04-30T23:59:59+08:00';

/** @return list<array<string, string>> */
function readCsv(string $path): array
{
    $lines  = array_values(array_filter(array_map(trim(...), file($path))));
    $header = explode(',', array_shift($lines));

    return array_map(
        fn (string $line): array => array_combine($header, explode(',', $line)),
        $lines,
    );
}

function hoursBetween(string $from, string $to): float
{
    return (new DateTimeImmutable($to))->getTimestamp() / 3600
         - (new DateTimeImmutable($from))->getTimestamp() / 3600;
}

/** @param list<float> $values */
function median(array $values): float
{
    sort($values);
    $count = count($values);
    $mid   = intdiv($count, 2);

    return $count % 2 === 1 ? $values[$mid] : ($values[$mid - 1] + $values[$mid]) / 2;
}

$deploys   = readCsv($argv[1] ?? 'deploys.csv');
$incidents = readCsv($argv[2] ?? 'incidents.csv');

$windowMonths = hoursBetween(WINDOW_START, WINDOW_END) / 24 / 30.44;

$frequency = count($deploys) / $windowMonths;

$leadTimesDays = array_map(
    fn (array $d): float => hoursBetween($d['first_commit_at'], $d['deployed_at']) / 24,
    $deploys,
);

$failedCount = count(array_filter($deploys, fn (array $d): bool => $d['failed'] === '1'));
$failureRate = $failedCount / count($deploys) * 100;

$restoreHours = array_map(
    fn (array $i): float => hoursBetween($i['started_at'], $i['restored_at']),
    $incidents,
);
$meanRestore = array_sum($restoreHours) / count($restoreHours);

printf(
    "TicketHub delivery baseline  (%s to %s)\n\n",
    substr(WINDOW_START, 0, 10),
    substr(WINDOW_END, 0, 10),
);
printf("Deployment frequency   %.1f deploys/month  (%d in window)\n", $frequency, count($deploys));
printf("Lead time for changes  %.1f days (median of first-commit to deploy)\n", median($leadTimesDays));
printf("Change failure rate    %.1f%%  (%d of %d deploys)\n", $failureRate, $failedCount, count($deploys));
printf("Time to restore        %.1f hours (mean over %d incidents)\n", $meanRestore, count($incidents));
```

Run it:

```bash
$ php dora.php deploys.csv incidents.csv
TicketHub delivery baseline  (2026-01-01 to 2026-04-30)

Deployment frequency   1.5 deploys/month  (6 in window)
Lead time for changes  22.6 days (median of first-commit to deploy)
Change failure rate    33.3%  (2 of 6 deploys)
Time to restore        4.0 hours (mean over 2 incidents)
```

There's the baseline, and against Section 3's table it reads: **low** frequency, **medium** lead time (dragged by that 42-day batch inside `v2026.03` — check `$leadTimesDays` yourself), **low** stability, **medium-to-high** restore. Note two definitional judgment calls you just made silently, exactly the kind Section 5 said to write down: INC-1's clock starts at 23:04, when *planned* maintenance began — does planned downtime count as impact? And the hotfix deploys sit in the denominator of CFR. Reasonable people can choose differently; the requirement is choosing once, in writing.

For contrast, this is what the same measurement becomes when the pipeline exists (Module 7 onward) — one command instead of archaeology:

```bash
$ gh run list --workflow deploy.yml --status success --limit 3 \
    --json displayTitle,updatedAt
[{"displayTitle":"deploy: sha-9f31c2e","updatedAt":"2026-08-07T06:12:44Z"},
 {"displayTitle":"deploy: sha-4b77d10","updatedAt":"2026-08-06T09:58:03Z"},
 {"displayTitle":"deploy: sha-a1b2c3d","updatedAt":"2026-08-06T04:21:37Z"}]
```

Finally, commit the CSVs, the script, and this target table to your journal — the course's promise, in numbers:

| Metric | Baseline (today) | Course target | Reached by |
|---|---|---|---|
| Deployment frequency | 1.5/month | On demand — every merge deploys to staging; production deploys routine, multiple per day *possible* | Module 9 |
| Lead time for changes | ~3 weeks | Under one day (merge-to-production in minutes) | Modules 7 + 9 |
| Change failure rate | ~33% | Under 10%, trending toward ~5% | Modules 7, 9 (tests, small batches, progressive delivery) |
| Time to restore | ~4 hours | Under 30 minutes | Modules 9 + 12 (instant rollback, real alerting, runbooks) |
| Reliability | Unmeasured | SLOs defined, tracked, and met | Module 12 |

Every module from here on moves at least one of these rows, and you'll re-run this measurement at the checkpoints to prove it.

## Real-world best practices

- **Emit deployment events from the pipeline itself, from day one.** A final workflow step that records tag, SHA, timestamp, and outcome costs five lines and makes frequency and lead time free forever. Why: retroactive reconstruction (what you just did) is possible exactly once; human-maintained logs decay in weeks.
- **Write the definitions document before the first dashboard.** One page: what counts as a deployment, what counts as a failure, when the restore clock starts and stops, how hotfixes and planned maintenance are treated. Why: undefined metrics get relitigated in every retro, and quiet definitional drift can manufacture any trend you like.
- **Review trends monthly, in the team's own retro.** The audience for these numbers is the team that produces them; the cadence is monthly because delivery metrics are noisy week to week (one incident swings a small team's CFR by 20 points). Why: metrics reviewed where the work happens drive fixes; metrics reviewed in executive decks drive fear.
- **Pair the four with one business signal.** For TicketHub: tickets sold, on-sale conversion, support-ticket volume after releases. Why: it keeps the improvement work honest — delivery speed is a means; if the business line doesn't eventually move, you're optimizing a proxy.
- **Never let the metrics near individual performance reviews, and say so out loud.** Teams measure systems; managers assess people by other means. Why: the moment engineers suspect surveillance, they will — rationally — manage the numbers, and your instrument is gone for good (Section 6).
- **Count every path to production.** Hotfixes, console fixes, "tiny config changes" — all deploys, all in the denominator. Why: the unofficial path is precisely where failures concentrate, and excluding it is how teams report a 5% CFR while users experience 30%. (Module 9 solves this structurally: one path, no exceptions.)

## Common pitfalls

1. **Turning the four metrics into individual targets.** The mistake: per-engineer deploy counts, lead-time goals in reviews. Why people make it: leadership wants accountability, and per-person numbers look like accountability. Correct approach: measure the system, target *capabilities* ("adopt trunk-based development," "automate rollback"), and let the metrics report whether the capability worked.
2. **Gaming frequency with meaningless deploys.** The mistake: empty or trivial deploys to pump the count — sometimes semi-innocently, via a daily no-change cron deploy. Why: a single-metric target was set. Correct approach: report the set together and investigate *what changed in practice* whenever a number moves; a frequency jump without a matching lead-time or batch-size change is noise or gaming, and both are findings.
3. **Ranking teams on a shared dashboard.** The mistake: a league table of CFRs across the org. Why: comparison feels like management, and the data is right there. Correct approach: each team against its own trend; use org-wide data only to find *systemic* bottlenecks (every team's lead time spikes at the same shared staging environment — that's a platform problem, not a team problem).
4. **Inconsistent or unwritten definitions.** The mistake: this quarter's CFR excludes hotfixes; last quarter's didn't; nobody remembers deciding. Why: definitions feel too obvious to document — until the first ambiguous incident. Correct approach: the one-page definitions doc, versioned in the repo, plus automated collection so definitions execute as code instead of as memory.
5. **Building the observatory before looking at the sky.** The mistake: a quarter spent integrating a metrics platform while delivery stays unmeasured and unimproved. Why: tool-building is more fun than process change, and vendors are persuasive. Correct approach: what you did today — two CSVs, sixty lines of PHP, an afternoon — then improve the *delivery system* and let tooling grow with genuine need.

## Exercises

1. **Calibrate on the tiers.** Three teams: (a) deploys every weekday, lead time ~2 days, CFR 8%, restores in ~40 minutes; (b) deploys quarterly, lead time ~4 months, CFR 40%, restores in ~2 days; (c) deploys hourly but CFR 25% and restores in ~6 hours. Place each in Section 3's table, then — the interesting part — diagnose team (c): which capability is missing when speed is elite but stability isn't, and which module of this course addresses it?
2. **Extend the instrument.** Add to `dora.php`: the p90 lead time alongside the median, and a per-month deployment count. Re-run on the baseline data and explain in two sentences why TicketHub's median (22.6 days) and p90 tell different stories about batching.
3. **Measure something real.** Point the method at a repository you actually work on: extract deploy-ish events (release tags via `git for-each-ref --format='%(refname:short) %(creatordate:iso)' refs/tags`, or `gh api` deployments if you have them) and PR merge timestamps, adapt the CSV columns, and compute your own four numbers. Write down every definitional compromise you made. Imperfect is expected; *documented* imperfect is the skill.
4. **Stretch — write TicketHub's measurement policy.** Draft the one-page definitions document this lecture kept demanding: precise start/stop events for each metric, treatment of hotfixes, rollbacks, planned maintenance, and partial degradations, plus where each number will come from once GitHub Actions exists (which workflow, which API, which label). Commit it to your journal repo. In Modules 7 and 9 you will implement this document as automation, and you'll discover which of your definitions survive contact with reality.

## What's next

Module 1 is complete: you know what DevOps is and where it came from (1.1), the lifecycle and its wait states (1.2), the application and its honest failure modes (1.3), and now the instruments and the baseline — 1.5 deploys a month, three-week lead times, one deploy in three causing damage. Time to start moving those numbers, and the path runs straight through the machine room: every improvement ahead — servers, containers, pipelines, Kubernetes — sits on Linux. [Module 2](../module-02-linux-command-line/) takes you from your first shell prompt to confidently operating the Ubuntu 24.04 VPS that TicketHub will call production for the next few modules.
