# TicketHub — The Course Project

TicketHub is the sample application used in **every** lecture of this course. It is an event-ticketing platform API built with Laravel. It was chosen because ticketing naturally exercises every real DevOps concern: traffic spikes when sales open, background jobs, scheduled tasks, file storage, caching, payments-grade data integrity, and zero tolerance for downtime during an on-sale.

This document is the **single source of truth** for the app's design, tool versions, and naming. Lectures refer to it instead of re-explaining it.

---

## 1. What TicketHub does

- **Organizers** create **events**; each event has one or more **ticket types** (e.g. General Admission, VIP) with a price and limited quantity.
- **Customers** browse events and place **orders** for tickets. An order reserves inventory for 15 minutes; unpaid reservations expire.
- On payment, the system issues **tickets** (one per seat/admission) with QR codes, generates a PDF per ticket, and emails the customer.
- Organizers get a nightly **sales report**.

### Workloads this creates (the DevOps-relevant part)

| Workload | Implementation | Why it matters for DevOps |
|---|---|---|
| HTTP API | Laravel (PHP-FPM behind Nginx) | The thing we scale, load-balance, and deploy without downtime |
| Queue workers | Laravel Horizon (Redis) — emails, PDF generation | Long-running processes that must be supervised, scaled, and drained on deploy |
| Scheduler | `php artisan schedule:run` — expire reservations (every minute), nightly reports | Cron in a world of many servers: must run exactly once |
| Database | MySQL — orders and inventory need transactions | Migrations under live traffic; backups; failover |
| Cache & queues backend | Redis | Session/cache/queue separation; eviction policy matters |
| File storage | S3 — ticket PDFs, event images | Local disk is a lie once you have 2 servers |
| Email | SES (Mailpit locally) | Environment parity for outbound mail |

## 2. Pinned versions

All lectures use these versions. Newer versions will mostly work, but commands and config are verified against these.

| Tool | Version |
|---|---|
| PHP | 8.4 (FPM) |
| Laravel | 12.x |
| MySQL | 8.0 |
| Redis | 7.x |
| Nginx | stable (1.26+) |
| Node.js (asset builds) | 22 LTS |
| Composer | 2.7+ |
| Test framework | Pest 3 |
| Docker Engine | 27+ |
| Terraform | 1.9+ |
| Kubernetes / EKS | 1.31 |
| Helm | 3.16+ |
| Ubuntu (server lectures) | 24.04 LTS |

## 3. Domain model

```
Organizer (User with role)  1──*  Event  1──*  TicketType
Customer  (User)            1──*  Order  1──*  OrderItem ──> TicketType
                                   Order  1──*  Ticket (issued after payment, has QR code + PDF)
```

Key tables: `users`, `events`, `ticket_types`, `orders`, `order_items`, `tickets`, plus Laravel's standard `jobs`/`failed_jobs` (only until we move queues to Redis in Module 5) and `cache` tables.

**Critical invariant:** a ticket type can never be oversold. Inventory checks happen inside DB transactions with row locks (`SELECT ... FOR UPDATE`). Several lectures use this invariant to demonstrate why deploys and migrations must respect in-flight transactions.

Key jobs & scheduled tasks (used in queue/worker lectures):

- `App\Jobs\GenerateTicketPdf` — CPU-heavy, queued on `pdfs` queue
- `App\Mail\OrderConfirmed` — queued mail, `default` queue
- `App\Console\Commands\ExpireReservations` — scheduled `everyMinute()`
- `App\Console\Commands\SendNightlySalesReports` — scheduled `dailyAt('02:00')`

## 4. Repository layout

One application repo: **`github.com/tickethub/tickethub-api`** (the `tickethub` GitHub org is a placeholder — use your own). Infrastructure lives in the same repo until Module 10 splits it out; the final layout:

```
tickethub-api/
├── app/ bootstrap/ config/ database/ routes/ tests/   # standard Laravel 12
├── docker/                    # Module 6: nginx conf, php ini, entrypoints
│   ├── nginx/
│   ├── php/
│   └── entrypoint.sh
├── Dockerfile                 # Module 6: multi-stage production image
├── compose.yaml               # Module 6: local dev stack
├── .github/workflows/         # Module 7+: ci.yml, deploy.yml
├── deploy/                    # Module 9: Deployer config (classic deploys)
└── helm/tickethub/            # Module 11: Helm chart

tickethub-infra/               # Module 10+: separate Terraform repo
├── modules/{network,database,cache,ecs-service,eks}/
└── envs/{staging,production}/
```

## 5. Environments

| Environment | Where | Purpose |
|---|---|---|
| `local` | Docker Compose on the developer machine | Day-to-day development; parity with prod via containers |
| `staging` | AWS, mirrors production at smaller scale | Every merge to `main` auto-deploys here |
| `production` | AWS `ap-southeast-1` | Promoted from staging via tagged release |

Branch → environment mapping (from Module 9 on): PR → CI only · merge to `main` → staging · tag `v*` → production.

## 6. Naming conventions

**Domains:** `tickethub.example` (marketing), `api.tickethub.example` (production API), `api.staging.tickethub.example` (staging API).

**Docker image:** `111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api`, tagged with the Git SHA (`sha-a1b2c3d`) and release tags (`v1.4.2`). `latest` is never deployed.

**AWS resources** follow `tickethub-<env>-<thing>`:

| Resource | Name |
|---|---|
| VPC | `tickethub-prod-vpc` (10.0.0.0/16) / `tickethub-staging-vpc` (10.1.0.0/16) |
| RDS instance | `tickethub-prod-mysql` |
| ElastiCache | `tickethub-prod-redis` |
| S3 buckets | `tickethub-prod-uploads`, `tickethub-prod-backups`, `tickethub-terraform-state` |
| ECS cluster / service | `tickethub-prod` / `tickethub-api` |
| ALB | `tickethub-prod-alb` |
| EKS cluster | `tickethub-prod-eks` |
| IAM roles | `tickethub-prod-app`, `tickethub-github-deploy` |

**Kubernetes (Module 11):** namespace `tickethub`; workloads `tickethub-web` (Deployment: nginx + php-fpm), `tickethub-horizon` (Deployment), `tickethub-scheduler` (CronJob); config in `tickethub-config` (ConfigMap) and `tickethub-secrets` (Secret, sourced from AWS Secrets Manager).

**Queues:** `default`, `pdfs`, `mail` on Redis. Horizon supervises all of them.

## 7. Where the app is at each stage of the course

| After module | TicketHub runs as |
|---|---|
| 3 | One Ubuntu VPS, Nginx + PHP-FPM, MySQL and Redis on the same box, deployed by `git pull` (deliberately naive) |
| 6 | Containers everywhere locally; production still the VPS |
| 8 | EC2 + ALB, RDS, ElastiCache, S3 — still deployed semi-manually |
| 9 | ECS Fargate, fully automated deploys from GitHub Actions, zero downtime |
| 10 | Identical, but every AWS resource is Terraform-managed |
| 11 | EKS with Helm + Argo CD (GitOps) |
| 12 | Same platform + full observability, security scanning, SLOs, runbooks |

The course deliberately shows the **evolution** — including the painful manual stages — because that pain is the reason each next tool exists.
