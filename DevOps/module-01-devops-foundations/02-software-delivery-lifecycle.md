# Lecture 1.2 — The Software Delivery Lifecycle

> **Module 1 — DevOps Foundations** · Lecture 2 of 4 · Estimated time: ~45 min

[Lecture 1.1](01-what-is-devops.md) defined DevOps as shortening two loops: idea to running software, and running software back to insight. This lecture opens those loops up and names every stage inside them. By the end you'll have the complete map of this course — every lifecycle stage matched to the module that automates it for TicketHub — plus the single most useful analysis technique in delivery work: value stream mapping, which converts the feeling "shipping here is slow" into numbers that identify exactly *where* it's slow.

## Learning objectives

- Explain the evolution from waterfall to agile to continuous delivery as a progressive shrinking of batch size
- Name the eight stages of the DevOps loop and, for each, its purpose, its concrete artifacts, and the tools this course uses for it
- Describe why the cost of a defect rises with the distance between introduction and detection, and define shift-left
- Distinguish a release from a deployment and explain why separating them changes how teams work
- Build a value stream map for a real feature and compute its flow efficiency

## 1. Shrinking the batch: waterfall → agile → continuous delivery

The clearest way to understand fifty years of software process history is as one long argument about **batch size** — how much change you accumulate before you validate it against reality.

**Waterfall** (dominant through the 1990s) had the largest possible batch: the entire project. Requirements fully specified, then designed, built, tested, delivered — each phase completed before the next began, with sign-off documents between them. The model assumes you know what to build up front and that nothing important changes while you build; reality falsifies both on most projects. The feedback loop — does this software work, and is it what users need? — closed exactly once, at the end, when changing course was most expensive. Projects "97% complete" for months, integration phases where nothing integrated, products correct to a two-year-stale spec: all batch-size symptoms.

**Agile** (the manifesto is from 2001) attacked the batch size of *planning and development*: iterations of a week or two, working software demoed each iteration, continuous reprioritization. A genuine revolution — for the left half of the lifecycle. In most adoptions, everything after "code complete" stayed batched: teams iterated in two-week sprints, then piled ten sprints into a quarterly release handed to ops exactly as before. Priya and Marcus, from Lecture 1.1, worked at an "agile" company. The wall was untouched; the batch had just moved downstream.

