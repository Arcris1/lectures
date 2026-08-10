# Lecture 7.3 — Code Quality Gates

> **Module 7 — Continuous Integration with GitHub Actions** · Lecture 3 of 4 · Estimated time: ~60 min

[Lecture 7.2](02-tickethub-test-pipeline.md) gave the pipeline its most important check: the test suite, run against real MySQL and Redis. But tests only catch defects you imagined while writing them. Three whole classes slip past: style drift that wastes reviewer attention comment by comment, type unsoundness that runs fine until production data contains the one shape nobody's factory produces, and dependencies with published CVEs that no amount of your own testing will reveal. All three are objective, which means all three are machine work.

This lecture wires the machines in: Laravel Pint for style, PHPStan with Larastan for static analysis — including a real bug it finds in TicketHub's report code — and a layered dependency gate. Then it pays the module's oldest debt: the branch ruleset from [Lecture 4.3](../module-04-git-collaboration/03-pull-requests-code-review.md) has been waiting since Module 4 for status checks worth requiring. Today they exist, and today the ruleset starts enforcing them.

## Learning objectives

- Explain why objective checks belong to machines, and what that buys the humans in code review
- Configure Laravel Pint with a minimal `pint.json` and run it as a non-mutating gate — and defend why CI must never auto-commit fixes
- Adopt PHPStan + Larastan on an existing codebase with an honest level strategy and a baseline you ratchet down
- Layer three dependency gates — `composer audit`, dependency review on PRs, and a grouped weekly Dependabot config — and state what each one catches
- Extend the `quality` job with cached, annotated static analysis while keeping it under three minutes
- Update the Module 4 ruleset so `tests` and `quality` are required checks, naming them correctly so PRs never hang at "Expected"

## 1. The principle: machines gate the objective, humans review the substantive

Lecture 4.3 gave code review a priority order — correctness, security, migration safety, tests, readability — and one hard rule: style is not on the list, because anything a machine can decide totally and without feelings should never consume human attention. This lecture is that rule, industrialized. A quality *gate* is a check that is **objective** (two runs on the same commit always agree), **fast** (feedback in minutes), and **self-explanatory** (the failure names the file, the line, and the fix). Style rules, type errors, and known-vulnerable dependencies all qualify. "This method feels too long" does not — that stays in review, where judgment lives.

The payoff is a clean division of labor across the pipeline:

| Gate | Question it answers | Tool |
|---|---|---|
| `tests` (7.2) | Does the code *behave* correctly? | Pest + real MySQL/Redis |
| Style | Is the code *formatted* the one agreed way? | Laravel Pint |
| Static analysis | Is the code *sound* — types, nulls, impossible states? | PHPStan + Larastan |
| Dependency gates | Is anything we *depend on* known-vulnerable? | `composer audit`, dependency review, Dependabot |

Every row a machine owns is a category of review comment that stops existing. What remains for humans is exactly the list machines can't touch — and that scarcity of noise is what makes reviewers actually read the diff.

## 2. Pint: one style, zero conversations

Laravel Pint — already installed and running since [Lecture 7.1](01-ci-concepts-workflow-anatomy.md) — is a wrapper around PHP-CS-Fixer that trades its hundreds of rule decisions for one word: a **preset**. With no config at all, Pint applies the `laravel` preset, the style the framework itself uses. That default carried us through two lectures; now make it explicit, because implicit config is config nobody can review. `pint.json` at the repo root:

```json
{
    "preset": "laravel",
    "rules": {
        "concat_space": {
            "spacing": "one"
        },
        "nullable_type_declaration_for_default_null_value": true
    }
}
```

Keep overrides *few* and *justified* — every rule you add is a deviation the next hire must learn. These two earn their place. `concat_space`: the Laravel preset glues concatenation (`$name.$suffix`), which the team finds unreadable next to method chains; one space is a pure taste call, and the point of a formatter is that taste calls get made **once**, in a reviewed commit, instead of in every PR forever. `nullable_type_declaration_for_default_null_value`: rewrites implicitly nullable parameters (`Event $event = null`) to the explicit `?Event $event = null` — not taste at all, because PHP 8.4 **deprecates** the implicit form. The rule makes the deprecated syntax unrepresentable in the codebase, which is the best kind of upgrade: one nobody has to remember.

