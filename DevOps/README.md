# DevOps from Zero to Advanced — with Laravel

A complete, hands-on DevOps curriculum that takes you from **zero operations knowledge** to **advanced, production-grade DevOps engineering**. Every concept is applied to one continuously evolving project: **TicketHub**, a realistic Laravel event-ticketing API that starts as "an app on your laptop" and ends as a fully automated, observable, secure system running on Kubernetes in AWS.

> **Read [`TICKETHUB.md`](TICKETHUB.md) first.** It describes the sample application, the pinned tool versions, and the naming conventions used in every lecture.

---

## Who this is for

- Backend developers (especially PHP/Laravel) who want to own their deployments and infrastructure.
- Aspiring DevOps/platform engineers starting from scratch.
- Developers at small companies who are "the ops person" by default and want to do it properly.

**Prerequisites:** you can read PHP and have seen a Laravel app before. No Linux, cloud, or operations experience is assumed — Module 1 starts from zero.

## How this course works

- **One project thread.** Every module applies its concepts to the same app, TicketHub. You will watch a real deployment architecture evolve — and understand *why* each evolution happens — instead of reading isolated toy examples.
- **Lecture format.** Every lecture follows the same structure: *Learning objectives → Concepts (from first principles) → Hands-on with TicketHub → Real-world best practices → Common pitfalls → Exercises → What's next*.
- **Real code only.** All application code is Laravel/PHP. Infrastructure code uses each tool's native language (Dockerfile, YAML, HCL, bash). Code blocks are complete and runnable, not fragments.
- **Best practices are labeled.** Each lecture separates "how it works" from "how real teams do it in production", including the mistakes teams actually make.

### What you need

| Modules | You need |
|---|---|
| 1–5 | A computer with a terminal (macOS/Linux, or Windows + WSL2), Git, PHP 8.4 + Composer |
| 6–7 | Docker Desktop (or Docker Engine), a GitHub account |
| 8–12 | An AWS account (⚠️ some resources cost real money — every lecture flags costs and includes teardown steps), Terraform CLI, kubectl, Helm |

---

## Curriculum

### Part I — Foundations (Beginner)

**[Module 1 — DevOps Foundations](module-01-devops-foundations/)**
1. [What DevOps Actually Is](module-01-devops-foundations/01-what-is-devops.md) — culture before tools; the wall between Dev and Ops; CALMS
2. [The Software Delivery Lifecycle](module-01-devops-foundations/02-software-delivery-lifecycle.md) — plan → code → build → test → release → deploy → operate → monitor
3. [Meet TicketHub](module-01-devops-foundations/03-meet-tickethub.md) — the app we take to production; the "works on my machine" problem
4. [Measuring DevOps: DORA Metrics](module-01-devops-foundations/04-measuring-devops-dora.md) — deployment frequency, lead time, MTTR, change failure rate

**[Module 2 — Linux & the Command Line](module-02-linux-command-line/)**
1. [Shell Fundamentals](module-02-linux-command-line/01-shell-fundamentals.md) — navigating, files, pipes, redirection, environment variables
2. [Users, Permissions & Processes](module-02-linux-command-line/02-users-permissions-processes.md) — ownership, chmod, sudo, ps, signals
3. [Services & Logs: systemd and journald](module-02-linux-command-line/03-systemd-services-logs.md) — units, service management, reading logs
4. [SSH & Server Hardening](module-02-linux-command-line/04-ssh-and-server-hardening.md) — key auth, sshd config, firewalls, fail2ban, unattended upgrades

**[Module 3 — Networking & Web Servers](module-03-networking-web-servers/)**
1. [How the Web Works](module-03-networking-web-servers/01-how-the-web-works.md) — IP, ports, DNS, HTTP from request to response
2. [TLS & Certificates](module-03-networking-web-servers/02-tls-and-certificates.md) — HTTPS, Let's Encrypt, termination, cert automation
3. [Nginx + PHP-FPM: Serving Laravel by Hand](module-03-networking-web-servers/03-nginx-php-fpm-laravel.md) — the full request path, tuning, real configs
4. [Reverse Proxies & Load Balancing](module-03-networking-web-servers/04-reverse-proxies-load-balancing.md) — L4 vs L7, health checks, session concerns