**Continuous delivery** (the term crystallized with Jez Humble and David Farley's 2010 book) extends small batches through the *entire* pipeline: every change is built, tested, and made deployable on its own, and deployment becomes a routine, automated, low-drama event that can happen any time — daily, hourly, on demand. The batch shrinks toward its natural minimum: one pull request.

Why does batch size dominate everything else? Four compounding reasons. **Risk:** a deploy of 3 changes has three suspects when something breaks; a deploy of 300 has three hundred, interacting. **Debuggability:** small batches make "what broke it?" nearly self-answering. **Recovery:** reverting one small change is surgical; reverting a quarterly release is a crisis. **Feedback quality:** with small batches, the author gets production feedback while the change is still loaded in their head — hours, not months, after writing it. You'll prove the risk and recovery points with Git in the hands-on section.

## 2. The DevOps loop, stage by stage

The standard picture of the lifecycle is an infinity symbol — plan, code, build, test on the left loop; release, deploy, operate, monitor on the right; monitor feeding back into plan, forever. The shape matters more than the artwork: this is a *loop*, not a line. Nothing is "done" at deploy; production teaches, and the loop turns again. Let's walk the eight stages as they apply to TicketHub — for each: what it is, its artifacts, and where this course teaches it.

**Plan.** Deciding what to build next and making the work visible: user stories, acceptance criteria, a prioritized backlog. For TicketHub this is GitHub Issues on the `tickethub/tickethub-api` repo — "customers can apply promo codes at checkout" starts life as an issue. This course doesn't teach planning methodology, but Module 4 covers how planning artifacts connect to branches, pull requests, and releases so work is traceable from idea to deploy.

**Code.** Writing the change, on a branch, with review. Artifacts: commits, a pull request, review comments, locally run checks (Pest tests, Pint formatting). Module 4 is dedicated to this stage — Git's object model, branching strategies, and the review culture that makes PRs a conversation instead of a gate.

**Build.** Turning source into a runnable artifact, deterministically. For a Laravel app: resolving Composer dependencies, compiling assets with Node 22, and — from Module 6 onward — baking everything into a Docker image, the single artifact that travels unchanged through every later stage. Artifacts: `vendor/`, built assets, eventually the image `111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d`. Taught in Modules 6 (images) and 7 (building in CI).

**Test.** Machines verifying the change: Pest 3 unit and feature tests against real MySQL 8.0 and Redis 7, static analysis with Larastan, Pint, dependency vulnerability audits. Artifacts: a green (or red) check on the PR, coverage reports. Module 7 builds TicketHub's test pipeline in GitHub Actions; Module 12 adds security scanning to the same stage.

**Release.** Declaring a specific, tested artifact ready for production and versioning that decision: tagging `v1.4.2`, generating a changelog, pushing the immutably tagged image to ECR. Release is *not* the same as deploy — Section 4 is entirely about that distinction. Taught in Modules 4 (versioning, tags, changelogs) and 9 (promotion between environments).

**Deploy.** Getting the released artifact running in an environment. This is where TicketHub's story arcs across the whole course: by hand onto a VPS (Module 3), semi-manually onto EC2 behind an ALB (Module 8), fully automated onto ECS Fargate with zero downtime (Module 9), finally onto EKS via Helm and Argo CD, where deployment becomes a Git operation (Module 11). Artifacts: the running system, deploy logs, a timestamped deployment record — treasure those timestamps; Lecture 1.4 shows they carry two of your four key metrics.

**Operate.** Keeping the deployed system alive and healthy: process supervision for Horizon workers, scheduler runs every minute, scaling for the Saturday on-sale spike, patching, backups, incident response. Modules 2 and 3 teach operating the hard way (a Linux box you SSH into); Modules 8 and 11 progressively hand toil to managed services and Kubernetes; Module 12 covers the human side — on-call, runbooks, postmortems.

**Monitor.** Instrumenting the running system so it can tell you things: structured logs, metrics, traces, alerts, SLOs — and business signals, like tickets sold per minute during an on-sale. Artifacts: dashboards, alert rules, error-tracker issues. Module 12 is devoted to this stage. Its output feeds straight back into **Plan** ("reservation expiry is our top error source — schedule the fix"), which is what makes the diagram a loop instead of a pipeline with an end.

Here is the full map — bookmark it; it's the course syllabus expressed as a lifecycle:

| Stage | Produces | TicketHub tooling | Taught in |
|---|---|---|---|
| Plan | Issues, acceptance criteria | GitHub Issues / Projects | Module 4 (traceability) |
| Code | Commits, pull requests, reviews | Git, GitHub, Pint, local Pest | Module 4 |
| Build | Docker image in ECR, built assets | Composer 2.7, Node 22, Docker 27, BuildKit | Modules 6, 7 |
| Test | Green checks, coverage, static analysis | Pest 3, Larastan, Pint, MySQL/Redis services in CI | Module 7 (12 adds security) |
| Release | Tag `v1.4.2`, changelog, immutable image tag | Git tags, conventional commits, ECR | Modules 4, 9 |
| Deploy | Running app in staging/production | git pull → EC2/ALB → ECS Fargate → EKS + Argo CD | Modules 3, 8, 9, 11 |
| Operate | Healthy processes, scaling, backups, incident response | systemd → AWS managed services → Kubernetes | Modules 2, 3, 8, 11, 12 |
| Monitor | Logs, metrics, traces, alerts, SLOs | CloudWatch/Loki, Prometheus/Grafana, OpenTelemetry, Sentry | Module 12 |

Two supporting layers sit underneath every stage rather than inside any one of them: configuration discipline (Module 5 — twelve-factor, environments, secrets) and infrastructure as code (Module 10 — the environments themselves defined in Terraform).

## 3. Feedback loops and the cost curve of a bug

Here's the principle that justifies the entire pipeline you'll spend Modules 6–9 building: **the cost of a defect grows with the distance between where it's introduced and where it's detected.** Not linearly — each stage a bug survives multiplies the number of people, systems, and hours involved in its eventual removal.

Make it concrete with TicketHub's most important code path. Suppose Priya, editing the reservation logic, writes the inventory check as `>` when it must be `>=` — an off-by-one that lets the last ticket oversell. Watch the cost of that single character at each stage where it could be caught:

1. **In the editor, seconds after typing.** Larastan or a unit test running on save flags it. Cost: one person, thirty seconds, nobody else ever knows.
2. **In CI on the pull request, twenty minutes later (Module 7).** A Pest feature test — *two buyers race for the last ticket* — fails. Cost: one context switch, a push, a re-run. Minutes of machine time, an hour of elapsed time.
3. **In staging, days later.** A tester (or an automated smoke test) finds it. Cost: a bug ticket, triage, reproduction, a fix PR, re-review, re-deploy. The author has moved on; context must be rebuilt. Hours to days.
4. **In production, weeks later — during the Marina Bay on-sale.** Real overselling: 512 tickets sold for 500 seats. Cost is now in a different currency entirely: refunds, support tickets, furious organizers, a compensation policy decision, an incident review — plus the engineering cost, now at its maximum because the change is weeks stale and buried under others (remember the Friday batch: 147 files of suspects).

The often-quoted claim that a production bug costs 100x one caught at design time traces to Barry Boehm's research on 1970s–80s projects; the precise multipliers are debatable and context-dependent, but the *shape* of the curve is not seriously disputed, and modern delivery practice is essentially a bet on it: move detection left, relentlessly.

That strategy has a name: **shift-left**. Take verification that historically happened late — testing, security review, performance checks, operability review — and move it earlier, where feedback is cheap and context fresh. Concretely in this course: tests run on every PR rather than in a QA phase (Module 7); static analysis and dependency audits run before merge, not in an annual audit (Modules 7, 12); infrastructure changes are validated by `terraform plan` in the PR, not discovered at apply time (Module 10); security scanning runs in the same pipeline as the tests, not as a gate owned by another department (Module 12). Shift-left is why those modules keep adding jobs to the *same* GitHub Actions workflow: the pull request becomes the place where the organization's whole opinion of a change is delivered, at the moment it's cheapest to act on.

One clarification, because the term gets abused: shift-left does not mean "developers absorb everyone else's job." The *checks* move left, mostly by being automated — the specialists' knowledge gets encoded where it runs on every change, instead of applied by hand at the end.

## 4. Deploy is not release

Two words the industry used interchangeably for decades name two genuinely different events:

- **Deploy**: new code is running in production infrastructure.
- **Release**: users are exposed to new behavior.

Under the traditional model these coincide — the moment code hits the server, every user gets it, which is exactly why deploys were treated as hazardous cargo. Decoupling them is one of the highest-leverage ideas in modern delivery.

You'll build the decoupling mechanics in Module 9, but the concepts deserve naming now. A **feature flag** wraps new behavior in a runtime switch — the promo-code checkout path can be deployed to production *off*, dark, weeks before marketing announces it, then released with a config change (and un-released just as fast — rollback without a deploy). A **canary** releases to a slice: deploy everywhere, route 5% of traffic to the new version, watch error rates, widen. **Blue/green** keeps two production environments and flips traffic atomically. In each case *deploy* becomes a frequent, boring, technical event, while *release* becomes a deliberate, reversible business decision — owned by different people, on different calendars, with different risk profiles.

The distinction also dissolves the famous "never deploy on Friday" argument. The fear is really about *releasing* on Friday — exposing users to new behavior with the weekend looming. A team whose deploys are automated, tested, flagged, and instantly reversible can deploy Friday afternoon safely, because deploying no longer implies releasing. By Module 9, TicketHub's `v*` tags promoting staging to production will be routine enough that the Friday question stops being interesting — which, given where this course started (Lecture 1.1's Friday night), is the point.

