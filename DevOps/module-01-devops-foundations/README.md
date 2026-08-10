# Module 1 — DevOps Foundations

Before this course touches a server, a container, or a single line of YAML, it fixes the mental model. DevOps is routinely reduced to a toolchain or a job title; this module establishes what it actually is — a way of organizing the work of building *and running* software so that both get better — and why every tool in Modules 2–12 exists as an answer to a specific, nameable pain.

You'll start inside the pre-DevOps world: two teams with opposing scoreboards, a wall of confusion between them, and a Friday-night TicketHub deploy that goes exactly as badly as that structure guarantees. From there you'll map the full software delivery lifecycle, learn why batch size and feedback loops dominate everything else, and practice value stream mapping on a real feature. You'll then meet TicketHub properly — the Laravel 12 event-ticketing API this entire course evolves — boot it on your laptop, read the row-locking reservation code that must never oversell, and experience three concrete mechanisms behind "works on my machine." Finally, you'll learn the four DORA metrics, the research showing speed and stability are allies rather than enemies, and compute TicketHub's ugly baseline numbers — the ones the next eleven modules exist to beat.

**Prerequisites:** none within the course — this is the starting line. You should be able to read PHP and have seen a Laravel app before, and for the hands-on work you need a terminal (macOS/Linux or Windows + WSL2) with Git, PHP 8.4, and Composer installed. Read [`TICKETHUB.md`](../TICKETHUB.md) first — it defines the app, pinned versions, and naming used everywhere.

## Lectures

1. [What DevOps Actually Is](01-what-is-devops.md) — the dev/ops incentive war, a Friday-night deploy disaster, the 2008–2009 origins, CALMS, DevOps vs SRE vs platform engineering, and the adoption anti-patterns.
2. [The Software Delivery Lifecycle](02-software-delivery-lifecycle.md) — waterfall to continuous delivery as shrinking batches, the eight lifecycle stages mapped to this course's modules, shift-left, deploy vs release, and value stream mapping with real numbers.
3. [Meet TicketHub](03-meet-tickethub.md) — the domain and its overselling invariant, the reservation transaction, jobs and scheduler, a naive first boot on SQLite, and three true stories of "works on my machine."
4. [Measuring DevOps: DORA Metrics](04-measuring-devops-dora.md) — the four key metrics plus reliability, benchmark tiers, why speed and stability correlate, honest measurement with GitHub and PHP, Goodhart's law, and TicketHub's baseline and targets.

## After this module you can…

- Explain DevOps as culture, practices, and tooling that shorten the loop from idea to production and back to insight — and spot the anti-patterns (third-silo "DevOps teams," renamed ops, tools without incentive change)
- Name all eight delivery lifecycle stages, their artifacts, and the module of this course that automates each for TicketHub
- Build a value stream map from real timestamps, compute flow efficiency, and identify the wait state to attack first
- Run TicketHub locally, explain its row-locking reservation invariant, and articulate exactly why "works on my machine" happens — version drift, undeclared extensions, unequal queue drivers
- Define and compute deployment frequency, lead time for changes, change failure rate, and time to restore, place a team against the DORA benchmark tiers, and defend why deploying *more* often improves stability
- State TicketHub's baseline delivery numbers and the targets this course will reach, with a measurement approach that favors consistent trend over perfect precision

## What's next

[Module 2 — Linux & the Command Line](../module-02-linux-command-line/) begins the hands-on climb: the shell, users and permissions, systemd, and SSH hardening — the substrate every later module stands on.
