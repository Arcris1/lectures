# Lecture 4.2 — Branching Strategies

> **Module 4 — Git & Collaboration Workflows** · Lecture 2 of 4 · Estimated time: ~65 min

In [Lecture 4.1](01-git-fundamentals.md) you learned that a branch is a 41-byte pointer. Cheap to create, trivial to merge — technically. Socially, branches are where teams go to suffer: week-old branches that no longer merge, a `develop` branch nobody trusts, release day as a recurring emergency. None of that is a Git problem. It is a *strategy* problem: the team never agreed on how branches map to the way they build and release software.

This lecture examines the three strategies you will actually encounter — GitFlow, GitHub Flow, and trunk-based development — fairly and with their history, then commits TicketHub to one of them for the rest of the course. The choice is not aesthetic: Module 7 wires CI to it, and Module 9 wires deployments to it.

## Learning objectives

- Explain why unintegrated branches accumulate risk, and quantify the cost of divergence
- Describe GitFlow, GitHub Flow, and trunk-based development, and match each to the release model it serves
- Use feature flags to decouple *deploying* code from *releasing* features, with a minimal Laravel implementation
- Keep a feature branch current with rebase, and push rewritten history safely with `--force-with-lease`
- Choose between squash, merge-commit, and rebase merges, knowing what each does to history
- Apply TicketHub's branching convention: short-lived branches, squash merges, a linear releasable `main`

## 1. Why teams need an agreed strategy

Solo, you can branch however you feel. The moment a second person joins, three failure modes appear:

**Integration pain.** Two people build for a week on separate branches. Each branch works; the *combination* has never existed until merge day, when 40 conflicting files and a broken test suite appear at once. The industry name is "merge hell", and it is not caused by Git being bad at merging — it is caused by deferring integration until the divergence is enormous.

**Ambiguity about what's deployable.** Your VPS deploy from Module 3 runs `git pull` on `main`. That only works if everyone agrees `main` is always in a deployable state. Without an agreed strategy, someone eventually pushes half-finished work to `main` "temporarily", and now nobody can deploy until it's fixed — a self-inflicted outage of your delivery capability.

**Release chaos.** When it's unclear which branch holds "the next release", releases become archaeology: cherry-picking commits into a release branch, hunting for "that fix from March", shipping things twice or not at all.

A branching strategy is simply a set of team-wide answers: *Where does new work start? How long may it live? What is always deployable? How does a release get cut?* The three named strategies below are three different answer sets, each optimized for a different release model.

## 2. Long-lived vs short-lived branches: the cost of divergence

The single most important variable in any strategy is **branch lifetime**. A branch is a copy of reality that stops receiving reality's updates. Every day it lives, two gaps grow: the branch doesn't know what `main` learned, and `main` doesn't know what the branch changed. Conflict probability compounds — not linearly, because conflicts come from *overlapping* edits, and the overlap window widens on both sides. Worse, the *semantic* conflicts Git can't even detect grow too: your branch calls a method that a merged refactor renamed; both merges succeed, the combination is broken.

Divergence cost is roughly: (rate of change on `main`) × (branch age) × (overlap of touched code). You control the middle term. A branch that lives four hours integrates almost for free. A branch that lives three weeks has a merge cost nobody budgeted, paid at the worst time — the end, when the work feels "done".

Hold that lens while evaluating each strategy: **how long do branches live, and who pays for divergence?**

## 3. GitFlow, explained fully and fairly

GitFlow (Vincent Driessen, 2010) is the most famous strategy, so you must understand it — including why its own author later added a note steering continuously delivered web apps away from it. It defines two permanent branches and three temporary kinds:

- **`main`** — every commit is a released version, tagged (`v1.4.0`).
- **`develop`** — the integration branch; the "next release" accumulates here.
- **`feature/*`** — branched from `develop`, merged back to `develop`.
- **`release/*`** — branched from `develop` when a release is being stabilized; only fixes land here; merged to **both** `main` (tag) and `develop`.
- **`hotfix/*`** — branched from `main` for production emergencies; merged to **both** `main` and `develop`.

```text
feature/promo-codes   ●───●
                     /     \
develop   ──●───●───●───●───●───●──────────●───●───●──→
             \                   \        /         (next cycle…)
              \                   ●───●──●   release/1.5
               \                          \
main      ──────●──────────────────────────●─────────●──→
              v1.4.0                     v1.5.0    v1.5.1
                                                  (hotfix, merged
                                                   back to develop)
```

