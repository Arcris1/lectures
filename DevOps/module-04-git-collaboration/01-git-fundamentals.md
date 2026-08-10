# Lecture 4.1 — Git Fundamentals

> **Module 4 — Git & Collaboration Workflows** · Lecture 1 of 4 · Estimated time: ~75 min

You have been using Git since Module 1: `git add`, `git commit`, `git push` on your laptop, and `git pull` on the VPS to deploy TicketHub. That is Git as a glorified file-copy tool. It works — until you need to undo something, or two people edit the same file, or a `.env` full of credentials lands in history.

The fix is not memorizing more commands; it is a mental model. Git is a small, honest system — a content database plus some pointers — and once you can picture it, every command becomes predictable. This lecture builds that model and puts it to work on the TicketHub repo.

## Learning objectives

- Explain Git's object model — blobs, trees, commits, refs — and why history forms a DAG
- Move changes deliberately between working tree, index, and repository
- Create and switch branches, explain HEAD, and demystify detached HEAD
- Resolve a real merge conflict in TicketHub code, and abort a merge safely
- Choose the correct undo command for any situation, and recover "lost" commits with the reflog
- Configure `.gitignore` for Laravel 12 and respond correctly if a secret is ever committed

## 1. Why version control — and why Git won

Version control answers questions you will ask constantly as a DevOps engineer: *What exactly is running in production? What changed between yesterday and today, and who changed it? Can I get back to the last good state in seconds?* Module 1's DORA metrics — lead time, mean time to restore — are directly limited by how well your team uses version control. A team that can `git revert` and redeploy in five minutes has a fundamentally different MTTR than one restoring `api-final-v2-REAL` folders.

One paragraph of history, because it explains Git's design: *centralized* systems (CVS, Subversion) kept the one true history on a server; committing was a network operation, and offline or private experimentation was painful. *Distributed* systems like Git give every clone the entire history — committing is local and instant, and synchronization (`push`, `pull`, `fetch`) is a separate step between full copies. GitHub is not "the repository" in any technical sense; it is just the copy everyone agrees to treat as central. That convention — shared hub, full local autonomy — enables every workflow in this module.

## 2. The object model: what a commit really is

Git's storage engine is a key-value database of four object types living in `.git/objects`. Learn them and commands stop being magic:

- **Blob** — file *contents*, nothing else. No filename, just bytes.
- **Tree** — a directory listing: names mapped to blobs and other trees.
- **Commit** — a snapshot plus context: one tree (the project root at that moment), zero or more *parent* commits, author, committer, message.
- **Annotated tag** — a named, signable pointer to a commit ([Lecture 4.4](04-versioning-and-releases.md)).

Every object is addressed by the SHA-1 hash of its content, with two enormous consequences. First, identical content is stored once — a thousand commits containing the same unchanged `composer.json` share one blob. Second, an object's ID *proves* its content: a commit's SHA covers its tree and its parents, so one 40-character ID pins the entire history behind it.

Because each commit points to its parent(s), history is a **directed acyclic graph (DAG)** — usually a straight line, branching where work diverges, joining where it merges. And a **ref** (like a branch) is nothing more than a file containing one SHA.

Look inside the TicketHub repo:

```bash
$ cd ~/code/tickethub-api
$ cat .git/HEAD
ref: refs/heads/main

$ cat .git/refs/heads/main
9b1f3c2e8d4a5f6b7c8d9e0f1a2b3c4d5e6f7a8b
```

`HEAD` says "you are on branch `main`"; `main` is literally a 41-byte file holding a commit SHA. Inspect that commit with `cat-file`, Git's raw object viewer:

```bash
$ git cat-file -p HEAD
tree 4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e
parent 7e2c9a1f5d3b4e6a8c0d2f4a6b8c0d2e4f6a8b0c
author Alex Cruz <alex@tickethub.example> 1786237200 +0800
committer Alex Cruz <alex@tickethub.example> 1786237200 +0800

Prevent duplicate reservation on double submit

$ git cat-file -p 4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e
100644 blob 8f3a2c19c4e5d6b7a8f9e0d1c2b3a4d5e6f7a8b9    .env.example
100644 blob 5c7e1d92a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8    .gitignore
040000 tree 7d2e5c04b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6    app
040000 tree 22b19f43d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0    config
...
```

