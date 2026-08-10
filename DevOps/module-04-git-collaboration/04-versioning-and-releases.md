# Lecture 4.4 — Versioning & Releases

> **Module 4 — Git & Collaboration Workflows** · Lecture 4 of 4 · Estimated time: ~60 min

TicketHub's `main` is now a clean sequence of squash-merged, reviewed commits. One question remains, and it sounds bureaucratic until the first production incident makes it existential: **which exact state of the code is running in production, and what do we call the one we want next?** "Whatever was on `main` on Tuesday-ish" is not an answer you can roll back to, put in a changelog, or tell a support engineer.

This lecture gives changes *names*: Semantic Versioning for meaning, conventional commits so machines can compute the next name, annotated tags to pin names to SHAs, changelogs and GitHub Releases to communicate them. It ends by pinning TicketHub's release convention — the one Module 9 wires into production deploys, where pushing tag `v1.4.2` *is* the deploy.

## Learning objectives

- Justify versioning as an operational tool: rollback targets, changelogs, support windows, communication
- Apply SemVer precisely, including pre-release identifiers, build metadata, and 0.x semantics
- Decide what counts as a breaking change for an HTTP API, and when `/api/v1` must become `/v2`
- Write conventional commits fluently, and enforce the format via PR titles under squash-merge
- Create, inspect, and push annotated tags as immutable release pointers
- Explain TicketHub's full release flow: conventional commits → release-please → annotated tag → deploy

## 1. Why version at all?

A web app deploys continuously — why name versions when there's no box to print them on? Because a version is a *shared coordinate*, and four groups need one:

- **Operators need rollback targets.** "Roll back to v1.4.1" is a command; "roll back to before Priya's thing" is a séance. When Module 9 automates deploys, the version is literally the deployment parameter, and the Docker image carries the same name (`TICKETHUB.md` pins image tags to Git SHAs and `v*` release tags).
- **Humans need a communication unit.** "The QR fix ships in v1.4.3" coordinates support, QA, and the waiting customer — without anyone reading diffs.
- **Changelogs need boundaries.** A changelog is the diff between two versions in human language; without named versions there is nothing to write between.
- **Consumers need contract signals.** Anyone integrating with your API needs to know which changes are safe to absorb and which will break them. That signal is the version number's *semantics* — the next section.

Versioning is cheap. Debugging *which* code produced a corrupted PDF batch three weeks ago, without versions, is not.

## 2. SemVer, precisely