**Where GitFlow genuinely fits.** Its structure exists to answer: *"we support explicit, versioned releases that live for a while."* If you ship a mobile app (app-store review gates every release), boxed/on-prem software, or maintain multiple supported versions simultaneously (customers on 1.x while you build 2.0), you need release stabilization branches and hotfix ports — GitFlow is a reasonable formalization, and this is why it persists in those worlds.

**Why it's overkill — and actively harmful — for a continuously delivered web app like TicketHub:**

- **Double merges everywhere.** Releases and hotfixes merge into two branches. Miss one (everyone eventually does) and the next release *un-fixes* a production bug — the classic GitFlow incident.
- **`develop` is a standing pool of unreleased risk.** Work integrates but doesn't ship, accumulating for the next "big-bang" release. Big releases mean big diffs against production, which means high change-failure rate and painful rollbacks — the exact opposite of the small-batch principle behind the DORA metrics from Module 1.
- **Two sources of truth.** "Is it in develop or main?" is a question that shouldn't exist. Long-lived divergence between two permanent branches is the section 2 cost, institutionalized.
- **Ceremony without benefit.** For a web app there is exactly one version in production. Release branches stabilize… nothing that CI on every commit doesn't already stabilize.

Driessen's own 2020 reflection note says essentially this: GitFlow was designed for versioned software of its era; web teams doing continuous delivery should consider simpler flows. Take the author at his word.

## 4. GitHub Flow: the simplest thing that works

GitHub Flow strips the model to one rule set:

1. `main` is always deployable.
2. All work happens on short-lived branches off `main`, with descriptive names.
3. Open a pull request early; discussion and CI happen there ([Lecture 4.3](03-pull-requests-code-review.md)).
4. Merge to `main` only when green and reviewed.
5. Deploy `main` — immediately or continuously.

That's the entire strategy. One permanent branch, one temporary kind, no double merges, no standing pool of unreleased work. Its weakness is that it says nothing about *discipline*: nothing stops a "short-lived" branch living three weeks, and nothing says how unfinished features coexist with continuous deployment. Which is exactly the gap trunk-based development fills.

## 5. Trunk-based development: what elite performers do

Trunk-based development (TBD) is less a topology than a *practice*: everyone integrates into one trunk (`main`) at least daily, via branches that live **hours to at most a day or two**. The DORA research program (Module 1) has found, year over year, that trunk-based practices — fewer than three active branches, branch lifetimes under a day or two, no code-freeze periods — correlate with elite performance across all four metrics. Not because short branches are magic, but because they *force* small batches, and small batches improve everything downstream: easier review, cheaper integration, smaller blast radius, trivial rollback.

The obvious objection: "my feature takes two weeks; how can I merge daily without shipping half a feature?" The answer is the load-bearing technique of modern delivery:

**Feature flags decouple *deploy* from *release*.** Deploying code means the bytes are on the server. Releasing a feature means users can reach it. With a flag, incomplete work merges and deploys *dark* — integrated daily, costing no divergence — and the feature is released later by flipping configuration, not by merging a giant branch.

Minimal, real Laravel implementation — a config file and a gate. `config/features.php`:

```php
<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Feature flags
    |--------------------------------------------------------------------------
    | Merged code ships dark until its flag is on. Flip per environment via
    | env vars (Module 5). Per-user rollout with Laravel Pennant: Module 9.
    */

    'promo_codes' => (bool) env('FEATURE_PROMO_CODES', false),

];
```

And the gate at the feature's entry point — here, the new promo-code endpoint:

```php
<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Requests\ApplyPromoCodeRequest;
use App\Models\Order;
use Illuminate\Http\JsonResponse;

class PromoCodeController extends Controller
{
    public function store(ApplyPromoCodeRequest $request, Order $order): JsonResponse
    {
        abort_unless(config('features.promo_codes'), 404);

        // Apply the promo code to the order… (the feature itself)

        return response()->json($order->fresh('items'), 201);
    }
}
```

While `FEATURE_PROMO_CODES` is unset, the endpoint 404s — indistinguishable from not existing — yet the code is merged, tested in CI, and deployed. Staging can run with the flag on while production stays dark. Full-featured flags (percentage rollouts, per-user targeting, Pennant) arrive in Module 9 with progressive delivery; a boolean is enough to unlock trunk-based work today.

TBD's honest costs: it demands CI you trust (Module 7), flag hygiene (flags must die after full rollout), and the maturity to slice work small. Those are costs; they're also just… good engineering, which is rather the point.

## 6. Choosing: the comparison

