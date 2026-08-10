# Lecture 10.4 — Terraform in CI & Policy

> **Module 10 — Infrastructure as Code with Terraform** · Lecture 4 of 4 · Estimated time: ~100 min

Everything Module 10 has built so far still has one embarrassing property: it runs from your laptop. [Module 9](../module-09-cd-deployment-strategies/01-cd-concepts-environments.md) established that the pipeline is the only path to production *for application code*; this lecture extends the doctrine to the infrastructure itself. By the end, `tickethub-infra` has what `tickethub-api` has had since Module 7: every PR shows its consequences (the plan) as a review artifact, linters and policy scanners reject misconfigurations before they exist, merges apply what was reviewed, humans approve production, and a nightly job catches drift while you sleep. Infrastructure changes stop being "commands someone ran" and become what they should have been all along: reviewed, gated, logged deployments.

## Learning objectives

- Explain why laptop applies fail at team scale, and describe the PR-plan / merge-apply target model
- Create a dedicated `tickethub-infra-ci` OIDC role and justify its separation from `tickethub-github-deploy`
- Build a Terraform pipeline job by job: fmt, validate, tflint, Checkov, plan-as-PR-comment, gated applies
- Handle the plan-staleness problem honestly, with concurrency groups protecting state
- Run scheduled drift detection that turns silent divergence into an issue with the diff attached
- Layer destruction guardrails — `prevent_destroy`, `deletion_protection`, state versioning — and keep secrets out of the repo entirely

## 1. Why laptop applies don't scale

At one person, laptop Terraform mostly works. Add a second engineer and the cracks are structural:

- **Whose credentials?** Every applier needs powerful AWS access on their machine — the standing-credential problem [Module 7](../module-07-ci-github-actions/04-building-images-in-ci.md) killed for app deploys, reborn with *more* privilege (this role can delete VPCs).
- **Whose code?** Two laptops, two checkouts, possibly divergent branches, planning against the same state simultaneously. Locking prevents corruption, not confusion — the winner is whoever applied last, and `main` may match neither.
- **No review artifact.** HCL is intent; the *plan* is consequence. Reviewing infrastructure changes without the plan is approving surgery from the consent form without the imaging.
- **No audit trail.** Six months later: "who opened that SG rule, and why?" Laptop applies answer with CloudTrail (which says *what*, never *why*) and someone's memory. Pipeline applies answer with a merged PR: reviewer, plan, ticket link.

The target model, mirroring Module 9's promotion shape exactly: **PR → plan posted as a comment (both environments) → review the diff → merge → staging applies automatically → production applies behind a required-reviewer gate.** Same shape as app deploys on purpose — one mental model for how *anything* reaches production is a design principle, not a coincidence.

## 2. The infra CI identity: a second, separate OIDC role

Module 9 gave `tickethub-api`'s workflows the `tickethub-github-deploy` role: push to ECR, update ECS services, read a few SSM parameters. Terraform needs vastly more — create and destroy VPCs, RDS, IAM roles, and read/write state. Granting that to the app-deploy role would mean any compromise of the *app* repo's CI (a malicious PR, a poisoned action) could reshape the network. So: a second role, **`tickethub-infra-ci`**, and the blast-radius rule it encodes: *app deploys can't touch VPCs; infra applies can't be triggered from the app repo.*

