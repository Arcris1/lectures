# Lecture 10.2 — Terraforming TicketHub: Network & Data Layer

> **Module 10 — Infrastructure as Code with Terraform** · Lecture 2 of 4 · Estimated time: ~120 min

Staging is live: the VPC from [Lecture 8.2](../module-08-aws-fundamentals/02-vpc-networking.md), the data tier from [8.3](../module-08-aws-fundamentals/03-core-services-rds-s3-redis.md), and Module 9's Fargate services deploying on every merge. You will not rebuild any of it. Instead you'll do the thing real teams do far more often than greenfield builds: write HCL that describes the infrastructure you already have, then **adopt** the live resources into Terraform state without recreating — or even restarting — them. Brownfield adoption is the unglamorous, high-value skill this lecture teaches; the finished product is `envs/staging` under full Terraform management while user traffic flows through it, unaware.

## Learning objectives

- Translate a hand-built AWS environment into complete, idiomatic HCL (for_each, cidrsubnet, current-style security-group rules)
- Adopt live resources with declarative `import` blocks, iterating until a clean plan proves config matches reality
- Decide what to omit versus pin when importing attribute-heavy resources like RDS
- Draw the platform/app ownership boundary so Terraform and the deploy pipeline never fight over the same resource
- Demonstrate Terraform as a drift tripwire: detect and revert a console change with one plan/apply
- Inspect state safely with `state list`, `state show`, and `console`

## 1. Brownfield first: why import beats recreate

The naive path to "staging as code" is to write HCL, `terraform apply` a *second* staging, cut over, and delete the old one. For a stateless demo, fine. For TicketHub it means migrating an RDS database, re-issuing Redis auth, repointing DNS, and re-verifying the whole Module 9 pipeline — days of risk to end up exactly where you started.

The professional path: write configuration describing the live resources, then tell Terraform "this address corresponds to that existing ID" — an **import**. Terraform records the mapping in state, refreshes the real attributes, and thereafter manages the resource like it created it. Nothing in AWS changes during an import; it is a pure state operation.

The workflow, which you'll run repeatedly today:

1. **Write** the resource configuration as you believe it exists.
2. **Add an import block** binding the address to the real ID.
3. **Plan.** Terraform shows the import plus any *differences* between your config and reality.
4. **Reconcile** — fix your HCL where it's wrong; accept the change where reality is wrong (like tags).
5. Repeat until **`terraform plan` reports no changes**. A clean plan is the *definition of done* for adoption: it proves your code and the cloud describe the same world.

Since Terraform 1.5, imports are declarative blocks in your config — plannable, reviewable, and removable after they've done their job:

```hcl
import {
  to = aws_vpc.main
  id = "vpc-0a1b2c3d4e5f67890"
}
```

This replaces the older imperative `terraform import` CLI command, which modified state immediately with no plan step. Blocks are strictly better: you see what will happen before it does.

## 2. Layout: flat now, modules later

Today's structure is deliberately simple — one directory, one state, files split by topic for humans:

```text
tickethub-infra/
├── sandbox/                  # Lecture 10.1 (destroyed)
└── envs/
    └── staging/
        ├── versions.tf       # terraform block, backend, provider
        ├── variables.tf
        ├── vpc.tf
        ├── security-groups.tf
        ├── rds.tf
        ├── cache.tf
        ├── s3.tf
        ├── ecs.tf            # shells only — section 6
        ├── imports.tf        # temporary, deleted when adoption completes
        └── outputs.tf
```

Modules — `modules/network`, `modules/database`, and friends per [TICKETHUB.md](../TICKETHUB.md) — arrive in [Lecture 10.3](03-modules-environments-remote-state.md), *as a refactor of this working code*. Starting flat is pedagogy and good practice at once: abstractions extracted from working concrete code are better than abstractions designed on faith.

## 3. The loop, the function, and the rule style you'll use everywhere

Three pieces of HCL idiom carry most of today's code:

**`for_each`** creates one resource instance per entry of a map. Six subnets become one resource block; each instance gets a stable address keyed by the map key — `aws_subnet.main["app-a"]` — so adding a seventh subnet later never renumbers the others (the classic flaw of `count`-based lists, where deleting element 1 renames every element after it, which Terraform sees as destroy-and-recreate).

