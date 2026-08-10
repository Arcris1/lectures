# Lecture 10.3 — Modules, Environments & Remote State

> **Module 10 — Infrastructure as Code with Terraform** · Lecture 3 of 4 · Estimated time: ~110 min

[Lecture 10.2](02-terraforming-tickethub-network-data.md) ended with staging fully adopted — as a flat directory with `10.1.0.0/16` and `db.t4g.micro` written into it as literals. Today the pressure that has been building since Module 8 finally releases: **production must exist**, and it must be staging's shape at production's scale. You'll extract reusable modules, refactor staging onto them *without changing a single resource* (the `moved` block is the professional's tool for exactly this), and then apply `envs/production` for real — the narrative payoff of the whole course so far: staging was clicked together in Module 8; production is born from code. Along the way you'll learn the remote-state operations that make multi-environment, multi-person Terraform safe.

## Learning objectives

- Explain why copy-pasting environment directories recreates config drift in HCL, and how modules prevent it
- Design right-sized module boundaries with opinionated defaults, escape hatches, and no environment literals
- Refactor live infrastructure onto modules using `moved` blocks, proving zero changes with the plan
- Create production from code: same modules, different values, applied for real
- Operate remote state confidently: locking conflicts, `force-unlock` discipline, versioned-bucket recovery, and sanctioned state surgery
- Share data between stacks via SSM parameters (and know when `terraform_remote_state` is the tighter-coupled alternative)

## 1. The force driving abstraction

The obvious way to make production is `cp -r envs/staging envs/production`, then edit: CIDR, sizes, AZ count. It works — today. The failure arrives on change number two: you fix the RDS backup window in staging, forget production, and the environments quietly diverge. Every improvement now must land twice, and nothing checks that it did. This is precisely [Module 5](../module-05-configuration-twelve-factor/03-environment-parity.md)'s config-drift disease, reborn inside the tool that was supposed to cure it — same code-shaped files, same "I'll sync them later," same eventual 3 a.m. discovery that production's SG chain missed a fix from March.

The cure is the same one application code found decades ago: **shared logic extracted once, differences expressed as parameters**. In Terraform, that's a module. Staging and production become ~60-line files that *call* the same modules with different values; a fix to a module lands everywhere on the next plan, and the diff proves it.

## 2. Modules, precisely

A Terraform module is just **a directory of `.tf` files** with three faces:

- **`variables.tf` — the API.** What callers may (and must) configure.
- **Resources — the implementation.** The opinions and wiring, hidden from callers.
- **`outputs.tf` — the return values.** The *only* things a caller can read; internal resources are invisible outside.

You've been inside modules all along — every `envs/staging` directory is the **root module**. A child module is instantiated with a `module` block:

```hcl
module "database" {
  source = "../../modules/database"   # where the code lives

  environment    = "staging"          # arguments = the module's variables
  instance_class = "db.t4g.micro"
}
```

Callers reference returns as `module.database.endpoint`, and resources inside get addresses like `module.database.aws_db_instance.main` — remember that shape; it's the target of today's refactor. `source` accepts local paths (what we use — the module lives in this repo), Git URLs, and registry addresses; section 8 covers when each makes sense.

## 3. Designing TicketHub's module boundaries

Per [TICKETHUB.md](../TICKETHUB.md), the repo's final layout:

```text
tickethub-infra/
├── modules/
│   ├── network/       # VPC, subnets, routing, NAT, endpoints, the SG chain
│   ├── database/      # RDS instance + subnet group + parameter group
│   ├── cache/         # ElastiCache + subnet group + parameter group + auth token → SSM
│   └── ecs-service/   # one Fargate service shell: service, task role wiring, target group
└── envs/
    ├── staging/
    └── production/
```

The boundaries teach the design principles better than any abstract rule:

**Right-sized: one module per logical capability.** `modules/database` wraps the RDS instance *and* its subnet group *and* its parameter group, because no caller ever wants one without the others — that trio is "a TicketHub database." What you don't build: a module wrapping a single resource (`modules/s3-bucket` that adds nothing over `aws_s3_bucket` is indirection tax with no opinion inside), or a god-module (`modules/tickethub-everything`) whose forty variables make every change a cross-environment gamble. If a module's variables read like the underlying resource's arguments renamed, it's too small; if you can't state its purpose in one sentence, it's too big. Corollary: not everything earns a module — staging's uploads-bucket resources stay as plain env files until a third use or real drift risk appears.

