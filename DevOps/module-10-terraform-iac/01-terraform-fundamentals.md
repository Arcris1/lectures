# Lecture 10.1 — Terraform Fundamentals

> **Module 10 — Infrastructure as Code with Terraform** · Lecture 1 of 4 · Estimated time: ~90 min

Think back to [Module 8](../module-08-aws-fundamentals/02-vpc-networking.md). You built `tickethub-staging-vpc` with roughly forty CLI commands, copied the resulting IDs into tables, and carried those tables through three more lectures. That worked — once. This lecture gives infrastructure the thing your application code has had since [Module 4](../module-04-git-collaboration/03-pull-requests-code-review.md): a reviewable, versioned, repeatable definition of what should exist. By the end you will have the `tickethub-infra` repository bootstrapped, remote state living in `tickethub-terraform-state`, and your first Terraform-managed AWS resource — plus the one skill that matters more than any syntax: reading a plan before you apply it.

## Learning objectives

- Argue the case for Infrastructure as Code using TicketHub's own history, not slogans
- Explain the declarative model: desired state, convergence, and why idempotency comes for free
- Describe what Terraform state contains, why it exists, and why it must be treated as a secret
- Read a `terraform plan` line by line and spot a destroy-and-recreate before it ruins your week
- Run the core workflow — `init`, `fmt`, `validate`, `plan -out`, `apply` — and explain what each step guarantees
- Bootstrap `tickethub-infra` with an S3 state backend and DynamoDB locking

## 1. The case for IaC, made from this course's own history

You don't need a hypothetical to motivate Infrastructure as Code — you lived the alternative in Module 8. Consider what you actually have right now:

**The record of your infrastructure is a lecture document.** The only reproducible form of `tickethub-staging-vpc` is the tables in [Lecture 8.2](../module-08-aws-fundamentals/02-vpc-networking.md). If your notes and the console disagree, which is right? You cannot know without clicking through every screen.

**A new environment means doing everything again.** Production does not exist yet — [Module 9](../module-09-cd-deployment-strategies/01-cd-concepts-environments.md)'s production deploy job sits disabled for exactly that reason. Creating it by hand means re-running ~40 networking commands, RDS, ElastiCache, S3, ALB, ECS — different CIDRs, different sizes, three AZs instead of two — and every transcription slip becomes a subtle staging/production difference: [Module 5](../module-05-configuration-twelve-factor/03-environment-parity.md)'s parity problem reborn at the infrastructure layer.

**Drift is invisible.** Someone widens `sg-mysql` "temporarily" during an incident. Nothing records it, nothing reverts it, and eight months later an auditor asks why the database accepts connections from the whole VPC. The answer is a shrug.

**Review is impossible.** Module 4 gave application changes pull requests, reviewers, and history. Module 8's infrastructure got none of that: `aws ec2 authorize-security-group-ingress` takes effect the moment you press Enter, reviewed by nobody, recorded only in CloudTrail's haystack. Opening 3306 to the internet and fixing a typo look identical: both are just commands someone ran.

Infrastructure as Code fixes all four with one move: **the infrastructure's definition becomes text in Git**. Text can be diffed, reviewed, reverted, copied to make production, and compared against reality to detect drift. The rest of this module is the working-out of that one idea.

## 2. Declarative vs imperative: the convergence engine

Module 8's CLI commands were **imperative**: each one is an instruction — *create this subnet*. Run the script twice and you get errors (or duplicates). Interrupt it halfway and you're in a state no script anticipates. The script describes a *journey*, and journeys only make sense from a known starting point.

Terraform is **declarative**: you describe the *destination* — "there is a VPC with CIDR 10.1.0.0/16, containing six subnets…" — and Terraform's job is **convergence**: compare desired state against reality, compute the minimal set of API calls to close the gap, and execute them. Run it against an empty account: it creates everything. Run it again immediately: it does nothing, because reality already matches. Run it after someone hand-deletes a subnet: it recreates just that subnet.