| | GitFlow | GitHub Flow | Trunk-based |
|---|---|---|---|
| Permanent branches | `main` + `develop` | `main` | `main` |
| Typical branch lifetime | days–weeks | days | hours–2 days |
| Release model | scheduled, versioned, stabilized | continuous | continuous; release = flag flip or tag |
| Unreleased work lives in | `develop` + release branches | branches | `main`, dark behind flags |
| Merge ceremony | high (double merges) | low | low |
| Suits | mobile, boxed/on-prem, multi-version support | small web teams | teams optimizing DORA metrics; CD |
| Fails when | you're a web app doing CD | branches quietly grow old | CI is weak or flags never get cleaned up |

The meta-lesson: **strategy follows release model.** Ship versioned artifacts with support windows → GitFlow-shaped. Ship one continuously updated service → GitHub Flow mechanics with trunk-based discipline.

## 7. Keeping a branch current: merge vs rebase

Even a two-day branch can be overtaken by `main`. You have two ways to catch up:

- **`git merge main`** (into your branch): creates a merge commit *on your branch*. History is truthful but knotted — do it four times and your eventual PR diff is spaghetti.
- **`git rebase main`**: Git rewinds your commits and *replays* them on top of current `main`, as if you'd started today. From Lecture 4.1 you know commits are immutable — so rebase creates **new commits** with new SHAs. Your branch history stays a clean straight line.

Rebase's cleanliness has one iron law attached — **the golden rule of rebasing: never rewrite history that others may have based work on.** Rebasing *your own unshared feature branch* is fine and encouraged. Rebasing `main`, or a branch a teammate has checked out, detonates the shared understanding of history (their commits point to parents that no longer exist in any ref).

Because rebase rewrites your branch, pushing it after a rebase is rejected — the remote's copy is not an ancestor of yours. You must force-push, and *how* you force matters:

- `git push --force` — "overwrite the remote, whatever it holds." If a teammate pushed to your branch ten minutes ago, their work is silently obliterated.
- `git push --force-with-lease` — "overwrite the remote *only if* it still points where I last saw it." If anyone pushed meanwhile, the push is refused and you get to fetch and reconcile.

There is no situation in normal work where `--force` beats `--force-with-lease`. Alias it and forget the raw form exists.

## 8. What the merge button actually does

GitHub offers three ways to land a PR, and they produce different history. Since history is your debugging database (`log`, `bisect`, `revert`), choose deliberately:

| Method | What lands on `main` | History shape | Bisect/revert story |
|---|---|---|---|
| **Merge commit** | All branch commits + a merge commit | Non-linear, bubbles | Full detail preserved — including every "wip" and "fix typo" commit; bisect may land on non-building WIP commits |
| **Squash and merge** | One new commit containing the whole branch diff | Strictly linear | One PR = one commit: `revert` and `bisect` operate at PR granularity; branch's messy internals discarded |
| **Rebase and merge** | Each branch commit replayed onto `main` | Linear, multi-commit | Clean *if* every branch commit was disciplined and atomic — a big if |

Squash-merge's trade: you lose intra-branch history (fine — it was scaffolding) and gain a `main` where every commit corresponds to exactly one reviewed, CI-tested PR that builds. For revert-driven incident response ("roll back PR #152") that granularity is precisely what you want. The requirement it imposes: PRs must stay small, because one squashed commit per PR is only useful if the PR itself is one logical change — which [Lecture 4.3](03-pull-requests-code-review.md) demands anyway.

## 9. TicketHub's decision

Here is the convention this course uses from now on. It's stated once, explicitly, because Modules 7 and 9 build automation on top of it:

> **TicketHub branching strategy — trunk-based, with GitHub Flow mechanics.**
>
> 1. **`main` is always releasable.** No exceptions; incomplete work merges dark behind feature flags.
> 2. **All work on short-lived branches off `main`** — target under two days from branch to merge. Slice work until it fits.
> 3. **Branch naming:** `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `chore/<slug>` — e.g. `feat/145-promo-codes`, `fix/162-qr-encoding`. The issue number links code to intent; the prefix feeds tooling in [Lecture 4.4](04-versioning-and-releases.md).
> 4. **Rebase feature branches on `origin/main`** to stay current; push with `--force-with-lease`. Never rebase `main`.
> 5. **Squash and merge, only.** `main` stays linear; one commit per PR.
> 6. **Deploys:** `main` auto-deploys to staging, releases are tags that deploy to production — the pipeline for both is wired in Module 9. Until then, the VPS still pulls `main`, which rule 1 keeps safe.

## Hands-on with TicketHub

Start the promo-codes feature the trunk-based way: branch, flag, rebase over a teammate's change, force-with-lease, and preview what squash-merge will do to history. (We stop just short of merging — that happens through a real pull request in the next lecture.)

**Step 1 — branch and build behind the flag.** Issue #145 asks for promo codes at checkout:

```bash
$ git switch -c feat/145-promo-codes
Switched to a new branch 'feat/145-promo-codes'
# create config/features.php, PromoCodeController, the route, and a Pest test
$ git add -A && git commit -m "Add promo code endpoint behind feature flag"
[feat/145-promo-codes 4c1d2e3] Add promo code endpoint behind feature flag
 5 files changed, 84 insertions(+)