A commit is a tree plus a parent plus a message; a tree is a directory. Hold this picture: **branches are pointers into a graph of snapshots** — merging, rebasing, resetting, and reverting are just operations on pointers and graph nodes.

## 3. The three areas: working tree, index, repository

Every confusing Git command is moving changes between exactly three places:

```text
 working tree            index (staging area)          repository (.git)
 the files you edit  →   the next commit, drafted  →   immutable history
                git add                      git commit
                ←  git restore               ←  git restore --staged
```

- The **working tree** is your project directory — ordinary files you edit.
- The **index** (staging area) is a draft of the *next commit*. `git add` copies a file's current content into it.
- The **repository** is the object database from section 2. `git commit` turns the index into a real commit and moves your branch pointer to it.

The index exists so you can *compose* commits deliberately instead of photographing whatever mess is on disk. You will routinely have three unrelated edits and want three separate commits — `git add -p` even stages individual hunks within one file.

Two diffs, one per gap:

```bash
$ git diff             # working tree vs index: not yet staged
$ git diff --staged    # index vs HEAD: exactly what the next commit contains
```

Make it concrete: improve the log line in `app/Console/Commands/ExpireReservations.php`, and watch `status` narrate the areas:

```bash
$ git status
On branch main
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   app/Console/Commands/ExpireReservations.php

$ git add app/Console/Commands/ExpireReservations.php
$ git diff --staged
diff --git a/app/Console/Commands/ExpireReservations.php b/app/Console/Commands/ExpireReservations.php
@@ -28,7 +28,7 @@ class ExpireReservations extends Command
-        $this->info("Expired {$count} reservations.");
+        $this->info("Expired {$count} reservations older than 15 minutes.");

$ git commit -m "Clarify expiry window in reservation log output"
[main c8d4f21] Clarify expiry window in reservation log output
 1 file changed, 1 insertion(+), 1 deletion(-)
```

Build the habit now: **always run `git diff --staged` before committing** — ten seconds of review catches debug statements, stray files, and secrets before they become history.

## 4. History and branches: pointers all the way down

The daily history command:

```bash
$ git log --oneline -4
c8d4f21 (HEAD -> main) Clarify expiry window in reservation log output
9b1f3c2 (origin/main) Prevent duplicate reservation on double submit
7e2c9a1 Add nightly sales report command
3f8b6d0 Add ticket reservation with row locking
```

`--graph --all` additionally draws the DAG across every branch — it shines in the hands-on section once branches diverge.

**A branch is a 41-byte file containing a SHA.** Creating one costs nothing, copies nothing — and deleting one deletes no commits:

```bash
$ git switch -c demo/pointers
Switched to a new branch 'demo/pointers'
$ git switch main && git branch -d demo/pointers
```

(`switch` and `restore` split the old overloaded `checkout`: branches vs file content. Prefer them.)

**HEAD** is a pointer to a pointer: it names the branch you are on. When you commit, the *branch* moves forward to the new commit, and HEAD comes along for the ride. That sentence explains "detached HEAD", the state that panics every beginner. Check out a commit directly instead of a branch:

```bash
$ git checkout 7e2c9a1
Note: switching to '7e2c9a1'.

You are in 'detached HEAD' state. You can look around, make experimental
changes and commit them ...
HEAD is now at 7e2c9a1 Add nightly sales report command
```

HEAD now points at a commit instead of a branch. Nothing is broken — this is exactly how you inspect "the code before the reservation feature" during an incident. The only risk: commits made here belong to no branch — run `git switch -c rescue-branch` to keep any. Return with `git switch main`.

## 5. Merging: fast-forward, three-way, and conflicts

Merging brings one branch's commits into another. There are exactly two cases.

**Fast-forward.** If `main` has not moved since you branched, your branch is a straight continuation of it. There is nothing to combine — Git slides the pointer forward to your branch tip; no new commit. This is why short-lived branches merge trivially.

**Three-way merge.** If both branches gained commits, Git finds their common ancestor (the *merge base*) and combines the two change sets relative to it, producing a **merge commit** — the one kind of commit with two parents. Where the sides changed *different* lines, Git combines automatically. Where they changed the *same* lines, Git refuses to guess and hands you a **conflict**:

```text
<<<<<<< HEAD
    your version (the branch you are on)
=======
    their version (the branch you are merging in)
>>>>>>> fix/shorten-reservation-window
```

A conflict is not an error. It is Git correctly saying "two humans made overlapping decisions; a human must pick the outcome." Resolving means editing the file to its *intended final state* — often neither side verbatim — removing the markers, then `git add` (marks it resolved) and `git commit`. `git merge --abort` restores the pre-merge state if you get overwhelmed. You'll do all of this for real below.

## 6. The undoing taxonomy

"How do I undo?" depends on *where* the mistake lives — hence the three areas. Bookmark this table:

| Situation | Command | Rewrites history? |
|---|---|---|
| Working-tree changes you want gone | `git restore <path>` | No (destroys uncommitted work) |
| Staged something you shouldn't have | `git restore --staged <path>` | No |
| Last commit wrong, not yet pushed | `git commit --amend` | Yes — last commit only |
| Bad commit already pushed/shared | `git revert <sha>` | No — adds an inverse commit |
| Move branch back to an older commit (local) | `git reset --soft/--mixed/--hard <sha>` | Yes |
| "I lost commits" after a bad reset | `git reflog`, then `reset --hard <sha>` | Recovers them |

The details that matter:

**`restore`** overwrites working-tree files from the index (or HEAD with `--source`). There is no undo — uncommitted work exists nowhere else.

**`commit --amend`** doesn't edit a commit; commits are immutable. It creates a *replacement* with a new SHA and repoints your branch. Harmless while private — disruptive once pushed, because teammates (and the VPS!) hold the old SHA. **Never amend a commit that has left your machine**; once public, `revert` instead — a new commit applying the inverse diff, preserving history.

**`reset`** moves your branch pointer to another commit; its flag says what happens to the other two areas. `--soft` moves only the pointer (index and working tree keep the newer content, staged — great for squashing local WIP); `--mixed` (default) also resets the index but leaves your files; `--hard` resets all three. `--hard` is the only truly dangerous flag in daily Git — and only for **uncommitted** work.

**`reflog`** is the safety net: a local journal of every position HEAD has held (~90 days). "Lost" commits after a bad `reset --hard` are not deleted, just unreferenced — the reflog still knows their SHAs.

## 7. Stash: a pocket for half-done work

Mid-feature, files half-edited, an urgent fix is needed on `main`. `git stash` shelves your working tree and index, leaving a clean slate:

```bash
$ git stash push -u -m "wip: promo code scaffolding"
Saved working directory and index state On main: wip: promo code scaffolding

$ git stash list
stash@{0}: On main: wip: promo code scaffolding

$ git stash pop        # re-apply newest and drop it (apply keeps it)
```

The `-u` flag matters: by default stash ignores *untracked* files — exactly what a scaffolded Laravel feature is full of. And treat the stash as a pocket, not a drawer: work sitting more than a day belongs on a WIP branch, which has a name, history, and a backup on push; `stash@{3}` has none of that.

## 8. `.gitignore` and the things that must never be committed

The rule: **commit inputs; ignore outputs, machine-specific files, and secrets.** Laravel 12's stock `.gitignore` encodes years of hard lessons — here it is, annotated:

```gitignore
# ---- Dependencies: outputs of composer/npm install. Rebuilt anywhere from
#      the lockfiles, which ARE committed — they pin exact versions.
/vendor
/node_modules

# ---- Build artifacts: Vite output + dev-server marker. CI rebuilds these.
/public/build
/public/hot

# ---- Machine-generated links & runtime files:
/public/storage        # symlink from `artisan storage:link` — meaningless elsewhere
/storage/pail          # Laravel Pail log-tailing scratch
/storage/*.key         # private keys some packages put in storage/ — SECRETS
/.phpunit.cache
.phpunit.result.cache

# ---- Secrets and per-environment config (deep dive: Module 5):
.env                   # live credentials — the most dangerous file in the repo
.env.backup
.env.production
auth.json              # Composer credentials — a real token!

# ---- Tool noise:
npm-debug.log
yarn-error.log

# ---- Editor/IDE folders (ignored project-side for convenience):
/.fleet
/.idea
/.nova
/.vscode
/.zed
```

