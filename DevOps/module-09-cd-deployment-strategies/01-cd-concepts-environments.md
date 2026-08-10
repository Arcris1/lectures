# Lecture 9.1 — CD Concepts, Environments & Promotion

> **Module 9 — Continuous Delivery & Deployment Strategies** · Lecture 1 of 4 · Estimated time: ~60 min

Open the pain audit you wrote at the end of [Lecture 8.4](../module-08-aws-fundamentals/04-classic-deployment-ec2-alb.md). Five numbered items, each a way the manual EC2 deployment hurt you. That list is this module's requirements document, and this lecture is where you stop treating deployment as a task someone performs and start treating it as a **system property**: something the platform does, on defined triggers, through one reviewed path, leaving an audit trail. Before we write a line of pipeline YAML (9.3) or a task definition, we need the concepts that make the YAML *mean* something — because every CD horror story you'll ever hear is a team that had the tools and skipped the doctrine.

## Learning objectives

- Distinguish continuous delivery from continuous deployment precisely, and choose the right mode per environment for a small team
- Defend "the pipeline is the only path to production" as policy, including a legitimate break-glass procedure
- Explain build-once-promote-everywhere and why a per-environment rebuild is a different, untested artifact
- Configure GitHub Environments — staging unprotected, production gated by reviewers and a tag policy — with environment-scoped secrets
- Extend Module 7's OIDC trust from branch-scoped to environment-scoped subjects and explain the security difference
- Use the GitHub Deployments API as an audit trail and to measure DORA deployment frequency

## 1. Delivery is a state, deployment is a decision

The two terms get used interchangeably; they are not the same thing, and the difference decides how your pipeline behaves.

**Continuous delivery** means every change that lands on `main` is *proven deployable*: built, tested, scanned, packaged, and sitting in the registry ready to go. Deploying it remains a **decision** — a human (or a policy) chooses when. You achieved most of this in Module 7: after 7.4, every merge produces an immutable `sha-` image whose existence certifies a green pipeline. **Continuous deployment** removes the decision: the change that proves itself deployable *is deployed*, automatically, with no human in the loop. Delivery is a capability; deployment is that capability with the trigger pulled.

Neither is universally "more advanced." The correct question is *per environment*: what does a human approval actually buy here, and what does it cost? TicketHub's answer, which this module implements:

- **Staging: continuous deployment.** Every merge to `main` deploys automatically. An approval step here buys nothing — staging exists precisely to absorb changes and reveal problems — while costing the thing staging is for: fast, honest feedback. If merges pile up waiting for someone to click deploy, staging drifts from `main` and stops telling the truth.
- **Production: gated continuous delivery.** Every candidate is deployable at all times; deploying is a deliberate act (a `v*` tag, per Module 4's release convention) plus an explicit approval. For a three-person team selling *tickets* — real money, oversell invariants, on-sale spikes announced in advance — the approval buys timing control (nobody wants an unattended deploy landing mid-on-sale) and a moment of human judgment, at the cost of a click. That trade is right for this team today. It's also honest to say what the gate is *not*: it is not a quality gate — quality was settled by CI and staging. It's a *timing and accountability* gate. Teams that grow past needing it (strong observability, progressive delivery from 9.4) often remove it; Module 12's tooling is what makes removing it responsible.

Write the mapping down, because everything in this module hangs off it: **PR → CI only · merge to `main` → staging, automatically · tag `v*` → production, with approval.** You've seen this line in [TICKETHUB.md](../TICKETHUB.md) since Module 1. This module makes it real.

## 2. The pipeline is the only path to production

Here is the doctrine, stated as absolutely as it deserves: **no change reaches an environment except through the pipeline.** No SSM-session-and-edit (Module 8's polite successor to SSH-and-edit), no console hotfix, no "I'll just tweak the task definition in the AWS console and backfill the code later." Not because you're untrustworthy — because every out-of-band change destroys the three properties the pipeline exists to provide:

1. **Reproducibility.** The environment is now something no artifact describes. The next pipeline deploy silently *reverts* the hand-edit — or worse, half-reverts it — and nobody can say what's running. This is pain-audit item 1 (unknowable drift) re-created voluntarily.
2. **Review.** The change skipped the PR, the tests, the scan, the second pair of eyes. Every quality gate you built in Module 7 applies to 0% of a console edit.
3. **Audit.** When the 2 a.m. incident happens, "what changed recently?" is question one. Pipeline deploys answer it in one API call (section 7). Console edits answer it with CloudTrail archaeology, if at all.

**Break glass, honestly.** Real systems have real emergencies, and a doctrine with no escape hatch gets abandoned the first time it's inconvenient — so define the escape hatch before you need it. A legitimate break-glass change is: *declared* (announced in the incident channel before it happens), *audited* (done through SSM/CloudTrail-visible tooling, never a shared credential), *minimal* (stop the bleeding, nothing more), and *codified immediately after* — a PR that makes the manual change real in code and pipeline ships the same day, because until it merges, the environment and the repo disagree and the next deploy is a landmine. If a "break glass" isn't followed by a codifying PR, it wasn't an emergency procedure; it was just a console edit with better vibes.

## 3. Build once, promote the artifact

Module 7 planted this principle; here it becomes the promotion system's load-bearing wall. **The `sha-<short-sha>` image is the unit of promotion.** It is built exactly once, on merge to `main`. Staging runs it. If it proves out, production runs *the same digest*. Nothing is ever rebuilt "for production."

Why so absolute? Because **a rebuild is a different artifact**. Same Dockerfile, hours later: the base image tag has moved, a Composer dependency re-resolved one patch version, the ondrej PPA published an update. You would be deploying to production a binary that no test has ever executed — while telling yourself it's "the same thing." It is not the same thing; it merely has the same name. Module 6 made ECR tags immutable so this can't even happen by accident: pushing a second `sha-9f2c1d7` is an API error, not a silent overwrite.

This is Module 5's factor V (build, release, run) made operational. The *build* is environment-agnostic — the image contains code and dependencies, zero configuration. The *release* is that build combined with an environment's config — and config is exactly what Parameter Store and Secrets Manager hold per environment (`/tickethub/staging/*` today, `/tickethub/production/*` in Module 10). **Config varies per environment; the artifact must not.** If you ever feel the urge to rebuild for production, what you actually want is a config value the image is missing — move it to the environment, where it belonged all along.

What qualifies a build for promotion? Three checks, all of which you can point at:

1. **Green CI** — structurally guaranteed: an image existing in ECR *means* tests, quality gates, smoke test, and Trivy passed (7.4's `needs:` design made the registry a menu of validated builds).
2. **A staging soak** — the build has run in staging under real (staging-shaped) traffic for long enough that Horizon has churned jobs, the scheduler has ticked, and nothing has screamed. For TicketHub: hours to a day, not minutes.
3. **Passing smoke tests against staging** — the deployed `/up` reports the expected SHA (Module 7's `APP_VERSION` stamp, which 9.3's pipeline asserts automatically), and the critical path works.

**Release ≠ deploy.** One more distinction to install now, because 9.4 completes it: *deploying* code means it's present and running; *releasing* a feature means users are exposed to it. Conflating them is why teams fear deploys — every deploy becomes a launch. Separate them and deploys become boring plumbing: Module 4 already merged the promo-codes groundwork "dark, flag off"; that code has been deploying harmlessly ever since, unreleased. Feature flags (9.4) finish this idea: deploy continuously, release deliberately.

## 4. GitHub Environments: the mechanism

The promotion model needs an enforcement mechanism, and GitHub provides one purpose-built: **Environments**. An environment is a named deployment target (`staging`, `production`) that a job binds to with one line — `environment: staging` — and that binding brings three things:

- **Protection rules** evaluated *before* the job starts: required reviewers, a wait timer, and a policy restricting which branches/tags may deploy to it.
- **Scoped secrets and variables** visible *only* to jobs bound to that environment — staging credentials structurally invisible to production jobs and vice versa.
- **Deployment records** — every run creates an entry in the Deployments API with the environment, SHA, actor, and outcome (section 7's audit trail).

Here is TicketHub's exact configuration, set in **Settings → Environments** (the hands-on scripts it via API):

**`staging`** — no protection rules at all. Deployment branches: **Selected branches → `main`** (defense in depth: even a buggy workflow trigger can't deploy a feature branch to staging). Environment variables: `AWS_REGION=ap-southeast-1`, `ECS_CLUSTER=tickethub-staging`, `BASE_URL=https://api.staging.tickethub.example`. No environment secrets — OIDC means there are no credentials to store, which should feel routine by now and is still worth savoring.

**`production`** — the gate. **Required reviewers**: at least one, ideally two named humans or a team; the deploy job *pauses* until one approves, right in the run UI. **Wait timer**: optional; a 5-minute timer is a cheap "are you sure" buffer that lets a hasty tagger cancel — we leave it at 0 and rely on reviewers. **Deployment branches and tags**: **Selected tags → `v*`** — the platform now *enforces* Module 4's convention: a job binding to `production` from any ref that isn't a `v*` tag is refused before it starts. Variables: `ECS_CLUSTER=tickethub-prod`, `BASE_URL=https://api.tickethub.example`.

Note what just happened to your promotion model: it stopped being a diagram in a README and became machine policy. Nobody — including you at 2 a.m. — can deploy production from a branch, and nobody deploys it alone.

## 5. Environment-scoped OIDC: the enterprise pattern

Module 7's trust policy for `tickethub-github-deploy` pinned the `sub` claim to `repo:tickethub/tickethub-api:ref:refs/heads/main` — the right scope for a role that pushes images from `main`. But deployment jobs change the claim's shape. **When a job declares `environment:`, GitHub mints its OIDC token with an environment-scoped subject:**

```text
Branch-scoped (Module 7, ci.yml build job):
  sub = repo:tickethub/tickethub-api:ref:refs/heads/main

Environment-scoped (Module 9, any job with `environment:`):
  sub = repo:tickethub/tickethub-api:environment:staging
  sub = repo:tickethub/tickethub-api:environment:production
```

This is a security *upgrade*, not just a format change. A subject of `environment:production` can only be presented by a job that bound to the `production` environment — which means it **passed the environment's protection rules first**. Condition AWS trust on that subject and you've chained the two systems: *AWS will not hand out production deploy credentials unless a human approved this specific run against a `v*` tag.* The reviewer requirement stops being a GitHub-side courtesy and becomes a cryptographic precondition for the cloud credentials themselves. That chaining — protection rules → token claims → IAM trust — is the enterprise pattern, and at larger shops it extends to one role per environment (a staging role that *cannot* touch production resources, assumed only via `environment:staging`, and vice versa). TicketHub keeps one deploy role with per-environment statements until Module 10 splits infrastructure per environment properly; the trust policy grows the environment subjects now (hands-on), and 9.3's deploy jobs use them.

## 6. Deployment history: the audit trail, and DORA comes home

Because every `environment:`-bound job creates a deployment record, you get an audit trail without building one: who deployed what SHA to which environment, when, triggered by which run, with what outcome. This answers the incident-time question ("what changed?") and the compliance question ("who can deploy and who did?") from one API.

It also closes a loop opened in [Module 1](../module-01-devops-foundations/04-measuring-devops-dora.md): **DORA's deployment frequency stops being a guess.** Back then you couldn't measure it because deploys were untracked human actions. Now every deploy is a record:

```console
$ gh api --paginate 'repos/tickethub/tickethub-api/deployments?environment=staging' \
    --jq '.[].created_at' | cut -dT -f1 | sort | uniq -c | tail -7
   3 2026-08-03
   5 2026-08-04
   2 2026-08-05
   4 2026-08-06
   6 2026-08-07
```

Deploys per day, from the system of record, for free. Lead time follows (deployment `created_at` minus the SHA's first-commit time), and 9.4 closes the loop on change failure rate and MTTR. When Module 12 builds dashboards, this API is a data source, not a new instrument.

## 7. Deploy hygiene, and the rollback question

Automation removes toil, not judgment. The habits that make automated deploys safe are cheap and mostly social:

- **Small batches.** Ten one-PR deploys beat one ten-PR deploy every time: when something breaks, the suspect list has one name. This is the deployment-frequency metric's *causal* justification, not just a scoreboard.
- **Deploy early in the day.** Not because deploys are scary — because *if* one goes sideways, you want awake colleagues and open hours ahead of you, not a 6 p.m. incident bleeding into dinner.
- **Announce with a changelog.** Module 4's conventional commits pay their dividend: the release notes write themselves (`gh release create` with generated notes), and "what's in this deploy" is a link, not a shrug.
- **Watch a bake period.** After the deploy lands, someone owns watching it — error rates, latency, Horizon queue depth — for a defined window. Honesty check: until Module 12, TicketHub's "dashboards" are CloudWatch's default ALB metrics, `/up`, and Horizon's UI. Thin, and you should feel that thinness — it's Module 12's entire justification. Watch them anyway; a thin dashboard watched beats a rich one nobody opens.

And when the bake period shows a problem? Two philosophies, and choosing between them under pressure is a skill this module trains deliberately. **Roll back**: return to the previous known-good artifact — fastest when the artifact is the problem and the change is self-contained. **Roll forward**: ship a small fix through the pipeline — necessary when data has changed shape (schema migrations don't un-happen; 9.2 is largely about this), and healthier as a default culture because it keeps the pipeline as the only path even during incidents. The decision tree in one breath: *user-facing impact now? → is the previous image safe to run against the current schema? → yes: roll back (it's one redeploy of the previous `sha-` tag — pain-audit item 3, solved); no, or the fix is trivial: roll forward.* Lectures 9.2 (schema compatibility) and 9.4 (flags make most "rollbacks" a toggle) each take a branch of that tree.

**The module's road from here:** 9.2 teaches what a *correct* deploy must do — atomicity, worker restarts, migrations under live traffic — on the classic VM model, because half the industry runs on it and every mechanism transfers. 9.3 brings TicketHub itself to ECS Fargate and automates everything this lecture described, retiring the stopped EC2 pair. 9.4 climbs past rolling deploys to blue/green, canary, and feature flags.

## Hands-on with TicketHub

⚠️ **Cost check:** this lecture creates GitHub configuration and edits one IAM trust policy — nothing here bills anything. The staging stack from Module 8 continues at its ~$4.50/day; the stopped EC2 pair bills only EBS until 9.3 terminates it.

### 1. Create the environments

The Settings → Environments UI works; settings-as-code works better (Module 4's ruleset spirit). Environments via `gh api`:

```console
$ gh api -X PUT repos/tickethub/tickethub-api/environments/staging \
    --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
$ gh api -X POST repos/tickethub/tickethub-api/environments/staging/deployment-branch-policies \
    -f name='main' -f type='branch'
$ gh api -X PUT repos/tickethub/tickethub-api/environments/production \
    --input - <<'JSON'
{
  "reviewers": [ { "type": "User", "id": 583231 } ],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
$ gh api -X POST repos/tickethub/tickethub-api/environments/production/deployment-branch-policies \
    -f name='v*' -f type='tag'
```

(Find your reviewer's user ID with `gh api users/<login> --jq .id`. On a personal repo you can name yourself — self-approval is theater with n=1, but the *pause* still prevents accidental tag-push deploys, which is most of the value solo.)

### 2. Scope the variables

```console
$ for kv in AWS_REGION=ap-southeast-1 ECS_CLUSTER=tickethub-staging \
      BASE_URL=https://api.staging.tickethub.example; do
    gh variable set "${kv%%=*}" --env staging --body "${kv#*=}"
  done
$ for kv in AWS_REGION=ap-southeast-1 ECS_CLUSTER=tickethub-prod \
      BASE_URL=https://api.tickethub.example; do
    gh variable set "${kv%%=*}" --env production --body "${kv#*=}"
  done
```

Same variable names, different values per environment — the workflow in 9.3 reads `${{ vars.ECS_CLUSTER }}` and stays environment-agnostic, which is factor III applied to the pipeline itself.

### 3. Grow the OIDC trust policy

Update `tickethub-github-deploy`'s trust policy (the file lives at `.github/aws/trust-policy.json` per 7.4) to accept the two environment-scoped subjects alongside Module 7's branch-scoped one — three subjects, one condition:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GitHubActionsScopedSubjects",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:tickethub/tickethub-api:ref:refs/heads/main",
            "repo:tickethub/tickethub-api:environment:staging",
            "repo:tickethub/tickethub-api:environment:production"
          ]
        }
      }
    }
  ]
}
```

```console
$ aws iam update-assume-role-policy --role-name tickethub-github-deploy \
    --policy-document file://.github/aws/trust-policy.json
```

Read the list as three doors: `ci.yml`'s build job pushes images through the branch door; 9.3's staging deploy walks through `environment:staging`; the production deploy can *only* enter through `environment:production` — which no token carries unless a reviewer approved a `v*`-tagged run. (The branch entry stays because `ci.yml`'s build job doesn't bind an environment — remove it and image pushes break. Exercise 3 has you prove that the fun way.)

### 4. Rehearse the audit trail

You can exercise the whole mechanism before 9.3 exists by making the deploy stub environment-aware. In `.github/workflows/deploy.yml`, change the placeholder job:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Placeholder
        run: echo "Deployment pipeline is completed in lecture 9.3."
```

Tag and push a release the Module 4 way (`git tag v1.6.1 && git push origin v1.6.1`), then watch: the run appears with the job **waiting** — "Review pending deployments" — and proceeds only after approval. Afterwards, the record exists:

```console
$ gh api repos/tickethub/tickethub-api/deployments \
    --jq '.[0] | {environment, ref, sha: .sha[0:7], creator: .creator.login, created_at}'
{
  "environment": "production",
  "ref": "v1.6.1",
  "sha": "a7d3e9f",
  "creator": "alexcruz",
  "created_at": "2026-08-09T02:41:07Z"
}
```

Who, what, where, when — queryable forever. Try tagging `experiment-1` (not matching `v*`) and pushing: the job is rejected by the tag policy before a single step runs. Delete the junk tag; the policy just earned its keep.

## Real-world best practices

- **Match automation level to what an approval actually buys.** Auto-deploy anywhere an approval adds only latency (staging, always); gate where a human buys timing control or accountability (production, for a small team). Revisit as observability matures — gates should be removed on evidence, not accumulated by fear.
- **Make the promotion policy machine-enforced, not documented.** A README that says "production deploys from tags only" is a suggestion; an environment tag policy plus an OIDC subject condition is a fact. Every rule that matters should fail loudly when violated, not rely on people remembering it.
- **Treat the deployment record as a first-class artifact.** If a deploy happened and no record exists, your process has a hole exactly where incident response needs a floor. `environment:` on every deploy job, no exceptions — the audit trail is a side effect of doing it right.
- **Keep one artifact, N configs.** The moment anyone proposes a `production` build variant, stop the meeting: what they want is a config value, and it belongs in the environment (Parameter Store, environment variables), not the image. Build-once is a *policy you defend*, not a default you drift from.
- **Write the break-glass procedure while calm.** Name who may invoke it, through what audited tooling, and the codify-after rule. Teams without a written procedure don't avoid break-glass — they improvise it badly, silently, and repeatedly.

## Common pitfalls

1. **Approval gates as quality gates.** Teams add production reviewers hoping a human will "catch problems" — but a reviewer staring at a green run has no new information; they rubber-stamp within a week, and the gate becomes pure latency. Correct approach: let CI and staging own quality; let the gate own *timing and accountability*, and say so out loud.
2. **Storing environment config as repository-level secrets.** `STAGING_CLUSTER`, `PROD_CLUSTER`, `PROD_CLUSTER_REAL` — repository-wide values with environment names baked in, readable by every job, wrong the day names change. Correct approach: same variable name, environment-scoped values; jobs read `vars.X` and inherit the right value from their `environment:` binding.
3. **A trust policy that grants environments but keeps a wildcard branch sub.** People add `environment:production` to the subject list but leave `repo:org/repo:*` from an old debugging session — making every protection rule bypassable by any branch job. Correct approach: enumerate exact subjects; audit the list whenever workflows change; treat `*` in a `sub` condition as a finding.
4. **Letting staging drift from `main`.** Someone pauses auto-deploy "during the incident" and never re-enables it; three weeks later staging validates nothing and its green means nothing. Correct approach: staging deploys on every merge, structurally; if staging must be frozen, that's an incident action item with an owner and an end date.
5. **Measuring deployment frequency by feel.** "We deploy pretty often" — nobody knows, so nobody notices the slide from daily to weekly that precedes every big-batch disaster. Correct approach: the Deployments API query from section 6 in a scheduled job or dashboard; trends reviewed monthly, because the *trend* is the signal.

## Exercises

1. In two sentences each, classify these teams as continuous delivery, continuous deployment, or neither — and whether the choice fits: (a) merges deploy straight to production behind flags, no staging; (b) every merge is deployable but releases ship quarterly in a batch; (c) TicketHub as configured in this lecture.
2. Extend the DORA query: compute staging deployment frequency per week over the last month, and median lead time (deployment `created_at` minus commit authored time for the deployed SHA — `gh api` for both). Write both numbers in your pain-audit file as the "before automation" baseline to compare after 9.3.
3. **Prove the subject scoping.** Add a temporary job with `environment: staging` that assumes `tickethub-github-deploy` via OIDC and runs `aws sts get-caller-identity`. Then remove the `environment:` line and re-run: same repo, same branch, `AccessDenied` (the sub reverted to branch-scope — allowed — so instead *change* the environment to a nonexistent name and observe GitHub refuse before AWS is even asked). Write three lines on which system rejected each attempt and why the layering matters.
4. Draft your break-glass procedure as `docs/runbooks/break-glass.md`: who may invoke, the exact audited access path (SSM/ECS Exec — no credentials outside IAM), the announcement template, and the codifying-PR rule with a deadline. Keep it under a page — a runbook nobody reads is scenery.
5. **Stretch — deployment protection as code.** Write a small script (or scheduled workflow) that audits the live settings against intent: environments exist, production requires ≥1 reviewer and a `v*` tag policy, staging allows only `main`, and the IAM trust policy's subject list matches an allowlist checked into the repo. Exit non-zero on drift. You've just written your first compliance check — Module 10 generalizes the idea to all infrastructure.

## What's next

The doctrine is set: one path to production, one artifact promoted through it, environments enforcing who and when. What the doctrine doesn't yet cover is *how a single deploy avoids hurting anyone while it happens* — what must occur, in what order, so that code swaps under live traffic without a dropped request, a stale worker, or a migration that breaks the version still running. [Lecture 9.2](02-zero-downtime-laravel-deploys.md) teaches exactly that on the classic VM model — atomic releases, worker restarts, and expand/contract migrations — craft that transfers intact to Fargate in 9.3 and to Kubernetes in Module 11.