The trust policy uses the same GitHub OIDC provider from Module 7, scoped to **this repository and its environments**:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": [
          "repo:tickethub/tickethub-infra:pull_request",
          "repo:tickethub/tickethub-infra:environment:staging",
          "repo:tickethub/tickethub-infra:environment:production"
        ]
      }
    }
  }]
}
```

No other repo, no other trigger, can assume it. Honesty about the permissions side: this role is necessarily powerful (it creates IAM roles, so it can *in principle* escalate), and truly least-privileging Terraform is an unsolved annoyance everywhere. The grown-up mitigations, in order of effort: a **permissions boundary** on every role Terraform creates (caps what created roles can do, even if the policy says more), explicit `Deny` statements on things Terraform should never touch (the state bucket's *deletion*, the OIDC provider itself), and ultimately separate AWS accounts per environment. We apply the deny-list today, name the boundary as the next step, and don't pretend a `PowerUserAccess`-shaped role is least privilege. The role itself is defined in Terraform like everything else (it's platform), reviewed through the very pipeline it powers.

## 3. The plan job: making the PR show consequences

Built piece by piece; the complete file appears in the hands-on. Every PR plans **both environments** — a module change touches staging *and* production, and reviewers must see both diffs.

**Setup.** `hashicorp/setup-terraform@v3` installs the pinned CLI. `terraform_wrapper: true` (the default, set explicitly because we depend on it) wraps the binary so each step exposes `steps.<id>.outputs.stdout` — how the plan text reaches the PR comment.

```yaml
- uses: hashicorp/setup-terraform@v3
  with:
    terraform_version: "1.9.8"
    terraform_wrapper: true