## 5. Hand-offs kill flow: value stream mapping

Section 1 argued batches are the disease; this section gives you the diagnostic instrument. A **value stream map (VSM)** — borrowed directly from Lean manufacturing, where Toyota used it to hunt waste in factories — traces one unit of work from request to delivery and records, for every step, two numbers: **work time** (someone is actively doing the step) and **wait time** (the work sits in a queue between steps). The ratio gives you **flow efficiency**:

```
flow efficiency = work time / (work time + wait time)
```

Software teams who map their stream for the first time expect maybe 50% and routinely find single digits. The waste is invisible precisely because it's *nobody's* time being wasted — every person is busy; it's the *work* that sits idle, in backlogs, in review queues, in "waiting for the release window." And each wait is usually attached to a **hand-off**: a moment where the work crosses from one person or team to another, shedding context and joining a queue. Hand-offs are where flow goes to die — which is why Lecture 1.1's wall of confusion, the ultimate hand-off, was so expensive, and why this course's automation is aimed disproportionately at eliminating hand-offs (a pipeline is a hand-off replaced by a machine).

The mechanics are almost embarrassingly simple — the value is in doing it honestly, with real timestamps from your tracker and Git history rather than optimistic memory. List the steps, attach work and wait durations, sum, divide. Then fix the *longest wait*, not the busiest person. You're about to do exactly this for TicketHub.

