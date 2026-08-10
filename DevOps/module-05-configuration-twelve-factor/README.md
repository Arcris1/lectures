# Module 5 — Configuration & the Twelve-Factor App

After Modules 1–4, TicketHub runs on a hardened VPS and ships through a real Git workflow — but it is quietly unprepared for everything that comes next. Containers (Module 6), CI-built artifacts (Module 7), managed AWS services (Module 8), and multi-server deployments (Module 9 onward) all *assume* properties the app doesn't fully have yet: stateless processes, config in the environment, disposable workers, environments that actually resemble each other. This module installs those properties while every fix is still cheap.

Lecture 1 maps all twelve factors onto concrete Laravel 12 decisions and changes TicketHub for real: sessions, cache, and queues move fully onto Redis, file handling gets disciplined behind the `Storage` facade, logs flow to stderr, and the shutdown timeout chain gets aligned — with an honest critique of where the 2011 manifesto shows its age. Lecture 2 goes deep on the config layer itself: the `config:cache` trap that turns `env()` calls into production-only bugs, `.env` mechanics and `.env.example` discipline, `APP_KEY` rotation, secrets classification and lifecycle, and a fail-fast `config:validate` command every future deploy will run. Lecture 3 tackles dev/prod parity with reproducible war stories — SQLite-vs-MySQL, sync-vs-Redis — makes the local-stack decisions, builds rich synthetic seed data, and sets staging's rules before staging exists.

The module ends with an explicit argument: config discipline closes most parity gaps, and the remainder — OS, PHP build, service versions — is exactly why containers are next.

## Prerequisites

- Modules 1–4 completed: TicketHub running locally and on the Module 3 VPS, with Module 2's systemd worker unit and Module 4's PR workflow in place
- SSH access to the VPS as the `deploy` user; comfort with `systemctl` and `journalctl`
- PHP 8.4 + Composer locally — no Docker or AWS account needed yet (this is the last laptop-and-VPS-only module)

## Lectures

1. [The Twelve-Factor App, Applied to Laravel](01-twelve-factor-laravel.md) — all 12 factors mapped to concrete Laravel 12 decisions; sessions, cache, and queues move to Redis; `Storage` facade discipline; the worker timeout chain; an honest critique of the manifesto's age
2. [Environment Config & Secrets Hygiene](02-environment-config-secrets.md) — how Laravel config actually works and the `config:cache` bug it hands every team once; `.env` and `.env.example` discipline; `APP_KEY` rotation with `APP_PREVIOUS_KEYS`; `APP_DEBUG` leaks; the secrets maturity ladder; a fail-fast `config:validate` command
3. [Environment Parity](03-environment-parity.md) — the three environments and their contracts; SQLite-vs-MySQL and sync-vs-Redis drift reproduced with real errors; Mailpit, S3, and seed-data strategy; the production-data rule; staging discipline and preview environments; why the remaining gaps demand containers

## After this module you can…

- Audit any application against the twelve factors and name the concrete fix — and the cost — for each violation
- Run Laravel's sessions, cache, and queues on Redis and reason about eviction policy, rate-limiter scope, and the job-timeout chain
- Explain the full path from `.env` to `config()`, debug "config isn't changing" in minutes, and never ship an `env()`-outside-`config/` bug again
- Classify secrets versus plain config, store each correctly per environment, and rotate `APP_KEY` without logging users out
- Make deploys fail fast on missing or unsafe config with a custom `config:validate` command
- Reproduce and fix classic parity bugs — strict-MySQL migration failures and queue serialization races — and configure mail and storage to differ by transport only
- Seed a rich synthetic local world with factories, and defend the rule that production data never leaves production

**Next:** [Module 6 — Docker & Containerization](../module-06-docker/)
