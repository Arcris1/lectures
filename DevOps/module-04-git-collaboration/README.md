# Module 4 — Git & Collaboration Workflows

Through Modules 1–3 you used Git as a copy mechanism: commit on your laptop, `git pull` on the VPS, hope for the best. That is fine for one person and fatal for a team. This module turns Git into what it actually is on real teams: the collaboration and release backbone that every later piece of automation attaches to.

You start with the mental model most Git users never build — the object database, the three areas, branches as pointers — because it makes conflicts, resets, and "lost" work stop being scary. Then you make the decisions a team must make once and stick to: a branching strategy (TicketHub adopts trunk-based development with GitHub Flow mechanics), a pull request and review process enforced by branch protection and CODEOWNERS, and a versioning and release convention built on conventional commits, SemVer, and annotated tags.

These aren't isolated skills. Module 7 wires CI to the PR workflow you configure here, and Module 9 wires deployments to the branches and tags you standardize here — merge to `main` deploys staging, tag `v1.4.2` deploys production. Get the conventions right now and the automation later is almost boring.

## Prerequisites

- Modules 1–3 completed: TicketHub running locally and on the VPS, comfortable in a shell
- Git 2.40+ installed and configured (`user.name`, `user.email`)
- A free GitHub account — required from Lecture 3 onward (branch protection, CODEOWNERS, `gh` CLI)
- The `tickethub-api` repo cloned locally (`~/code/tickethub-api` in all examples)

## Lectures

1. [Git Fundamentals](01-git-fundamentals.md) — the object model, the three areas, branches and merges, a real conflict in TicketHub code, the undo taxonomy, reflog rescue, and Laravel's `.gitignore`
2. [Branching Strategies](02-branching-strategies.md) — GitFlow vs GitHub Flow vs trunk-based development, feature flags in Laravel, rebase vs merge, and TicketHub's strategy decision
3. [Pull Requests & Code Review](03-pull-requests-code-review.md) — small PRs, review culture and priorities, a real PR template, branch protection rulesets, and CODEOWNERS on `tickethub-api`
4. [Versioning & Releases](04-versioning-and-releases.md) — SemVer, conventional commits, annotated tags, changelogs, release-please, and TicketHub's tag-driven release convention

## After this module you can…

- Explain what Git actually stores and predict what any command will do to the working tree, index, and history
- Resolve merge conflicts calmly and recover "lost" work with the reflog
- Run a trunk-based workflow: short-lived branches, feature flags, rebase + `--force-with-lease`, squash merges onto an always-releasable `main`
- Write reviewable PRs, review others' code in priority order, and keep review culture healthy
- Enforce the workflow with branch protection rulesets, required approvals, and CODEOWNERS
- Cut a release the professional way: conventional commits → computed SemVer → annotated tag → published release notes

**Next:** [Module 5 — Configuration & the Twelve-Factor App](../module-05-configuration-twelve-factor/)
