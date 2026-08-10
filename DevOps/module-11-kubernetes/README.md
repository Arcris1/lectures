# Module 11 — Kubernetes

TicketHub already ships to production on ECS Fargate with zero-downtime deploys, Terraform-managed infrastructure, and a full CI/CD pipeline — and that is a perfectly respectable place to stop. This module explains honestly why the course doesn't stop there: Kubernetes is the industry's shared platform layer, the ecosystem Module 12's observability stack rides on, and the skill the job market keeps asking for. You'll earn it the hard way — by understanding it, not just pasting YAML.

You start on a free, disposable **kind** cluster on your laptop and learn the one idea everything else hangs off: declarative reconciliation, the continuous cousin of Module 10's plan/apply. Then you translate every piece of TicketHub's ECS setup into real manifests — the two-container web pod, Horizon, the scheduler CronJob, probes, graceful shutdown, migrations as a Job. Next you move to **EKS**, provisioned from a Terraform PR, with IRSA, the AWS Load Balancer Controller, external-dns, External Secrets, and Karpenter. Finally you package it all as a Helm chart and hand deployment itself to **Argo CD**, closing the course's platform arc with GitOps.

⚠️ Lectures 1–2 are free (kind). Lectures 3–4 create real AWS resources (EKS ≈ $0.10/hr control plane plus nodes, ALB, NAT — roughly $260+/mo if left running). Every hands-on section includes teardown steps.

## Prerequisites

- Modules 1–10 — especially Module 6 (the two-image nginx + php-fpm pattern), Module 9 (ECS deploys, release phases, promotion gates), and Module 10 (Terraform modules, remote state, the `tickethub-infra` repo).
- Docker Desktop running locally; `kubectl`, `kind`, and Helm 3.16+ installed; AWS account + Terraform CLI for lectures 3–4.

## Lectures

1. [Why Kubernetes & Core Concepts](01-kubernetes-core-concepts.md) — the honest case for (and against) Kubernetes, architecture, the reconciliation loop, core objects, and TicketHub's first pods on a local kind cluster.
2. [TicketHub on Kubernetes](02-tickethub-on-kubernetes.md) — the full ECS→K8s translation: web, Horizon, scheduler CronJob, resources, probes, graceful shutdown, config, migrations, Ingress, and HPA.
3. [EKS in Production](03-eks-production.md) — `tickethub-prod-eks` born from a Terraform PR: IRSA, ALB controller, external-dns, External Secrets Operator, Karpenter, Spot, and the real monthly bill.
4. [Helm & GitOps with Argo CD](04-helm-gitops-argocd.md) — templating the manifests into `helm/tickethub`, migration hooks, and pull-based deployment where a git merge is the deploy.

## After this module you can…

- Explain when Kubernetes earns its complexity over ECS — and when it doesn't.
- Read and write production-quality manifests: Deployments, Services, Ingress, Jobs, CronJobs, ConfigMaps/Secrets, and HPA.
- Set resource requests/limits and probes that prevent incidents instead of causing them.
- Provision and operate an EKS cluster from Terraform, with IRSA for pod-level AWS access and External Secrets for config.
- Package an app as a Helm chart with per-environment values and migration hooks.
- Run GitOps with Argo CD: automated staging sync, gated production promotion, drift self-healing, rollback by `git revert`.