[Semantic Versioning](https://semver.org) gives version numbers grammar: **MAJOR.MINOR.PATCH**, judged against your *declared public API*:

- **MAJOR** (`1.4.2` → `2.0.0`) — you broke the contract. Consumers must change something before upgrading.
- **MINOR** (`1.4.2` → `1.5.0`) — you added capability, backward-compatibly. Upgrading is safe; new things exist.
- **PATCH** (`1.4.2` → `1.4.3`) — you fixed behavior, backward-compatibly. Upgrading is safe and changes nothing you relied on (unless you relied on the bug).

The rarer corners, precisely:

- **Pre-release identifiers**: a hyphen and dot-separated tokens — `2.0.0-rc.1`, `1.5.0-beta.3`. Pre-releases sort *before* their release (`2.0.0-rc.1 < 2.0.0`) and carry no stability promise. Useful when staging needs a name before production commits to one.
- **Build metadata**: a plus suffix — `1.4.2+build.2026.08.09` or `1.4.2+sha.a7d3e9f`. *Ignored entirely* for precedence; two versions differing only in metadata are the same version. Handy for traceability, never for meaning.
- **0.x semantics**: major version zero means "no stable public API exists; anything may change at any time." `0.7.0 → 0.8.0` may break everything, legally. The corollary: the moment real consumers depend on you, staying on 0.x is not humility, it's an unpriced risk you're exporting to them. Ship 1.0.0.

The point people miss: SemVer is a **promise about compatibility, not size**. A one-line change renaming a JSON field is MAJOR; six months of internal refactoring that changes nothing observable is PATCH. Which forces the real question: what exactly is TicketHub's "public API"?

## 3. What "breaking" means for an HTTP API

TicketHub's public API is its HTTP surface: the routes under `/api/v1`, their request/response shapes, and their semantics. Against that contract:

**Breaking (MAJOR):** removing or renaming a response field (`total` → `total_cents`); changing a field's type (`"price": "25.00"` → `25.00`) or format (IDs from int to UUID); changing a status code's meaning (201 → 200 on order creation, or a validation failure moving from 422 to 400); adding a *required* request field; removing an endpoint; tightening validation so previously accepted requests now fail; changing auth requirements. The test is brutal and simple: **could a correctly written existing client break?** If yes, it's breaking — your intentions are irrelevant.

**Non-breaking (MINOR/PATCH):** adding endpoints; adding *optional* request parameters; adding response fields (well-behaved clients ignore unknown fields — say this explicitly in your API docs so it's a contract, not a hope); fixing behavior to match documentation.

This is why TicketHub's routes carry `/v1` in the URI. **URI versioning** puts the contract's major version in the address, so a breaking change doesn't have to be a betrayal: ship the new contract at `/api/v2` *alongside* `/v1`, run both, let consumers migrate on their timeline. Bump to `/v2` only for genuinely unavoidable breaks — and prefer evolution first: add `total_cents` next to `total`, document the deprecation, remove `total` only in `/v2`. Every `/vN` you operate is a surface you maintain, test, and (Module 12) monitor — mint new ones reluctantly.

**Two different axes, one number each.** Keep these separated in your head:

- **App version** (`v1.4.2`, a Git tag): names a *deployable state of the codebase*. It moves constantly — every release. It's the currency of deploys and rollbacks.
- **API version** (`/api/v1`, a URI segment): names a *contract with consumers*. It moves rarely — years apart, ideally never.

They interact at exactly one point: an app release whose changes break the HTTP contract is a MAJOR app version — and under TicketHub's policy, that same change must ship the new contract as `/v2` rather than mutating `/v1` in place. App v2.0.0 serves both `/v1` (unchanged) and `/v2` (new).

## 4. Conventional commits: making history machine-readable

You've seen `feat(orders): support promo codes at checkout` since Lecture 4.2. The [Conventional Commits](https://www.conventionalcommits.org) spec formalizes it:

```text
<type>[optional scope][!]: <description>

[optional body]

[optional footer(s)]
```

The types, and what they mean for versioning:

| Type | Meaning | SemVer effect |
|---|---|---|
| `feat:` | New capability visible to users/consumers | **MINOR** |
| `fix:` | Corrects wrong behavior | **PATCH** |
| `perf:` | Performance improvement, no behavior change | PATCH (by convention) |
| `refactor:` | Code change, no behavior change | none |
| `docs:` | Documentation only | none |
| `test:` | Tests only | none |
| `ci:` | CI/pipeline configuration | none |
| `chore:` | Maintenance that fits nowhere else (deps, tooling) | none |
| *any type* with `!` or a `BREAKING CHANGE:` footer | Breaks the contract | **MAJOR** |

The grammar in full: a **scope** in parentheses narrows the area — `feat(orders):`, `fix(tickets):`, `ci(deploy):`; TicketHub scopes by domain (`orders`, `events`, `tickets`, `api`) rather than by directory. A **`!`** before the colon flags a breaking change in the subject — `feat(api)!: remove deprecated total field from order payloads` — and/or a footer spells it out with migration guidance:

```text
feat(api)!: remove deprecated total field from order payloads

The total field (string, dollars) has been deprecated since v1.3.0 in
favor of total_cents (integer). Serving both doubled serialization cost
on order lists.

BREAKING CHANGE: order payloads no longer include `total`. Read
`total_cents` instead; divide by 100 for display.
Refs: #171
```

**The payoff — why the rigid format is worth it:** history becomes *data*. A machine can scan every commit since the last release and mechanically derive the next version (any breaking → MAJOR; else any `feat` → MINOR; else any `fix` → PATCH) and a grouped changelog (Features / Bug Fixes / Breaking Changes) with zero human recall of "what did we ship this month?" Sections 7–8 cash this cheque. Underneath, Lecture 4.1's human rules still apply — imperative mood, explanatory body, 72-column wrap; conventional commits only standardize the subject's first tokens.

## 5. Enforcing the format — lightly

An unenforced convention decays in a month. But heavy enforcement is unnecessary, because TicketHub squash-merges: **the PR title becomes the commit subject on `main`**, so only PR titles need policing — messy WIP commits inside branches are squashed away, exactly as intended. Two mechanisms:

- **PR-title check (TicketHub's choice):** the GitHub Action **`amannn/action-semantic-pull-request`** validates the PR title against the spec and fails the check on `fet(orders):` typos or missing types. We add it to CI in Module 7 alongside the other required checks. One setting makes this airtight — in **Settings → General → Pull Requests**, set the default squash commit message to **"Pull request title"**, so the validated title is *verbatim* what lands on `main`.
- **commitlint (mention, not adopted):** teams that merge-commit or rebase-merge need every commit valid, so they run `commitlint` (usually via a `husky` Git hook and again in CI). More coverage, more friction; unnecessary under squash-merge.

Lightweight is the point: one green check on the PR, zero ongoing ceremony.

## 6. Tags: immutable release pointers

A branch is a pointer that moves; a **tag** is a pointer that doesn't. Git has two kinds, and the difference matters:

- **Lightweight tag** (`git tag v1.0.0`): just a ref file containing a commit SHA — a sticky note. No author, no date, no message.
- **Annotated tag** (`git tag -a`): a full object in the database (the fourth object type from Lecture 4.1) with tagger, date, message, and optionally a GPG/SSH signature. It records *who declared this a release, when, and why*.

**Releases always get annotated tags.** A release is an accountable act, and the annotation is its record — `git tag -a v1.4.2 -m "…"` is the form to burn into muscle memory. Tags aren't pushed by default; push them explicitly and deliberately (`git push origin v1.4.2` — avoid `--tags`, which shoves every stray local tag to the shared repo).

And the iron rule: **a pushed tag is immutable — never move or reuse one.** Git *lets* you delete and recreate a tag at a different commit; doing so makes "v1.4.2" mean different things to different clones, CI caches, and the Docker images already labeled with it (a moved tag severs image-to-source traceability). If a release is bad, it stays bad under its name; ship `v1.4.3`. Version numbers cost nothing; ambiguity about what production ran costs incidents.

## 7. Changelogs and GitHub Releases

A changelog answers "what changed between vX and vY?" for humans. Two schools:

- **Hand-curated, in the [Keep a Changelog](https://keepachangelog.com) format:** a `CHANGELOG.md` with a section per version and categorized entries (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`), plus an `Unreleased` section that PRs append to. Maximum reader value, ongoing writer discipline.
- **Generated from conventional commits:** tooling groups commits since the last tag by type into release notes automatically. Zero marginal effort — and here is the honest take: **a generated changelog is exactly as good as your commit discipline, no better.** Feed it `fix: stuff` and it dutifully publishes "stuff". Teams adopt generation believing it removes the writing work; it actually *relocates* the work into writing PR titles a customer could read. That's a good trade — the title gets written anyway, reviewed anyway (Lecture 4.3), and validated by the section 5 check — but it is a trade, not magic.

**GitHub Releases** wraps a tag with rendered notes and artifacts at a stable URL, and can autogenerate notes from merged PRs (`gh release create v1.4.2 --generate-notes`) — including first-time-contributor callouts and a full-changelog diff link. TicketHub uses generated notes, lightly edited when a release warrants prose (breaking changes always warrant prose).

## 8. Release automation: release-please

The end state (concept now, wiring in Module 9) is that nobody computes versions at all. **[release-please](https://github.com/googleapis/release-please)** — via `googleapis/release-please-action` — runs on every push to `main` and maintains a standing **release PR**:

1. It scans conventional commits since the last release tag.
2. It opens (or updates) a PR titled e.g. `chore(main): release 1.5.0` — the computed next version — containing the changelog additions and version-file bumps.
3. The release PR simply *accumulates* as more feature PRs merge; the proposed version ratchets up if a `feat` or `!` lands.
4. **Merging the release PR is the release**: the bot creates the annotated tag `v1.5.0` and the GitHub Release with notes.

Releasing becomes a reviewed, one-click decision — in the same PR flow as everything else, changelog reviewable *before* publication. And because releases are just tags, Module 9 closes the loop: **tag `v*` → production deploy**. The human act of releasing TicketHub will be: merge the release PR.

## 9. Hotfixes under trunk-based development

Production runs `v1.4.2`; a bug surfaces: QR codes with apostrophes render corrupted PDFs. GitFlow answers with a `hotfix/` branch off the release. Trunk-based development answers: **roll forward.**

Fix it on `main` like any change — branch `fix/171-qr-encoding`, PR, review, squash-merge — then release immediately: release-please computes `v1.4.3`, the tag deploys. No special branch, no separate process, no back-merge to forget. This works only because of discipline already built: `main` is always releasable (Lecture 4.2), so whatever else merged since `v1.4.2` is safe to ship with the fix. If something on `main` isn't shippable, the branching strategy — not the hotfix process — already failed; that's what flags were for.

**When is a true cherry-pick warranted?** When you must patch an *old* version while `main` has moved past it incompatibly — which requires a reason to keep old versions alive at all: parallel supported majors (`v1.x` under contract while `main` is v2), on-prem/mobile artifacts you can't force-upgrade, or a regulated release freeze. Then you maintain a `release/1.x` branch, `git cherry-pick` the fix commit onto it (Lecture 4.1's model says: *replay* the change as a new commit), and tag `v1.4.3` from that branch. TicketHub — one production, continuously delivered — should never need this. If you find yourself cherry-picking regularly, your releases are drifting away from `main`, and the root cause is upstream in your strategy.

## 10. TicketHub's release convention — pinned

The convention the rest of the course builds on, in one box:

> **TicketHub releases.**
> 1. PR titles follow **conventional commits**, enforced by a PR-title check; **squash-merge** puts the title on `main` verbatim.
> 2. **release-please** watches `main`, maintains the release PR, and computes the next **SemVer** version from commit types.
> 3. Merging the release PR creates an **annotated tag** `vX.Y.Z` and a GitHub Release with generated notes.
> 4. (Module 9) `main` auto-deploys to **staging**; pushing tag `v*` deploys to **production**. The tag *is* the deploy trigger and the rollback vocabulary.
> 5. Breaking HTTP-contract changes ship as **`/api/v2`** alongside `/v1` — never as in-place mutations of `/v1`.
> 6. Hotfixes **roll forward** from `main`. No release branches unless we someday support parallel majors.

## Hands-on with TicketHub

Two parts: cut TicketHub's first real release, then do the version arithmetic that release-please will soon do for you.

**Part 1 — v1.0.0.** The repo has shipped to a VPS for three modules with no named version — the state currently deployed becomes 1.0.0 (per SemVer: consumers exist, so 0.x time is over). Tag the merge commit of PR #152:

```bash
$ git switch main && git pull
Already up to date.
$ git log --oneline -2
a7d3e9f (HEAD -> main, origin/main) feat(orders): support promo codes at checkout (#152)
f1e2d3c chore: add PR template, CODEOWNERS, and main ruleset (#151)

$ git tag -a v1.0.0 -m "TicketHub 1.0.0

First named release. Everything deployed through Module 3 plus the
promo-codes groundwork (dark, flag off). Baseline for all future
version arithmetic."

$ git show v1.0.0 --no-patch
tag v1.0.0
Tagger: Alex Cruz <alex@tickethub.example>
Date:   Sun Aug 9 17:40:12 2026 +0800

TicketHub 1.0.0
...
commit a7d3e9f2c1b4d6e8f0a2c4e6b8d0f2a4c6e8b0d2 (HEAD -> main, tag: v1.0.0, origin/main)
```

Prove the lightweight/annotated difference with Lecture 4.1's object tools:

```bash
$ git tag throwaway
$ git cat-file -t throwaway    # lightweight: the ref points straight at a commit
commit
$ git cat-file -t v1.0.0       # annotated: a real tag object wrapping the commit
tag
$ git tag -d throwaway
Deleted tag 'throwaway' (was a7d3e9f)
```

Push the tag — explicitly — and publish the release:

```bash
$ git push origin v1.0.0
Enumerating objects: 1, done.
To github.com:tickethub/tickethub-api.git
 * [new tag]         v1.0.0 -> v1.0.0

$ gh release create v1.0.0 --generate-notes
https://github.com/tickethub/tickethub-api/releases/tag/v1.0.0
```

The generated notes, straight from the merged PRs:

```markdown
## What's Changed
* chore: add PR template, CODEOWNERS, and main ruleset by @alexcruz in #151
* feat(orders): support promo codes at checkout by @alexcruz in #152

**Full Changelog**: https://github.com/tickethub/tickethub-api/commits/v1.0.0
```

Readable with zero writing effort — because the PR titles were written and reviewed as if a customer would read them. That was the section 7 trade, paying out. Finally, meet `git describe`, which names *any* commit relative to the newest reachable tag — after one more commit lands, it reads `v1.0.0-1-g3c9d2f4`: one commit past v1.0.0, at abbreviated SHA `3c9d2f4`. Deploy tooling and error trackers lean on this format constantly.

**Part 2 — the version arithmetic, worked.** Fast-forward to the steady state the course reaches by Module 9: production is at **v1.4.2**. Three PRs merge in order; compute what release-please proposes after each (cover the right column first):

| # | Squash commit on `main` | Type | Release PR now proposes |
|---|---|---|---|
| 1 | `fix(tickets): encode QR payloads as UTF-8` | PATCH | **v1.4.3** |
| 2 | `feat(events): let organizers attach a venue map` | MINOR | **v1.5.0** |
| 3 | `feat(api)!: remove deprecated total field from order payloads` | MAJOR | **v2.0.0** |

The mechanics worth internalizing: the release PR *accumulates*, so if you merge it after commit 1 you ship v1.4.3, and the next cycle starting from commit 2 ships v1.5.0, then v2.0.0 — three releases. Let all three pile up unreleased and you ship **one** release, v2.0.0 (highest bump wins; the fix and the feature ride along inside it), with all three commits in its changelog. Same commits, different release cadence, different history — cadence is a *choice* the release PR makes explicit. And commit 3, under TicketHub rule 5, only merges if the `/api/v2` surface ships alongside the `/v1` removal — the `!` is doing contract work, not just version arithmetic.

## Real-world best practices

- **Release small and often.** A release containing three PRs has a three-PR blast radius and an obvious rollback story; a release containing forty is a mystery box. This is the batch-size lesson (Module 1's DORA data) applied to naming: frequent releases make each version a *useful* coordinate.
- **Never republish a version.** Not tags, not images, not packages. If v1.4.2 is broken, v1.4.3 exists within the hour — that's the entire cost. The alternative — "which v1.4.2 do you have?" — poisons every artifact and cache that ever referenced the name.
- **Make the version visible at runtime.** Expose it in a health/version endpoint and stamp it into logs and error reports (Modules 9 and 12 wire this). "What version were you on?" should be answerable by curl.
- **Treat PR titles as release-notes writing, because they are.** One review comment on a title (`fix: bug` → `fix(orders): release expired holds before availability check`) improves `git log`, the changelog, and the next incident's timeline simultaneously. Cheapest documentation you'll ever write.
- **Deprecate loudly, remove slowly.** Before any `/v1` field disappears: document it, mark it in responses (a `Deprecation`/`Sunset` header is the emerging convention), tell consumers a date, ship `/v2`, and only then remove. Breaking changes are sometimes necessary; *surprise* breaking changes are always a choice.
- **Sign release tags once provenance matters.** `git tag -s` (GPG/SSH-signed) proves who cut a release — table stakes in supply-chain-sensitive shops. Filed here as a pointer; Module 12's supply-chain lecture picks it up.

## Common pitfalls

1. **Moving a tag to "fix" a release.** It feels like correcting a typo; it actually forks reality — clones, CI caches, and deployed images now disagree about what v1.4.2 *is*. Correct approach: tags are write-once; cut v1.4.3.
2. **Version-bump paralysis.** Teams debate "is this really 2.0?" for an hour because bumps feel like marketing. They're not — they're compatibility bookkeeping, and the commit types already answered the question mechanically. Correct approach: trust the arithmetic; save the debate for *whether* to break, not what to number it.
3. **`feat!` hidden in a body nobody reads.** A breaking change flagged only deep in a commit body slides past reviewers, and the major bump "surprises" everyone. Correct approach: the `!` belongs in the PR title where the title check, the reviewer, and the changelog all see it; the footer carries migration detail.
4. **Perpetual 0.x.** "We're not ready to promise stability" — meanwhile three teams integrate against you in production, and every minor bump is secretly major. Correct approach: consumers-in-production *is* the 1.0 criterion. Ship it and start meaning your version numbers.
5. **Changelog written at release time from memory.** The night-before-release `git log` scroll produces "various fixes and improvements". Correct approach: the changelog is written continuously — it's your PR titles — and release time is editing, not authoring.
6. **Mutating `/api/v1` because "it's a small break".** Every consumer outage starts with a developer deciding a break is small. Correct approach: the client-breakage test from section 3 is binary; if it breaks, it's `/v2` (or additive evolution inside `/v1`), never an in-place change.

## Exercises

1. **Classification drill.** Assign a bump (MAJOR/MINOR/PATCH/none) to each, from a baseline of v1.5.0: (a) `fix(orders): clamp promo discounts at 100%`; (b) `feat(tickets): add Apple Wallet pass download`; (c) `refactor(events): extract EventPublisher service`; (d) `fix(api)!: return 404 instead of 200 for cancelled events`; (e) `perf(events): eager-load ticket types on index`; (f) `docs: document rate limits`. State the version after all six merge and release once.
2. **Object-model proof.** Create one lightweight and one annotated tag on a scratch commit. Using only `cat .git/refs/tags/...` and `git cat-file -p`, show exactly where the two differ in the object database, and explain why only one can be signed.
3. **Contract lawyering.** The mobile team asks for three changes to `GET /api/v1/events`: add a `duration_minutes` field; rename `starts_at` to `start_time`; have past events return `410 Gone` instead of `200`. For each: breaking or not, the SemVer effect, and the migration path you'd offer (additive change? deprecation? `/v2`?). Write it as the comment you'd post on their issue.
4. **Keep a Changelog, by hand.** Take the six commits from exercise 1 and write the `CHANGELOG.md` entry for the resulting release in Keep a Changelog format (correct categories, correct version heading, `Unreleased` section left ready). Compare it with what `--generate-notes` would produce and note what the human version adds.
5. **Stretch — dry-run the robot.** In a scratch clone, tag `v1.4.2`, then create three empty commits with the messages from this lecture's worked example (`git commit --allow-empty -m …`). Write a small script (any language) that scans `git log v1.4.2..HEAD --pretty=%s`, applies the bump rules, and prints the next version and a grouped changelog. You have now implemented the core of release-please — and you know precisely what it will and won't figure out from your history.

## What's next

Module 4 is complete: Git is no longer a copy tool but a collaboration system — a mental model, a branching strategy, a review gate, and a release convention with real names for what ships. Module 5 turns to the application itself: before TicketHub can leave its VPS, its configuration must stop living in files edited over SSH. [The Twelve-Factor App](../module-05-configuration-twelve-factor/) methodology — config in the environment, dev/prod parity, disposability — enables the containers of Module 6 and the pipelines of Modules 7 and 9. The conventions pinned here (squash-merged conventional commits, protected `main`, tag-named releases) are now load-bearing: CI attaches to them in Module 7, deploys in Module 9.