**[Module 4 — Git & Collaboration Workflows](module-04-git-collaboration/)**
1. [Git Fundamentals](module-04-git-collaboration/01-git-fundamentals.md) — the object model, staging, undoing things safely
2. [Branching Strategies](module-04-git-collaboration/02-branching-strategies.md) — trunk-based vs GitFlow vs GitHub Flow; what real teams use and why
3. [Pull Requests & Code Review](module-04-git-collaboration/03-pull-requests-code-review.md) — review culture, branch protection, CODEOWNERS
4. [Versioning & Releases](module-04-git-collaboration/04-versioning-and-releases.md) — conventional commits, SemVer, tags, changelogs, release automation

### Part II — Building the Pipeline (Intermediate)

**[Module 5 — Configuration & the Twelve-Factor App](module-05-configuration-twelve-factor/)**
1. [The Twelve-Factor App, Applied to Laravel](module-05-configuration-twelve-factor/01-twelve-factor-laravel.md) — all 12 factors mapped to concrete Laravel decisions
2. [Environment Config & Secrets Hygiene](module-05-configuration-twelve-factor/02-environment-config-secrets.md) — `.env` discipline, `config:cache`, what never goes in Git
3. [Environment Parity](module-05-configuration-twelve-factor/03-environment-parity.md) — local/staging/production, seed data, why parity drives us to containers

**[Module 6 — Docker & Containerization](module-06-docker/)**
1. [Containers from First Principles](module-06-docker/01-containers-from-first-principles.md) — namespaces & cgroups, images vs containers, layers, registries
2. [A Production-Grade Dockerfile for Laravel](module-06-docker/02-production-dockerfile-laravel.md) — multi-stage builds, PHP-FPM, opcache, non-root, healthchecks
3. [Docker Compose for Local Development](module-06-docker/03-docker-compose-local-dev.md) — the full TicketHub stack: app, MySQL, Redis, Mailpit, MinIO
4. [Registries & the Image Lifecycle](module-06-docker/04-registries-image-lifecycle.md) — ECR, tagging strategy, vulnerability scanning, image slimming

**[Module 7 — Continuous Integration with GitHub Actions](module-07-ci-github-actions/)**
1. [CI Concepts & Workflow Anatomy](module-07-ci-github-actions/01-ci-concepts-workflow-anatomy.md) — events, jobs, runners, contexts, secrets
2. [The TicketHub Test Pipeline](module-07-ci-github-actions/02-tickethub-test-pipeline.md) — Pest with MySQL/Redis services, parallel tests, coverage
3. [Code Quality Gates](module-07-ci-github-actions/03-code-quality-gates.md) — Pint, Larastan/PHPStan, dependency audit, required PR checks
4. [Building & Pushing Images in CI](module-07-ci-github-actions/04-building-images-in-ci.md) — BuildKit caching, tagging, OIDC to AWS (no long-lived keys)

**[Module 8 — AWS Cloud Fundamentals](module-08-aws-fundamentals/)**
1. [Cloud Concepts & Setting Up AWS Properly](module-08-aws-fundamentals/01-cloud-concepts-account-setup.md) — IAM users vs roles, MFA, least privilege, billing alarms
2. [Networking in AWS: VPC](module-08-aws-fundamentals/02-vpc-networking.md) — subnets, route tables, gateways, security groups vs NACLs
3. [Core Services for TicketHub](module-08-aws-fundamentals/03-core-services-rds-s3-redis.md) — RDS MySQL, S3, ElastiCache Redis, SES; managed vs self-hosted
4. [The Classic Deployment: EC2 + ALB](module-08-aws-fundamentals/04-classic-deployment-ec2-alb.md) — deploy TicketHub manually, feel the pain that automation removes

### Part III — Production Engineering (Advanced)