Two modes matter operationally. `pint` **rewrites files** to comply. `pint --test` **changes nothing** — it reports violations and exits non-zero, which is what the `quality` job has run since 7.1. Keep that distinction sacred, because the tempting alternative is genuinely harmful:

**Why CI never auto-commits fixes.** The pattern circulates in every Actions tutorial: run `pint`, then have the workflow commit and push the result to the PR branch. Resist it, for four compounding reasons. First, it **injects unreviewed changes into a reviewed branch** — the entire ruleset from Module 4 exists so that every change on `main` was seen by a human, and a bot pushing after approval is a hole in that wall (your ruleset even dismisses stale approvals on push, so the "fix" un-approves the PR and loops the process). Second, it breaks **commit signing and attribution** — the commit belongs to a token, not a person, and fails any signed-commit requirement outright. Third, it needs `contents: write`, escalating the very token 7.1 taught you to keep read-only. Fourth, it doesn't even work uniformly: fork PRs run with a read-only token, so the workflow that "fixes" teammate branches silently fails for outside contributors. The correct loop is: **CI reports, the author fixes locally, the commit is theirs.** The hands-on section makes local fixing a one-word command plus an optional pre-commit hook, so the gate almost never fires in the first place.

## 3. PHPStan + Larastan: finding the bug you didn't write a test for

Tests execute the code with inputs you chose. **Static analysis reads the code and reasons about every input it could receive** — no execution, no database, no luck. It treats every type declaration as a claim and hunts for the code path where the claim breaks: the `null` that flows into a method call, the string handed to a parameter typed `int`, the match arm that can never be reached. PHPStan is PHP's standard tool for this; **Larastan** is the PHPStan extension that teaches it Laravel's magic — facades, `config()` keys, Eloquent model properties (inferred from your casts *and your migration files*, statically — which is why the `quality` job needs no database service), and relation types.

That last one is where TicketHub keeps a real bug. The nightly sales report command — `App\Console\Commands\SendNightlySalesReports`, scheduled `dailyAt('02:00')` since Module 1's domain tour — formats one line per order:

```php
// app/Console/Commands/SendNightlySalesReports.php

protected function reportLine(Order $order): string
{
    return sprintf(
        '#%d · %s · %d tickets · %s',
        $order->id,
        $order->event->venue,          // line 61
        $order->tickets->count(),
        Number::currency($order->total / 100),
    );
}
```

Every test passes. Every factory in the suite creates orders attached to events, so `$order->event` has never once been null in test. But TicketHub's schema says it can be: `orders.event_id` is `nullOnDelete()`, because financial records must outlive a delisted event. The day an organizer removes an old event that still has historical orders, the 02:00 report run hits one of those orders, `$order->event` returns `null`, and the command throws — killing the *entire* nightly report for *every* organizer, silently, until someone asks where their numbers went. A race you'd find in production, days late. PHPStan finds it at level 8 in twenty seconds, because Larastan types `$order->event` as `Event|null` — a `BelongsTo` can always come back empty:

```text
 ------ ----------------------------------------------------------------------
  Line   app/Console/Commands/SendNightlySalesReports.php
 ------ ----------------------------------------------------------------------
  61     Cannot access property $venue on App\Models\Event|null.
         🪪  property.nonObject
 ------ ----------------------------------------------------------------------
```

The error is really a question: *what should this line do when the event is gone?* For a report, degrade gracefully:

```php
$order->event?->venue ?? '(event removed)',
```

Notice what just happened: the type system forced a product conversation the tests never raised. You could have answered differently — make deletion impossible (`restrictOnDelete()` on the FK, then the relation is never null and you assert it), or eager-load from the `Event` side so the null direction is never traversed. Any of the three is defensible; *not deciding* was the bug. That is what static analysis catches that tests don't: tests verify the worlds you imagined, the analyzer enumerates the worlds your types permit.

## 4. Adopting analysis on a codebase that already exists