```

**Hygiene gates, cheapest first.** `terraform fmt -check -recursive` (a diff nobody argues about), then `terraform init` (needs backend access), then `terraform validate`. Same fail-fast ordering logic as [Module 7's](../module-07-ci-github-actions/03-code-quality-gates.md) quality gates: formatting before type-checking before anything that costs minutes.

**tflint** knows what `validate` doesn't: provider-specific facts. `validate` happily accepts `instance_class = "db.t4g.mciro"` — syntactically fine, a string like any other; AWS rejects it twenty minutes into an apply. tflint's AWS ruleset knows the real instance-type catalog, flags deprecated arguments, and can enforce tagging conventions. `.tflint.hcl` in the repo root:

```hcl
plugin "aws" {
  enabled = true
  version = "0.33.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
```

One example finding, the kind that saves a broken apply:

```text
$ tflint --init && tflint --recursive
1 issue(s) found:

Error: "db.t4g.mciro" is an invalid value as instance_class (aws_db_instance_invalid_type)

  on envs/staging/main.tf line 14:
  14:   instance_class    = "db.t4g.mciro"
```

Seconds, no AWS calls, no state lock — versus discovering the typo mid-apply with half the plan already executed.

## 4. Policy as code: the scanner that reads intent

Linting checks *validity*; policy scanning checks *judgment*. Tools like **Checkov** and **trivy config** (either fits here; we use Checkov) ship hundreds of rules encoding security consensus: no public buckets, no unencrypted databases, no `0.0.0.0/0` ingress on databases. They read HCL statically — misconfigurations are caught *before the resource exists*, which is an entire category better than cloud-side auditing after the fact.

A worked example. A well-meaning PR adds a reports bucket:

```hcl
resource "aws_s3_bucket" "reports" {
  bucket = "tickethub-staging-reports"
}
# ...no public access block — forgot it
```

```text
$ checkov -d envs/staging --quiet --compact
Check: CKV2_AWS_6: "Ensure that S3 bucket has a Public Access block"
	FAILED for resource: aws_s3_bucket.reports
	File: /envs/staging/s3.tf:12-14
Check: CKV_AWS_18: "Ensure the S3 bucket has access logging enabled"
	FAILED for resource: aws_s3_bucket.reports
```

The first finding is real — fix it by adding the `aws_s3_bucket_public_access_block` resource (10.2's pattern), and the check passes. The second illustrates scanner reality: not every rule fits every context (access logging on a tiny internal bucket is a judgment call). Handle exceptions *visibly*, in code, with a reason — Checkov reads inline suppressions:

```hcl
resource "aws_s3_bucket" "reports" {
  # checkov:skip=CKV_AWS_18: internal reports bucket; access logging deferred to M12 logging work
  bucket = "tickethub-staging-reports"
}
```

A skip with a reason is reviewable; a globally disabled rule is a blindfold. Positioning, honestly: Checkov/trivy are *policy checkers with a built-in rulebook* — excellent for industry-consensus security. For **custom organizational rules** ("every SG rule needs a `Reason` tag", "only the platform team may touch `aws_iam_*`"), the general engines are **OPA** (Open Policy Agent, with Conftest evaluating Rego policies against the plan JSON) and HashiCorp's commercial **Sentinel**. That's a paragraph of awareness, not today's build — TicketHub's rules are still the consensus ones.

## 5. Apply on merge: the staleness problem, handled honestly

[Lecture 10.1](01-terraform-fundamentals.md) taught the contract: `plan -out=tfplan`, review, `apply tfplan` — apply exactly what was reviewed. So the *pure* pipeline would save the PR's plan artifact and apply it after merge. Here's the honest problem: **a saved plan binds to a state serial**. Between plan time and merge time, state may move — another PR merged, a colleague's fix — and Terraform then refuses the stale plan (`Error: Saved plan is stale`), so your pipeline needs re-plan logic anyway. Worse, with several PRs open, each holds a plan computed against a world the others are about to change.

The industry-pragmatic answer, adopted by most real teams and this course: **re-plan on `main`, then apply immediately**, accepting the small window between the reviewed plan and the merge-time plan. The trade-off, stated plainly: what applies is the merge-time plan, not byte-for-byte the reviewed one. Three mitigations close most of the gap: **concurrency groups** serialize applies per environment, a **small-PR, squash-merge culture** keeps the window short, and — for the cautious — `-detailed-exitcode` on the merge-time plan can halt and re-request review if changes appear where none were expected. Some shops run plan-artifact pipelines with strict serial checking (Atlantis and Terraform Cloud formalize this). Know the spectrum; ship the pragmatic point on it.

**Concurrency** protects the other invariant — one apply per environment at a time, and queued rather than failed on the DynamoDB lock:

```yaml
concurrency:
  group: terraform-apply-${{ matrix.env || 'staging' }}
  cancel-in-progress: false     # never cancel a running apply
```

`cancel-in-progress: false` matters: cancelling a mid-flight apply is how you get half-created infrastructure and orphaned locks. Applies queue; they don't die.

**Promotion shape.** `apply-staging` runs on push to `main` with `environment: staging`; `apply-production` `needs: apply-staging` and runs with `environment: production`, whose **required reviewers** ([Module 9](../module-09-cd-deployment-strategies/01-cd-concepts-environments.md)'s mechanism, reused verbatim) pause the job until a human approves. Infrastructure promotes exactly like the application: staging proves it, a person blesses it, production receives it. Consistency across the two pipelines is itself a control — nobody needs to remember a second mental model under incident pressure.

## 6. The human's plan-review checklist

Automation gets the plan onto the PR; a human still has to *read* it. The discipline, as a checklist reviewers actually run:

1. **Any `-/+` replacement?** Find the `# forces replacement` line and demand the why. On stateful resources (RDS, ElastiCache, anything with "data" in its job description) this is a full stop until justified.
2. **Any `-` destroy at all?** Expected only in PRs that *say* they remove things.
3. **Security widening:** new `0.0.0.0/0` anywhere, SG rule changes, IAM policy diffs (`+ "Action": "*"` is a career moment), public-access settings.
4. **Cardinality surprises:** a `for_each`/`count` change that shows 6 adds and 6 destroys means the keys changed — that's a replacement wave wearing a rename costume (10.3's `moved` lesson).
5. **`.terraform.lock.hcl` diffs:** a provider version bump is a supply-chain event — deliberate, changelog-read, not drive-by (10.1's pinning doctrine).
6. **The summary line last:** does `X to add, Y to change, Z to destroy` match the PR description's claim? A "docs-only" PR planning 3 changes is lying to someone — possibly its author.

## 7. Drift detection: the tripwire, scheduled

[Lecture 10.2](02-terraforming-tickethub-network-data.md) showed one drift caught by a manual plan. Nobody runs manual plans at 2 a.m. — so schedule it. A nightly workflow plans each environment with `-detailed-exitcode`, whose contract is made for this: **exit 0** = no changes, **1** = error, **2** = changes present, i.e. *reality no longer matches code*. On exit 2, the workflow opens (or updates) a **"Drift detected"** issue with the plan attached — silent divergence becomes a tracked work item with a diff, an assignee, and an age.

Where drift comes from, and the per-drift policy decision it forces: **break-glass console changes** during incidents — Module 9's doctrine already said these are legitimate *if codified afterward*; the drift issue is the codification reminder arriving automatically. Someone widened a timeout at 3 a.m.? Fine — now either **revert** (the change was a mistake or temporary: `terraform apply` restores code's truth) or **adopt** (the change was right: commit HCL matching it, plan goes clean). And **AWS-side changes** — auto minor-version upgrades, default rotations — which are usually "adopt" (pin the new value or loosen the argument). The one wrong answer is the standing dirty plan that trains everyone to ignore drift (10.2's rule: clean plan or a tracked issue, nothing between).

## 8. Guardrails and secrets discipline

**Two destruction guards, different layers, both on.** `lifecycle { prevent_destroy = true }` is **Terraform-level**: any plan containing this resource's destruction *errors at plan time* — the mistake dies in CI, before AWS hears of it. `deletion_protection = true` is **provider/AWS-level**: the API refuses deletion no matter who asks — console, CLI, or a Terraform run where someone removed the lifecycle block. Belt and braces on RDS (10.3's module hardcodes both), plus the state bucket's versioning as the third, last-resort layer: even a catastrophic wrong apply leaves you a state history to recover against, per 10.3's restore drill.