**`cidrsubnet(prefix, newbits, netnum)`** slices CIDRs arithmetically: `cidrsubnet("10.1.0.0/16", 4, 2)` = "take the /16, add 4 bits (→ /20), give me slice number 2" = `10.1.32.0/20`. Lecture 8.2's subnet table, computed instead of transcribed — and when production arrives with `10.0.0.0/16`, the same expressions produce the right answers with zero editing.

**Security-group rules as separate resources.** The `aws_security_group` resource accepts inline `ingress`/`egress` blocks, but the current style is standalone `aws_vpc_security_group_ingress_rule` / `..._egress_rule` resources, one rule each. The gotcha that makes this a rule rather than a taste: **inline and separate styles must never be mixed on the same SG** — inline blocks claim exclusive ownership of the rule set, so a separate rule resource added elsewhere gets stripped on the next apply, then re-added by its own resource, forever flip-flopping. Separate rules also give each rule its own address (importable, taggable, individually reviewable). We use separate rules exclusively.

## 4. Disaster-prevention arguments on stateful resources

Module 8 set safety flags at the CLI; in Terraform they become permanent, reviewable code. On `aws_db_instance`, four arguments earn a one-line justification each:

- `deletion_protection = true` — AWS refuses to delete the instance at the API level, whoever asks.
- `skip_final_snapshot = false` — if a delete *is* ever intended, RDS snapshots first; the data outlives the mistake.
- `final_snapshot_identifier = "..."` — required for the above to work; name it now, not mid-panic.
- `backup_retention_period = 7` — seven days of point-in-time recovery ([8.3 §3](../module-08-aws-fundamentals/03-core-services-rds-s3-redis.md)).

These cost nothing and convert three categories of catastrophe (fat-fingered destroy, malicious delete, "oops wrong environment") into recoverable annoyances. They go in *before* import so they're enforced from adoption day one.

## 5. `-generate-config-out`: scaffolding, honestly assessed

Writing HCL for forty existing resources is real work. Terraform can draft it for you: put import blocks in a file *without* corresponding resource blocks and run:

```bash
$ terraform plan -generate-config-out=generated.tf
```

Terraform reads each resource's live attributes and writes resource blocks that match. Treat the output as **a draft from a verbose intern**: it emits every attribute it can see — nulls, defaults, computed values — with no variables, no references (`vpc_id = "vpc-0a1b…"` hardcoded instead of `aws_vpc.main.id`), and occasionally combinations that don't re-validate. The workflow: generate, then *flatten and de-noise* — delete null/default arguments, replace literals with references — and re-plan until clean. It saves an hour of API-doc reading per gnarly resource; it does not save you from understanding the result. Today we write config by hand (you know these resources intimately from Module 8) and keep generation for the tedious corners.

## 6. The platform/app boundary: what NOT to import

Terraform should not manage everything. Module 9's pipeline deploys by registering a **new task-definition revision** (new image tag) and updating the ECS service to point at it — dozens of times a week. If Terraform owned the task definition, every deploy would create drift, and every `terraform apply` would roll the app back to whatever image the HCL last mentioned. Deploys and infrastructure changes would fight over the same resource.

So draw the boundary explicitly:

| Concern | Owner | Examples |
|---|---|---|
| **Platform** (changes rarely, by PR to `tickethub-infra`) | Terraform | VPC, subnets, SGs, RDS, ElastiCache, S3, ALB, ECR repos, ECS **cluster** and **service shells**, IAM roles, SSM parameter *names* |
| **App / deploy artifact** (changes per deploy, by `tickethub-api` pipeline) | GitHub Actions | Task-definition **revisions**, which image tag runs, desired count during scaling events |

The ECS *cluster* and *services* are platform — their existence, networking, and load-balancer wiring belong in Terraform. But the service's `task_definition` pointer is a deploy artifact, so Terraform is told to ignore it:

```hcl
resource "aws_ecs_service" "api" {
  name            = "tickethub-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = "tickethub-api"   # family only — pipeline owns the revision
  launch_type     = "FARGATE"
  desired_count   = 2

  network_configuration {
    subnets         = [aws_subnet.main["app-a"].id, aws_subnet.main["app-b"].id]
    security_groups = [aws_security_group.app.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "nginx"
    container_port   = 80
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
```

