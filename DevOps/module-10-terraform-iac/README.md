# Module 10 — Infrastructure as Code with Terraform

Module 8 built TicketHub's staging environment by hand: forty CLI commands, IDs copied into tables, and a record that exists only as lecture notes. This module fixes that permanently. You'll learn Terraform from first principles — with **state** as the load-bearing concept and plan-reading as the career-saving skill — then do what real teams do: **adopt** the live staging stack via imports without recreating or restarting anything, refactor it onto reusable modules with `moved` blocks (zero infrastructure changes, proven by the plan), and finally deliver the module's narrative payoff: **production, created entirely from code** — the same modules as staging with different values, unblocking Module 9's disabled production deploy job. The finale gives infrastructure the same delivery discipline application code got in Modules 7–9: plans posted on PRs as review artifacts, tflint and Checkov gating merges, environment-approved applies, and nightly drift detection that files its own issues.

**Prerequisites:** Modules 1–9 — especially the live staging stack from Module 8 (VPC, RDS, ElastiCache, S3) upgraded by Module 9 (ECS Fargate, GitHub Actions OIDC deploys, environment approvals), an AWS account, and Terraform CLI ≥ 1.9. ⚠️ Applying production costs real money (~$470/mo); teardown notes are included.

## Lectures

1. [Terraform Fundamentals](01-terraform-fundamentals.md) — the case for IaC, HCL, state deep-dive, reading plans, and bootstrapping `tickethub-infra` with S3 remote state
2. [Terraforming TicketHub: Network & Data Layer](02-terraforming-tickethub-network-data.md) — staging's VPC, RDS, Redis, and S3 as complete HCL, adopted live via import blocks
3. [Modules, Environments & Remote State](03-modules-environments-remote-state.md) — reusable modules, `moved`-block refactoring, state operations, and production applied for real
4. [Terraform in CI & Policy](04-terraform-in-ci-policy.md) — plan-on-PR, apply-on-merge with approvals, policy scanning, and scheduled drift detection

## After this module you can…

- Explain Terraform state, the plan/apply contract, and why state is a secret
- Read any plan line by line and catch a destroy-and-recreate before it ships
- Adopt live, hand-built infrastructure into Terraform with imports until the plan is clean
- Design right-sized, environment-agnostic modules with opinionated security defaults
- Stand up (and tear down) an entire production environment with one command
- Run Terraform through a PR-gated CI pipeline with linting, policy checks, protected applies, and drift detection
