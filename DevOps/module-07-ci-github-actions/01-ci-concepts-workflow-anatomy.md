# Lecture 7.1 — CI Concepts & Workflow Anatomy

> **Module 7 — Continuous Integration with GitHub Actions** · Lecture 1 of 4 · Estimated time: ~60 min

Module 4 left `tickethub-api` with a disciplined workflow: trunk-based development, short-lived branches, squash merges through reviewed PRs onto a protected `main`. Module 6 gave you a containerized stack and a production image. But one promise is still unpaid: the branch ruleset from [Lecture 4.3](../module-04-git-collaboration/03-pull-requests-code-review.md) deliberately left out required status checks, because nothing existed to report them. Right now, "the tests pass" means "someone remembered to run `docker compose exec app php artisan test` before merging." That is a hope, not a system.

This module builds the system. Over four lectures you will construct one workflow file, `ci.yml`, that tests, checks, and packages every change to TicketHub — and this first lecture gives you the two foundations everything else stands on: what continuous integration actually *is* (a practice much older than any CI product), and how GitHub Actions models work precisely — events, jobs, runners, contexts, permissions. Get these mental models right and the next three lectures are assembly. Get them wrong and you will spend hours confused about why a secret is empty or why your job tested the wrong commit.

## Learning objectives

- Define continuous integration as a practice — and distinguish it from "having a CI server"
- Explain the GitHub Actions execution model: workflows, events, jobs, steps, and runners, and what is (and is not) shared between jobs
- Choose the right trigger and explain the `pull_request` merge-ref behavior and the fork-PR security model
- Apply least-privilege `permissions:` and `concurrency:` groups to every workflow you write
- Use caching and artifacts correctly, knowing which problem each solves
- Write, run, and debug a first working workflow for TicketHub

## 1. What continuous integration actually is

Continuous integration predates every tool that claims the name. It comes out of Extreme Programming in the late 1990s, and Martin Fowler's canonical description reduces to two sentences:

1. **Everyone integrates their work into the shared mainline at least daily.**
2. **Every integration is verified by an automated build — including automated tests — so integration problems surface within minutes, not weeks.**

Notice what is *not* in that definition: no product, no YAML, no vendor. CI is a **team practice**; the tooling exists to serve it. You already adopted the first half in Module 4 — trunk-based development with branches that live hours, not weeks, *is* the "integrate daily" discipline. This module supplies the second half: the automated verification that makes daily integration safe instead of reckless.

It is worth being equally clear about what CI is **not**, because the industry is full of what Fowler's colleagues call *CI theatre*:

- A Jenkins box that runs the test suite **nightly** is not CI — a bug introduced at 9 a.m. survives the whole working day, and by the time the red build email arrives, three other people have built on top of it.
- Tests that run on a **feature branch that lives for three weeks** are not CI. The branch may be green in isolation; the *integration* — that branch combined with everyone else's three weeks of work — has never been tested at all.
- A pipeline that exists but that the team routinely merges past ("it's flaky, ignore it") is worse than no CI: it trains everyone that red means nothing.

The test of whether you *have* CI is behavioral: if the build breaks, does the team know within minutes, and is fixing it the immediate priority? For TicketHub the concrete form is: every push to a PR and every merge to `main` runs the full verification automatically, and `main` red is an all-hands-stop event.

## 2. Why minutes matter: the economics

Module 1 gave you the cost curve in one line: a defect found at commit time costs minutes; the same defect found in production costs hours of incident response, plus customer trust. CI is the machine that moves discovery leftward. Without it, the *find-to-fix window* — the gap between writing a bug and learning about it — is bounded by how often someone happens to run the tests, which in practice means days. With CI it is bounded by pipeline duration: you push, and eight minutes later you know, while the change is still fully loaded in your head and the diff is 80 lines instead of 3,000.

This is also why the DORA metrics from Lecture 1.4 keep appearing in this module. Lead time for changes is dominated by waiting — for review, for test results, for someone to notice the build broke. A fast, trustworthy pipeline attacks the waiting directly, which is why we will care, concretely and repeatedly, about keeping TicketHub's pipeline under ten minutes.

## 3. The GitHub Actions model

GitHub Actions is the CI runtime this course uses: it lives where the repo and PRs already live, has a free tier that covers this course, and is what you will most likely meet at work. The concepts transfer almost one-to-one to GitLab CI, CircleCI, or Buildkite — different YAML, same model. The model has five layers, and you need all five precisely.