PHPStan's strictness is a dial: **levels 0–10**. Low levels catch undefined symbols and obvious mistakes; 5 checks argument types; 6 demands type coverage (this is where `iterable type array` complaints appear); 8 adds the nullability checks that caught the venue bug; 9–10 get strict about `mixed`. The honest adoption strategy depends on where you're standing. **Greenfield: start at the top** (`level: max`) from the first commit — every error is about code you wrote this week, and the standard costs nothing to maintain from day one. **Existing codebase: pick the level worth enforcing, then baseline the backlog.** Running TicketHub at level 8 today produces 41 errors; demanding someone fix all 41 before merging anything ever again is how analyzers get deleted in week two. Instead, `--generate-baseline` writes every *current* error into `phpstan-baseline.neon`, a file of ignore patterns that the config includes. From then on **the build fails only on new errors**: the debt is frozen, the border is patrolled.

The baseline is tracked debt, and two mechanics keep it honest. When you *fix* a baselined error, PHPStan fails with "ignored error pattern was not matched" until you regenerate — so the baseline can only shrink through deliberate commits, and every shrink is visible in a diff. And governance is one review rule: **a PR where the baseline shrinks is celebrated; a PR that regenerates it larger is hiding new errors inside old debt, and gets read very carefully.** Schedule a little paydown (a few errors per sprint) and the file trends to empty.

The config, `phpstan.neon` at the repo root:

```neon
includes:
    - vendor/larastan/larastan/extension.neon
    - phpstan-baseline.neon

parameters:
    level: 8
    paths:
        - app
        - config
        - database
        - routes
    tmpDir: var/phpstan
```

