# Module 6 — Docker & Containerization

Module 5 ended with an argument: environment parity is only achievable when the environment itself is a build artifact. This module makes TicketHub that artifact. You start at the kernel — namespaces, cgroups, and overlay filesystems, demonstrated with real commands rather than folklore — so that Docker is a tool you understand, not an incantation. Then you build the module's centerpiece: a production-grade, multi-stage Dockerfile that turns any Git commit into an immutable, non-root, healthcheck-equipped PHP-FPM image, with the nginx image that rides alongside it — the two-image pattern TicketHub carries all the way to ECS and Kubernetes. Local development moves onto Docker Compose: the full stack (app, nginx, MySQL, Redis, Horizon, scheduler, Mailpit for mail, MinIO for S3) in one declarative, versioned file, so `git clone && docker compose up` is the whole onboarding story. Finally, images get a home and a lifecycle: ECR, a tagging strategy where the Git SHA is the only deployable truth, lifecycle policies, and vulnerability scanning with a triage workflow.

Production still runs on the VPS — deliberately. Containerized production arrives in Module 9, once CI (Module 7) and AWS foundations (Module 8) exist to support it properly.

## Prerequisites

- Modules 1–5, especially Module 3 (nginx + PHP-FPM internals, opcache) and Module 5 (twelve-factor discipline: config in the environment, stateless processes, `Storage::`/stderr conventions)
- Docker Desktop (macOS/Windows) or Docker Engine 27+ (Linux)
- An AWS account for Lecture 6.4's ECR work (costs: cents; teardown included)

## Lectures

1. [Containers from First Principles](01-containers-from-first-principles.md) — namespaces, cgroups, and overlay layers demonstrated live; images vs containers; OCI standards; the container lifecycle; ports, volumes, and running TicketHub's backing services as containers
2. [A Production-Grade Dockerfile for Laravel](02-production-dockerfile-laravel.md) — the flagship: multi-stage builds, layer caching, `.dockerignore`, extensions and production ini as code, non-root, healthchecks, a signal-correct entrypoint, and the companion nginx image
3. [Docker Compose for Local Development](03-docker-compose-local-dev.md) — the full TicketHub dev stack as one file: dev build target with Xdebug, health-gated ordering, Horizon and scheduler as separate containers, Mailpit and MinIO for full backing-service parity
4. [Registries & the Image Lifecycle](04-registries-image-lifecycle.md) — ECR with immutable tags, the `sha-` tagging strategy, lifecycle policies, Trivy scanning and triage, base-image refresh, OCI provenance labels

## After this module you can…

- Explain precisely what a container is (and isn't), down to the kernel mechanisms, and debug containers from `inspect`, logs, and exit codes
- Build a production-ready Laravel image: multi-stage, cache-ordered, non-root, environment-free, gracefully stoppable, and measured with `docker history`
- Run and develop against the entire TicketHub stack with one command, at full engine-version parity with production and CI
- Operate a container registry like a production team: immutable SHA tags, re-tag releases without rebuilds, lifecycle policies, and a scanning workflow that fixes or documents — never ignores
