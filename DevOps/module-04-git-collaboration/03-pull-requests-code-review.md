# Lecture 4.3 — Pull Requests & Code Review

> **Module 4 — Git & Collaboration Workflows** · Lecture 3 of 4 · Estimated time: ~70 min

[Lecture 4.2](02-branching-strategies.md) left `feat/145-promo-codes` pushed and ready, with a rule attached: work lands on `main` only when green and reviewed. This lecture builds the machinery and — more importantly — the culture behind that rule. The pull request is where your team's engineering standards either exist or don't: where CI will run (Module 7), where review happens, where the "why" of every change is recorded for the archaeologists of 2028.

We'll cover what makes PRs reviewable (spoiler: size), how to review — what to look for, in what order, how to talk to each other — then enforce the process with GitHub's real mechanisms: a PR template, branch protection rulesets, and CODEOWNERS, all configured on `tickethub-api`.

## Learning objectives

- Explain why the pull request is the atomic unit of team change, and what belongs in one
- Keep PRs small enough to review well, and split or stack work that outgrows that limit
- Review code in priority order — correctness, security, migration safety, tests, readability — and leave feedback that lands
- Write and use a PR template that forces operational questions (migrations, rollback) to be answered
- Configure branch protection rulesets and CODEOWNERS on a real repository
- Run an async-friendly review loop: self-review, draft PRs, "nit:" conventions, approve-with-nits

## 1. The pull request: the atomic unit of team change

Technically, a pull request is trivial: "here is a branch; please merge it into `main`." Organizationally, it is the most important object your team produces — the *only* place where four things converge on one unit of change:

- **The gate.** With branch protection (section 7), the PR is the sole path to `main` — no "quick fix directly on main" back door. One path means one place to enforce every standard you'll ever adopt.
- **The checkpoint for machines.** When Module 7 wires up CI, checks run *on the PR*, before merge. "Would this break `main`?" is answered before it can.
- **The checkpoint for humans.** Review happens here, anchored to specific lines, before the change is irreversible.
- **The record.** Every discussion, objection, and decision is permanently attached to the change it concerns. Two years from now, `git log` gives you the squash commit, the commit references the PR, and the PR holds the *entire context* — including the alternative that was rejected. Chat threads evaporate; PRs are institutional memory.

This is why the squash-merge decision (Lecture 4.2) matters: one PR becomes exactly one commit on `main`. The PR is not paperwork around the change. The PR *is* the change.

## 2. Small PRs: the highest-leverage review practice

If you take one habit from this lecture: **keep PRs small**. The best-known industrial data is SmartBear's study of Cisco code reviews (~2,500 reviews on real product teams): defect discovery falls off a cliff beyond roughly **400 lines of change**, and reviewers are most effective under ~200. Past that, reading degrades into scrolling; reviewers cannot hold the change in their head, so they approve on vibes. Every engineer knows the two review modes: a 90-line PR gets three substantive comments; a 2,000-line PR gets "LGTM 🚀" in four minutes. The big PR got *less* scrutiny precisely because it carried more risk.

Small PRs also merge faster (shorter review latency → shorter branch lifetime → the trunk-based math of Lecture 4.2), revert cleaner (one squash commit, small blast radius), and bisect kinder.

Keeping work small when the *feature* isn't:

- **Slice vertically** (Lecture 4.2): each PR delivers one thin, testable behavior behind the flag — schema, then read path, then write path.
- **Separate the mechanical from the meaningful.** A 60-file rename and a logic change should never share a PR; the rename drowns the logic. Ship the mechanical PR first, labeled as such.
- **Stacked (dependent) PRs**, in one paragraph: when slice B builds on unmerged slice A, branch B *off A* and open B's PR with A as its base (`gh pr create --base feat/145-promo-codes`); reviewers see only B's diff. Merge A, let GitHub retarget B to `main` automatically, merge B. Stacks keep each review small at the cost of some rebase choreography — worth it for any multi-step feature.

## 3. Writing a PR worth reviewing

Review quality is set by the author, before the reviewer arrives. A great PR:

**Has a title that will make sense in `git log`.** Under squash-merge, the PR title *becomes* the commit subject on `main`. TicketHub titles follow the conventional-commit format — `feat(orders): support promo codes at checkout` — which [Lecture 4.4](04-versioning-and-releases.md) formalizes into automated versioning.

**Explains WHY, then WHAT, then HOW TO VERIFY.** The diff already shows the code; the description supplies what the diff can't: the problem (link the issue), the approach and rejected alternatives, how you tested it, and what could go wrong (risk notes, screenshots for anything visual). A reviewer who understands intent reviews the design; one who doesn't can only proofread.