## Hands-on with TicketHub

### Part A — map the promo-codes feature

The feature: *"add promo codes to checkout"* — an issue on `tickethub/tickethub-api`, requested by marketing on Monday, March 2, 2026, at the pre-DevOps company from Lecture 1.1. Here is its true history, reconstructed from the issue tracker, Git, and the release calendar:

| # | Step | Work time | Wait before this step | Cause of the wait |
|---|---|---|---|---|
| 1 | Issue written, acceptance criteria agreed | 1.0 h | — | |
| 2 | Sits in backlog until sprint starts Mar 9 | — | 5 workdays | Sprint-boundary batching |
| 3 | Priya implements (code + Pest tests) | 6.0 h | — | |
| 4 | PR opened Mar 10 15:00; review starts Mar 12 10:00 | — | 1.8 workdays | Reviewer's queue; no review SLA |
| 5 | Review | 0.7 h | — | |
| 6 | Changes requested; Priya reworks | 1.5 h | 0.5 workday | Context switch — she's mid-task on something else |
| 7 | Approved and merged Mar 13 | 0.1 h | — | |
| 8 | Waits for the next release cut | — | 10 workdays | Fixed release calendar — the batch accumulates |
| 9 | Manual regression pass by QA | 3.0 h | 2 workdays | Shared staging env booked by another team |
| 10 | Deployed in the Friday 23:00 window, Apr 3 | 0.8 h | 4 workdays | Deploy windows only on Fridays |

Add it up. Work time: `1.0 + 6.0 + 0.7 + 1.5 + 0.1 + 3.0 + 0.8 = 13.1` hours. Wait time: `5 + 1.8 + 0.5 + 10 + 2 + 4 = 23.3` workdays, at 8 hours each ≈ `186.4` hours. Since you're a PHP developer, use the tool at hand:

```bash
$ php -r 'printf("Flow efficiency: %.1f%%\n", 13.1 / (13.1 + 23.3 * 8) * 100);'
Flow efficiency: 6.6%
```

**6.6%.** Thirteen hours of actual work took thirty-three calendar days to reach users — and this feature had *no* production incident, no requirement change, nothing unusual. This is the honest baseline of a completely normal, "agile," pre-DevOps team, and it's the number Lecture 1.4 will formalize as *lead time for changes*.