### 3.1 Workflows and events

A **workflow** is a YAML file in `.github/workflows/` (the path is fixed — Module 4's CODEOWNERS already routes it to the platform team). Each workflow declares the **events** that trigger it in its `on:` block. The triggers you will actually use:

```yaml
on:
  push:
    branches: [main]     # commits landing on main (i.e. every squash merge)
    tags: ['v*']         # release tags — deploy.yml uses this in Module 9
  pull_request:          # opened / new commits pushed / reopened (the defaults)
  schedule:
    - cron: '0 2 * * *'  # cron, in UTC, on the default branch only; may lag under load
  workflow_dispatch:     # a "Run workflow" button + API call, with optional inputs
```

The pair that matters daily is `push` vs `pull_request`, and it confuses everyone, so fix it now:

- **`push` runs on the branch itself.** After a squash merge, the push to `main` triggers a run on the new merge commit. `github.sha` is that commit.
- **`pull_request` runs on a synthetic merge ref.** GitHub creates `refs/pull/<N>/merge` — a temporary commit that merges your branch into the *current* base — and the workflow checks *that* out. You are not testing your branch; you are testing **what `main` would become if you merged right now**. That is exactly what you want from a pre-merge check, but it has two consequences people trip on: `github.sha` on a PR run is the synthetic merge commit's SHA (it appears nowhere in your branch history — use `github.event.pull_request.head.sha` when you need the real branch tip), and if `main` moves *after* your run, your green check describes a merge that will never happen. Lecture 7.3's "require branches up to date" ruleset setting closes that gap.

One security rule to internalize before you ever accept outside contributions: **`pull_request` runs triggered from a fork get no secrets and a read-only `GITHUB_TOKEN`.** The reason is obvious once stated — a fork PR executes *the fork's code*, including a modified workflow file or a malicious `composer.json` script. If secrets were available, anyone on the internet could open a PR that exfiltrates them. GitHub therefore withholds secrets and write access from fork-triggered runs, and first-time contributors need maintainer approval before workflows run at all. (There is a trigger called `pull_request_target` that runs with secrets in the base repo's context; combined carelessly with a checkout of the fork's code it is the classic self-pwn. Do not use it until you can explain that sentence to someone else.)

### 3.2 Jobs: parallel by default, fresh VM each

A workflow contains **jobs**. Two properties define them:

- **Jobs run in parallel by default.** You express ordering only where it truly exists, with `needs:`, which turns your jobs into a DAG. In our final `ci.yml`, `tests` and `quality` run simultaneously; `build` declares `needs: [tests, quality]` and runs only when both succeed.
- **Every job starts on a fresh runner VM.** Nothing your `tests` job wrote to disk exists when `build` starts — no checked-out repo, no `vendor/`, no built image. The *only* things that cross the job boundary are **artifacts**, **caches** (both in section 7), and small string **outputs**. Internalize this or you will spend an afternoon wondering where your files went.

```yaml
jobs:
  tests:    # ← the job id — this exact string becomes the status check name (Lecture 7.3)
    runs-on: ubuntu-latest
    steps: [...]
  quality:
    runs-on: ubuntu-latest
    steps: [...]
  build:
    needs: [tests, quality]   # gate: only runs when both are green
    runs-on: ubuntu-latest
    steps: [...]
```

### 3.3 Steps: `uses:` and `run:`

Inside a job, **steps** run sequentially on that job's VM, sharing its filesystem and (per-step) environment. A step is either:

- **`run:`** — a shell script (bash on Linux). Multi-line scripts with `|` are normal.
- **`uses:`** — a reusable **action** from the marketplace or any repo, e.g. `actions/checkout@v4`. The `@v4` is a version pin, and you must always have one. An unpinned or `@main`-pinned action means *someone else's next commit runs inside your pipeline with your permissions*. Pinning to a major version tag (`@v4`) trusts the maintainer's release discipline; pinning to a full commit SHA (`@11bd719...`) trusts nothing and is what high-security teams do — a real action-hijack in 2025 (`tj-actions/changed-files`) leaked secrets from thousands of repos that had trusted a mutable tag. This course pins majors from well-known publishers (`actions/*`, `docker/*`, `aws-actions/*`, `shivammathur/setup-php`) and flags where you would tighten to SHAs.

### 3.4 Runners

A **runner** is the machine that executes a job. `runs-on: ubuntu-latest` gets you a GitHub-hosted, throwaway Ubuntu 24.04 VM — at the time of writing, 4 vCPUs / 16 GB RAM for public repos, 2 vCPUs / 7 GB RAM for private ones, ~14 GB of free SSD, with Docker, Git, and common toolchains preinstalled. It exists for your job and is destroyed after — which is a *feature*: every run starts from a known-clean state, the ultimate "works on my machine" killer. macOS and Windows runners exist (for iOS builds and Windows-specific software) and bill at 10x and 2x the Linux rate respectively; TicketHub, deploying to Linux containers, has no use for either.

One honest paragraph on **self-hosted runners**, because you will meet them: you register your own machine (EC2 instance, on-prem box, Kubernetes pod) and jobs run there. Legitimate reasons: jobs that must reach private networks (a database in your VPC), special hardware (GPUs, ARM), or CI bills large enough that owned hardware wins. The costs people discover late: *you* now patch, scale, and clean these machines, and a non-ephemeral runner accumulates state between jobs — cache poisoning, leftover credentials — that hosted runners structurally cannot. And the landmine: **never attach self-hosted runners to a public repository.** A fork PR runs arbitrary code *on your machine, inside your network*; GitHub's own docs say plainly not to do it. If you ever need self-hosted, use ephemeral (one-job, then destroyed) runners on private repos. TicketHub uses hosted runners for the entire course.

## 4. Contexts, expressions, and environment variables

Workflows are parameterized through **expressions** — `${{ ... }}` — evaluated against **contexts**:

| Context | What it holds | Examples you will use constantly |
|---|---|---|
| `github` | Event and repo metadata | `github.sha`, `github.ref` (`refs/heads/main`), `github.ref_name`, `github.event_name`, `github.actor`, `github.run_id` |
| `secrets` | Encrypted secrets (repo / org / environment scope) | `secrets.GITHUB_TOKEN` (auto-provided), any secret you define — masked as `***` in logs |
| `vars` | Non-secret configuration variables | `vars.AWS_REGION` if you prefer config over hardcoding |
| `env` | Environment variables currently in scope | `env.DB_DATABASE` |
| `needs` | Outputs of jobs this job depends on | `needs.build.outputs.image_tag` |
| `runner` | The current runner | `runner.os` in cache keys |

Expressions also power **conditionals** — `if:` on jobs or steps — with functions like `success()`, `failure()`, `always()`, `contains()`, and `hashFiles()`:

```yaml
- name: Push image
  if: github.ref == 'refs/heads/main'   # skip on PR runs — Lecture 7.4 uses exactly this
```

Environment variables can be declared at **three scopes** — workflow, job, and step — with the most specific winning. Use the narrowest scope that works; a workflow-level `DB_PASSWORD` leaks into every job including ones that build and push images and have no business holding it:

```yaml
env:                    # workflow scope: visible to every job
  TZ: UTC
jobs:
  tests:
    env:                # job scope: every step in this job — where DB_* belongs (Lecture 7.2)
      DB_CONNECTION: mysql
    steps:
      - run: php artisan migrate --force
        env:            # step scope: this step only
          DB_DATABASE: tickethub_test
```

A step can also export variables to *later steps in the same job* by appending to the `$GITHUB_ENV` file, and string outputs to *other jobs* via `$GITHUB_OUTPUT` — you will use both in Lectures 7.2 and 7.4.

## 5. `permissions:` — least privilege for the GITHUB_TOKEN

Every run receives an automatic credential, `GITHUB_TOKEN`, scoped to the repo and expiring with the job. Its *default* grants depend on repo/org settings — and on older repos the default is a token that can push code, write packages, and edit issues. Your test job needs none of that; a compromised dependency (a malicious Composer post-install script, a hijacked action) inherits whatever the token can do.

So every workflow you write in this course states its permissions explicitly, following one rule: **workflow level grants the minimum (read), individual jobs escalate only what they need.**

```yaml
permissions:
  contents: read        # checkout can read the repo; nothing can write anything

jobs:
  build:
    permissions:
      contents: read
      id-token: write   # only this job may request an OIDC token (Lecture 7.4)
```

This two-line habit costs nothing and converts "our CI got compromised" from an incident into a non-event. Treat a workflow without a `permissions:` block the way you treat a `chmod 777` from Module 2.

## 6. `concurrency:` — cancel superseded runs

You push to a PR, notice a typo, push again ten seconds later. Without intervention, both runs execute to completion — the first one now testing a commit nobody cares about, occupying a runner some other PR is queued behind, and burning paid minutes. The fix is a concurrency group:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Runs in the same group (here: same workflow + same branch/PR) queue behind each other; with `cancel-in-progress`, a new run kills the in-flight one. The expression makes cancellation apply **only to PR runs**: on `main` every run is sacred, because Lecture 7.4 makes each `main` run produce a deployable image — cancel one and some merge commit never gets its artifact, which ruins the rollback story before Module 9 even builds it.

## 7. Cache vs artifacts: two different problems

Both survive the death of a runner VM; that is where the similarity ends.

| | **Cache** (`actions/cache`) | **Artifacts** (`actions/upload-artifact` / `download-artifact`) |
|---|---|---|
| Purpose | **Speed**: reuse expensive-to-recreate files (Composer downloads, PHPStan result cache, Docker layers) | **Outputs**: move real results between jobs, or keep them after the run (coverage reports, built binaries, logs) |
| Addressed by | A **key** you construct, plus `restore-keys` prefix fallbacks | Name, within one workflow run |
| Guarantees | **None — best effort.** Evicted at 10 GB/repo (LRU) or 7 days unused. A correct pipeline must merely be *slower* on a miss, never *broken* | Retained (90 days default, configurable), downloadable from the run page |
| Scope rule | A branch sees caches from itself, its PR's base branch, and the default branch — never from sibling branches (poisoning protection) | The run that produced them |

The canonical cache pattern — key on the exact lockfile hash, fall back to the newest previous cache so you download only the delta:

```yaml
key: composer-${{ runner.os }}-${{ hashFiles('composer.lock') }}
restore-keys: composer-${{ runner.os }}-
```

An exact key hit skips re-saving (cache entries are immutable); a `restore-keys` hit restores a stale-but-close cache and saves a fresh entry under the new key at job end. You will use this exact pattern for Composer in a moment, for PHPStan in Lecture 7.3, and the same *idea* (with a different backend) for Docker layers in Lecture 7.4.

## 8. What CI costs

CI minutes are real money, and the meter shapes good habits. Public repos: standard hosted runners are free, unlimited. Private repos: the Free plan includes 2,000 minutes/month and Team 3,000, after which Linux bills about $0.008/minute — with Windows at 2x and macOS at **10x** the rate (a 10-minute macOS job debits 100 minutes). Artifact and package storage has its own small quota (500 MB on Free), which is why we set `retention-days` on artifacts instead of hoarding 90 days of coverage reports.

Do the arithmetic once: a team of four merging six PRs a day, each PR averaging two pushes, with a 10-minute pipeline, burns ~2,400 minutes a month on PR runs alone — over the Free quota before counting `main` runs. Now reread sections 6 and 7 with money-vision: `cancel-in-progress` refunds every superseded run, and caching that turns a 3-minute install into 10 seconds saves ~290 runner-minutes a month *per daily-run job*. Speed and cost are the same optimization here.

## Hands-on with TicketHub

Time to write the first real workflow. The goal is deliberately modest — prove the toolchain end to end: trigger on a PR, install dependencies with caching, run *one* real check. Lectures 7.2–7.4 grow this file; today you learn the write → push → watch → read-the-logs loop you will live in.

The one check we start with is **Laravel Pint** (the code-style checker — Lecture 7.3 covers it properly; today it is just a fast, real command that can fail). Add it locally first:

```console
$ cd ~/code/tickethub-api
$ composer require laravel/pint --dev
$ ./vendor/bin/pint --test
  ................................................................ 248 files
                                                            PASS   248 files
```

**Step 1 — the workflow file.** On a branch, create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  quality:
    runs-on: ubuntu-latest
    timeout-minutes: 5          # always set one — the default is 360 (6 billable hours)
    steps:
      - uses: actions/checkout@v4

      - name: Set up PHP 8.4
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.4'
          coverage: none

      - name: Validate composer.json and lock file
        run: composer validate --strict

      - name: Determine Composer cache directory
        id: composer-cache
        run: echo "dir=$(composer config cache-files-dir)" >> "$GITHUB_OUTPUT"

      - name: Cache Composer downloads
        uses: actions/cache@v4
        with:
          path: ${{ steps.composer-cache.outputs.dir }}
          key: composer-${{ runner.os }}-${{ hashFiles('composer.lock') }}
          restore-keys: composer-${{ runner.os }}-

      - name: Install dependencies
        run: composer install --prefer-dist --no-progress --no-interaction

      - name: Check code style (Pint)
        run: ./vendor/bin/pint --test
```

Read it as a story: least-privilege token; superseded PR runs get cancelled; one job on a throwaway Ubuntu VM checks out the merge ref, installs PHP 8.4 (no coverage driver — faster), fails fast if `composer.json` is malformed or out of sync with the lock file, restores the download cache keyed on the lock file, installs, and runs one check whose exit code decides the job. `runs-on`, `timeout-minutes`, `permissions`, `concurrency` — every concept from sections 3–6 is already load-bearing.

**Step 2 — push and watch.** Workflows run from the PR's branch, so this tests itself:

```console
$ git switch -c ci/bootstrap
$ git add .github/workflows/ci.yml composer.json composer.lock pint.json
$ git commit -m "ci: bootstrap GitHub Actions workflow with Pint check"
$ git push -u origin ci/bootstrap
$ gh pr create --fill
https://github.com/tickethub/tickethub-api/pull/158
$ gh run watch
✓ ci/bootstrap ci · 17224418321
Triggered via pull_request about 1 minute ago

JOBS
✓ quality in 1m12s (ID 48211930514)
```

**Step 3 — read a run like an operator.** Open the run in the browser (`gh run view --web`) and take the tour: the left sidebar lists jobs; each step expands into its log; the *Set up job* step at the top records the runner image version and evaluated permissions (verify: `Contents: read` and nothing else); *Post*-steps at the bottom show the cache being saved. On this first run the cache step reports a miss and `composer install` downloads everything (~35–45 s). Push any trivial change and compare:

```text
Cache restored successfully
Cache restored from key: composer-Linux-3f52a09e18c1c…
...
Installing dependencies from lock file (including require-dev)
Nothing to download, installing from cache
```

Install time drops to a few seconds. That difference, multiplied by every run forever, is section 8's money.

**Step 4 — break it, on purpose.** You learn more from a red run than ten green ones. Commit a style crime:

```console
$ echo '<?php $x = array( 1,2 );' > app/Support/Badly.php
$ git commit -am "test: deliberately violate code style" && git push
```

The run fails; the job summary shows an annotation — the mechanism actions use to attach messages to files and lines, rendered right in the PR's *Files changed* tab (your own scripts can emit them too: `echo "::error file=app/Support/Badly.php::message"`). The log names the crime:

```text
  ✗ app/Support/Badly.php  array_syntax, spaces_inside_parenthesis
                                                    FAIL   249 files, 1 style issue
Error: Process completed with exit code 1.
```

Fix it (`git rm app/Support/Badly.php`, commit, push) — and notice in the *Actions* tab that the previous in-flight run shows **Cancelled**: your concurrency group at work. If a run ever fails for an *environmental* reason instead (a network blip pulling a package), `gh run rerun <run-id> --failed` re-runs only the failed jobs — but treat that button with suspicion; Lecture 7.2 has opinions about "just re-run it" culture.

Merge the PR. `main` now runs `ci` on every merge commit, and the check named `quality` reports on every PR — it is not *required* yet (that is Lecture 7.3's job, once the important checks exist), but the loop is alive.

## Real-world best practices

- **The pipeline is the only integration gate — no parallel folklore.** If "green pipeline" doesn't fully answer "is this change safe to merge?", encode the missing check *into* the pipeline instead of into tribal knowledge ("oh, you also have to manually test X"). Teams that let folklore accumulate end up with CI nobody trusts and a wiki nobody reads. The next three lectures are exactly this: moving every merge-safety question into `ci.yml`.
- **Fix red `main` before anything else.** Trunk-based development runs on an always-releasable `main` (Module 4); a red `main` blocks every deploy and poisons every new branch. Production teams treat it like a minor incident: whoever merged it drops what they're doing; if the fix isn't obvious in ~10 minutes, revert the squash commit (one clean `git revert` — this is why Module 4 chose squash merges) and investigate on a branch.
- **Set `timeout-minutes` on every job.** The default is 360 minutes. A hung test or a stuck network call otherwise bills six hours *and* holds a runner slot your teammates are queued behind. A job that normally takes 8 minutes should time out at 15 — the timeout is an alarm, not a target.
- **State `permissions:` in every workflow, even when defaults would work.** Defaults vary by org and repo age; explicit permissions are self-documenting and survive settings changes. Auditors and security reviews will thank you; more importantly, the day a dependency is compromised, blast radius is a read-only token.
- **Keep workflow logic in scripts when it grows.** Ten lines of bash in a `run:` step is fine; fifty lines means extract to `bin/ci/<task>.sh` and call it — reviewable, shellcheck-able, runnable locally. YAML is configuration, not a programming language.

## Common pitfalls

1. **Treating `github.sha` on a PR run as "my commit".** It is the synthetic merge commit of `refs/pull/N/merge` — it does not exist on your branch. People paste it into `git show` locally, get `fatal: bad object`, and conclude CI is haunted. Correct approach: understand section 3.1; use `github.event.pull_request.head.sha` when you genuinely need the branch tip, and expect merge-ref testing the rest of the time — it is the better default.
2. **Assuming files persist between jobs.** A `build` job that expects `vendor/` from the `tests` job finds an empty VM, because each job is a fresh runner. People assume jobs are like steps because both live in one file. Correct approach: each job re-establishes what it needs (checkout + cached install is fast), or pass explicit outputs via artifacts.
3. **Making cache a correctness dependency.** A workflow that only works when the cache is warm (e.g., skipping `composer install` entirely if the cache hit) breaks unpredictably when the entry is evicted — 10 GB LRU, 7-day expiry, no SLA. People do it chasing seconds. Correct approach: cache accelerates a step that always runs; `composer install` against a warm download cache is already near-instant.
4. **Unpinned or loosely-trusted actions.** `uses: someuser/handy-action@main` executes whatever that user pushes next, with your token, forever. People do it because the README said so. Correct approach: pin at least a major version tag from publishers you trust; pin full commit SHAs for anything obscure — or read its 40 lines of source and vendor it into your repo.
5. **Leaving `cancel-in-progress` on for `main`.** Cancelling superseded *PR* runs saves money; cancelling *main* runs means some merge commits never complete verification (and, after Lecture 7.4, never get an image built). People copy a concurrency block without the conditional. Correct approach: the expression form shown in section 6 — cancel PRs, queue `main`.
6. **Debugging by adding `echo` commits.** Push-to-debug burns a full pipeline round-trip per guess and litters history. Correct approach: reproduce locally first (the beauty of containerized parity from Module 6 — the same commands run in both places); read the *full* step log including the collapsed sections; enable step-debug logging (set secret `ACTIONS_STEP_DEBUG=true`) before resorting to guess-commits.

## Exercises

1. **Read a stranger's pipeline.** Pick any large open-source PHP project (e.g. Laravel itself) and open `.github/workflows/`. For its main test workflow, identify: the triggers, the job DAG (`needs:`), what is cached and keyed on what, and its `permissions:` block (or absence). Write down one thing you would copy and one you would change.
2. **Prove the fresh-VM rule.** Add a temporary second job to `ci.yml` with `needs: [quality]` and a single step: `ls vendor/ && echo "vendor exists" || echo "vendor is gone"`. Predict the output, run it, then delete the job. Bonus: make the first job write a file and pass it to the second via `actions/upload-artifact@v4` / `actions/download-artifact@v4`.
3. **Cache forensics.** In your repo's *Actions → Caches* UI (or `gh cache list`), find your Composer cache entry and note its size. Change one dependency (`composer require --dev fakerphp/faker` is harmless), push, and watch the run: which key missed, which `restore-keys` prefix hit, how long did install take versus a full miss? Delete the cache with `gh cache delete --all` and measure a truly cold run.
4. **Add a manual trigger with an input.** Extend `on:` with a `workflow_dispatch` accepting a boolean input `verbose`; when true, run `composer install` with `-vvv`. Trigger it with `gh workflow run ci --field verbose=true` and find where the input surfaces in the `inputs` context.
5. **Stretch — a scheduled canary.** Create a separate `nightly.yml` that runs at 02:00 UTC on a schedule, installs dependencies *without* the lock file's protection (`composer update --dry-run`), and fails if major updates are available, so dependency drift surfaces weekly instead of during an incident. Add `workflow_dispatch` so you can test it without waiting a night, keep `permissions: contents: read`, and consider: why should this *not* run on every PR?

## What's next

You have a living pipeline, but a single style check is a bouncer checking shoelaces. The check that actually protects an event-ticketing platform is the test suite — run against the same MySQL 8.0 and Redis 7 the app ships with, because TicketHub's no-overselling invariant lives in row locks that only real MySQL can exercise. [Lecture 7.2 — The TicketHub Test Pipeline](02-tickethub-test-pipeline.md) builds the `tests` job: service containers, the networking model that trips everyone, parallel Pest with per-process databases, and an honest conversation about coverage gates.
