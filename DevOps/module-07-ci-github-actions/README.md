# Module 7 — Continuous Integration with GitHub Actions

Module 4 gave TicketHub a disciplined workflow — trunk-based development, reviewed PRs, a protected `main` — but left its central promise unpaid: "the tests pass" still means someone remembered to run them. This module builds the machine that keeps that promise automatically. Across four lectures you construct a single workflow, `ci.yml`, that verifies every change and packages every merge, turning the repository from a place where code waits into a pipeline that produces deployable artifacts.

You start with the two foundations everything else stands on: what continuous integration actually is as a practice, and GitHub Actions' precise execution model — events, jobs, runners, contexts, permissions, caching. Then the pipeline grows teeth: the `tests` job runs Pest in parallel against real MySQL 8.0 and Redis 7 service containers, because TicketHub's no-overselling invariant lives in row locks only a real database can exercise. The `quality` job adds the checks tests can't make — Pint for style, PHPStan/Larastan static analysis (which finds a real null-dereference bug in TicketHub's report code), and a layered dependency gate — and finally flips the switch Module 4 left waiting: `tests` and `quality` become required status checks on `main`. The closing lecture makes every merge produce an immutable, scanned, provenance-stamped image in ECR, authenticated to AWS via OIDC with no stored keys at all — the artifact Module 9 will deploy.

## Prerequisites

- Modules 1–6 completed — especially Module 4 (the PR workflow and branch ruleset this module enforces), Module 5 (config via environment), and Module 6 (the Dockerfiles, `compose.yaml`, and ECR repositories this module builds on)
- A GitHub account hosting the `tickethub-api` repo, with the `gh` CLI authenticated
- Docker Desktop (or Docker Engine 27+) and PHP 8.4 + Composer locally
- For Lecture 4 only: an AWS account with the Module 6 ECR repositories (`tickethub-api`, `tickethub-nginx`) and admin CLI access to create the OIDC provider and IAM role — nothing in this module bills by the hour

## Lectures

1. [CI Concepts & Workflow Anatomy](01-ci-concepts-workflow-anatomy.md) — CI as a practice vs "having a CI server"; events, jobs, runners, contexts, `permissions:` and `concurrency:`; cache vs artifacts; a first working workflow with a real check
2. [The TicketHub Test Pipeline](02-tickethub-test-pipeline.md) — MySQL/Redis service containers and the runner networking model, config without `.env`, parallel Pest with per-process databases, honest coverage gates, and a flaky-test policy
3. [Code Quality Gates](03-code-quality-gates.md) — Pint with a justified `pint.json`, PHPStan/Larastan with a level strategy and ratcheted baseline, `composer audit` + dependency review + Dependabot, and making `tests` and `quality` required checks without the "Expected — waiting" trap
4. [Building & Pushing Images in CI](04-building-images-in-ci.md) — OIDC to AWS with full trust and permissions policies, Buildx layer caching on fresh runners, metadata-driven `sha-` tagging, smoke tests and a Trivy gate before push, the module's complete `ci.yml`, and the `deploy.yml` stub for Module 9

## After this module you can…

- Explain the GitHub Actions execution model precisely — and debug the classic confusions: merge refs, fresh-VM jobs, empty secrets on fork PRs
- Run a Laravel test suite in CI against the same MySQL and Redis engines production uses, in parallel, with coverage enforced at an honest threshold
- Keep every workflow least-privilege (`permissions:`), cost-aware (`concurrency:`, caching), and fast enough that nobody batches changes
- Adopt static analysis on a real codebase without drowning in old errors, and govern the baseline so it only shrinks
- Enforce quality gates as required PR checks whose names, matching rules, and failure modes you actually understand
- Authenticate CI to AWS with OIDC — no long-lived keys — scoped to one repo, one branch, two ECR repositories
- Turn every merge to `main` into an immutable, scanned `sha-`-tagged image pair in ECR: the artifact continuous delivery will promote

**Next:** [Module 8 — AWS Cloud Fundamentals](../module-08-aws-fundamentals/)