`paths` covers everything that ships; add `tests/` later if you want your test code held to the same standard. `tmpDir` pins the **result cache** — PHPStan remembers analysis per file and re-checks only what changed, which is the difference between a 60-second cold run and a 15-second warm one. On your laptop that cache just works; in CI every runner is fresh (7.1's fresh-VM rule), so the hands-on section persists `var/phpstan` with `actions/cache` — and because the cache validates itself against file hashes, config, and PHP version, a stale restore is merely slower, never wrong, exactly the cache discipline 7.1 demanded. One more operational habit: run with `--memory-limit=1G` locally, because default CLI limits abort mid-analysis on real codebases (CI is fine — `setup-php` lifts the limit).

## 5. Gating the supply chain

Your code can be pristine while `composer.lock` ships an exploit. Three tools, three different questions:

**`composer audit` — is anything installed right now known-vulnerable?** Built into Composer, it checks the lock file against the advisory databases behind Packagist (including the GitHub Advisory Database) and exits non-zero on any hit. Note the policy it implies: *any* advisory fails, no severity threshold — and this course keeps it that way, because PHP advisories are rare and high-signal, and a gate with a "medium doesn't count" clause trains people to argue severity instead of upgrading. The escape valve for a genuinely unexploitable finding is an entry in `composer.json`'s `audit.ignore` config **with the reason written next to it** — the same reviewed-exception governance Module 6 established for `.trivyignore`. Two flags matter: we pass `--abandoned=report`, because Composer now *fails* on abandoned packages by default, and abandonment is a roadmap concern, not a merge emergency; and we deliberately do **not** pass `--no-dev` — dev dependencies execute in CI with a repo token, which makes them exactly as much of a supply chain as the code you deploy.

**Dependency review — is this PR *adding* something vulnerable?** `actions/dependency-review-action` diffs the dependency graph between base and head and fails the PR when a newly added or upgraded package carries a known advisory (we set `fail-on-severity: high`), before it ever reaches the lock-file-wide audit. It also covers ecosystems Composer can't see — the pinned GitHub Actions themselves, npm if the repo builds assets — and can enforce license policy (`deny-licenses`), which is a lawyer's decision, not ours today. One honest limitation: it's free on public repos, but private repos need GitHub's paid code-security add-on.

**Dependabot — are we drifting behind?** The previous two gates react to known-bad; Dependabot keeps you *current*, which is the cheapest security posture there is, because the smaller the version gap, the smaller the emergency when a CVE drops. `.github/dependabot.yml` (the full file lands in the hands-on) asks for **weekly, grouped** update PRs: minor and patch bumps arrive as one reviewable PR per ecosystem per week instead of eleven separate pings, while majors stay individual because they deserve individual attention. Every Dependabot PR runs the entire pipeline — tests against real MySQL, PHPStan, audit — which is the whole reason update PRs are cheap to merge: the pipeline you built *is* the review. (Separately from these scheduled version updates, enable Dependabot *security updates* in the repo's Code security settings — those PRs arrive immediately when an advisory affects you, not on Monday.)

**And one tool this course deliberately does not wire in: Rector.** Rector performs automated *refactoring* — upgrading code across PHP versions, applying Laravel-specific modernizations via `driftingly/rector-laravel`, converting docblocks to native types at scale. It is superb, and it does not belong in `ci.yml`, for the section 2 reason: it rewrites code, and gates must never mutate. Rector is a tool you *run deliberately* on a branch, producing an ordinary PR that gets ordinary review — typically before a PHP or Laravel version bump. Know it exists; reach for it in that moment; keep it out of the gate.

## 6. Making the checks required — closing Module 4's loop

Lecture 4.3 wrote the ruleset that protects `main` and left one block deliberately unapplied — `required_status_checks`, sketched with a placeholder context named `ci` — because requiring a check nothing reports freezes every PR at "Expected — waiting for status to be reported". The checks exist now, so it's time. But the placeholder hides the detail that bites almost everyone: **a workflow does not report a check named after itself.** GitHub Actions reports **one check run per job, named after the job** — the `id` (`tests`, `quality`) unless a `name:` property overrides it, plus a matrix suffix if there is one (7.2's hypothetical shards would report `tests (Feature)`). Require the literal string `ci` and you have required a check that will never arrive; the merge button waits politely, forever. The contexts to require are the job names: **`tests`** and **`quality`**.

Which cuts both ways: once a job name is a required context, that name is **load-bearing configuration**. Rename `quality` to `lint` in a cleanup PR without touching the ruleset, and every subsequent PR blocks on a `quality` check that no longer exists — same "Expected" symptom, self-inflicted, and confusing precisely because *the workflow is green*. Treat job names like an API: rename the job and update the ruleset in the same change, and expect one moment of manual unblocking (an admin merge or a temporary rule edit) for the PR that performs the rename, since it can't satisfy the old name and the new one simultaneously.

Two refinements complete the block. `strict_required_status_checks_policy: true` — "require branches to be up to date" in the UI — closes the gap 7.1 flagged: a PR's green check describes the merge with `main` *as it was at run time*; if `main` moves afterward, strict mode demands a re-run against the new base before merging. The cost is honest — every base move means clicking **Update branch** and waiting for CI again, which on busy repos serializes merges (the industrial fix, merge queues, is overkill for a team of four — file next to 7.2's sharding). And pin each context to `integration_id` 15368 — the GitHub Actions app — so only Actions can satisfy it; without the pin, any installed app (or a stray commit status pushed via the API) could report a check *named* `tests`, and the ruleset would believe it.

## Hands-on with TicketHub

Everything lands in one PR, then the ruleset flip makes it law.

**Step 1 — Pint config.** Add `pint.json` from section 2, then apply the two new rules to the whole codebase in the same commit, so the gate and the compliance land together:

```console
$ ./vendor/bin/pint
  ................................................................ 249 files
                                                             FIXED 249 files, 31 style issues
$ ./vendor/bin/pint --test
                                                              PASS 249 files
```

**Step 2 — adopt Larastan, triage, baseline.** Install, then run the first analysis and *read it before you silence it*:

```console
$ composer require --dev "larastan/larastan:^3.0"
$ vendor/bin/phpstan analyse --memory-limit=1G
 ------ ------------------------------------------------------------------
  Line   app/Http/Requests/StoreOrderRequest.php
 ------ ------------------------------------------------------------------
  24     Method App\Http\Requests\StoreOrderRequest::rules() return type
         has no value type specified in iterable type array.
         🪪  missingType.iterableValue
 ------ ------------------------------------------------------------------
  ...
  61     Cannot access property $venue on App\Models\Event|null.
         🪪  property.nonObject
 ------ ------------------------------------------------------------------
 [ERROR] Found 41 errors
```