`ignore_changes` tells Terraform: manage everything about this service *except* these arguments — never plan a change because the pipeline moved them. Module 9's deploys keep working, untouched, while the service's shape is still code. (`desired_count` joins the list so a scaling action — manual or future autoscaling — isn't "corrected" back by the next apply.) The same shells-not-revisions pattern covers `tickethub-horizon` and the scheduler service.

## Hands-on with TicketHub

⚠️ **Cost:** $0 new spend — every resource in this lecture already exists and keeps its Module 8/9 billing (~$80/mo). Imports are state-only operations; the only applies today change tags and revert a drill-drift. **Nothing is destroyed and nothing restarts.**

`envs/staging/versions.tf` — same shape as 10.1's sandbox, its own state key:

```hcl
terraform {
  required_version = ">= 1.9.0"

  backend "s3" {
    bucket         = "tickethub-terraform-state"
    key            = "envs/staging/terraform.tfstate"
    region         = "ap-southeast-1"
    dynamodb_table = "tickethub-terraform-lock"
    encrypt        = true
  }

  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" {
  region = "ap-southeast-1"

  default_tags {
    tags = {
      Project   = "tickethub"
      Env       = var.environment
      Owner     = "platform"
      ManagedBy = "terraform"
    }
  }
}
```

`variables.tf` — small on purpose; these become module inputs in 10.3:

```hcl
variable "environment" {
  type    = string
  default = "staging"
}

variable "vpc_cidr" {
  type    = string
  default = "10.1.0.0/16"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}
```

### 1. The network as code

`vpc.tf` — Lecture 8.2, sections 1–4 and 6, in ~80 lines:

```hcl
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "tickethub-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)

  subnets = {
    public-a = { cidr = cidrsubnet(var.vpc_cidr, 4, 0), az = local.azs[0], public = true }
    public-b = { cidr = cidrsubnet(var.vpc_cidr, 4, 1), az = local.azs[1], public = true }
    app-a    = { cidr = cidrsubnet(var.vpc_cidr, 4, 2), az = local.azs[0], public = false }
    app-b    = { cidr = cidrsubnet(var.vpc_cidr, 4, 3), az = local.azs[1], public = false }
    data-a   = { cidr = cidrsubnet(var.vpc_cidr, 4, 4), az = local.azs[0], public = false }
    data-b   = { cidr = cidrsubnet(var.vpc_cidr, 4, 5), az = local.azs[1], public = false }
  }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.name}-vpc" }
}

resource "aws_subnet" "main" {
  for_each = local.subnets

  vpc_id                  = aws_vpc.main.id
  cidr_block              = each.value.cidr
  availability_zone       = each.value.az
  map_public_ip_on_launch = each.value.public

  tags = { Name = "${local.name}-${each.key}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-igw" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  subnet_id     = aws_subnet.main["public-a"].id
  allocation_id = aws_eip.nat.id
  tags          = { Name = "${local.name}-nat" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-public-rt" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-private-rt" }
}

resource "aws_route" "private_internet" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main.id
}

resource "aws_route_table_association" "main" {
  for_each = local.subnets

  subnet_id      = aws_subnet.main[each.key].id
  route_table_id = each.value.public ? aws_route_table.public.id : aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  vpc_endpoint_type = "Gateway"
  service_name      = "com.amazonaws.ap-southeast-1.s3"
  route_table_ids   = [aws_route_table.public.id, aws_route_table.private.id]

  tags = { Name = "${local.name}-s3-endpoint" }
}
```

(One genuine `depends_on`: a NAT gateway needs the IGW attached, but references nothing on it — the invisible-dependency case from [10.1 §7](01-terraform-fundamentals.md).)

`security-groups.tf` — the 8.2 chain, CIDR only at the internet edge:

```hcl
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb-sg"
  description = "ALB: public 443/80"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-alb-sg" }
}

resource "aws_security_group" "app" {
  name        = "${local.name}-app-sg"
  description = "App tier: 80 from ALB only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-app-sg" }
}

resource "aws_security_group" "mysql" {
  name        = "${local.name}-mysql-sg"
  description = "RDS: 3306 from app only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-mysql-sg" }
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis-sg"
  description = "Redis: 6379 from app only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-redis-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "mysql_from_app" {
  security_group_id            = aws_security_group.mysql.id
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_app" {
  security_group_id            = aws_security_group.redis.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_egress_rule" "all" {
  for_each = {
    alb   = aws_security_group.alb.id
    app   = aws_security_group.app.id
    mysql = aws_security_group.mysql.id
    redis = aws_security_group.redis.id
  }

  security_group_id = each.value
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
```

`referenced_security_group_id` is 8.2's "intent, not coordinates" argument in its Terraform spelling. The egress `for_each` adopts the default allow-all egress rule AWS created on each SG.

### 2. The data tier as code

`rds.tf`:

```hcl
resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db-subnets"
  subnet_ids = [aws_subnet.main["data-a"].id, aws_subnet.main["data-b"].id]
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
  engine_version = "8.0.42"
  instance_class = var.db_instance_class

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name                     = "tickethub"
  username                    = "admin"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.mysql.id]
  publicly_accessible    = false
  multi_az               = false
  parameter_group_name   = aws_db_parameter_group.mysql80.name

  backup_retention_period         = 7
  backup_window                   = "19:00-20:00"
  maintenance_window              = "sun:20:30-sun:21:30"
  enabled_cloudwatch_logs_exports = ["error", "slowquery"]

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-mysql-final"
}
```

Every argument is a decision you already made in 8.3, now permanent. `manage_master_user_password = true` keeps the password's only home in Secrets Manager — but remember [10.1 §5](01-terraform-fundamentals.md): the secret's ARN and metadata land in state, and many resources' secrets land there in full. State stays a secret either way.

`cache.tf`:

```hcl
resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-cache-subnets"
  subnet_ids = [aws_subnet.main["data-a"].id, aws_subnet.main["data-b"].id]
}

resource "aws_elasticache_parameter_group" "redis7" {
  name   = "${local.name}-redis7"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "random_password" "redis_auth" {
  length  = 64
  special = false
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name}-redis"
  description          = "TicketHub ${var.environment} Redis 7"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type

  num_cache_clusters         = 1
  automatic_failover_enabled = false

  parameter_group_name = aws_elasticache_parameter_group.redis7.name
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]

  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  auth_token_update_strategy = "ROTATE"
}

resource "aws_ssm_parameter" "redis_auth" {
  name  = "/tickethub/${var.environment}/redis-auth"
  type  = "SecureString"
  value = random_password.redis_auth.result
}
```

The token flows `random_password` → ElastiCache → SSM SecureString, where Module 9's task definitions already read their secrets. Be honest about what this buys: the token is generated by Terraform and *therefore lives in state* — the SecureString protects it from casual `aws ssm` browsing, not from anyone who can read state. That's 10.1's lesson recalled: state access *is* secret access, so state access is what you lock down. **The auth-token wrinkle:** AWS never returns auth tokens on read, so the first apply after import rotates it — gracefully, via `ROTATE` (old and new both work during the transition; the app picks up the new SSM value on its next deploy). A one-time, zero-downtime rotation is the honest price of adoption here.

`s3.tf` — the uploads bucket as five small resources (the modern provider splits bucket features out):

```hcl
resource "aws_s3_bucket" "uploads" {
  bucket = "${local.name}-uploads"
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "tickets-to-standard-ia"
    status = "Enabled"
    filter {
      prefix = "tickets/"
    }
    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
  }
}
```

`outputs.tf` — the contract other stacks will consume (Module 11's EKS cluster will want exactly these):

```hcl
output "vpc_id" { value = aws_vpc.main.id }

output "private_app_subnet_ids" {
  value = [aws_subnet.main["app-a"].id, aws_subnet.main["app-b"].id]
}

output "private_data_subnet_ids" {
  value = [aws_subnet.main["data-a"].id, aws_subnet.main["data-b"].id]
}

output "app_security_group_id" { value = aws_security_group.app.id }

output "db_endpoint" { value = aws_db_instance.main.endpoint }

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "uploads_bucket" { value = aws_s3_bucket.uploads.bucket }
```

### 3. Import walkthrough one: the VPC (simple)

`imports.tf`, first entry:

```hcl
import {
  to = aws_vpc.main
  id = "vpc-0a1b2c3d4e5f67890"
}
```

```text
$ terraform init && terraform plan

aws_vpc.main: Preparing import... [id=vpc-0a1b2c3d4e5f67890]
aws_vpc.main: Refreshing state... [id=vpc-0a1b2c3d4e5f67890]

Terraform will perform the following actions:

  # aws_vpc.main will be imported and updated
  ~ resource "aws_vpc" "main" {
        cidr_block           = "10.1.0.0/16"
        enable_dns_hostnames = true
        id                   = "vpc-0a1b2c3d4e5f67890"
      ~ tags_all             = {
          ~ "ManagedBy" = "manual" -> "terraform"
            # (4 unchanged elements hidden)
        }
    }

Plan: 1 to import, 0 to add, 1 to change, 0 to destroy.
```

One diff, and it's *true*: the VPC's `ManagedBy` tag says `manual`, and as of this apply, that stops being accurate. Apply, and the tag flips — the first (and only) change adoption makes to your network. Re-plan: `No changes`. The VPC is adopted.

### 4. Import walkthrough two: RDS (attribute-noisy)

```hcl
import {
  to = aws_db_instance.main
  id = "tickethub-staging-mysql"
}
```

Suppose you'd written `engine_version = "8.0"` (a natural shorthand). First plan:

```text
  # aws_db_instance.main will be imported and updated
  ~ resource "aws_db_instance" "main" {
      ~ engine_version = "8.0.42" -> "8.0"
        identifier     = "tickethub-staging-mysql"
      ~ tags_all       = {
          ~ "ManagedBy" = "manual" -> "terraform"
            # (4 unchanged elements hidden)
        }
        # (48 unchanged attributes hidden)
    }

Plan: 1 to import, 0 to add, 1 to change, 0 to destroy.
```

That `engine_version` line is your config being *wrong about reality* — left alone, apply would attempt an engine change. Pin it to `8.0.42`. This is the reconcile loop from section 1 in miniature, and RDS is where you practice the **omit-vs-set** judgment:

- **Set** what you decided in Module 8: class, storage, windows, retention, parameter group, the protection flags. These are policy; you want drift in them detected.
- **Omit** what you never chose: `iops` and `storage_throughput` (gp3 baselines, provider-computed), `ca_cert_identifier`, `monitoring_interval`, `copy_tags_to_snapshot`, `performance_insights_enabled`. Unset arguments follow the provider's read of reality — no diff, no noise. Writing them all down anyway (what `-generate-config-out` does) buys you nothing but a longer file.
- **Config-only arguments never diff:** `skip_final_snapshot`, `final_snapshot_identifier`, and `apply_immediately` exist only in Terraform's behavior, not in AWS — set them to taste, imports ignore them.

Fix, re-plan (only the tag change remains), apply, re-plan: clean. The database is adopted — and never noticed.

### 5. The rest, as a checklist

The remaining imports repeat the same loop; what varies is the **ID format**. The fiddly ones are composites:

| Resource address | Import ID format | Example |
|---|---|---|
| `aws_subnet.main["public-a"]` … (×6) | subnet ID | `subnet-0c2b7d1e4a9f83001` |
| `aws_internet_gateway.main` | IGW ID | `igw-0fedcba9876543210` |
| `aws_eip.nat` | allocation ID | `eipalloc-0abc123def4567890` |
| `aws_nat_gateway.main` | NAT ID | `nat-0a1b2c3d4e5f11111` |
| `aws_route_table.public` / `.private` | RTB ID | `rtb-00aaaa1111bbbb001` |
| `aws_route.public_internet` | **`<rtb-id>_<destination>`** | `rtb-00aaaa1111bbbb001_0.0.0.0/0` |
| `aws_route_table_association.main["app-a"]` | **`<subnet-id>/<rtb-id>`** | `subnet-0e4d9f306c1ba5003/rtb-00bbbb2222cccc002` |
| `aws_security_group.*` (×4) | SG ID | `sg-0d1c7a9b0e2f30003` |
| `aws_vpc_security_group_ingress_rule.*`, `egress_rule.all[*]` | rule ID (look up: `aws ec2 describe-security-group-rules --filters Name=group-id,Values=sg-…`) | `sgr-0aa11bb22cc33dd44` |
| `aws_vpc_endpoint.s3` | endpoint ID | `vpce-0530e9d8c7b6a5001` |
| `aws_db_subnet_group.main` / `aws_db_parameter_group.mysql80` | name | `tickethub-staging-db-subnets` |
| `aws_elasticache_subnet_group.main` / `_parameter_group.redis7` | name | `tickethub-staging-redis7` |
| `aws_elasticache_replication_group.main` | replication group ID | `tickethub-staging-redis` |
| `aws_s3_bucket.uploads` *and each sub-resource* | bucket name | `tickethub-staging-uploads` |
| `aws_ssm_parameter.redis_auth` | full name | `/tickethub/staging/redis-auth` |
| `aws_ecr_repository.api` / `.nginx` | name | `tickethub-api` |
| `aws_ecs_cluster.main` | name | `tickethub-staging` |
| `aws_ecs_service.api` etc. | **`<cluster>/<service>`** | `tickethub-staging/tickethub-api` |

(`random_password.redis_auth` can't be imported — it's generated on first apply, triggering the one-time token rotation from §2.) Work tier by tier — network, SGs, data, ECS shells — planning after each batch. When the full `terraform plan` prints `No changes. Your infrastructure matches the configuration.`, adoption is **done**, by definition. Delete `imports.tf`, commit everything. The ALB, ACM certificate, Route 53 records, IAM roles, and remaining SSM parameters follow the identical pattern — they're this lecture's exercise 4 rather than more pages of the same loop.

### 6. The drift tripwire

Prove the payoff. In the console, play the incident-time engineer: edit `mysql-sg`'s ingress rule, changing its source from `app-sg` to `10.1.0.0/16` ("just while we debug"). Then:

```text
$ terraform plan

  # aws_vpc_security_group_ingress_rule.mysql_from_app will be updated in-place
  ~ resource "aws_vpc_security_group_ingress_rule" "mysql_from_app" {
      + referenced_security_group_id = "sg-0e2d8b0c1f3a40002"
      - cidr_ipv4                    = "10.1.0.0/16" -> null
        id                           = "sgr-0aa11bb22cc33dd44"
    }

Plan: 0 to add, 1 to change, 0 to destroy.
```

The console change that was invisible for eight months in section 1's horror story now shows up in the next plan, attributed, diffable — and `terraform apply` reverts it. One honest caveat: separate-rule style detects changes to *managed* rules, but a **brand-new rule** added in the console belongs to no resource, so plan won't see it. Full-set enforcement needs the inline style's exclusiveness (with its mixing hazard) or config auditing — [Lecture 10.4](04-terraform-in-ci-policy.md)'s drift detection plus periodic Security Hub review is the pragmatic combination.

### 7. Looking around: state inspection

```text
$ terraform state list
aws_db_instance.main
aws_subnet.main["app-a"]
...
$ terraform state show aws_db_instance.main
# aws_db_instance.main:
resource "aws_db_instance" "main" {
    endpoint = "tickethub-staging-mysql.c9akciq32rga.ap-southeast-1.rds.amazonaws.com:3306"
    ...
$ terraform console
> aws_subnet.main["data-a"].cidr_block
"10.1.64.0/20"
> [for k, s in aws_subnet.main : s.availability_zone if !local.subnets[k].public]
```

`state list`/`state show` are read-only and safe; `console` evaluates expressions against real state — the fastest way to debug a `for_each` or check what an output would return. (Mutating commands — `state mv`, `state rm` — are Lecture 10.3's controlled-surgery topic.)

**Cost visibility, one paragraph:** [infracost](https://www.infracost.io/) reads a plan and prices it (`infracost breakdown --path .`), turning "this plan adds `db.m7g.large` + Multi-AZ" into "+$260/month" *before* apply — free at this usage, postable on PRs next to the plan (10.4). Estimates only (data transfer is a guess), but as a "did this PR just triple our bill?" tripwire it has paid for itself at many real companies.

## Real-world best practices

- **Adopt, don't recreate — and let the clean plan be your acceptance test.** Rebuilding working infrastructure to make it "Terraform-native" is risk with no reward. The clean plan is objective, reviewable proof of adoption; "I'm pretty sure the config matches" is neither.
- **Import in small batches, tier by tier.** Forty import blocks in one plan are an unreviewable wall; batches of five-to-ten keep each reconcile loop tight and each mistake local. Commit after each clean batch — the history then documents the adoption.
- **Hand-write config for resources you understand; generate scaffolding for ones you don't.** `-generate-config-out` is a reading aid, not an authoring tool — flatten, de-noise, re-plan. Config you can't explain is config you can't review.
- **Declare the platform/app boundary in writing (and in `ignore_changes`).** Every team with IaC *and* a deploy pipeline eventually has the fight where an apply rolls back a deploy. The fix is architectural: deploy artifacts are never Terraform-managed, and the boundary table lives in the repo README where both teams see it.
- **Safety arguments go in before import, not after the first near-miss.** `deletion_protection`, `skip_final_snapshot = false`, versioning, BPA — they cost nothing and are the difference between an incident and an anecdote. Adopting a resource without them adopts the risk too.
- **Never let a plan stay dirty.** A standing diff ("it always shows those two changes, ignore them") trains everyone to rubber-stamp plans — and the day a real change hides in the noise, nobody sees it. Clean plan, or an issue tracking why not; nothing in between.

## Common pitfalls

1. **Skipping the plan between import and apply.** Old habits from the imperative `terraform import` era — import, assume done. But an import with mismatched config applies *your mistakes to production*: the `engine_version = "8.0"` shorthand becomes an actual engine modification. Correct approach: import blocks + plan, reconcile until you can narrate every remaining change, then apply.
2. **Importing into `count`-indexed resources.** Someone imports six subnets as `count` indexes, later reorders the list — and Terraform plans to replace subnets holding a live RDS. It happens because `count` looks simpler than `for_each`. Correct approach: `for_each` over a keyed map for anything imported or long-lived; addresses like `["data-a"]` survive every future edit.
3. **Letting Terraform own the task definition.** It *feels* more complete — "everything as code!" — until the next apply quietly rolls every service back to the image tag frozen in HCL, undoing the afternoon's deploys. Correct approach: section 6's boundary — service shells with `ignore_changes = [task_definition]`, revisions owned by the pipeline that creates them.
4. **Mixing inline SG rules with rule resources.** The config validates, the first apply works, then rules flip-flop forever as the two styles fight for ownership — the classic "Terraform keeps changing it back" mystery. Correct approach: separate-rule resources only, enforced in review, remembering their blind spot for unmanaged additions (§6).
5. **Trusting generated config as finished code.** `-generate-config-out` emits hardcoded IDs and every readable attribute; committed as-is it's unmaintainable and silently pins things you never chose (an AZ, a CA cert identifier). Correct approach: treat it as a draft — references for literals, delete unchosen arguments, re-plan to prove the cleanup changed nothing.

## Exercises

1. Without looking at the lecture: write the `locals.subnets` map and the `aws_subnet` resource for a hypothetical `10.2.0.0/16` VPC using `cidrsubnet`. What CIDR does `cidrsubnet("10.2.0.0/16", 4, 5)` produce? Verify with `terraform console`.
2. The imports table shows `aws_route.public_internet` importing as `rtb-…_0.0.0.0/0`. Look up (in the provider docs) the import ID formats for `aws_route53_record` and `aws_route_table_association`, and explain in one sentence why composite IDs exist at all — what property do these resources lack that a VPC has?
3. Perform the drift drill in reverse: change `long_query_time` from `1` to `2` *in your HCL*, plan, and read the diff. Does the RDS parameter change require a reboot (check `apply_method`)? Revert without applying.
4. Extend the adoption: write config + import blocks for the ALB (`aws_lb`, `aws_lb_target_group`, `aws_lb_listener`) and the Route 53 record for `api.staging.tickethub.example`, using outputs/references — no hardcoded IDs except in the import blocks. Definition of done: clean plan.
5. **Stretch:** run `terraform plan -generate-config-out=drafts.tf` against an import block for the ACM certificate, then refactor the generated block to final quality: remove nulls and defaults, replace literals with references, and diff your version against the draft. Write three sentences on what the generator got wrong or over-specified.

## What's next

Staging's network and data layer are code, adopted without a second of downtime, and Terraform now catches console drift that used to be invisible. But the code is a flat directory that says `10.1.0.0/16` and `db.t4g.micro` in literal text — copy it for production and every future fix must land twice. [Lecture 10.3 — Modules, Environments & Remote State](03-modules-environments-remote-state.md) extracts the reusable modules TICKETHUB.md promised, refactors staging onto them with zero infrastructure changes (`moved` blocks — the professional's refactor), and then pays off the whole module: production, born from `terraform apply`.