Now read the map like an engineer. The three biggest waits — release cut (10 days), sprint boundary (5), deploy window (4) — are 19 of 23.3 days, and **all three are calendar batching**, not people being slow. No amount of "developers should work faster" touches them; Priya's 6 hours of coding are 3% of the elapsed time. The fixes are structural, and they are this course: continuous integration removes the regression pass (Module 7 — tests run on every PR, so step 9 vanishes); deploy automation removes the window (Module 9 — merges deploy to staging, tags to production, any day, in minutes); small-batch releases dissolve the release cut entirely. The sprint-boundary wait is a planning-policy choice, fixable by flow-based prioritization — an organizational fight beyond this course's scope. Redraw the future-state map with those changes and the same 13.1 hours of work: elapsed time collapses to roughly 2–3 workdays, review latency now dominating (which is why Module 4 spends time on review SLAs and PR sizing). Flow efficiency: around 60%. Same people, same effort, ten times faster feedback.

### Part B — feel batch size with Git

Theory said small batches are safer and easier to debug and recover. Prove it to yourself in two minutes with nothing but Git. Create a scratch repo simulating eight independent changes shipped as small batches:

```bash
$ mkdir tickethub-batch-demo && cd tickethub-batch-demo
$ git init -b main
Initialized empty Git repository in .../tickethub-batch-demo/.git/

$ for i in 1 2 3 4 5 6 7 8; do
    echo "feature $i" >> checkout.txt
    git add checkout.txt
    git commit -q -m "feat: change $i"
  done

$ git log --oneline
9d41f7c (HEAD -> main) feat: change 8
1c22e90 feat: change 7
a90cf5e feat: change 6
77b3a1d feat: change 5
5f0e6b2 feat: change 4
e3d19c4 feat: change 3
b8a02f7 feat: change 2
4e6d803 feat: change 1
```

(The `for` loop just saves typing eight commit commands — Module 2 teaches shell loops properly.) Now word arrives that "change 5" broke checkout. With small batches, the suspect is a single, named commit, and recovery is surgical:

```bash
$ git revert --no-edit 77b3a1d
[main 62b9e0f] Revert "feat: change 5"
 1 file changed, 1 deletion(-)

$ cat checkout.txt
feature 1
feature 2
feature 3
feature 4
feature 6
feature 7
feature 8
```

One command, one line removed, seven good changes untouched. Now simulate the big-batch world — all eight changes land as one commit:

```bash
$ cd .. && mkdir tickethub-bigbatch-demo && cd tickethub-bigbatch-demo
$ git init -b main
$ for i in 1 2 3 4 5 6 7 8; do echo "feature $i" >> checkout.txt; done
$ git add checkout.txt && git commit -q -m "feat: Q1 release"
```

Same broken checkout, but now: *which* change caused it? The commit gives you no isolation — your options are reverting the entire release (losing seven good features), or bisecting by hand through changes that were never separated. In this toy the file is eight lines; in the Friday deploy it was 147 files and 6,210 insertions. The toy and the disaster differ only in scale, not in structure. This asymmetry — revert one commit versus untangle one blob — is the concrete, mechanical reason every later module pushes you toward small PRs, merged often, deployed immediately.

## Real-world best practices