Triage rule: **fix the bugs, baseline the debt.** Forty of these are missing type coverage — real debt, not urgent. One is the section 3 venue bug: fix it now (real bugs never go in the baseline — a baselined bug is a bug with a permission slip). Then freeze the rest:

```console
$ vendor/bin/phpstan analyse --generate-baseline --memory-limit=1G
 [OK] Baseline generated with 40 errors.
$ vendor/bin/phpstan analyse --memory-limit=1G
 [OK] No errors
$ echo "/var/" >> .gitignore     # PHPStan's tmpDir lives untracked
```

Commit `phpstan.neon` (from section 4) and `phpstan-baseline.neon` together.

**Step 3 — extend the `quality` job.** The 7.1 job grows three steps and a cache. The complete job as it now stands in `ci.yml`:

```yaml
  quality:
    runs-on: ubuntu-latest
    timeout-minutes: 8          # headroom for cold-cache PHPStan runs; p50 stays ~2½ min
    steps:
      - uses: actions/checkout@v4

      - name: Set up PHP 8.4
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.4'
          coverage: none

      - name: Validate composer.json and lock file
        run: composer validate --strict

      - name: Determine Composer cache directory
        id: composer-cache
        run: echo "dir=$(composer config cache-files-dir)" >> "$GITHUB_OUTPUT"

      - name: Cache Composer downloads
        uses: actions/cache@v4
        with:
          path: ${{ steps.composer-cache.outputs.dir }}
          key: composer-${{ runner.os }}-${{ hashFiles('composer.lock') }}
          restore-keys: composer-${{ runner.os }}-

      - name: Install dependencies
        run: composer install --prefer-dist --no-progress --no-interaction

      - name: Check code style (Pint)
        run: ./vendor/bin/pint --test

      - name: Cache PHPStan result cache
        uses: actions/cache@v4
        with:
          path: var/phpstan
          key: phpstan-${{ runner.os }}-${{ github.run_id }}
          restore-keys: phpstan-${{ runner.os }}-

      - name: Static analysis (PHPStan + Larastan)
        run: ./vendor/bin/phpstan analyse --error-format=github --no-progress

      - name: Audit dependencies for known vulnerabilities
        run: composer audit --abandoned=report

      - name: Review dependency changes (PRs only)
        if: github.event_name == 'pull_request'
        uses: actions/dependency-review-action@v4
        with:
          fail-on-severity: high
```

Three details are doing quiet work. The PHPStan cache **inverts** the Composer key pattern: the result cache changes on every run, so an exact-key hit (which skips re-saving — 7.1) would freeze it forever; keying on the unique `github.run_id` guarantees a miss, `restore-keys` restores the *newest* previous cache, and a fresh entry saves at job end. `--error-format=github` makes every finding a PR annotation on the exact file and line (PHPStan even auto-detects Actions and would switch formats itself; we state it because pipeline config should read as intent). And the step order is cheap-to-expensive — Pint in seconds, PHPStan in tens of seconds, audit and review at the end — so the commonest failures cost the least wall time. Budget check: with warm caches the whole job runs ~2½ minutes, comfortably inside the three-minute target that keeps `quality` the fastest feedback in the pipeline.

**Step 4 — Dependabot.** The full `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "composer"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "07:00"
      timezone: "Asia/Singapore"
    open-pull-requests-limit: 5
    groups:
      composer-minor-patch:
        applies-to: version-updates
        update-types: ["minor", "patch"]
    commit-message:
      prefix: "chore(deps)"
    labels: ["dependencies"]

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "07:00"
      timezone: "Asia/Singapore"
    groups:
      actions:
        patterns: ["*"]
    commit-message:
      prefix: "ci"
    labels: ["dependencies"]
```

Composer minors and patches arrive grouped every Monday; majors arrive solo, ungrouped by omission. The second block keeps the workflow's own pinned actions current — your CI is a dependency tree too. Commit prefixes follow Module 4's conventional commits, so release automation keeps working. (If the repo grows a `package.json` build, add a third block for `npm` on the same pattern.)

**Step 5 — local ergonomics.** Devs should run CI's brain without pushing. In `composer.json`:

```json
"scripts": {
    "fix": "pint",
    "check": [
        "pint --test",
        "phpstan analyse --memory-limit=1G",
        "@composer audit --abandoned=report",
        "@php artisan test --parallel"
    ]
}
```

`composer check` is the PR pre-flight — same commands, same configs, same verdict as CI, which is what keeps "green locally, red in CI" from ever being a mystery (set `"process-timeout": 600` in `config` so Composer doesn't kill the test run at five minutes). Optionally, wire a shared pre-commit hook — checked in at `.githooks/pre-commit`, opt-in via `git config core.hooksPath .githooks`:

```bash
#!/bin/sh
./vendor/bin/pint --test --dirty || {
    echo "Style violations in changed files — run: composer fix   (then re-stage)"
    exit 1
}
```

Note the hook *checks* (`--test --dirty`: only files you touched) and tells you to fix — it never rewrites files mid-commit. Same principle as CI, smallest possible scale.

**Step 6 — ship it, then flip the switch.** PR, watch, merge:

```console
$ git switch -c ci/quality-gates
$ git add pint.json phpstan.neon phpstan-baseline.neon .github/dependabot.yml \
      .gitignore composer.json composer.lock app/
$ git commit -m "ci: add Pint config, Larastan at level 8 with baseline, dependency gates"
$ git push -u origin ci/quality-gates && gh pr create --fill && gh run watch
✓ ci/quality-gates ci · 17301226418
JOBS
✓ tests in 4m02s
✓ quality in 2m31s
```

Now close Module 4's loop. Edit `.github/rulesets/protect-main.json` — the settings-as-code copy from Lecture 4.3 — adding the block it left out, with the *real* context names in place of the `ci` placeholder:

```json
{
  "type": "required_status_checks",
  "parameters": {
    "strict_required_status_checks_policy": true,
    "required_status_checks": [
      { "context": "tests",   "integration_id": 15368 },
      { "context": "quality", "integration_id": 15368 }
    ]
  }
}
```

Apply it to the live ruleset (a `PUT` replaces the whole ruleset with the file's contents, which is exactly why the file is in Git):

```console
$ RULESET_ID=$(gh api repos/tickethub/tickethub-api/rulesets \
      --jq '.[] | select(.name == "protect-main") | .id')
$ gh api "repos/tickethub/tickethub-api/rulesets/$RULESET_ID" \
      --method PUT --input .github/rulesets/protect-main.json
```

Open any PR and look at the merge box: `tests` and `quality` now carry a **Required** badge, and the merge button stays disabled — for everyone, including admins — until both report green. Since Module 4 the workflow has been culture; as of this command it is physics.

## Real-world best practices

- **Gate only what is objective and deterministic; everything else is review.** A gate that two runs can disagree on (a flaky metric, a "maintainability score") teaches the team to re-run until green, and that habit spreads to the gates that matter. Keep the gate binary and boring; keep judgment human.
- **CI reports; humans commit.** No workflow ever mutates a branch — not Pint fixes, not baseline regenerations, not lock-file bumps (Dependabot is the disciplined exception: its commits *are* the PR, not additions to yours). The moment a bot pushes to reviewed branches, review integrity, signing, and fork parity all crack at once.
- **Treat the baseline as a debt ledger with a paydown schedule.** Frozen debt that only ever shrinks is a strategy; frozen debt nobody looks at is denial. Budget a few fixes per sprint, and hold the review line that regenerating the baseline *larger* requires an explanation in the PR description.
- **Keep `quality` under three minutes, ordered cheap-to-expensive.** It is the check developers will run against most often; its speed sets the perceived cost of pushing small commits, and small commits are the whole trunk-based bargain from Module 4. When PHPStan outgrows the budget, the result cache and level discipline are the levers — not deleting checks.
- **Pin required contexts to the Actions app.** `integration_id: 15368` means a check named `tests` only satisfies the ruleset when GitHub Actions reported it. Without the pin, anything that can create a status or check run on the repo can impersonate your gate — an integration you installed for something unrelated becomes a bypass.
- **One formatter, one analyzer.** Adding a second style tool (PHP_CodeSniffer next to Pint) or overlapping analyzers guarantees contradictory verdicts and config archaeology. Depth comes from raising PHPStan's level, not from adding voices.

## Common pitfalls

1. **Letting CI auto-commit style fixes.** It demos beautifully — push messy code, watch the bot tidy it. But it injects unreviewed commits past a review-required ruleset, dismisses approvals (your own `dismiss_stale_reviews_on_push` at work), breaks signing, and dies on fork PRs. Correct approach: `pint --test` in CI, `composer fix` locally, optionally the pre-commit hook.
2. **Requiring a check named after the workflow.** `ci` is the workflow's name, so it feels like the check's name — Module 4's sketch made the same natural guess. No job named `ci` exists, so every PR waits at "Expected — waiting for status to be reported", forever. Correct approach: require job names (`tests`, `quality`); verify against the names on a real PR's checks tab before applying the ruleset.
3. **Renaming a job without updating the ruleset.** Same symptom as pitfall 2, but self-inflicted later and harder to spot because the workflow itself is green. Correct approach: job names are API — rename job and ruleset in the same change, and expect to manually unblock the renaming PR itself.
4. **Turning on `level: max` against an existing codebase with no baseline.** Four hundred errors on day one, every PR red, and by Friday someone proposes removing PHPStan. Correct approach: pick the level whose *new* findings you'd genuinely fix (8 is this course's floor — nullability is where Laravel bugs live), baseline the backlog, ratchet.
5. **Baselining without triaging.** `--generate-baseline` on the first run silences everything — including the venue bug, which is now a production incident with a permission slip. Correct approach: read the first report, fix everything that is a *behavior* bug, baseline only the debt.
6. **Running `composer audit --no-dev` in CI to "check what ships".** It feels precise, but dev dependencies execute during CI with a repo token attached — a compromised dev package is a supply-chain hole regardless of what reaches production. Correct approach: audit everything in CI; `--no-dev` belongs to the image build, where Module 6 already excludes dev packages.

## Exercises

1. **Own an override.** Pick one Pint rule you feel strongly about (`ordered_class_elements` is a good candidate), add it to `pint.json`, and run `./vendor/bin/pint --test -v` to see the diff it would impose. Keep it or drop it — but write the justification in the commit message either way, the way section 2 justified its two.
2. **Walk the level ladder.** Run `vendor/bin/phpstan analyse --level={5..10}` (temporarily removing the baseline include) and record the error count at each level. Where does the count jump? Write a three-sentence policy for when TicketHub raises its committed level, and what happens to the baseline when it does.
3. **Trip every dependency gate.** On a branch, `composer require "guzzlehttp/psr7:2.4.0"` (it has a published advisory, CVE-2023-29197) and push a PR. Watch `composer audit` and the dependency review step both fail; compare what each reports and *when each would have caught it* if the other didn't exist. Revert the branch.
4. **Ratchet the baseline.** Fix five errors from `phpstan-baseline.neon` (missing array value types are quick wins), watch PHPStan fail on the now-unmatched ignore patterns, regenerate, and open the PR. Confirm the diff shows the baseline strictly shrinking — the review signal from section 4 in action.
5. **Stretch — a Rector dress rehearsal.** Install `rector/rector` and `driftingly/rector-laravel` on a branch, configure the Laravel set list, and run `vendor/bin/rector process --dry-run`. Review its proposed diff like a hostile reviewer: pick the one transform you trust most, apply just that rule as its own PR through the full gate, and note how the pipeline you built this module is what made an automated rewrite safe to merge.

## What's next

Every PR is now verified twice over — behavior by `tests`, soundness and supply chain by `quality` — and the ruleset makes both non-optional. But notice what the pipeline *produces*: a green checkmark, nothing more. The container image that Modules 8 and 9 will actually run still gets built by hand on whoever's laptop last ran `docker build`. [Lecture 7.4 — Building & Pushing Images in CI](04-building-images-in-ci.md) fixes that: every merge to `main` will produce an immutable, scanned, provenance-stamped image in ECR — authenticated to AWS with no stored keys at all, thanks to OIDC — and the module's complete `ci.yml` becomes the course's reference pipeline.