That last property is **idempotency**, and in the declarative model you get it for free. You never write "create if not exists" logic; the diff engine *is* that logic. This should feel familiar: it is exactly the reconciliation idea you'll meet again in Kubernetes controllers (Module 11). Declarative desired state plus a convergence loop is arguably *the* big idea of modern infrastructure — Terraform runs the loop on demand, Kubernetes runs it continuously.

## 3. The tool landscape, honestly

**CloudFormation / CDK.** AWS's native IaC. CloudFormation is declarative JSON/YAML with state stored inside AWS itself (no state file to manage — a real advantage); CDK generates CloudFormation from real programming languages. Strengths: deep AWS integration, automatic rollback. Weaknesses: AWS-only, and stack updates can be opaque when they fail. A respectable choice for an all-in AWS shop.

**Pulumi.** Terraform's model (state file, diff, providers — it can even use Terraform's providers) programmed in general-purpose languages instead of HCL. Loops and abstractions feel natural to developers; the flip side is that infrastructure definitions can accumulate the full complexity of software, and reviewing "what will this create?" gets harder as cleverness grows.

**OpenTofu.** In 2023 HashiCorp relicensed Terraform from the open-source MPL to the source-available BUSL, which restricts building competing commercial products on it (it does not affect normal users like us). Part of the community responded by forking the last MPL version into OpenTofu, now a Linux Foundation project. It is drop-in compatible at the level this course operates — same HCL, same providers, same state format — and has since added its own features. Both are reasonable choices; this course uses **Terraform 1.9 syntax**, which OpenTofu also accepts.

**Ansible is not the same category.** Ansible is *configuration management*: it assumes machines exist and converges what's *on* them — packages, files, services. Terraform is *provisioning*: it makes the machines (and VPCs, and databases) exist. Historically you'd use both; containers ate most of Ansible's app-level territory, because the Dockerfile ([Module 6](../module-06-docker/02-production-dockerfile-laravel.md)) now configures what's inside the compute unit. TicketHub needs no config management at all: Terraform provisions, the image configures.

## 4. HCL core concepts

Terraform code is written in **HCL** (HashiCorp Configuration Language), organized into `.tf` files in a directory — a **root module**. Terraform reads all `.tf` files in the directory as one set; file names are purely for humans.

### Providers

A **provider** is the plugin that translates resource definitions into API calls. You pin it in two places:

```hcl
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "ap-southeast-1"

  default_tags {
    tags = {
      Project   = "tickethub"
      Owner     = "platform"
      ManagedBy = "terraform"
    }
  }
}
```

`~> 5.0` is the **pessimistic constraint**: any `5.x`, never `6.0`. Major provider versions can rename arguments and change behavior — you upgrade them deliberately, not by accident on a colleague's fresh checkout. And notice `default_tags`: [Lecture 8.1](../module-08-aws-fundamentals/01-cloud-concepts-account-setup.md)'s tagging governance, which you dutifully retyped onto every CLI command in Module 8, is now applied to every resource this provider creates, automatically. Governance as configuration.

### Resources, arguments, attributes

```hcl
resource "aws_ecr_repository" "sandbox" {
  name                 = "tickethub-tf-sandbox"
  image_tag_mutability = "IMMUTABLE"
}
```

Every resource has an **address** — `type.name`, here `aws_ecr_repository.sandbox` — unique within the module. The `name` inside the block is Terraform's label, invisible to AWS. **Arguments** are what you set (`name`, `image_tag_mutability`); **attributes** are what AWS reports back after creation (`arn`, `repository_url`, `registry_id`). You reference either as `aws_ecr_repository.sandbox.repository_url` — and every such reference is also an edge in the dependency graph (section 7).

### Data sources

Data sources *read* existing things instead of creating them:

```hcl
data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}
```

Now `data.aws_caller_identity.current.account_id` replaces every hardcoded `111122223333`, and AZ names stop being string literals. Data sources are how config stays portable across accounts and regions.

### Variables, outputs, locals

```hcl
variable "environment" {
  description = "Deployment environment"
  type        = string

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "db_config" {
  description = "RDS sizing"
  type = object({
    instance_class = string
    multi_az       = bool
  })
  default = {
    instance_class = "db.t4g.micro"
    multi_az       = false
  }
}

```