**Secrets in Terraform CI, the rules:** No secret `.tfvars` in the repo — 10.1's `.gitignore` enforces it, and CI needs none: the only credential in the workflow is the OIDC-assumed role, alive for minutes. Secrets that infrastructure *needs* are **created by Terraform, inside AWS**: `random_password` → ElastiCache + SSM SecureString (10.2), `manage_master_user_password` → Secrets Manager (RDS). No human sees them; no workflow env var carries them. The honest asterisk, one last time: generated values rest in **state**, so state access is secret access and is IAM'd accordingly. Forward-looking, honestly labeled: newer Terraform versions add **ephemeral values and write-only arguments** — mechanisms for secrets to flow through a run *without persisting in state or plan*. The right direction, worth reading when you upgrade past this course's pinned 1.9; nothing in our design depends on them, and state-locked-down-as-secret-store is the industry's standard posture today.

## Hands-on with TicketHub

⚠️ **Cost:** $0 beyond existing infrastructure — workflows run on GitHub-hosted runners within the free tier at this volume. The applies they perform manage the environments you already run (staging ~$80/mo; production ~$470/mo if you kept it from 10.3 — its teardown note still applies).

### 1. Prerequisites in AWS and GitHub

In Terraform (it's platform): the `tickethub-infra-ci` role with section 2's trust policy and its permissions policy (broad create/manage, explicit denies on state-bucket deletion and the OIDC provider). In GitHub: `staging` and `production` environments on `tickethub-infra`, production with **required reviewers** — the same two clicks as Module 9, deliberately.

### 2. The workflow, complete

`.github/workflows/terraform.yml` — every piece from sections 3–5, assembled:

```yaml
name: terraform

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  id-token: write        # OIDC token for AWS
  contents: read
  pull-requests: write   # plan comments

env:
  AWS_REGION: ap-southeast-1
  TF_VERSION: "1.9.8"

jobs:
  plan:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        env: [staging, production]
    defaults:
      run:
        working-directory: envs/${{ matrix.env }}
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/tickethub-infra-ci
          aws-region: ${{ env.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${{ env.TF_VERSION }}
          terraform_wrapper: true

      - name: fmt
        run: terraform fmt -check -recursive
        working-directory: .

      - name: init
        run: terraform init -input=false

      - name: validate
        run: terraform validate

      - name: tflint
        uses: terraform-linters/setup-tflint@v4
        with:
          tflint_version: v0.53.0
      - run: tflint --init && tflint --recursive
        working-directory: .

      - name: checkov
        uses: bridgecrewio/checkov-action@v12
        with:
          directory: .
          quiet: true
          framework: terraform

      - name: plan
        id: plan
        run: terraform plan -input=false -no-color -detailed-exitcode -out=tfplan
        continue-on-error: true    # exit 2 = changes, not failure

      - name: fail on plan error
        if: steps.plan.outputs.exitcode == '1'
        run: exit 1

      - name: comment plan on PR
        uses: actions/github-script@v7
        env:
          PLAN: ${{ steps.plan.outputs.stdout }}
        with:
          script: |
            const plan = process.env.PLAN.length > 60000
              ? process.env.PLAN.slice(0, 60000) + "\n... (truncated — see job log)"
              : process.env.PLAN;
            const marker = `<!-- tf-plan-${{ matrix.env }} -->`;
            const body = `${marker}
            #### Terraform plan — \`${{ matrix.env }}\`
            <details><summary>Show plan</summary>

            \`\`\`hcl
            ${plan}
            \`\`\`
            </details>`;
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner, repo: context.repo.repo,
              issue_number: context.issue.number,
            });
            const existing = comments.find(c => c.body.includes(marker));
            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner, repo: context.repo.repo,
                comment_id: existing.id, body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner, repo: context.repo.repo,
                issue_number: context.issue.number, body,
              });
            }

  apply-staging:
    if: github.event_name == 'push'
    runs-on: ubuntu-24.04
    environment: staging
    concurrency:
      group: terraform-apply-staging
      cancel-in-progress: false
    defaults:
      run:
        working-directory: envs/staging
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/tickethub-infra-ci
          aws-region: ${{ env.AWS_REGION }}
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${{ env.TF_VERSION }}
      - run: terraform init -input=false
      - name: plan and apply       # re-plan on main — section 5's trade-off
        run: |
          terraform plan -input=false -out=tfplan
          terraform apply -input=false tfplan

  apply-production:
    if: github.event_name == 'push'
    needs: apply-staging
    runs-on: ubuntu-24.04
    environment: production        # required reviewers gate here
    concurrency:
      group: terraform-apply-production
      cancel-in-progress: false
    defaults:
      run:
        working-directory: envs/production
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/tickethub-infra-ci
          aws-region: ${{ env.AWS_REGION }}
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${{ env.TF_VERSION }}
      - run: terraform init -input=false
      - name: plan and apply
        run: |
          terraform plan -input=false -out=tfplan
          terraform apply -input=false tfplan