**Was self-reviewed first.** Before requesting review, read your own diff in the PR view — the same rendering your reviewer gets — and comment your own lines where a reviewer would stumble: "Looks unrelated, but the old signature broke this test's fake", "Chose a JOIN over a subquery; EXPLAIN was 40× better." Self-review catches the embarrassing leftovers (`dd()`, stray files) and pre-answers half the review — the single most async-friendly authoring habit, since every pre-answered question saves a round-trip across time zones.

**Uses draft status honestly.** A **draft PR** (`gh pr create --draft`) says "CI can run; humans shouldn't review yet" — the right way to share early work or ask one targeted question ("is this migration approach sane?") without summoning full review. Mark it ready (`gh pr ready`) only when it meets the bar above.

## 4. A PR template that asks the operational questions

GitHub auto-fills `.github/PULL_REQUEST_TEMPLATE.md` into every new PR description. A good template is short — long templates get deleted, not filled — and asks precisely the questions people forget under deadline. TicketHub's:

```markdown
## Summary

<!-- WHY does this change exist? One or two sentences. Link the issue. -->

Closes #

## Changes

<!-- WHAT changed, as a short list a reviewer can hold in their head. -->

-

## Migration

- [ ] This PR contains a database migration

<!-- If checked: is it backward-compatible with currently deployed code?
     Does it lock a hot table (orders, tickets, ticket_types)?
     Expected runtime against production-sized data? -->

## How I tested this

<!-- Commands, endpoints hit, flag states tested. Screenshots if visual. -->

## Rollback plan

<!-- If this misbehaves in production, what do we do?
     "Revert the PR" is a fine answer UNLESS a migration or data change
     makes naive revert unsafe — if so, say what to do instead. -->
```

Why **Migration** and **Rollback plan** live in the template: they are the two questions that turn a code change into a production incident when unasked. An index added to `orders` can lock the table mid-on-sale (Module 9 covers migrations under traffic); a "just revert it" rollback fails when the reverted code can't read rows the new code already wrote. Forcing every author to type an answer — even "N/A" — moves the *thinking* from incident time to PR time. This is DevOps culture (Module 1) made concrete: developers answering operational questions as part of writing code.

## 5. Review culture: how to talk about code

Most review advice fails because it treats review as a technical activity. It's a *social* activity with technical content, and these norms are the difference between review as teaching and review as hazing:

- **The author is not the code.** "This function ignores the expired-reservation case" is review; "you ignored the expired-reservation case" is drifting; "how did you miss this?" is an attack. Criticize artifacts, never people — and as an author, receive comments as gifts to the codebase, not verdicts on you.
- **Questions over commands.** "What happens if two requests apply the same code concurrently?" beats "add a lock here" — it invites reasoning, teaches, and leaves room for the author to know something you don't. Reserve imperatives for when you're certain and it matters.
- **Prefix minor points with `nit:`.** "nit: `$discounted` reads better than `$d`" says explicitly: *this does not block merge.* Without severity labels, authors treat all 14 comments as mandatory and a one-day PR becomes a one-week PR.
- **Approve with nits.** If the change is correct and safe, approve *and* leave the polish points — trust the author to address them before merging. Blocking a correct PR over variable names optimizes for reviewer ego, not flow.
- **First response within a business day — an SLA, said out loud.** Review latency is usually the largest component of lead time (a DORA metric, Module 1), and unpredictability hurts more than slowness: authors who can't predict review time batch work into big PRs, which makes reviews slower — a doom loop.
- **Know when to stop typing.** Two rounds of comment-reply on one thread means the medium has failed. Pair for fifteen minutes, agree, and record the outcome as a PR comment for the archive. Ping-pong across time zones stretches a two-line disagreement over a week.

## 6. What to review for — in priority order

Unordered review is vibes. Review in *descending order of damage*, and don't apologize for spending most attention at the top:

1. **Correctness.** Does it do what the PR claims, and what happens at the edges? For TicketHub, always through the core invariant: could this path oversell a ticket type? Does it hold the row lock (Lecture 4.1's `ReserveTickets`) everywhere inventory is checked? What if the reservation expired between check and use?
2. **Security.** The Laravel classics: **mass assignment** — does a controller pass `$request->all()` into `create()`/`update()` on a model whose `$fillable` would let a customer set `orders.status = 'paid'`? **Authorization** — every endpoint touching an order must verify ownership (`$this->authorize('view', $order)` backed by a policy); "the ID is a UUID, nobody will guess it" is not authorization. **Query patterns** — an **N+1** on `GET /api/v1/events` (loading `ticketTypes` per event instead of `->with('ticketTypes')`) is a performance bug today, an outage during an on-sale.
3. **Migration safety.** Read every file in `database/migrations/` twice. Does it lock a hot table — an `ALTER TABLE orders` that MySQL 8.0 can't do INSTANT/INPLACE blocks writes for the whole rebuild, mid-sale? Is it backward-compatible with currently deployed code (old code runs against the new schema during every deploy window)? Is `down()` honest?
4. **Tests.** Do they exercise *behavior* (would they fail if the feature broke?) or just re-assert the implementation? Is the flag-off path tested?
5. **Readability.** Naming, structure, comments-that-explain-why. Last not because it's unimportant, but because a beautifully named oversell bug is still an oversell bug.

**What you should *not* review by hand: style.** Indentation, import order, brace placement — machines enforce these totally and without feelings. TicketHub uses Laravel Pint in CI (Module 7); once a formatter is a required check, style comments are noise wasting the scarcest resource in the process: human attention. If it can be a lint rule, make it a lint rule, then never speak of it again.

## 7. Enforcing the process: branch protection rulesets

Culture defines the workflow; **rulesets** make it non-optional — for everyone, including admins having a confident day. UI path: **Settings → Rules → Rulesets → New ruleset → New branch ruleset**, targeting the default branch. TicketHub's ruleset as the JSON the API accepts (kept in the repo — settings-as-code, even when applied by hand):

```json
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    }
  ]
}
```

Reading it as policy: `main` cannot be deleted; **no force pushes** (`non_fast_forward`) — pushed history on `main` is permanent, which is what makes it a reliable deploy source; **linear history**, pairing with squash-only merging (`allowed_merge_methods`); all changes arrive **via PR with one approval**; **stale approvals are dismissed** on new pushes — an approval covers what was reviewed, not whatever arrives afterward; review threads must be resolved, so concerns can't be merged past silently.

One rule is deliberately missing. The full ruleset also requires a passing status check named **`ci`**:

```json
{
  "type": "required_status_checks",
  "parameters": {
    "strict_required_status_checks_policy": true,
    "required_status_checks": [{ "context": "ci" }]
  }
}
```

We add that block in Module 7, the moment a workflow actually reports a check called `ci`. Add it today and you've built a gate waiting forever for a check that never comes — every PR stuck at "Expected — waiting for status to be reported". Requiring checks that don't exist yet is a classic self-inflicted lockout.

Two honest notes: `required_approving_review_count: 1` assumes a second human — GitHub won't let you approve your own PR. Solo learners: set it to `0` for now (keep every other rule) or add a second account as a collaborator. And team-based CODEOWNERS (next section) requires a GitHub **organization**; on a personal repo, use usernames instead of `@tickethub/*` teams.

## 8. CODEOWNERS: routing review to the right humans

`.github/CODEOWNERS` maps paths to owners. When a PR touches an owned path, GitHub **auto-requests review** from the owners; with the ruleset's `require_code_owner_review`, their approval becomes *required*, not advisory. TicketHub's:

```text
# .github/CODEOWNERS — last matching pattern wins.

# Default: the backend team owns anything not claimed below.
*                       @tickethub/backend

# Application code
/app/                   @tickethub/backend
/database/migrations/   @tickethub/backend @tickethub/platform

# Operational surface: containers and CI (arriving in Modules 6–7)
/docker/                @tickethub/platform
/.github/               @tickethub/platform
```

The design intent: **ownership follows blast radius.** Application code is the backend team's domain. Anything that changes how TicketHub *builds, ships, or runs* — CI workflows, container definitions — routes to platform, because a subtle `.github/workflows/` edit can break every deploy. Migrations get *both* teams: application logic *and* an operational event (section 6.3). Listing `/docker/` before it exists is harmless — the pattern matches nothing until Module 6 creates it, then ownership is already correct.

Keep CODEOWNERS honest: an owner who never reviews is a lie in a config file, and `require_code_owner_review` turns that lie into a merge blocker. Own what you actually review.

## Hands-on with TicketHub

Install the apparatus on the real repo, then push `feat/145-promo-codes` through it end to end.

**Step 1 — the process PR.** The template, CODEOWNERS, and ruleset JSON go in via a PR themselves (PRs need no protection to work; protection makes them mandatory):

```bash
$ git switch main && git pull && git switch -c chore/pr-process
# create .github/PULL_REQUEST_TEMPLATE.md, .github/CODEOWNERS,
#        .github/rulesets/protect-main.json  (contents from sections 4, 7, 8)
$ git add .github && git commit -m "Add PR template, CODEOWNERS, and main ruleset"
[chore/pr-process 6b8a2f1] Add PR template, CODEOWNERS, and main ruleset
 3 files changed, 74 insertions(+)
$ git push -u origin chore/pr-process
$ gh pr create --title "chore: add PR template, CODEOWNERS, and main ruleset" \
    --body "Installs the review process from Module 4. No runtime code changes."
Creating pull request for chore/pr-process into main in tickethub/tickethub-api

https://github.com/tickethub/tickethub-api/pull/151
$ gh pr merge 151 --squash --delete-branch
✓ Squashed and merged pull request #151
✓ Deleted branch chore/pr-process and switched to branch main
```

**Step 2 — apply the ruleset and prove it bites.** Create the ruleset, then try the thing it forbids:

```bash
$ gh api repos/tickethub/tickethub-api/rulesets \
    --method POST --input .github/rulesets/protect-main.json
{
  "id": 4127001,
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  ...
}
$ git commit --allow-empty -m "Test direct push" && git push origin main
remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: - Changes must be made through a pull request.
To github.com:tickethub/tickethub-api.git
 ! [remote rejected] main -> main (push declined due to repository rule violations)
error: failed to push some refs to 'github.com:tickethub/tickethub-api.git'
$ git reset --hard origin/main   # discard the test commit (Lecture 4.1)
```

That `GH013` rejection is the sound of process becoming infrastructure — the back door is closed for everyone, including future-you at 1 a.m. with a "tiny fix".

**Step 3 — the real PR.** The promo-codes branch from Lecture 4.2 is rebased and pushed. Open its PR; the template auto-fills, and you complete it:

```bash
$ git switch feat/145-promo-codes
$ gh pr create --title "feat(orders): support promo codes at checkout" --web
Opening https://github.com/tickethub/tickethub-api/compare/main...feat/145-promo-codes in your browser.
```

The description you submit:

```markdown
## Summary
Organizers want discount campaigns for slow-selling events. Adds promo
codes at checkout, dark behind `features.promo_codes`. Closes #145.

## Changes
- `POST /api/v1/orders/{order}/promo-code` endpoint + `PromoCodeController`
- `config/features.php` flag scaffold (flag OFF everywhere; staging enables
  it in Module 5's env work)
- Pest coverage: flag off → 404, percentage discount applied, double-apply rejected

## Migration
- [x] This PR contains a database migration
`promo_codes` is a NEW table — no ALTER on hot tables, no lock risk,
backward compatible (deployed code never reads it while the flag is off).

## How I tested this
`php artisan test --filter=PromoCode` with the flag on and off; manual
checkout against local MySQL with a 20% code.

## Rollback plan
Revert the PR. Safe: flag is off in production, and the new table is
ignored by all other code paths. Table cleanup can ride a later chore PR.
```

Then self-review: in the **Files changed** tab, annotate your own diff — one comment on the `abort_unless` line ("404 not 403: while dark, the endpoint should be indistinguishable from absent") — before requesting Priya.

**Step 4 — the review loop.** Priya responds within the SLA:

> **Priya (comment, `PromoCodeController.php` line 18):** Question — two concurrent requests apply the same single-use code to different orders. What stops both from succeeding?
>
> **You:** Good catch — nothing did. Pushed a fix: the code row is now read with `lockForUpdate()` inside the existing order transaction, same pattern as `ReserveTickets`. Added a Pest test simulating the race.
>
> **Priya (approving):** nit: `$pct` → `$percentage` in the discount calc, and the config comment says "Module 5" — worth linking the issue instead. Neither blocks. Approving — the locking approach is right.

```bash
$ gh pr review 152 --approve --body "Locking approach is right. Two nits left inline — not blocking."
```

Note the structure: her *question* surfaced a real race (correctness, priority 1); your fix pushed a new commit — **dismissing any stale approval** and re-running the loop; and the nits were labeled so they couldn't stall the merge. Fix the nits, push, get the final approve.

**Step 5 — squash and merge.**

```bash
$ gh pr merge 152 --squash --delete-branch
✓ Squashed and merged pull request #152 (feat(orders): support promo codes at checkout)
✓ Deleted branch feat/145-promo-codes and switched to branch main
$ git pull && git log --oneline -3
a7d3e9f (HEAD -> main, origin/main) feat(orders): support promo codes at checkout (#152)
f1e2d3c chore: add PR template, CODEOWNERS, and main ruleset (#151)
b2c4d6e Add index on orders.expires_at for reservation expiry
```

Linear history, one commit per PR, each pointing back to its full discussion. This is the shape `main` keeps for the rest of the course.

## Real-world best practices

- **Hold the 400-line line.** Mature teams treat PR size as a metric, some enforcing a soft cap with a bot comment. Not bureaucracy: it's the SmartBear finding operationalized — every line past ~400 is reviewed worse than the line before it.
- **Author self-review is mandatory, not optional polish.** Google's engineering practices and every high-functioning team converge here: the author reads the diff in the review UI first. It halves round-trips, which across time zones halves *days*.
- **Review promptly; protect it on your calendar.** Teams that treat review as interruptible leftovers get old branches and giant PRs (section 5's doom loop). Elite teams treat review as first-class work — often the first thing after standup.
- **Block only for the top of the priority list.** Reserve "Request changes" for correctness, security, and data/migration safety; everything below travels as nits with an approval. Blocking on preference trains authors to fear review and batch work — the opposite of flow.
- **Move style out of human review entirely.** Pint + Larastan as required checks (Module 7) end whole categories of review noise. Human attention is the bottleneck resource; spend it where machines can't go.
- **Write decisions down in the PR, even when resolved elsewhere.** Pairing settled it? One sentence in the thread: "Agreed on X because Y." A decision that lives only in a call is a decision your successor re-litigates.

## Common pitfalls

1. **The 2,000-line "review this when you get a chance" PR.** Authors batch because branching feels expensive or review feels slow; reviewers respond with the four-minute LGTM. Correct approach: slice vertically, stack dependent PRs, and fix review latency (the SLA) so small PRs feel cheap.
2. **Style ping-pong.** A reviewer with strong bracket opinions and no formatter generates 30 comments of pure friction — style is the easiest thing to notice. Correct approach: adopt Pint, make it a required check, delete style from the human review vocabulary.
3. **Rubber-stamp culture.** Five-minute approvals on non-trivial diffs — usually because review is measured (count) but not valued (quality). Correct approach: review with the section 6 checklist, comment on what you verified ("traced the lock path — holds"), and let PR size make real review possible.
4. **Review as status contest.** Commands, sarcasm, "obviously" — text strips tone and seniority fills the vacuum. Correct approach: the section 5 norms, enforced by leads *modeling* them: questions, `nit:` labels, artifact-not-author language.
5. **Solo lockout.** You enable `required_approving_review_count: 1` on a personal repo and discover you can't approve yourself; PRs pile up unmergeable. Correct approach: solo → count `0` (keep the PR requirement); the setting earns its `1` when a second human joins.
6. **Requiring a status check that doesn't exist yet.** Enabling `required_status_checks` before any workflow reports `ci` freezes every merge at "Expected" — people do it while pre-configuring "the end state". Correct approach: require checks only after they exist; TicketHub flips this on in Module 7.

## Exercises

1. **Template transplant.** Write a `PULL_REQUEST_TEMPLATE.md` for the future `tickethub-infra` Terraform repo (Module 10). Which sections survive, and what replaces "Migration"? (Hint: what's the Terraform equivalent of "does it lock the orders table"?)
2. **Priority-ordered review.** Review this excerpt from a PR titled `feat(orders): admin order editing`, listing every finding in section 6 priority order:

   ```php
   public function update(Request $request, Order $order): JsonResponse
   {
       $order->update($request->all());

       foreach ($order->items as $item) {
           $item->ticketType->update(['quantity_sold' => $item->ticketType->sold()]);
       }

       return response()->json($order);
   }
   ```

   (Expected: no authorization check, mass assignment from `$request->all()`, an N+1 with writes inside it, no transaction around inventory mutation, no validation — in that order.)
3. **Ruleset archaeology.** Apply the section 7 ruleset, fetch it back with `gh api repos/<you>/tickethub-api/rulesets`, and diff the response against your JSON. What did GitHub add or normalize? Then try to delete `main` and force-push to it; collect both error messages.
4. **Stacked PRs for real.** Split a follow-up ("promo code usage limits") into two stacked PRs: schema + model, then endpoint behavior. Open B against A's branch, merge A, watch GitHub retarget B, merge B. Note where the rebase choreography bit you.
5. **Stretch — review calibration.** With a teammate (or your second account), independently review the same TicketHub PR using section 6. Compare findings: which priorities did each of you over- or under-weight? Agree on one norm you'd add to the culture list, and write it as a `CONTRIBUTING.md` bullet.

## What's next

`main` is now protected, linear, and made entirely of reviewed, squash-merged PRs whose titles look suspiciously machine-readable — `feat(orders): …`, `chore: …`. That's no accident. [Lecture 4.4 — Versioning & Releases](04-versioning-and-releases.md) turns those titles into the conventional-commits contract, and the contract into automation: SemVer, annotated tags, changelogs, and the release flow Module 9 wires straight into production deploys.