Types go from `string`/`number`/`bool` up through `list`, `map`, and structured `object` types; `validation` blocks fail fast at plan time with your error message instead of an AWS error twenty minutes into an apply. A variable can also be marked `sensitive = true`, which redacts its value from plan output — but, as section 5 will make uncomfortably clear, *not* from state.

Values arrive via `terraform.tfvars` (loaded automatically), `-var-file`, `-var` flags, or `TF_VAR_environment`-style environment variables. Precedence, lowest to highest: variable defaults → `terraform.tfvars` → `*.auto.tfvars` → `-var`/`-var-file` in command-line order. Later wins.

**Outputs** are a module's return values (`output "repo_url" { value = aws_ecr_repository.sandbox.repository_url }`) — they matter enormously once modules arrive in [Lecture 10.3](03-modules-environments-remote-state.md). **Locals** are named expressions for reuse within a module: `locals { name_prefix = "tickethub-${var.environment}" }`, referenced as `local.name_prefix`. Variables are the API; locals are private computation.

## 5. State: the load-bearing concept

Here is the question that reveals whether someone actually understands Terraform: *when you run plan, how does Terraform know which real VPC corresponds to `aws_vpc.main`?* Nothing in AWS says "this is Terraform's, and it maps to that address." The answer is the **state file** — `terraform.tfstate` — and it is the single most important thing to understand about Terraform.

State is a JSON document containing, for every managed resource:

1. **The address → real-ID mapping.** `aws_vpc.main` ⇒ `vpc-0a1b2c3d4e5f67890`. This mapping *is* ownership. Lose the state and Terraform doesn't know your infrastructure exists — it will cheerfully plan to create everything again, alongside the originals.
2. **A full copy of every attribute** as of the last refresh — including sensitive ones. When Terraform creates an RDS instance or a `random_password`, the generated secret is written to state **in plaintext**. `sensitive = true` hides values from *terminal output*, not from the file.
3. **The recorded dependency order**, so destroys can run in reverse-creation order even after you've deleted the config.

Draw the conclusion now, because it drives everything in [Lecture 10.3](03-modules-environments-remote-state.md): **state is a secret**. It never goes in Git (our `.gitignore` enforces this), it lives in an encrypted, versioned, access-controlled bucket, and reading it is equivalent to reading your database password.

Why does state exist at all — couldn't Terraform just query AWS every time? Three reasons: the **mapping** (AWS has no concept of "the resource belonging to `aws_vpc.main`"; tags could lie or be missing), the **dependency graph** (preserved even for deleted config), and **performance** (state is a cache; selective refresh beats enumerating an account through rate-limited APIs).

The **plan/apply contract** follows directly. `terraform plan` *refreshes* state against reality (detecting drift), *diffs* it against your configuration, and emits an **execution plan** — the exact creates, updates, and destroys that would converge reality to config. `terraform apply` executes a plan. Save it to a file (`plan -out=tfplan`) and `apply tfplan` executes **exactly what was reviewed** — if the world changed in between, the apply errors out instead of improvising. That contract makes plan output a genuine review artifact, and it is the foundation of [Lecture 10.4](04-terraform-in-ci-policy.md)'s pipeline.

## 6. Reading a plan, line by line

This is the career-saving skill. Plans use four markers:

| Marker | Meaning | Danger level |
|---|---|---|
| `+` | create | low |
| `~` | update in place | low–medium |
| `-/+` | **destroy, then recreate** | high — data loss possible |
| `-` | destroy | high |

`~` means AWS can change the attribute on the live resource. `-/+` means it cannot: the attribute is immutable, so convergence requires *deleting the resource and making a new one*. Terraform tells you exactly which argument is responsible with a `# forces replacement` comment. Read this plan the way a reviewer must:

```text
Terraform will perform the following actions:

  # aws_db_instance.main must be replaced
-/+ resource "aws_db_instance" "main" {
      ~ address                = "tickethub-staging-mysql.c9akciq32rga.ap-southeast-1.rds.amazonaws.com" -> (known after apply)
      ~ arn                    = "arn:aws:rds:ap-southeast-1:111122223333:db:tickethub-staging-mysql" -> (known after apply)
      ~ identifier             = "tickethub-staging-mysql" -> "tickethub-mysql-staging" # forces replacement
        instance_class         = "db.t4g.micro"
        # (34 unchanged attributes hidden)
    }

Plan: 1 to add, 0 to change, 1 to destroy.
```

Someone "tidied up" a resource name. The plan says, in plain sight: *I will destroy your staging database and create an empty one.* The `Plan:` summary line — `1 to add, 1 to destroy` on a stateful resource — is the smoke alarm; `# forces replacement` is the exact cause. A reviewer who scans only for `+` lines approves this; a reviewer trained on this section rejects it in ten seconds. For a stateless resource (a security group rule, an ECS task definition) replacement is usually harmless; for **anything holding data — RDS, ElastiCache, S3 — `-/+` demands justification** before merge. You will practice this reflex for the rest of the module.

## 7. The dependency graph