**Opinionated defaults with escape hatches.** Decisions that should never vary by environment are *not variables*: `storage_encrypted = true`, `publicly_accessible = false`, the `noeviction` Redis policy, TLS on ElastiCache — hardcoded, so no caller can quietly weaken them; weakening requires editing the module, in a PR everyone sees. Decisions that legitimately vary *are* variables with safe defaults: `instance_class`, `multi_az`, `az_count`. The module encodes policy; the variables encode scale.

**Environment-agnostic.** No `"staging"` literal anywhere inside a module. Names derive from inputs — `"${var.project}-${var.environment}-mysql"` — so the same code produces `tickethub-staging-mysql` and `tickethub-prod-mysql`. A module that mentions an environment by name has failed at its one job.

## 4. The refactor: `moved` blocks, or how professionals rename things

Here's the trap. Move the RDS resource into `modules/database` and plan: Terraform sees `aws_db_instance.main` *gone* (destroy!) and `module.database.aws_db_instance.main` *new* (create!). Same resource, new address — but state maps addresses to real IDs, and to the diff engine a vanished address is a vanished desire. The amateur move is to shrug and let it destroy/recreate ("it's just staging"). The professional move is to tell Terraform the truth — this resource didn't change, it *moved*:

```hcl
moved {
  from = aws_db_instance.main
  to   = module.database.aws_db_instance.main
}
```

`moved` blocks are declarative state surgery: plannable, reviewable, committed with the refactor, deletable once every workspace that might hold the old address has applied. The extraction workflow is mechanical: (1) move the resource code into the module, parameterize literals; (2) write one `moved` block per relocated resource; (3) plan — it must show **only moves, zero changes**; (4) apply — state addresses are rewritten, AWS untouched. You'll see the transcript in the hands-on. This is also the answer whenever you rename a resource or re-key a `for_each` — any time an address changes but reality shouldn't.

## 5. Environment isolation: separate state, and why not workspaces

Production and staging must not share a state file. The backend `key` is the isolation mechanism:

```text
tickethub-terraform-state/
└── envs/
    ├── staging/terraform.tfstate
    └── production/terraform.tfstate
```

Each `envs/<env>` directory carries its own `backend "s3"` block pointing at its own key. The point is **blast radius**: a botched apply, a bad state migration, a fat-fingered `state rm` in staging *physically cannot* touch production's state — different object, different lock. Terraform operations in one environment don't even hold a lock on the other, so a long production apply never blocks staging work. The enterprise-grade version of the same idea is **separate AWS accounts per environment** (separate credentials, separate billing, IAM boundaries by construction) — one sentence of awareness now; the single-account, separate-state layout is honest for a team of TicketHub's size.

**Workspaces, presented fairly.** `terraform workspace` gives one configuration multiple named state files — `select staging` swaps which one you're operating on. They're genuinely right for **ephemeral copies of identical infrastructure**: spin up `review-pr-421`, test, destroy — same shape, short life, no divergence. They're wrong for long-lived environments, and the community consensus here is unusually solid, for two reasons. First, environments *diverge in shape*, not just size — production has three NATs, different alerting, soon different EKS wiring — and workspaces force that into `count = terraform.workspace == "production" ? 3 : 1` conditionals that metastasize. Second, the selected workspace is invisible mode-state: the same `terraform apply` in the same directory hits staging or production depending on what someone selected last Tuesday — exactly the foot-gun directories make impossible. Directories per environment; workspaces for ephemera.

## 6. Remote state operations: locks, time machines, and sanctioned surgery

**Locking, observed.** Every state-touching operation acquires the DynamoDB lock first. When a colleague is mid-apply, you see:

```text
Error: Error acquiring the state lock

Error message: ConditionalCheckFailedException: The conditional request failed
Lock Info:
  ID:        3f2a9c1d-7e8b-4a5f-b0c6-d1e2f3a4b5c6
  Path:      tickethub-terraform-state/envs/staging/terraform.tfstate
  Operation: OperationTypeApply
  Who:       alice@alice-mbp
  Created:   2026-08-09 07:41:12 UTC
```

