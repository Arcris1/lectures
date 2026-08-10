# Module 9 — Continuous Delivery & Deployment Strategies

Module 8 ended with a working staging stack and a pain audit: five ways manual deployment hurt, each with a named fix. This module collects that debt. It turns "deployment" from a task someone performs into a property of the system — one reviewed path to every environment, one immutable artifact promoted through it, zero downtime while it happens.

You'll start with doctrine: delivery vs deployment, build-once-promote-everywhere, GitHub Environments enforcing the PR→CI, `main`→staging, tag-`v*`→production model, and environment-scoped OIDC trust. Then the craft: what a *correct* deploy must do, taught on the classic VM model with Deployer 7 — atomic releases, worker restarts, and the module's most production-critical skill, expand/contract migrations under live traffic. Then the machine: TicketHub moves to ECS Fargate, Module 7's `sha-` images deploy automatically from GitHub Actions with migration gating, circuit-breaker rollback, and a version-asserting smoke test — and the EC2 pair is terminated for good. Finally, the strategy toolbox: blue/green with CodeDeploy, canary releases, and feature flags with Laravel Pennant, closing Module 1's DORA loop.

**Prerequisites:** Modules 1–8 — especially the Module 8 staging stack (VPC, RDS, ElastiCache, ALB, Route 53) left running, Module 7's completed `ci.yml` pushing `sha-` tagged images to ECR, and Module 6's production images. AWS CLI configured; `gh` CLI authenticated. ⚠️ Fargate services bill while running (~$69/mo at staging size; every lecture includes cost notes and pause/teardown steps).

## Lectures

1. [CD Concepts, Environments & Promotion](01-cd-concepts-environments.md) — delivery vs deployment, the pipeline as the only path to production, GitHub Environments and environment-scoped OIDC, deployment history as the DORA audit trail
2. [Zero-Downtime Laravel Deploys](02-zero-downtime-laravel-deploys.md) — atomic releases with Deployer 7, opcache and worker-restart discipline, and expand/contract migrations under live traffic
3. [Containerized CD: ECS Fargate](03-ecs-fargate-pipeline.md) — task definitions, the three TicketHub services, migration-gated rolling deploys, the complete `deploy.yml`, autoscaling, and the EC2 funeral
4. [Progressive Delivery](04-progressive-delivery.md) — blue/green via CodeDeploy, canary releases with real comparison metrics, feature flags and kill switches with Laravel Pennant, and the per-change decision framework

## After this module you can…

- Design a promotion model where every artifact is built once, proven in staging, and promoted — never rebuilt — to production
- Enforce that model with GitHub Environments, tag policies, required reviewers, and OIDC trust keyed to environment sub claims
- Deploy a Laravel app to VMs with zero downtime, and ship any schema change safely under live traffic with expand/contract
- Run TicketHub on ECS Fargate with fully automated, health-checked, auto-rolling-back deploys from GitHub Actions
- Operate migrations as a release-phase singleton, debug containers with ECS Exec, and autoscale for both surprises and scheduled on-sales
- Choose rolling, blue/green, canary, or feature flags per change — and use Pennant flags to release, degrade, and recover without deploying

Next: [Module 10 — Infrastructure as Code with Terraform](../module-10-terraform-iac/) turns everything built by hand in Modules 8–9 into reviewed, versioned code — and finally provisions production.