```

Walk the seams: the plan job's `sub` claim is `repo:tickethub/tickethub-infra:pull_request` (trusted, read-plan powers used); the apply jobs authenticate under their *environment* claims, which is what lets IAM distinguish them if you later split the role per environment. `continue-on-error` plus the explicit exit-code check keeps `-detailed-exitcode` semantics (2 = changes = fine on a PR) without swallowing real failures. The comment step *updates* its previous comment per environment (the `marker` trick) so a ten-push PR shows two live plan comments, not twenty stale ones. Open a trial PR — bump an instance class — and watch the two plans arrive; then check the branch-protection boxes so `plan (staging)` and `plan (production)` are required checks, exactly as [Module 7](../module-07-ci-github-actions/03-code-quality-gates.md) did for tests.

Merging that PR applies staging immediately, then parks `apply-production` on the approval gate — the same "Review deployments" button Module 9 taught, now guarding infrastructure. After approval: **this is the moment the last dangling thread ties off** — with production real (10.3) and its changes pipeline-gated (now), flip Module 9's disabled production deploy job on. Both pipelines are live.

### 3. Drift detection, nightly

`.github/workflows/drift.yml`:

```yaml
name: drift-detection

on:
  schedule:
    - cron: "0 18 * * *"    # 02:00 SGT nightly
  workflow_dispatch: {}

permissions:
  id-token: write
  contents: read
  issues: write