This is not an error to defeat; it's the system working — *Alice is applying; wait*. The lock clears when her operation ends. `terraform force-unlock 3f2a9c1d-…` exists for one case only: an **orphaned** lock, left by a process that died (laptop battery, killed CI runner). The check-first ritual before ever running it: read `Who` and `Created`, contact that human, confirm the process is truly dead — *then* unlock. Force-unlocking a live apply lets two writers corrupt one state file, which is the disaster locking exists to prevent. (`-lock=false` is the same sin with less ceremony.)

**The bucket's versioning is your time machine.** Because [Lecture 10.1](01-terraform-fundamentals.md) enabled versioning on `tickethub-terraform-state`, every state write preserves its predecessor. Recovery sketch — corrupt or wrongly-migrated state:

```bash
$ aws s3api list-object-versions --bucket tickethub-terraform-state \
    --prefix envs/staging/terraform.tfstate \
    --query 'Versions[].{Id:VersionId,When:LastModified,Latest:IsLatest}'
# identify the last-known-good VersionId, then restore it as the current version:
$ aws s3api copy-object --bucket tickethub-terraform-state \
    --key envs/staging/terraform.tfstate \
    --copy-source "tickethub-terraform-state/envs/staging/terraform.tfstate?versionId=3sL4kqQ..."
```

Then `terraform plan` and read the result carefully — reality may have moved since that version.

**Never hand-edit state.** The JSON tempts you; resist. Serial numbers, lineage IDs, and dependency records make hand edits corrupting even when they look right. Every legitimate state problem has a sanctioned tool: **`terraform state mv`** for one-off address moves (`moved` blocks are the reviewable, preferred form), **`terraform state rm`** to forget a resource *without destroying it* (handing it to another stack or back to manual management), and **`import`** to adopt (10.2). Surgery, with instruments, never with a text editor.

## 7. Sharing data between stacks: remote state vs SSM

Module 11's EKS cluster — a separate stack — will need staging's VPC ID, private subnets, and SG IDs. Two patterns:

**`terraform_remote_state`** reads another stack's outputs straight from its state file:

```hcl
data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = "tickethub-terraform-state"
    key    = "envs/staging/terraform.tfstate"
    region = "ap-southeast-1"
  }
}
# → data.terraform_remote_state.network.outputs.vpc_id
```

Direct, no extra infrastructure — but the consumer needs *read access to the entire state file* (which, per 10.1, contains secrets), and it couples the consumer to your backend layout and Terraform itself.

**SSM parameters as the published interface** — the looser-coupled platform-team pattern: the owning stack *publishes* selected outputs to well-known parameter names; consumers read parameters, never state:

```hcl
# In envs/<env> — the network's public interface
resource "aws_ssm_parameter" "network" {
  for_each = {
    vpc-id                  = module.network.vpc_id
    private-app-subnet-ids  = join(",", module.network.private_app_subnet_ids)
    private-data-subnet-ids = join(",", module.network.private_data_subnet_ids)
    app-security-group-id   = module.network.app_security_group_id
  }

  name  = "/tickethub/${var.environment}/network/${each.key}"
  type  = "String"
  value = each.value
}
```

A consumer needs only `data "aws_ssm_parameter" "vpc_id" { name = "/tickethub/staging/network/vpc-id" }` — and IAM can grant exactly that path, nothing more. Any tool can read it (a script, an app, the console), the interface is explicit (you published four values, not "whatever's in state"), and the producer can refactor freely behind stable names. We set this up today, in both environments, because **Module 11's EKS stack will consume these exact parameters.** Rule of thumb: `terraform_remote_state` inside one team's tightly-coupled stacks; published parameters at any boundary between owners, tools, or trust levels.

## 8. Module versioning and the repo question

With local `source = "../../modules/database"`, envs and modules always move together — one PR, one review, atomic. That's the right call at TicketHub's scale (**monorepo modules are fine**; resist premature ceremony). When modules gain consumers outside this repo, `source` grows a pin: `git::https://github.com/tickethub/tickethub-infra.git//modules/database?ref=v1.2.0` — a Git tag per module release, so consumers upgrade deliberately (the `~>` philosophy, applied to your own code). Terraform registries (public or private) add discovery and constraint syntax on top; file under "when the platform team serves many teams."