$ git push -u origin feat/145-promo-codes
To github.com:tickethub/tickethub-api.git
 * [new branch]      feat/145-promo-codes -> feat/145-promo-codes
```

Run the tests both ways — flag off (expects 404) and on — because dark code you can't verify is just risk with extra steps:

```bash
$ php artisan test --filter=PromoCode
   PASS  Tests\Feature\PromoCodeTest
  ✓ promo endpoint returns 404 when feature disabled          0.31s
  ✓ applies percentage discount to reserved order             0.44s

  Tests:    2 passed (6 assertions)
```

**Step 2 — main moves under you.** Meanwhile Priya lands a performance fix on `main` (an index on `orders.expires_at`, speeding up `ExpireReservations`). Simulate it, or just fetch if you're pairing with someone:

```bash
$ git fetch origin
From github.com:tickethub/tickethub-api
   e4f1c9a..b2c4d6e  main       -> origin/main
$ git log --oneline feat/145-promo-codes..origin/main
b2c4d6e Add index on orders.expires_at for reservation expiry
```

Your branch is now behind. Two days of this and you're in section 2's divergence math.

**Step 3 — rebase, and push with a lease.** Replay your commit on top of the new `main`:

```bash
$ git rebase origin/main
Successfully rebased and updated refs/heads/feat/145-promo-codes.

$ git log --oneline -3
9f8e7d6 (HEAD -> feat/145-promo-codes) Add promo code endpoint behind feature flag
b2c4d6e (origin/main) Add index on orders.expires_at for reservation expiry
e4f1c9a Merge branch 'fix/shorten-reservation-window'
```

Same change, brand-new SHA (`4c1d2e3` → `9f8e7d6`) — a replayed commit is a new commit. The remote still has the old one, so an ordinary push refuses:

```bash
$ git push
To github.com:tickethub/tickethub-api.git
 ! [rejected]        feat/145-promo-codes -> feat/145-promo-codes (non-fast-forward)
error: failed to push some refs to 'github.com:tickethub/tickethub-api.git'

$ git push --force-with-lease
To github.com:tickethub/tickethub-api.git
 + 4c1d2e3...9f8e7d6 feat/145-promo-codes -> feat/145-promo-codes (forced update)
```

This is the one sanctioned force-push in TicketHub's workflow: your own feature branch, after your own rebase, with the lease protecting against overwriting anyone else's surprise contribution.

**Step 4 — preview the squash.** See exactly what GitHub's "Squash and merge" will produce, locally and without pushing:

```bash
$ git switch main && git merge --squash feat/145-promo-codes
Squash commit -- not updating HEAD
Automatic merge went well; stopped before committing as requested
$ git commit -m "feat(orders): support promo codes at checkout"
[main 3e5a7c9] feat(orders): support promo codes at checkout
 5 files changed, 84 insertions(+)
