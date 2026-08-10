# Module 12 — Observability, Security & SRE

Everything the course has built so far answers "how do we ship?" This final module answers the harder question: "how do we *run* it?" TicketHub sits on EKS with GitOps, Terraform-born infrastructure, and progressive delivery — but a platform you cannot see into, defend, or operate under pressure is a liability, not an asset.

The module builds operational capability in layers. First the three observability signals: structured JSON logs with correlation IDs that survive the trip through Horizon; Prometheus metrics, Grafana dashboards, and alerts that page on user-visible symptoms only — anchored by SLOs and error budgets that make Module 1's speed-vs-stability bargain mechanical; and distributed traces that show where the time went across nginx, PHP-FPM, MySQL, Redis, and S3. Then security as a pipeline property: supply-chain controls from dependency and image scanning through SBOMs, signing, and runtime hardening with NetworkPolicies and a WAF. Finally, SRE as a practice: humane on-call, incident response with a fully worked SEV1 during a stadium on-sale, a blameless postmortem written out in full, runbooks, gamedays, load testing, cost review — and the capstone: a production-readiness checklist distilling all twelve modules, which you can apply to any application you own.

This is where the DORA metrics from Module 1 get remeasured, and where the course's promise is kept with receipts.

⚠️ The hands-on sections run on the existing `tickethub-prod-eks` cluster plus modest extras (Prometheus stack storage, CloudWatch ingest, WAF). Costs are flagged per lecture, with teardown steps.

## Prerequisites

- Modules 1–11 — especially Module 7 (CI, OIDC, image builds), Module 8 (RDS/ElastiCache/S3 and the documented Redis `noeviction` trade-off), Module 9 (progressive delivery, feature flags), Module 10 (Terraform), and Module 11 (EKS, Helm, Argo CD).
- A running `tickethub-prod-eks` cluster (or the staging equivalent) with the Module 11 GitOps flow in place; `kubectl` and Helm 3.16+ locally.

## Lectures

1. [Structured Logging & Aggregation](01-structured-logging-aggregation.md) — JSON logs from Laravel with Monolog, request-scoped `Context` and correlation IDs through queues, Fluent Bit → CloudWatch Logs, and Logs Insights queries that reconstruct one order's life in seconds.
2. [Metrics, Alerting & SLOs](02-metrics-alerting-slos.md) — Prometheus and the golden signals, instrumenting Laravel honestly, PromQL, Grafana dashboards as craft, symptom-based alerting, SLOs, error budgets, and multi-window burn-rate alerts — closing with the DORA remeasurement.
3. [Tracing & APM](03-tracing-apm.md) — OpenTelemetry in Laravel with context propagated through Horizon queues, sampling, the Collector, Tempo, Sentry for error tracking, and the full logs↔metrics↔traces correlation payoff.
4. [DevSecOps](04-devsecops.md) — threat-modeling the delivery system, dependency and secret hygiene, SAST, pipeline hardening, SBOMs and image signing verified at admission, runtime hardening with SecurityContexts and NetworkPolicies, WAF, and the OWASP API Top 10 mapped to Laravel.
5. [SRE in Practice: Incidents & the Capstone](05-sre-incidents-capstone.md) — on-call, incident response, a fully worked on-sale SEV1 with its complete blameless postmortem, runbooks, gamedays, load testing, cost review, and the production-readiness checklist that caps the course.

## After this module you can…

- Emit, aggregate, and query structured logs that turn a support ticket into a one-query investigation.
- Instrument a Laravel app with Prometheus metrics, design Grafana dashboards an executive can read, and write alerts that only fire when users are hurting.
- Define SLIs, SLOs, and error budgets — and run multi-window burn-rate alerting as the modern paging discipline.
- Trace a request from nginx through PHP-FPM, MySQL, Redis, and a Horizon worker, and correlate traces with logs and metrics in one investigation.
- Secure the delivery pipeline end to end: dependencies, secrets, images, signatures, runtime policies, and the network.
- Run incidents like a practiced team: severity, roles, mitigation-first response, blameless postmortems, and runbooks that work at 3 a.m.
- Audit any application against a production-readiness checklist built from the entire course.

**You've finished the course** — the [production-readiness checklist in Lecture 12.5](05-sre-incidents-capstone.md) is the artifact to take with you: apply it to your own application next.