Why is `tickethub-infra` a separate repo from `tickethub-api` at all? Different **cadence** (weekly vs daily), different **reviewers** (platform vs feature teams), different **pipeline** (plan-gated PRs, [Lecture 10.4](04-terraform-in-ci-policy.md)), different **blast radius** (an app CI bug can't touch VPC credentials). The honest counterpoint: a monorepo keeps app + infra changes atomic, and small teams thrive with it — the split is a scaling decision, made at Module 10 because this is where infra review stopped resembling app review.

## Hands-on with TicketHub

⚠️ **Cost:** the staging refactor is $0 (state-only). **Applying production is real money — ~$470/month while it runs** (table below). The apply is the point of the module; the teardown note tells you how to stop the meter the same day if cost matters. Per course policy: never leave lab infrastructure running overnight *unless you know why it's running*.

### 1. `modules/database`, in full

`modules/database/variables.tf` — the API, with types, descriptions, validation:

```hcl
variable "project" {
  description = "Project slug used in resource names"
  type        = string
  default     = "tickethub"
}

variable "environment" {
  description = "Environment name slug used in resource names (staging, prod)"
  type        = string
}

variable "subnet_ids" {
  description = "Private data-tier subnet IDs for the DB subnet group"
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "RDS subnet groups require subnets in at least two AZs."
  }
}

variable "security_group_id" {
  description = "Security group to attach (the mysql SG from the network module)"
  type        = string
}

variable "instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"

  validation {
    condition     = startswith(var.instance_class, "db.")
    error_message = "instance_class must be an RDS class, e.g. db.t4g.micro."
  }
}

variable "multi_az" {
  description = "Synchronous standby in a second AZ (production: true)"
  type        = bool
  default     = false
}

variable "engine_version" {
  description = "Exact MySQL engine version"
  type        = string
  default     = "8.0.42"
}

variable "allocated_storage" {
  description = "Storage in GB (gp3)"
  type        = number
  default     = 20
}

variable "backup_retention_days" {
  description = "PITR window in days"
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 7
    error_message = "TicketHub policy: at least 7 days of point-in-time recovery."
  }
}
```

`modules/database/main.tf` — the implementation. Note what is *not* a variable: encryption, public access, deletion protection, the final snapshot. Those are policy:

```hcl
locals {
  name = "${var.project}-${var.environment}"
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db-subnets"
  subnet_ids = var.subnet_ids
}

resource "aws_db_parameter_group" "mysql80" {
  name   = "${local.name}-mysql80"
  family = "mysql8.0"

  parameter {
    name  = "character_set_server"
    value = "utf8mb4"
  }
  parameter {
    name  = "collation_server"
    value = "utf8mb4_unicode_ci"
  }
  parameter {
    name  = "slow_query_log"
    value = "1"
  }
  parameter {
    name  = "long_query_time"
    value = "1"
  }
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name}-mysql"
  engine         = "mysql"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true                      # policy, not preference

  db_name                     = var.project
  username                    = "admin"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false                # policy
  multi_az               = var.multi_az
  parameter_group_name   = aws_db_parameter_group.mysql80.name

  backup_retention_period         = var.backup_retention_days
  backup_window                   = "19:00-20:00"
  maintenance_window              = "sun:20:30-sun:21:30"
  enabled_cloudwatch_logs_exports = ["error", "slowquery"]

  deletion_protection       = true              # policy
  skip_final_snapshot       = false             # policy
  final_snapshot_identifier = "${local.name}-mysql-final"

  lifecycle {
    prevent_destroy = true                      # Terraform-level guard; 10.4 §8
  }
}
```

`modules/database/outputs.tf`:

```hcl
output "endpoint" {
  description = "host:port of the instance"
  value       = aws_db_instance.main.endpoint
}

output "address" {
  description = "Hostname only"
  value       = aws_db_instance.main.address
}

output "master_user_secret_arn" {
  description = "Secrets Manager ARN of the managed master password"
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}
```

### 2. `modules/network` and `modules/cache`: the contracts

The network module's *internals* are Lecture 10.2's `vpc.tf` + `security-groups.tf`, generalized (the subnet map computed from `az_count`, netnum = `tier_index * az_count + az_index` — same arithmetic, now parameterized). What matters here is its **signature**:

```hcl
# modules/network/variables.tf (contract)
variable "environment" { type = string }
variable "vpc_cidr" { type = string }

variable "az_count" {
  type    = number
  default = 2
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  type    = bool
  default = true    # staging's cost policy; production overrides — 8.2's promise kept
}
```

Its outputs (the contract's other half): `vpc_id`, the three subnet-ID lists (`public_subnet_ids`, `private_app_subnet_ids`, `private_data_subnet_ids`), and the four SG IDs (`alb_`/`app_`/`mysql_`/`redis_security_group_id`).

`modules/cache` wraps 10.2's `cache.tf` the same way `database` wraps `rds.tf`: variables `node_type` and `num_nodes` (with `automatic_failover_enabled = var.num_nodes > 1` computed, not asked); TLS, AUTH, and `noeviction` hardcoded as policy; outputs `primary_endpoint` and `auth_token_ssm_parameter`. `modules/ecs-service` generalizes 10.2 §6's service shell (cluster, task-def family, target group wiring, the `ignore_changes` boundary) — its instantiation appears below; writing its internals is exercise 4.

### 3. Refactor staging onto the modules — zero changes

Rewrite `envs/staging/main.tf` as module calls — the payoff is that it now fits on a screen:

```hcl
module "network" {
  source = "../../modules/network"

  environment        = var.environment      # "staging"
  vpc_cidr           = "10.1.0.0/16"
  az_count           = 2
  single_nat_gateway = true
}

module "database" {
  source = "../../modules/database"

  environment       = var.environment
  subnet_ids        = module.network.private_data_subnet_ids
  security_group_id = module.network.mysql_security_group_id
  instance_class    = "db.t4g.micro"
  multi_az          = false
}

module "cache" {
  source = "../../modules/cache"

  environment       = var.environment
  subnet_ids        = module.network.private_data_subnet_ids
  security_group_id = module.network.redis_security_group_id
  node_type         = "cache.t4g.micro"
  num_nodes         = 1
}
```

(The uploads bucket and ECS/ALB files stay flat env files for now, per section 3's right-sizing note.) Then the `moved` blocks, one per relocated resource, in `envs/staging/moved.tf`:

```hcl
moved {
  from = aws_vpc.main
  to   = module.network.aws_vpc.main
}

moved {
  from = aws_subnet.main
  to   = module.network.aws_subnet.main     # covers every for_each instance
}

moved {
  from = aws_db_instance.main
  to   = module.database.aws_db_instance.main
}

moved {
  from = aws_db_subnet_group.main
  to   = module.database.aws_db_subnet_group.main
}
# ... one per resource: routes, SGs, rules, parameter groups, ElastiCache, SSM
```

The moment of truth:

```text
$ terraform plan

Terraform will perform the following actions:

  # aws_db_instance.main has moved to module.database.aws_db_instance.main
    resource "aws_db_instance" "main" {
        identifier = "tickethub-staging-mysql"
        # (52 unchanged attributes hidden)
    }

  # aws_subnet.main["app-a"] has moved to module.network.aws_subnet.main["app-a"]
  ...

Plan: 0 to add, 0 to change, 0 to destroy.
```

Read that summary line again: **`0 to add, 0 to change, 0 to destroy`** — a pure re-labeling. If it shows anything else, a module parameterization subtly changed a value (a name, a tag) — stop and reconcile; the plan just saved you. Apply rewrites the state addresses; AWS never hears about it. *That* is the difference between the professional refactor and the amateur destroy/recreate — same end state in Git, one of them with 45 minutes of staging downtime and a restored database. Once applied everywhere, `moved.tf` can be deleted.

### 4. Production, born from code

`envs/production/main.tf` — the same modules, production's values. This file *is* the environment diff, readable in one glance:

```hcl
module "network" {
  source = "../../modules/network"

  environment        = var.environment      # "prod" — the name slug per TICKETHUB.md
  vpc_cidr           = "10.0.0.0/16"
  az_count           = 3
  single_nat_gateway = false                # one NAT per AZ — 8.2's availability policy
}

module "database" {
  source = "../../modules/database"

  environment       = var.environment
  subnet_ids        = module.network.private_data_subnet_ids
  security_group_id = module.network.mysql_security_group_id
  instance_class    = "db.m7g.large"
  multi_az          = true
}

module "cache" {
  source = "../../modules/cache"

  environment       = var.environment
  subnet_ids        = module.network.private_data_subnet_ids
  security_group_id = module.network.redis_security_group_id
  node_type         = "cache.t4g.small"
  num_nodes         = 2                     # primary + replica, automatic failover
}

module "api_service" {
  source = "../../modules/ecs-service"

  environment    = var.environment
  service_name   = "tickethub-api"
  cluster_name   = "tickethub-prod"
  subnet_ids     = module.network.private_app_subnet_ids
  security_group = module.network.app_security_group_id
  # + horizon and scheduler instantiations; ALB/uploads-bucket files mirror staging's
}
```

`envs/production/versions.tf` is staging's with one change: `key = "envs/production/terraform.tfstate"` — its own state, its own blast radius (section 5). Then:

```text
$ cd envs/production && terraform init && terraform plan -out=tfplan
...
Plan: 74 to add, 0 to change, 0 to destroy.

$ terraform apply tfplan
module.network.aws_vpc.main: Creating...
module.network.aws_vpc.main: Creation complete after 2s [id=vpc-0prod1234abcd5678]
...
module.database.aws_db_instance.main: Still creating... [12m30s elapsed]
module.database.aws_db_instance.main: Creation complete after 14m02s [id=tickethub-prod-mysql]

Apply complete! Resources: 74 added, 0 changed, 0 destroyed.

Outputs:
  db_endpoint = "tickethub-prod-mysql.c9akciq32rga.ap-southeast-1.rds.amazonaws.com:3306"
```

Sit with what just happened: the environment Module 8 spent three lectures clicking together now materialized from one command, correct by construction, with three AZs and Multi-AZ everywhere — differences you can *read* in a 60-line file. This also unblocks the last dangling thread of [Module 9](../module-09-cd-deployment-strategies/03-ecs-fargate-pipeline.md): the disabled production deploy job finally has a production to deploy to (flip it on after 10.4 wires infra CI, so both pipelines go live reviewed).

⚠️ **Production cost, honestly:**

| Resource | ~Monthly |
|---|---|
| 3 × NAT gateway + EIPs | ~$140 |
| RDS `db.m7g.large` Multi-AZ + 20 GB gp3 | ~$260 |
| ElastiCache 2 × `cache.t4g.small` | ~$52 |
| ALB | ~$20 |
| Fargate tasks (api + horizon + scheduler, small) | ~$30+ |
| **Total** | **~$470–500/mo (≈ $0.65/hr)** |

**Teardown note:** if you're cost-sensitive, destroy production after finishing this module and re-create it when Module 11 needs it — *the entire point is that it comes back with one command*. Destroying requires consciously disarming the guards, which is by design: set `deletion_protection = false` and remove `prevent_destroy` in a PR (or accept the final snapshot and delete via console for the drill), apply, then `terraform destroy`. Budget ~30 minutes each way.

### 5. Publish the network interface

Add section 7's `aws_ssm_parameter` publishing block to **both** environments and apply. Verify:

```text
$ aws ssm get-parameter --name /tickethub/prod/network/vpc-id --query 'Parameter.Value'
"vpc-0prod1234abcd5678"
```

Module 11's EKS stack will consume `/tickethub/<env>/network/*` without touching this stack's state. The interface is now published; the implementation behind it is free to evolve.

## Real-world best practices

- **Extract modules from working code, not from imagination.** Staging ran flat for a full lecture, and the boundaries were obvious *because* the concrete code existed. Up-front module design grows speculative variables nobody uses and misses the parameter that actually varies.
- **Make policy unconfigurable.** Every security default a module hardcodes is a class of incident a hurried caller can't cause. If someone truly needs an unencrypted database, they must edit the module in a PR titled that way — friction *is* the feature.
- **`moved` blocks for every rename, forever.** An address change without one is a pending destroy/recreate wearing a refactor's clothes. Make "plan shows only moves" a review requirement — checkable in seconds from the summary line.
- **One state file per environment, never shared.** `envs/<env>/terraform.tfstate` buys blast radius, independent locks, and IAM-scopable access (production CI can be denied staging's key and vice versa). Workspaces for ephemeral copies only.
- **Treat `force-unlock` like `rm -rf` — a last resort with a ritual.** Identify the holder, contact them, confirm the process is dead, then unlock. Teams that force-unlock reflexively eventually write two states at once.
- **Publish interfaces, not state.** SSM parameters let consumers depend on four named values instead of your whole secret-bearing state file — and the looser coupling pays off precisely when you refactor, which today proved is routine.

## Common pitfalls

1. **Copy-paste environments "just to get production up."** Under deadline, `cp -r` is irresistible — and it works, which is the trap: the divergence cost arrives months later as a production-only bug in a fix that landed only in staging. Correct approach: modules first, even rough ones; the second environment is exactly when abstraction pays.
2. **Refactoring addresses without `moved` and trusting apply.** The plan clearly says `1 to add, 1 to destroy`, but it's read as refactor noise and approved — goodbye database (deletion protection permitting). Correct approach: the section-4 workflow; a refactor plan not ending in `0/0/0` is wrong until proven otherwise.
3. **A god-module with `create_x` flags.** The "everything" module sprouts `create_alb`, `create_redis`, `count = var.x ? 1 : 0` — and every environment change risks every other environment through the same tangle. Correct approach: right-sized capability modules; composition happens in env `main.tf`, not inside modules via flags.
4. **Workspaces for staging vs production.** It demos beautifully — until the first shape divergence spawns workspace conditionals, and until someone applies production while *believing* they're in staging (the prompt doesn't say). Correct approach: directories + separate state keys; workspaces for `review-pr-*` copies that are genuinely identical.
5. **Reading another team's state with `terraform_remote_state` because it was quickest.** Day one it works; then the producer refactors an output, six consumers break at once, and everyone's CI holds read access to a state file full of secrets. Correct approach: published SSM parameters at ownership boundaries; remote state only within one team's tightly-coupled stacks.

## Exercises

1. From memory: a module's three faces, and for each of `storage_encrypted`, `instance_class`, `multi_az`, `backup_window` — variable or hardcoded in `modules/database`, and why in one sentence each.
2. Add a `redis_version` variable to `modules/cache` with a validation accepting only `7.x` versions (`can(regex(...))`), defaulting to `"7.1"`. Prove both environments plan clean (no changes) after the addition — what property of variable defaults makes that true?
3. Simulate the lock conflict: `terraform apply` in one terminal (pause at the prompt), `terraform plan` in another. Capture the Lock Info, identify `Who`, and write the three-step ritual you'd follow *before* `force-unlock` — then explain what you'd risk by skipping step three.
4. Write `modules/ecs-service` for real: variables (`service_name`, `cluster_name`, `container_port`, `subnet_ids`, `security_group`, `desired_count`), the service shell with 10.2's `ignore_changes` boundary, a target group + outputs. Refactor staging's three services onto it with `moved` blocks — plan must show only moves.
5. **Stretch — the recovery drill:** in a *sandbox* stack (never staging), deliberately break state: `terraform state rm` one resource, observe the plan wanting to recreate it, then recover it two ways — (a) re-import it, (b) restore the previous state version from the bucket via `list-object-versions`/`copy-object`. Time both. Write down which you'd reach for during a real incident and why.

## What's next

The repository now matches TICKETHUB.md's promise: shared modules, two environments born from the same code, isolated state, and a published interface other stacks can consume. But every apply so far ran from your laptop, with your credentials, reviewed by whoever was looking over your shoulder. [Lecture 10.4 — Terraform in CI & Policy](04-terraform-in-ci-policy.md) gives infrastructure the pipeline application code has had since Module 7: plans posted on PRs as review artifacts, applies gated by environment approvals, policy scanners that catch a public bucket before it exists, and nightly drift detection that files the issue for you.