**[Module 9 — Continuous Delivery & Deployment Strategies](module-09-cd-deployment-strategies/)**
1. [CD Concepts, Environments & Promotion](module-09-cd-deployment-strategies/01-cd-concepts-environments.md) — delivery vs deployment, pipelines as the only path to prod
2. [Zero-Downtime Laravel Deploys](module-09-cd-deployment-strategies/02-zero-downtime-laravel-deploys.md) — atomic deploys, migrations under traffic, queues & config cache
3. [Containerized CD: ECS Fargate](module-09-cd-deployment-strategies/03-ecs-fargate-pipeline.md) — task definitions, services, rolling deploys from GitHub Actions
4. [Progressive Delivery](module-09-cd-deployment-strategies/04-progressive-delivery.md) — blue/green, canary, feature flags, instant rollback

**[Module 10 — Infrastructure as Code with Terraform](module-10-terraform-iac/)**
1. [Terraform Fundamentals](module-10-terraform-iac/01-terraform-fundamentals.md) — state, plan/apply, providers, HCL, why IaC is non-negotiable
2. [Terraforming TicketHub: Network & Data Layer](module-10-terraform-iac/02-terraforming-tickethub-network-data.md) — VPC, RDS, ElastiCache, S3 as code
3. [Modules, Environments & Remote State](module-10-terraform-iac/03-modules-environments-remote-state.md) — reusable modules, staging vs prod, S3 backend + locking
4. [Terraform in CI & Policy](module-10-terraform-iac/04-terraform-in-ci-policy.md) — plan on PR, apply on merge, drift detection, tflint/Checkov

**[Module 11 — Kubernetes](module-11-kubernetes/)**
1. [Why Kubernetes & Core Concepts](module-11-kubernetes/01-kubernetes-core-concepts.md) — pods, deployments, services, ingress, the reconciliation loop
2. [TicketHub on Kubernetes](module-11-kubernetes/02-tickethub-on-kubernetes.md) — web, Horizon workers, scheduler CronJob, probes, ConfigMaps & Secrets
3. [EKS in Production](module-11-kubernetes/03-eks-production.md) — IRSA, ALB controller, autoscaling (HPA/cluster), node strategy
4. [Helm & GitOps with Argo CD](module-11-kubernetes/04-helm-gitops-argocd.md) — charts, values per environment, pull-based deployment

**[Module 12 — Observability, Security & SRE](module-12-observability-security-sre/)**
1. [Structured Logging & Aggregation](module-12-observability-security-sre/01-structured-logging-aggregation.md) — JSON logs from Laravel, correlation IDs, CloudWatch/Loki
2. [Metrics, Alerting & SLOs](module-12-observability-security-sre/02-metrics-alerting-slos.md) — Prometheus/Grafana, the four golden signals, alert design
3. [Tracing & APM](module-12-observability-security-sre/03-tracing-apm.md) — OpenTelemetry in Laravel, Sentry, finding the slow query
4. [DevSecOps](module-12-observability-security-sre/04-devsecops.md) — supply chain, SAST/dependency/image scanning, secrets management & rotation
5. [SRE in Practice: Incidents & the Capstone](module-12-observability-security-sre/05-sre-incidents-capstone.md) — on-call, runbooks, postmortems, cost optimization, the full production checklist

---

## Learning paths

- **Complete path (recommended):** Modules 1 → 12 in order. Each module assumes the previous ones.
- **"I know Linux & Git" fast track:** skim Modules 2 & 4, start seriously at Module 5.
- **"Get me deploying containers" track:** Modules 5 → 9, then return to 10–12. Not recommended before reading Module 3 — you'll be configuring Nginx blind.

## Conventions used everywhere

| Placeholder | Meaning |
|---|---|
| `111122223333` | AWS account ID (replace with yours) |
| `ap-southeast-1` | AWS region used throughout (Singapore — pick your nearest) |
| `tickethub.example` | Production domain (replace with a real domain you own) |
| `github.com/tickethub/tickethub-api` | The application repository |
| `$` prefix | A command you run; lines without `$` are output |

⚠️ **Cost warning:** Modules 8–12 create AWS resources that bill by the hour (RDS, ALB, NAT gateways, EKS ≈ $0.10/hr for the control plane alone). Every hands-on section lists what it creates and ends with teardown instructions. Never leave lab infrastructure running overnight.