- **Cap pull request size, culturally if not mechanically.** High-performing teams treat a PR over roughly 400 changed lines as a smell and split it. Why: review quality collapses with size (reviewers approve what they can't hold in their head), and Part B showed what un-revertable batches cost. Small PRs are the upstream cause of most good downstream numbers.
- **Decouple release cadence from sprint cadence.** Sprints are a planning rhythm; they are a terrible deployment rhythm. Teams that ship every merge while planning in two-week sprints get the benefits of both. Why: Part A — the sprint boundary and release cut were 15 of the 23 wasted days.
- **Make wait states visible before optimizing anything.** Real teams put timestamps on board-column transitions (most trackers record them already) and review the aging of in-flight work weekly. Why: humans systematically misjudge where time goes; the VSM exists because the biggest waits are always a surprise.
- **Attack the longest wait, not the busiest person.** Adding developers to a stream with 6.6% flow efficiency speeds up 13 hours of a 199-hour timeline. Why teams get this wrong: work time is visible and staffed; wait time is nobody's job. Assign an owner to the queue, not more hands to the work.
- **Separate deploy from release as soon as you have the tooling.** Feature flags for anything user-visible, canaries for anything risky (Module 9). Why: it converts release risk from "prevent errors perfectly" (impossible) to "detect and reverse quickly" (engineering), and it ends the Friday-freeze argument on the merits.
- **Run the same artifact through every stage.** The image built in Module 7's CI is byte-for-byte the one deployed in Module 9's production. Why: every rebuild between stages is a chance for the thing you tested and the thing you shipped to differ — a whole class of "but it passed staging" incidents deleted by policy.

## Common pitfalls

1. **Optimizing work time instead of wait time.** The mistake: responding to slow delivery with pressure on developers to code faster. Why people make it: work is visible and attributable; queues are neither. Correct approach: map the stream first, then remove the longest wait — in the promo-codes map, coding speed was 3% of the problem.
2. **Calling it agile while batching everything downstream.** The mistake: two-week sprints feeding a quarterly release train and treating that as "we're agile." Why: agile adoption commonly stopped at the wall of confusion, and ceremonies are easier to adopt than delivery changes. Correct approach: measure idea-to-production time (Lecture 1.4's lead time), not sprint velocity; extend iteration through deploy.
3. **Treating deploy and release as synonyms.** The mistake: freezing deploys near weekends, holidays, and marketing events because "deploying is risky." Why: in the coupled model it genuinely was. Correct approach: decouple with flags and progressive delivery (Module 9); make deploys boring and releases reversible, then schedule releases on business logic alone.
4. **Adding a gate after every incident.** The mistake: each failure spawns a new mandatory approval, until the pipeline is a corridor of checkpoints. Why: gates feel like diligence and protect the gate-adder politically. Correct approach: convert each incident's lesson into an *automated* check in build/test (shift-left) — machines gate in seconds without adding wait time; humans gate in days. The Accelerate research (next lecture) found external approval boards correlate with worse stability *and* worse speed.
5. **Mapping the value stream once, framing it, and never returning.** The mistake: a workshop, a wall poster, no follow-up. Why: mapping is a satisfying deliverable; changing queue policy is conflict. Correct approach: re-walk the map after each structural change with fresh timestamps and publish the trend — the map is an instrument, not an artifact.

## Exercises

1. **Stage-tag a real feature.** Take the last feature you personally shipped anywhere and write its story as the eight lifecycle stages. Note which stages were automated, which were manual, and which didn't exist (no monitoring? no release identity?). Keep this — you'll reuse it in Lecture 1.4.
2. **Map your own stream.** Using real timestamps from your tracker and Git history (issue created, first commit, PR opened, approved, merged, deployed), build the promo-codes-style table for one recent change at your job or side project, and compute flow efficiency with the same `php -r` one-liner. Predict the number before you calculate it; the gap between prediction and reality is the lesson.
3. **Break the big batch.** In the `tickethub-bigbatch-demo` repo, the release is one commit. Try to remove only "feature 5" using `git revert`, observe what happens, then recover the situation any way you can (edit and recommit, or `git revert` then re-add the good lines). Time yourself against the one-command small-batch revert. Write two sentences on what this implies for a 147-file release.
4. **Design the future state.** Redraw the promo-codes VSM assuming the practices of Modules 4, 7, and 9 are in place (CI on every PR, deploy on every merge, no release windows). Which waits survive? What's the new flow efficiency? What's now the bottleneck — and is it technical or organizational?
5. **Stretch — map a team you don't control.** Interview an engineer at another company (or use a well-documented public engineering-blog account) and reconstruct their delivery stream: stages, hand-offs, longest wait. Identify which single change from this lecture would help them most and why it would be resisted. Arguing the resistance is the real exercise — it's where you'll spend your career.

## What's next

You now hold the map: eight stages, two loops, and a course that automates them one module at a time. But we've been discussing TicketHub as a story. Time to make it real. [Lecture 1.3](03-meet-tickethub.md) hands you the actual application — the domain model, the overselling invariant and the row-locking transaction that protects it, the queue jobs and scheduler you'll be running all course — and boots it the naive way on your laptop, so you can experience "works on my machine" firsthand before we spend eleven modules making that phrase obsolete.