jobs:
  drift:
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        env: [staging, production]
    defaults:
      run:
        working-directory: envs/${{ matrix.env }}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/tickethub-infra-ci
          aws-region: ap-southeast-1
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.9.8"
      - run: terraform init -input=false
      - name: plan
        id: plan
        run: terraform plan -input=false -no-color -detailed-exitcode
        continue-on-error: true
      - name: fail on plan error
        if: steps.plan.outputs.exitcode == '1'
        run: exit 1
      - name: open or update drift issue
        if: steps.plan.outputs.exitcode == '2'
        uses: actions/github-script@v7
        env:
          PLAN: ${{ steps.plan.outputs.stdout }}
        with:
          script: |
            const title = `Drift detected: ${{ matrix.env }}`;
            const body = `Nightly plan found changes in **${{ matrix.env }}** — reality no longer matches code.

            Decide per change: **revert** (apply restores code) or **adopt** (commit HCL to match).

            <details><summary>Plan</summary>

            \`\`\`hcl
            ${process.env.PLAN.slice(0, 60000)}
            \`\`\`
            </details>`;
            const { data: issues } = await github.rest.issues.listForRepo({
              owner: context.repo.owner, repo: context.repo.repo,
              state: "open", labels: "drift",
            });
            const existing = issues.find(i => i.title === title);
            if (existing) {
              await github.rest.issues.update({
                owner: context.repo.owner, repo: context.repo.repo,
                issue_number: existing.number, body,
              });
            } else {
              await github.rest.issues.create({
                owner: context.repo.owner, repo: context.repo.repo,
                title, body, labels: ["drift"],
              });
            }