Note what is *not* ignored: `.env.example` (keys but no values — the contract for new environments) and the lockfiles. Deleting `composer.lock` from Git is a classic junior mistake that turns "works on my machine" into a lifestyle.

Editor and OS junk is a *personal* concern, not a project one — configure a **global gitignore** once per machine:

```bash
$ git config --global core.excludesFile ~/.gitignore_global
$ printf '.DS_Store\n*.swp\n.idea/\n' > ~/.gitignore_global
```

### When a secret gets committed anyway

It will happen — someone commits `.env`, or hardcodes an AWS key in `config/services.php`. The order of operations is the entire lesson:

1. **Rotate the credential first. Immediately.** The moment a secret is pushed, assume it is harvested — bots scan public GitHub pushes within seconds; private repos leak through forks and CI logs. No history surgery un-leaks a password. Rotation does.
2. **Then rewrite history** with [`git filter-repo`](https://github.com/newren/git-filter-repo) (the maintained successor to `filter-branch`):

```bash
$ git filter-repo --invert-paths --path .env --force
$ git push --force --all
```

Every collaborator must re-clone, and GitHub support must purge cached views and PR diffs. A plain force-push of a "fixed" commit is never enough: the old commit still exists in reflogs, forks, and caches — and the secret was already read anyway. **Rotate first; clean second.** Module 12 adds automated secret scanning so this playbook hopefully never runs.

## 9. Atomic commits and messages worth reading

An **atomic commit** contains exactly one logical change — one bug fix, one refactor, one feature slice — and leaves the project working. Every later superpower depends on this: `git revert` can surgically remove a change only if it lives in one commit; `git bisect` can binary-search for what broke reservations only if each commit builds; reviewers can only review what they can comprehend. "WIP", "fixes", and 40-file "misc changes" commits forfeit all of that.

Messages follow the **50/72 convention**, which every Git tool assumes:

```text
Prevent duplicate reservation on double submit

Rapid double-clicks on checkout created two orders holding the same
seats, because the second request read availability before the first
committed. Wrap the read-check-reserve sequence in one transaction and
lock the ticket_types row with SELECT ... FOR UPDATE.
```

- **Subject:** ≤ 50 characters, capitalized, no trailing period, **imperative mood** — "Prevent", not "Prevented". Test: it should complete *"If applied, this commit will…"*.
- Blank line, then a **body wrapped at 72 characters** explaining *why* — the diff already shows *what*. The body is what your future self reads at 2 a.m. during an incident.

[Lecture 4.4](04-versioning-and-releases.md) layers a machine-readable prefix (`fix:`, `feat:`) on top so tooling can compute versions and changelogs; the human rules above still apply underneath.

## Hands-on with TicketHub

Time to hit a real conflict, in the most sensitive code TicketHub has: `app/Actions/ReserveTickets.php`, home of the critical invariant — never oversell a ticket type:

```php
<?php

namespace App\Actions;

use App\Exceptions\SoldOutException;
use App\Models\Order;
use App\Models\TicketType;
use Illuminate\Support\Facades\DB;

class ReserveTickets
{
    // Inventory is checked under a row lock: concurrent checkouts cannot oversell.
    public function handle(TicketType $ticketType, int $quantity, int $customerId): Order
    {
        return DB::transaction(function () use ($ticketType, $quantity, $customerId): Order {
            $locked = TicketType::query()
                ->whereKey($ticketType->getKey())
                ->lockForUpdate()
                ->firstOrFail();

            if ($locked->available() < $quantity) {
                throw new SoldOutException($locked);
            }

            return Order::createReservation(
                ticketType: $locked,
                quantity: $quantity,
                customerId: $customerId,
                expiresAt: now()->addMinutes(15),
            );
        });
    }
}
```

**Step 1 — a feature branch.** Product wants the 15-minute hold window configurable per environment. Branch, point the `expiresAt:` line at config, add the config file:

```bash
$ git switch -c feat/configurable-reservation-window
Switched to a new branch 'feat/configurable-reservation-window'
# edit ReserveTickets.php:  expiresAt: now()->addMinutes(config('tickethub.reservation_minutes', 15)),
# add config/tickethub.php: ['reservation_minutes' => env('RESERVATION_MINUTES', 15)]
$ git add -A && git commit -m "Make reservation window configurable"
[feat/configurable-reservation-window 5a9e3f4] Make reservation window configurable
 2 files changed, 12 insertions(+), 1 deletion(-)
 create mode 100644 config/tickethub.php
```

**Step 2 — meanwhile, a fix branch from the *old* main.** Before merging, simulate a teammate who branched earlier: last night's on-sale starved inventory, and the quick fix was a shorter window.

```bash
$ git switch -c fix/shorten-reservation-window main
# edit the SAME line:  expiresAt: now()->addMinutes(10),
$ git commit -am "Shorten reservation window to 10 minutes"
[fix/shorten-reservation-window 8c2d7b1] Shorten reservation window to 10 minutes
 1 file changed, 1 insertion(+), 1 deletion(-)
```

**Step 3 — merge the feature: fast-forward.** `main` hasn't moved since the feature branched, so the pointer just slides:

```bash
$ git switch main
$ git merge feat/configurable-reservation-window
Updating c8d4f21..5a9e3f4
Fast-forward
 app/Actions/ReserveTickets.php | 2 +-
 config/tickethub.php           | 11 +++++++++++
 2 files changed, 12 insertions(+), 1 deletion(-)
```

**Step 4 — merge the fix: conflict.** Both branches edited the same line, so Git stops:

```bash
$ git merge fix/shorten-reservation-window
Auto-merging app/Actions/ReserveTickets.php
CONFLICT (content): Merge conflict in app/Actions/ReserveTickets.php
Automatic merge failed; fix conflicts and then commit the result.

$ git status
On branch main
You have unmerged paths.
  (use "git merge --abort" to abort the merge)

Unmerged paths:
  (use "git add <file>..." to mark resolution)
	both modified:   app/Actions/ReserveTickets.php
```

First practice the escape hatch — `git merge --abort`, confirm a clean state with `git status` — then run the merge again and open the file:

```php
<<<<<<< HEAD
                expiresAt: now()->addMinutes(config('tickethub.reservation_minutes', 15)),
=======
                expiresAt: now()->addMinutes(10),
>>>>>>> fix/shorten-reservation-window
```

Think before typing: one side's *intent* is "configurable", the other's is "default to 10". The correct resolution honors both (update the default in `config/tickethub.php` too):

```php
                expiresAt: now()->addMinutes(config('tickethub.reservation_minutes', 10)),
```

Remove the markers, run `php artisan test --filter=Reservation` (a resolution is code you wrote and must verify), then conclude the merge:

```bash
$ git add app/Actions/ReserveTickets.php config/tickethub.php
$ git commit
[main e4f1c9a] Merge branch 'fix/shorten-reservation-window'

$ git log --oneline --graph --all -6
*   e4f1c9a (HEAD -> main) Merge branch 'fix/shorten-reservation-window'
|\
| * 8c2d7b1 (fix/shorten-reservation-window) Shorten reservation window to 10 minutes
* | 5a9e3f4 (feat/configurable-reservation-window) Make reservation window configurable
|/
* c8d4f21 Clarify expiry window in reservation log output
* 9b1f3c2 (origin/main) Prevent duplicate reservation on double submit
```

There's the DAG from section 2, drawn for real: a diamond — one merge commit, two parents.

**Step 5 — the accident, and the rescue.** Now "clean up" the way panicked beginners do:

```bash
$ git reset --hard HEAD~2
HEAD is now at 9b1f3c2 Prevent duplicate reservation on double submit
```

The merge, the resolution, the config work — gone from `git log`. But not from Git:

```bash
$ git reflog -3
9b1f3c2 (HEAD -> main) HEAD@{0}: reset: moving to HEAD~2
e4f1c9a HEAD@{1}: commit (merge): Merge branch 'fix/shorten-reservation-window'
5a9e3f4 HEAD@{2}: merge feat/configurable-reservation-window: Fast-forward

$ git reset --hard e4f1c9a
HEAD is now at e4f1c9a Merge branch 'fix/shorten-reservation-window'
```

Everything is back. `reset` never deleted the commits — the branch pointer just stopped referencing them, and the reflog remembered. This ten-second rescue is why committed work is safe work.

**Step 6 — tidy and publish.** Delete the merged branch pointers (the commits stay) and push:

```bash
$ git branch -d feat/configurable-reservation-window fix/shorten-reservation-window
$ git push origin main
To github.com:tickethub/tickethub-api.git
   9b1f3c2..e4f1c9a  main -> main
```

## Real-world best practices

- **Commit small and often locally; push at least daily.** Frequent commits give `bisect` and `revert` fine-grained targets; pushed work survives dead laptops. The reflog lives only on your machine — pushing is the real backup.
- **Review `git diff --staged` before every commit.** Ten seconds of reading prevents the two worst commit classes: debug leftovers and secrets. Teams that skip this ship `dd($order)` to production.
- **Write commit bodies for the 2 a.m. reader.** During incidents `git log` is the first forensic tool opened — MTTR depends on it. "Fix bug" tells the on-call nothing; the *why* paragraph says whether the commit is a safe revert target.
- **Never rewrite pushed history on shared branches.** Amend and reset freely while work is private; once a SHA has been fetched by a teammate or pulled by the VPS, correct with `revert` — rewrites force everyone else into confusing recovery merges.
- **Treat any pushed secret as fully compromised.** Rotate first, rewrite second, and add pre-commit scanning (gitleaks — formalized in Module 12). Teams that "just force-pushed over it" get their AWS bill spent on someone else's crypto mining.

## Common pitfalls

1. **`git add .` on autopilot.** It's fast — and commits whatever is on disk: editor junk, debug scripts, `.env.backup`. Correct approach: `git status` first, stage deliberately (`git add -p` for partial files), review `git diff --staged`.
2. **Using Git as a save button.** One giant "WIP stuff" commit per day produces unrevertable, unbisectable, unreviewable history. Correct approach: atomic commits — if your message needs "and", it's probably two commits.
3. **`reset --hard` with uncommitted changes on disk.** People reach for it to "make the errors go away"; the reflog cannot save what was never committed. Correct approach: `git stash` first if in doubt — a stash costs nothing; retyping a day's work costs a day.
4. **Amending or force-pushing shared commits.** Feels tidy; invalidates the SHA everyone else holds, including the deploy remote. Correct approach: amend only unpushed commits; after pushing, live with the typo or `revert`.
5. **Committing `.env` "just this once" because staging credentials feel harmless.** Bots don't distinguish staging from production, and staging often shares your SES/S3 account. Correct approach: if it happens, rotate immediately, then `filter-repo` — in that order.
6. **The nuke-and-reclone workflow.** Re-cloning "fixes" a confusing state — silently discarding stashes, local branches, and reflog. Correct approach: `git status` names which of the three areas is in what state; the table above has a targeted command for each.

## Exercises

1. **Spelunk the object store.** Using only `cat .git/HEAD` and `git cat-file -p`, walk from `HEAD` to the blob containing `app/Actions/ReserveTickets.php` and print it. No `git show` allowed.
2. **Compose a commit.** Make two unrelated edits to the same file. Use `git add -p` to stage and commit only one, verifying with `git diff --staged` first. Finish with two clean atomic commits.
3. **Re-run the conflict.** Recreate the two-branch conflict with different edits (one branch renames `$quantity`, the other adds validation on it). Resolve it, deliberately resolve it *wrong* once, and use the reflog to get back before the merge and redo it.
4. **Public vs private undo.** On a scratch branch, make a commit and amend it. Then push a commit and revert it. Inspect `git log` after each: explain why the amend changed a SHA and the revert added one.
5. **Stretch — the leaked secret drill.** In a *throwaway clone*, commit a fake `.env` with `AWS_SECRET_ACCESS_KEY=oops123`, make two more commits, then purge it with `git filter-repo --invert-paths --path .env`. Prove it's gone with `git log --all --full-history -- .env` and `git log -p | grep -c oops123`. Write down the two things you'd do *before* this in real life, in order.

## What's next

You now hold Git's actual model: snapshots in a DAG, pointers that move, three areas changes flow through. What you don't yet have is *process* — when to branch, how long branches live, how a team keeps `main` deployable while ten people commit daily. That's [Lecture 4.2 — Branching Strategies](02-branching-strategies.md): GitFlow vs GitHub Flow vs trunk-based development, and the strategy TicketHub adopts for the rest of the course.