Terraform builds a directed graph of resources and walks it in order — creating dependencies first, destroying in reverse, parallelizing anything unrelated. The graph is **implicit**: writing `vpc_id = aws_vpc.main.id` inside a subnet *is* the edge. You almost never declare ordering by hand. The escape hatch, `depends_on`, exists for genuinely invisible dependencies (classically: an IAM role's policy must attach before a service that assumes the role starts) — if you find yourself sprinkling `depends_on` around, you're usually working against a reference structure that would express the order naturally.

## 8. The workflow commands

- **`terraform init`** — run once per directory (and after backend/provider changes): configures the backend and downloads providers into `.terraform/`. It also writes **`.terraform.lock.hcl`**, recording the exact provider versions *and their checksums*. **Commit this file.** It is `composer.lock` for infrastructure ([Module 5](../module-05-configuration-twelve-factor/01-twelve-factor-laravel.md)'s factor II), and because it pins checksums it's also supply-chain protection: a tampered provider binary fails verification instead of executing with your AWS credentials.
- **`terraform fmt`** — canonical formatting. No style debates, ever; CI checks it with `-check`.
- **`terraform validate`** — syntax and internal consistency, no cloud access. Catches typos before they cost a plan.
- **`terraform plan -out=tfplan`** then **`terraform apply tfplan`** — the contract from section 5. A bare `terraform apply` plans and prompts interactively; fine at the laptop, never in automation.
- **`terraform destroy`** — a plan where everything is `-`. Respect it accordingly. `-target=<address>` limits any command to one resource and its dependencies — ⚠️ a break-glass tool for surgery, not a routine, because targeted applies leave the rest of your config unconverged and hide the true diff.

## Hands-on with TicketHub

⚠️ **Cost:** everything in this section is ~$0. The state bucket and lock table bill fractions of a cent monthly; the test ECR repository is free and destroyed at the end. Nothing here touches the running staging stack.

### 1. Bootstrap the repository

Per [TICKETHUB.md](../TICKETHUB.md), infrastructure gets its own repo — the *why* of the split is argued properly in Lecture 10.3; for now, create it:

```bash
$ mkdir tickethub-infra && cd tickethub-infra
$ git init -b main
```

`.gitignore` — three rules, each guarding a secret or a machine artifact:

```gitignore
# Local provider cache and modules — machine-specific, re-created by init
.terraform/

# State files contain every attribute of every resource, INCLUDING SECRETS
*.tfstate
*.tfstate.*

# Variable files that may carry secrets or personal overrides
*.tfvars
!example.tfvars
```

(`.terraform.lock.hcl` is *not* ignored — it gets committed, per section 8.)

### 2. The state backend: the one thing not Terraform-managed, on purpose

Remote state needs a bucket — but Terraform can't store the state for the bucket *in* the bucket before the bucket exists. Every team faces this chicken-and-egg once, and the pragmatic industry answer is: create the backend by hand, exactly once, and never touch it again. Two CLI commands — label them in your head as **the one thing not Terraform-managed, on purpose**:

```bash
$ aws s3api create-bucket --bucket tickethub-terraform-state \
    --region ap-southeast-1 \
    --create-bucket-configuration LocationConstraint=ap-southeast-1
$ aws s3api put-bucket-versioning --bucket tickethub-terraform-state \
    --versioning-configuration Status=Enabled
$ aws s3api put-bucket-encryption --bucket tickethub-terraform-state \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
$ aws s3api put-public-access-block --bucket tickethub-terraform-state \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

$ aws dynamodb create-table --table-name tickethub-terraform-lock \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --query 'TableDescription.TableStatus'
"CREATING"
```

Each flag is doing a job: **versioning ON** means every state write keeps its predecessor — state history is your undo button after a corruption or a bad migration; **SSE** because state holds secrets; **block public access** for the same reason, non-negotiably; **PAY_PER_REQUEST** because the lock table sees a handful of reads per day and a provisioned table would be paying for idleness. The `LockID` string key is the schema Terraform's S3 backend expects for locking.

### 3. First resources, local state — the learning progression

Start with local state deliberately: watching `terraform.tfstate` appear on disk teaches more than any diagram. In `sandbox/`, create `main.tf` with the `terraform`, `provider` blocks from section 4 (with `Env = "staging"` added to `default_tags`), plus a test repository and its lifecycle policy:

```hcl
resource "aws_ecr_repository" "sandbox" {
  name                 = "tickethub-tf-sandbox"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "sandbox" {
  repository = aws_ecr_repository.sandbox.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
```

This is [Lecture 6.4](../module-06-docker/04-registries-image-lifecycle.md)'s ECR configuration — the repo, immutable tags, scan-on-push, keep-last-10 — expressed as fifteen lines instead of three CLI commands and a JSON file. Initialize and plan:

```text
$ terraform init

Initializing the backend...
Initializing provider plugins...
- Finding hashicorp/aws versions matching "~> 5.0"...
- Installing hashicorp/aws v5.82.2...
- Installed hashicorp/aws v5.82.2 (signed by HashiCorp)

Terraform has created a lock file .terraform.lock.hcl to record the provider
selections it made above. Include this file in your version control repository [...]

Terraform has been successfully initialized!

$ terraform plan -out=tfplan

Terraform will perform the following actions:

  # aws_ecr_repository.sandbox will be created
  + resource "aws_ecr_repository" "sandbox" {
      + arn                  = (known after apply)
      + image_tag_mutability = "IMMUTABLE"
      + name                 = "tickethub-tf-sandbox"
      + repository_url       = (known after apply)
      + tags_all             = {
          + "Env"       = "staging"
          + "ManagedBy" = "terraform"
          + "Owner"     = "platform"
          + "Project"   = "tickethub"
        }
    }

  # aws_ecr_lifecycle_policy.sandbox will be created
  + resource "aws_ecr_lifecycle_policy" "sandbox" {
      + policy     = jsonencode({ ... })
      + repository = "tickethub-tf-sandbox"
    }

Plan: 2 to add, 0 to change, 0 to destroy.

$ terraform apply tfplan
aws_ecr_repository.sandbox: Creating...
aws_ecr_repository.sandbox: Creation complete after 1s [id=tickethub-tf-sandbox]
aws_ecr_lifecycle_policy.sandbox: Creating...
aws_ecr_lifecycle_policy.sandbox: Creation complete after 0s [id=tickethub-tf-sandbox]

Apply complete! Resources: 2 added, 0 changed, 0 destroyed.
```

Note the graph at work: the lifecycle policy references `aws_ecr_repository.sandbox.name`, so it waited. `(known after apply)` marks attributes that don't exist until AWS assigns them. Now open `terraform.tfstate` — there's the address→ID mapping and every attribute, in JSON, exactly as section 5 promised. Convergence check: run `terraform plan` again — `No changes. Your infrastructure matches the configuration.` Idempotency, demonstrated.

Change something — add `CostCenter = "labs"` to the repository's `tags` — and re-plan:

```text
  # aws_ecr_repository.sandbox will be updated in-place
  ~ resource "aws_ecr_repository" "sandbox" {
      ~ tags     = {
          + "CostCenter" = "labs"
        }
        name     = "tickethub-tf-sandbox"
        # (5 unchanged attributes hidden)
    }

Plan: 0 to add, 1 to change, 0 to destroy.
```

A `~` update in place — tags are mutable, nothing gets destroyed. Apply it.

### 4. Migrate to the S3 backend

Local state on a laptop fails every requirement from section 5: not shared, not locked, not backed up, sitting unencrypted next to your code. Add the backend block inside `terraform {}`:

```hcl
terraform {
  required_version = ">= 1.9.0"

  backend "s3" {
    bucket         = "tickethub-terraform-state"
    key            = "sandbox/terraform.tfstate"
    region         = "ap-southeast-1"
    dynamodb_table = "tickethub-terraform-lock"
    encrypt        = true
  }
  # required_providers unchanged
}
```

Backend changes require re-initialization, and Terraform offers to carry your existing state across:

```text
$ terraform init -migrate-state

Initializing the backend...
Terraform detected that the backend type changed from "local" to "s3".

Do you want to copy existing state to the new backend?
  Pre-existing state was found while migrating the previous "local" backend to the
  newly configured "s3" backend. An existing non-empty state already exists in
  the new backend. [...] Enter "yes" to copy and "no" to start with an empty state.

  Enter a value: yes

Successfully configured the backend "s3"! Terraform will automatically
use this backend unless the backend configuration changes.
```

Verify: `aws s3 ls s3://tickethub-terraform-state/sandbox/` shows the state object; `terraform plan` still says `No changes`; and during any plan/apply, a lock item appears in `tickethub-terraform-lock` so two operators can't apply concurrently. Delete the leftover local `terraform.tfstate` and `terraform.tfstate.backup` — the bucket is the single source of truth now.

### 5. Destroy the sandbox

The sandbox did its job. Watch the `-` markers do theirs:

```text
$ terraform destroy
  # aws_ecr_lifecycle_policy.sandbox will be destroyed
  # aws_ecr_repository.sandbox will be destroyed

Plan: 0 to add, 0 to change, 2 to destroy.

  Enter a value: yes

Destroy complete! Resources: 2 destroyed.
```

Destruction ran in reverse-dependency order — policy first, repository second — courtesy of the graph recorded in state. Commit the repo (`main.tf`, `.gitignore`, `.terraform.lock.hcl`). The real staging ECR repositories (`tickethub-api`, `tickethub-nginx`) are still untouched and still serving Module 9's pipeline; they get *adopted* — not recreated — in [Lecture 10.2](02-terraforming-tickethub-network-data.md).

## Real-world best practices

- **Treat plan output as the deliverable of review, not a formality.** The HCL diff shows intent; the plan shows consequence. Teams that merge on HCL review alone eventually approve an innocent-looking rename that is secretly a database replacement. The `# forces replacement` grep is the cheapest insurance in this industry.
- **Commit `.terraform.lock.hcl`; never commit `*.tfstate` or secret `tfvars`.** The lockfile makes every machine and CI runner resolve identical, checksum-verified providers (reproducibility *and* supply chain). State is a secrets file that happens to contain infrastructure metadata — versioned bucket, encrypted, and treated in IAM like the database password it contains.
- **Pin with `~>`, upgrade deliberately.** Unpinned providers turn a colleague's `terraform init` into a surprise major upgrade, and provider majors change real behavior. The lockfile pins the exact patch until someone consciously runs `terraform init -upgrade` — in a PR, where the lockfile diff is visible.
- **`default_tags` is governance you can't forget.** Module 8 asked you to remember four tags on every command; humans forget, providers don't. Cost allocation, ownership lookup during incidents, and "can I delete this?" all depend on tags existing *everywhere* — automate them at the provider.
- **One backend, hand-made, boring.** The state bucket and lock table are the only infrastructure that should predate Terraform. Resist Terraforming them later "for completeness" — self-referential state management adds risk and zero value. Document the two commands in the repo README and move on.
- **Keep `-target` and manual state edits out of routine work.** Both exist for incidents. If your normal workflow needs them, your configuration structure is wrong — fix the structure (Lecture 10.3 gives you the tools).

## Common pitfalls

1. **Committing `terraform.tfstate` to Git.** It feels natural — it's a file in the project. But state holds every secret attribute in plaintext, and Git history is forever: rotating the leaked credentials becomes mandatory, scrubbing history is painful. Correct approach: the hands-on `.gitignore` *before* the first apply, and remote state from day one of real work.
2. **Scanning plans for `+` and missing `-/+`.** People read plans like changelogs ("what's new?") instead of risk reports — a habit formed in tutorials where everything is a create. Correct approach: read the `Plan:` summary line *first* — any non-zero destroy count on a supposedly additive plan is a full stop; then find every `forces replacement` and justify each one.
3. **Losing or corrupting local state.** A laptop dies, a `terraform.tfstate` gets deleted as clutter, and Terraform now plans to recreate infrastructure that already exists (`Error: ... already exists` on every apply). Local state *works fine* right up until it doesn't. Correct approach: local state only for throwaway sandboxes; anything shared or long-lived goes to S3 with versioning before the second resource exists.
4. **Running bare `terraform apply -auto-approve` in scripts and CI.** Added "to make it work", it applies whatever the world looks like at that second, reviewed by no one. Correct approach: `plan -out=tfplan` → review → `apply tfplan`. The saved plan is the contract; Lecture 10.4 builds the whole pipeline on it.
5. **Fighting the dependency graph with `depends_on` everywhere.** When ordering looks wrong, the reflex is to add explicit dependencies until it works — producing brittle, over-serialized configs whose real disease is a hardcoded value where a reference should be. Correct approach: pass attributes (`aws_vpc.main.id`), not copied strings; the graph then orders itself, and `depends_on` stays rare enough to be a code smell.

## Exercises

1. From memory, list what a state file contains and the three reasons Terraform needs one. Then explain in two sentences why `sensitive = true` does not make state safe to commit.
2. Write a `variable "instance_config"` block with an `object` type holding `class` (string) and `count` (number), a sensible default, and a validation that rejects `count` outside 1–10. Prove the validation fires with `terraform plan -var 'instance_config={class="t3.micro",count=99}'`.
3. Re-create the sandbox ECR repository, then change `image_tag_mutability` from `"IMMUTABLE"` to `"MUTABLE"` and plan. Is it `~` or `-/+`? Now change `name` instead. Explain the difference using the words *argument*, *attribute*, and *forces replacement*. Destroy when done.
4. Simulate state loss: with the sandbox applied (local state), delete `terraform.tfstate`, run `terraform plan`, and interpret the output. Recover *without* recreating the resource by writing an `import` block (`import { to = aws_ecr_repository.sandbox, id = "tickethub-tf-sandbox" }`) and re-planning — a preview of Lecture 10.2's core move. Destroy when done.
5. **Stretch:** read the S3 backend's locking flow, then demonstrate it: run `terraform apply` in one terminal, pause at the confirmation prompt, and run `terraform plan` in another. Capture the `Error acquiring the state lock` message and identify the `LockID`, who holds it, and the operation. Explain why `-lock=false` (which "fixes" it) is almost always the wrong response — you'll meet the right one in Lecture 10.3.

## What's next

You can now describe infrastructure declaratively, and you understand the state file that makes Terraform work — plus the plan-reading discipline that makes it safe. But your Terraform manages one empty sandbox while the *real* staging stack — VPC, RDS, Redis, S3, the lot — still exists only as console history from Module 8. [Lecture 10.2 — Terraforming TicketHub: Network & Data Layer](02-terraforming-tickethub-network-data.md) writes the HCL for all of it and then performs the trick that makes brownfield IaC adoption possible: importing live resources into state without recreating — or even touching — them.