```

Rehearse it end to end: make a console change (re-run 10.2 §6's SG edit), trigger the workflow with `workflow_dispatch`, watch the issue appear with the diff, revert via a normal apply, re-run, and confirm the next run finds exit code 0 (close the issue — or extend the script to auto-close on clean, exercise 3).

### 4. The closing architecture: two pipelines, one boundary

What the course's delivery system looks like now — hold both columns in view:

| | `tickethub-api` (Modules 7–9) | `tickethub-infra` (Module 10) |
|---|---|---|
| PR checks | Pest, Pint, Larastan, image build | fmt, validate, tflint, Checkov, **plan ×2** |
| Review artifact | test results + code diff | **the plan** |
| Merge to `main` | build image → deploy ECS staging | re-plan → apply staging |
| Production | tag `v*` + environment approval | environment approval on `apply-production` |
| AWS identity | `tickethub-github-deploy` (ECR/ECS/SSM read) | `tickethub-infra-ci` (infra-wide, repo-scoped trust) |
| Owns | task-def **revisions**, image tags, releases | VPC, RDS, Redis, S3, ALB, ECR, ECS **shells**, IAM, SSM names |

The bottom row is [10.2 §6](02-terraforming-tickethub-network-data.md)'s platform/app boundary, now enforced by *identity* as well as by `ignore_changes`: each pipeline physically lacks the other's permissions. And the bridge forward: when [Module 11](../module-11-kubernetes/03-eks-production.md) brings EKS, the cluster will not be clicked into existence — it arrives as `module "eks"` (the community `terraform-aws-modules/eks` module) in a PR to this repo, planned on the PR, scanned by Checkov, applied through this exact gate, consuming the `/tickethub/<env>/network/*` parameters 10.3 published. The pipeline you built today is the front door every future piece of TicketHub's platform walks through.

## Real-world best practices

- **The plan comment is the review; protect it accordingly.** Both plan jobs are required checks, and culture-wise: reviewing an infra PR without expanding the plan `<details>` should feel like approving code without reading it — because it is that.
- **Separate CI identities per privilege domain, trust-scoped to repo *and* trigger.** `sub`-claim conditions are the cheapest strong control in this lecture: the infra role only `tickethub-infra`'s PRs and environments can assume turns "compromised app CI" from a network incident into a non-event.
- **Scanners block by default; exceptions are inline, reasoned, and reviewed.** A `checkov:skip` with a justification is engineering; `--soft-fail` on the whole job is theater — findings scroll by unread while the badge stays green.
- **Serialize applies; never cancel them.** One concurrency group per environment, `cancel-in-progress: false`. Parallel applies to one state are corruption roulette; cancelled applies are how orphaned locks and half-built infrastructure are born.
- **Drift issues get the incident treatment: triaged within a day, closed by revert or adopt.** An open drift issue is an unreviewed production change wearing a nightly timestamp. Let them age and real drift starts hiding in the noise.
- **Rehearse the gates before you rely on them.** Once, deliberately: a PR that tries to destroy the staging DB (watch `prevent_destroy` kill the plan in CI), and a PR with a public bucket (watch Checkov block it). A guardrail you've never seen fire is a hypothesis, not a control.

## Common pitfalls

1. **Leaving laptop applies possible after CI exists.** The pipeline is "the way," but every laptop still holds admin credentials for emergencies — and under deadline, the emergency path becomes the path, complete with unreviewed applies of unmerged code. Correct approach: humans keep read/plan access; apply rights live with `tickethub-infra-ci` plus a break-glass role whose assumption pages someone and mandates a post-hoc PR — Module 9's doctrine, ported.
2. **Posting the plan but not gating on it.** The comment renders, the checks are optional, and a red `plan (production)` merges anyway because "it's just staging work" — then production's apply fails at 6 p.m. Correct approach: both plan jobs are required status checks; a PR that can't plan cleanly against *both* environments isn't mergeable.
3. **`-auto-approve` on an unplanned apply in CI.** It "simplifies the YAML" — and applies whatever the world plus your branch happens to diff to, reviewed by no one, including during a mid-merge race. Correct approach: plan to a file, then apply that file, even in the re-plan-on-main model; the two-step makes the log show *what was about to happen* before it did.
4. **Scanner rollout as a hundred-finding wall.** Checkov lands on a year-old codebase, fails with 87 findings, and the team's fix is `soft-fail: true` forever — the tool gets blamed, the misconfigurations remain. Correct approach: triage once at adoption (fix the reds that matter, `skip` the contextual ones with reasons), then blocking mode within a week. Our repo enters clean because 10.2/10.3 built to these rules.
5. **Drift "handled" by nightly auto-apply.** Tempting symmetry — detection found changes, apply erases them, no humans needed. But auto-revert erases *break-glass fixes* too: the 3 a.m. SG change keeping the site up gets reverted at 4 a.m. by a robot. Correct approach: detect automatically, *decide* humanly (revert vs adopt), keep the issue as the audit trail. Reconciliation without judgment is only safe when judgment already happened — a distinction that returns with GitOps in Module 11.

## Exercises

1. From memory, reproduce the two-pipeline table's bottom three rows (merge behavior, production gate, AWS identity), then explain in three sentences why `tickethub-infra-ci` and `tickethub-github-deploy` must be different roles even though both are "GitHub Actions OIDC roles in the same account."
2. Add `infracost` (10.2's one-paragraph tool) as a plan-job step that posts estimated monthly cost delta alongside the plan comment. What finding would have made 10.3's production apply less surprising?
3. Extend `drift.yml` to auto-close the drift issue when a nightly run exits 0 (list open `drift`-labeled issues for the environment; close with a comment linking the clean run).
4. Write the deny-statements for `tickethub-infra-ci` discussed in section 2: deny `s3:DeleteBucket` on `tickethub-terraform-state`, deny `dynamodb:DeleteTable` on the lock table, deny `iam:Delete*`/`iam:Update*` on the OIDC provider and on `tickethub-infra-ci` itself. Explain the last one's purpose in one sentence.
5. **Stretch — the full rehearsal:** run both guardrail drills from the best practices (destroy-the-DB PR; public-bucket PR), capturing where each was stopped (plan-time error vs Checkov finding vs human review), then remove `prevent_destroy` in the PR and observe which *other* layers still stand between the mistake and the database. Write up the defense-in-depth chain you observed, layer by layer.

## What's next

Module 10's arc is complete: infrastructure that was console archaeology in Module 8 is now modules, two environments born from the same code, remote state with history, and a PR-driven pipeline where plans are reviewed, policies are enforced, and drift files its own tickets. TicketHub runs exactly as it did a month ago — that was the point — but every future change now travels a reviewed, gated, reversible path. [Module 11](../module-11-kubernetes/01-kubernetes-core-concepts.md) puts that path to work immediately: Kubernetes arrives, and the EKS cluster that will eventually replace ECS enters production the only way anything does now — as a module, in a PR, behind a plan.