$ git log --oneline -3
3e5a7c9 (HEAD -> main) feat(orders): support promo codes at checkout
b2c4d6e (origin/main) Add index on orders.expires_at for reservation expiry
e4f1c9a Merge branch 'fix/shorten-reservation-window'
```

One linear commit, whole feature, no bubble. (That commit-message format gets formalized in [Lecture 4.4](04-versioning-and-releases.md).)

**Step 5 — undo the preview with Lecture 4.1 skills.** The real merge must go through a PR, so put local `main` back exactly where the remote is — a safe `reset --hard`, because `origin/main` is a known-good pointer and our experiment was never pushed:

```bash
$ git reset --hard origin/main
HEAD is now at b2c4d6e Add index on orders.expires_at for reservation expiry
$ git switch feat/145-promo-codes
```

The branch is rebased, pushed, and ready for review. Leave it there — Lecture 4.3 opens the pull request.

## Real-world best practices

- **Enforce branch lifetime culturally, and measure it.** Elite teams treat a three-day-old branch like a production alert: someone asks "what's blocking?" — because the DORA data says branch age predicts delivery performance. Some teams literally dashboard `max(branch_age)`.
- **Slice work vertically, not by layer.** "Migration + model + endpoint for one small behavior" merges in a day; "all migrations, then all models, then all controllers" creates three unmergeable mega-branches. Vertical slices keep trunk-based lifetimes achievable.
- **Deploy dark by default.** Merging behind a flag should be boring routine, not a special event. When deploy and release are the same act, every deploy is a product decision and deploys become rare and scary — the failure spiral Module 1 warned about.
- **Put a death date on every flag.** A flag at 100% rollout is dead code with live branching logic — a real incident class (dead flags flipped by accident years later). Create the cleanup issue the day the flag is born; TicketHub files it as `chore/remove-<flag>`.
- **Delete branches on merge.** Merged branches are pointer clutter that make `git branch -a` useless. GitHub can auto-delete on merge — turn it on and rely on the reflog/PR record for archaeology.
- **Rebase before requesting review, not after approval.** Reviewers should see your change against current `main`; rebasing after approval invalidates what was approved (and re-triggers CI at the worst time).

## Common pitfalls

1. **Adopting GitFlow because a diagram looked authoritative.** It's the most-blogged strategy, so teams cargo-cult it, then drown in double merges for a web app with one production version. Correct approach: derive strategy from release model — continuous delivery gets trunk-based; GitFlow is for versioned, multi-supported releases.
2. **The three-week "big reveal" branch.** It feels efficient ("I'll merge when it's polished") but defers integration until divergence is maximal — merge hell on schedule. Correct approach: slice thinner, merge daily behind a flag; the polish can be a flag flip away, invisible to users.
3. **Rebasing a shared branch.** Someone "cleans up" a branch a teammate is also pushing to; both now hold incompatible histories and the next force-push eats work. Correct approach: golden rule — rebase only branches you alone write to; on genuinely shared branches, merge instead.
4. **`--force` out of habit.** It works right up until it silently deletes a colleague's commits, and you learn about it in standup. Correct approach: `--force-with-lease`, always; let the refusal tell you when the world moved.
5. **Merging `main` into your branch every morning, then squashing anyway.** The interleaved merge bubbles make your branch's diff and review harder for zero benefit, since the squash discards branch history regardless. Correct approach: rebase to stay current on branches destined for squash-merge.
6. **Flags as a graveyard.** Teams add flags but never remove them; two years later `config/features.php` has 40 entries and nobody knows which are load-bearing. Correct approach: flags are scaffolding — cleanup issue at creation, removal PR right after full rollout.

## Exercises

1. **Strategy matching.** For each team, pick a strategy and defend it in three sentences: (a) a 4-person startup shipping a SaaS API 10× per day; (b) a bank's mobile team with app-store review gates and a 6-week release train supporting the last two majors; (c) an agency handing a versioned Laravel package to clients on a support contract.
2. **Divergence, felt.** From current `main`, create two branches. On one, rename `$quantity` to `$requestedQuantity` throughout `ReserveTickets.php`. On the other, add a validation guard using `$quantity`. Merge both. Now redo the exercise, but rebase the second branch and fix it *before* merging. Write two sentences on which conflict was easier to reason about and why.
3. **Rebase under pressure.** Recreate steps 2–3 of the hands-on, but have "Priya's" commit touch `config/features.php` so the rebase itself conflicts. Resolve mid-rebase (`git status` will guide you; `git rebase --continue`), and note how the conflict is presented one commit at a time rather than all at once.
4. **History autopsy.** In a scratch repo, land the same three-commit branch three times: merge-commit, squash, rebase-merge (locally: `merge --no-ff`, `merge --squash`, `rebase`+ff). Compare `git log --oneline --graph` for each and write down which history you'd want at 2 a.m. while bisecting a bad deploy.
5. **Stretch — flag lifecycle.** Add a second flag, `features.waitlist`, gating a stub endpoint. Ship it in one branch; then write the *removal* plan as if rollout finished: which files change, what the PR looks like, what could break if the flag were removed while staging still sets `FEATURE_WAITLIST=true`. Then execute the removal on a branch.

## What's next

TicketHub now has a strategy: short-lived branches, rebased current, squashed onto an always-releasable `main`. But "merge when green and reviewed" smuggled in an entire discipline we haven't built — *reviewed by whom, against what standard, enforced how?* [Lecture 4.3 — Pull Requests & Code Review](03-pull-requests-code-review.md) turns the pull request into your team's quality gate: templates, review culture, branch protection rulesets, and CODEOWNERS on the real repo.
