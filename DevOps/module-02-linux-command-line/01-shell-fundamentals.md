# Lecture 2.1 — Shell Fundamentals

> **Module 2 — Linux & the Command Line** · Lecture 1 of 4 · Estimated time: ~90 min

In Module 1 you met TicketHub and the delivery lifecycle it has to travel. Now the practical work begins. The destination for the next two modules is a single Ubuntu 24.04 server that runs TicketHub behind Nginx and PHP-FPM — and every production system you will ever touch, from a $6 VPS to a Kubernetes node in AWS, is administered the same way: through a text shell. There is no clicking your way out of a 3 a.m. incident. This lecture makes the shell feel like home: where things live, how to look at them, and how to combine small tools into powerful one-liners — the skill you'll use daily for the rest of this course and your career.

## Learning objectives

- Distinguish a terminal, a shell, and a console, and explain why this course uses bash on servers.
- Navigate the Linux filesystem hierarchy and state where config, logs, and Laravel applications conventionally live.
- Read `ls -la` output column by column without guessing.
- Inspect files of any size with `cat`, `less`, `head`, and `tail`, including following a live log.
- Build pipelines using stdin/stdout/stderr, `>`, `>>`, `2>&1`, `|`, and `tee`, plus the `grep`/`cut`/`sort`/`uniq`/`wc` toolkit.
- Control your environment with variables, `PATH`, aliases, and `~/.bashrc`, and diagnose "command not found".

## 1. Terminal, shell, console — three words people mix up

Historically these were three physical things. A **console** was the keyboard and screen physically attached to the machine. A **terminal** was a remote keyboard-and-screen (a teletype, hence `tty` in Linux names) wired to a distant computer. The **shell** was — and still is — the *program* that reads the text you type, interprets it, runs other programs, and shows you their output.

Today the console is your cloud provider's emergency "recovery console" web page, the terminal is an app on your laptop (Terminal.app, iTerm2, Windows Terminal, GNOME Terminal), and the shell is still a program running *on the server*. When you connect to your VPS, your terminal app draws the window; the shell — `bash` — runs remotely and does the actual work. Keep this separation in your head: terminal = window on your machine, shell = interpreter on the server.

Which shell? Your Mac defaults to **zsh**; Ubuntu servers default to **bash** (specifically, `/bin/bash` for user accounts). They share most syntax, but this course standardizes on **bash for everything on servers**, because it's what Ubuntu gives you, what CI runners use, and what every script you'll encounter assumes. Write and test your commands in bash on the server, and you'll never be surprised.

The **prompt** is the shell saying "ready". Ubuntu's default looks like this:

```text
deploy@tickethub-vps:/var/www/tickethub$
```

Read it left to right: the user you are (`deploy`), `@`, the machine's hostname (`tickethub-vps`), `:`, the directory you're standing in (`/var/www/tickethub`), and a final character — `$` for a normal user, `#` for root. That last character matters: when documentation shows `#`, it's telling you the command needs root. In this course, `$` prefixes commands you type; lines without `$` are output.

## 2. Get a server and connect (a five-minute detour)

You need a real, internet-facing server for Modules 2 and 3 — the same box on which Module 3 installs Nginx and PHP-FPM. Any provider works (Hetzner, DigitalOcean, Vultr, Linode); pick the smallest **Ubuntu 24.04 LTS** instance with at least 1 GB RAM, roughly $5–6/month. The provider will email you a root password or install your SSH key.

Lecture 2.4 explains SSH properly. For now, take this on faith:

```bash
$ ssh root@203.0.113.10
The authenticity of host '203.0.113.10' can't be established.
ED25519 key fingerprint is SHA256:hK9v1kXmPzR4cQ7Yw2sT8uB3nE5dJ6fA0gL1mN9oPqU.
Are you sure you want to continue connecting (yes/no/[fingerprint])? yes
```

Type `yes`, enter the password, and you're in — the prompt changes to `root@tickethub-vps:~#`. (`203.0.113.10` is a documentation IP; substitute your server's.) Yes, we're working as root for now; Lecture 2.2 fixes that properly, and 2.4 locks the whole box down.

## 3. A tour of the filesystem

Linux has one tree, rooted at `/`. There are no drive letters; disks, partitions, even devices are grafted into this single hierarchy. The layout follows the **Filesystem Hierarchy Standard (FHS)**, and knowing it is half of server literacy — during an incident you don't search, you *go*.

| Directory | What lives there | Why you care |
|---|---|---|
| `/etc` | System-wide configuration, plain text files | Nginx, PHP, SSH, cron config — you'll edit here constantly |
| `/var/log` | System and service logs | First stop in any incident |
| `/var/www` | Web application code, by long convention | **TicketHub will live at `/var/www/tickethub`** |
| `/usr/bin` | Programs installed by the OS/package manager | `php`, `git`, `mysql` binaries end up here |
| `/usr/local/bin` | Programs *you* install by hand | `composer` goes here in Lecture 2.2 |
| `/opt` | Self-contained third-party software | Vendor agents, monitoring tools |
| `/home` | Normal users' home directories | `/home/deploy` after Lecture 2.2 |
| `/root` | root's home directory | Where you land right now |
| `/tmp` | Scratch space, cleared on reboot | Never store anything you need |
| `/proc`, `/sys` | Virtual files exposing kernel state | `ps` and `top` read these (Lecture 2.2) |

Two conventions to internalize now. First, **configuration is text in `/etc`** — there is no registry; you read and edit files. Second, **apps under `/var/www`, one directory per app**: `/var/www/tickethub` is where every later module — Nginx configs, deploy scripts, systemd units — expects the code to be.

Look around:

```bash
$ ls /
bin  boot  dev  etc  home  lib  media  mnt  opt  proc  root  run  sbin  srv  sys  tmp  usr  var
$ cat /etc/os-release
PRETTY_NAME="Ubuntu 24.04.2 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
...
```

## 4. Moving around: pwd, cd, and reading ls -la

Three commands cover navigation. `pwd` prints where you are. `cd <dir>` moves you; `cd` alone jumps to your home directory (also spelled `~`), and `cd -` bounces back to wherever you just were — enormously useful when hopping between `/etc/nginx` and `/var/www/tickethub`. Paths starting with `/` are **absolute** (unambiguous, from the root); anything else is **relative** to your current directory, with `.` meaning "here" and `..` meaning "one level up".

Press **Tab** constantly: the shell completes file and command names, and double-Tab lists candidates. Tab completion isn't a convenience — it's how professionals avoid typos in destructive commands.

`ls` lists a directory; the form you'll type hundreds of times is `ls -la` — `-l` for the long format, `-a` to include hidden files (names starting with `.`, like `.env`):

```bash
$ ls -la /var/log
total 3168
drwxrwxr-x  8 root      syslog     4096 Aug  9 06:25 .
drwxr-xr-x 13 root      root       4096 Apr 23 09:11 ..
-rw-r-----  1 syslog    adm      412308 Aug  9 07:44 auth.log
drwxr-xr-x  2 root      root       4096 Aug  8 06:25 apt
-rw-r--r--  1 root      root      61229 Aug  9 06:25 dpkg.log
-rw-r-----  1 syslog    adm     1048576 Aug  9 07:44 syslog
```

Read one line column by column: **file type and permissions** (`d` directory or `-` file, then nine permission characters — decoded fully in Lecture 2.2), **link count**, **owner** (`syslog`), **group** (`adm`), **size in bytes**, **last-modified timestamp**, **name**. The `.` and `..` entries are the directory itself and its parent. For human-readable sizes add `-h` (`412K` instead of `412308`); to sort newest-first add `-t`. `ls -laht` is the "what changed here recently?" reflex.

## 5. Reading files: cat, less, head, tail

`cat` prints an entire file to the screen — fine for short config files, terrible for a 500 MB log. For anything sizeable use `less`, a *pager* that shows one screen at a time:

```bash
$ less /var/log/syslog
```

Inside `less`: **Space**/**b** page down/up, **g**/**G** jump to start/end, **/pattern** searches forward (`n` next match, `N` previous), **q** quits. Learn the search keys now — `less` is also what `man` and `journalctl` use, so this one skill pays off three times.

`head` and `tail` show the first or last lines (10 by default; `-n 50` for 50). The killer feature is `tail -f` ("follow"), which prints new lines as they're appended — this is how you watch a log live:

```bash
$ tail -f /var/log/auth.log
Aug  9 07:52:01 tickethub-vps sshd[1873]: Failed password for root from 45.148.10.77 port 41758 ssh2
Aug  9 07:52:04 tickethub-vps sshd[1875]: Failed password for invalid user admin from 45.148.10.77 port 41902 ssh2
```

Yes — that's real. Your minutes-old server is already being brute-forced by bots scanning the whole internet. Every public server experiences this constantly. Let it sink in, press **Ctrl+C** to stop following, and remember it when Lecture 2.4 installs fail2ban.

## 6. Creating, copying, moving, removing

`touch file` creates an empty file (or updates its timestamp). `mkdir dir` creates a directory, and `mkdir -p a/b/c` creates the whole chain, silently succeeding if it already exists — which makes it safe to re-run, a property called **idempotence** that you'll come to treasure in scripts.

`cp src dst` copies a file; directories need `-r` (recursive): `cp -r tickethub tickethub-backup`. `mv` both moves *and* renames — `mv app.log app.log.old` is a rename; `mv app.log /tmp/` is a move. `mv` within a filesystem is instant regardless of size (it rewrites directory entries, not data) — a fact that makes atomic deploys possible in Module 9.

`rm file` removes a file; `rm -r dir` removes a directory tree; `-f` suppresses prompts and errors. Understand this clearly: **there is no trash can and no undo.** `rm -rf` on the wrong path is the classic career-defining mistake, usually via typo — `rm -rf /var/www/tickethub /old` (note the accidental space) deletes the app *and* starts eating `/old`. Defenses: Tab-complete every path you're about to remove, run `ls` on the target first, and never `rm -rf` a path you assembled by hand without staring at it.

Quoting: filenames with spaces must be quoted (`rm "error log.txt"`), or the shell treats each word as a separate argument. Better yet, never create filenames with spaces on servers.

## 7. Globbing: patterns the shell expands

A **glob** is a wildcard pattern: `*` matches any run of characters, `?` exactly one, `[0-9]` one from a set. Crucially, the *shell* expands the glob **before** the command runs — `rm *.log` never sees `*.log`; it sees the resulting file list. Two consequences: a glob that matches nothing is (by default) passed through literally, producing "No such file or directory"; and `*` does **not** match hidden files, which is why `cp -r app/* /var/www/tickethub` silently leaves `.env` behind — a bug you'll see in the wild. When a glob feeds a destructive command, preview it first: `echo rm *.log` shows you exactly what would run.

## 8. Pipes and redirection, done properly

Every Linux process starts with three open **file descriptors** — numbered channels for data:

| FD | Name | Default | Purpose |
|---|---|---|---|
| 0 | stdin | keyboard | input the program reads |
| 1 | stdout | screen | normal output |
| 2 | stderr | screen | errors and diagnostics |

Because stdout and stderr both hit your screen, they *look* like one stream. They aren't — and redirection operators prove it:

- `cmd > file` — send stdout to `file`, **truncating** (emptying) it first.
- `cmd >> file` — append stdout to `file`.
- `cmd 2> file` — send stderr to `file`.
- `cmd > file 2>&1` — send stdout to `file`, then point stderr at wherever FD 1 currently goes (the file). **Order matters**: `cmd 2>&1 > file` first points stderr at the screen (where FD 1 goes *at that moment*), then redirects only stdout — errors still hit your terminal.
- `cmd > /dev/null 2>&1` — discard everything; `/dev/null` is the kernel's black hole. You'll meet this exact incantation in the Laravel scheduler cron entry in Lecture 2.3.

The **pipe** `|` connects one command's stdout to the next command's stdin, letting small single-purpose tools compose into something powerful — the core of the Unix philosophy:

```bash
$ grep ' 500 ' access.log | wc -l
17
```

Note that stderr does *not* travel through a pipe (add `2>&1` before the `|` if you need it to). Finally, `tee` splits a stream — writing to a file *and* passing it along — perfect for keeping evidence while you watch:

```bash
$ grep -i error storage/logs/laravel.log | tee /tmp/errors-today.txt | wc -l
42
```

## 9. The text-processing toolkit

Five commands turn logs into answers. Learn their common flags cold.

**`grep`** prints lines matching a pattern. `-i` ignores case, `-n` shows line numbers, `-v` inverts (lines *not* matching), `-r` searches a directory tree recursively, `-c` counts matching lines, and `-E` enables extended regular expressions so you can alternate: `grep -E ' (500|502|503) ' access.log`.

**`cut`** extracts columns. `-d' '` sets the delimiter to a space, `-f9` takes field 9. Given Nginx's default log format, field 9 is the HTTP status code.

**`sort`** orders lines (alphabetically by default; `-n` numerically, `-r` reversed, `-h` understands "human" sizes like `1.2G`). **`uniq`** collapses *adjacent* duplicate lines — which is why you almost always `sort` first — and `uniq -c` prefixes each with its count. **`wc -l`** counts lines.

The pattern to internalize — frequency analysis of anything:

```bash
$ cut -d' ' -f9 access.log | sort | uniq -c | sort -rn
   1240 200
    301 404
     88 201
     17 500
      9 301
```

Extract the field → sort so duplicates are adjacent → count groups → sort counts descending. This one pipeline shape answers "top IPs", "top URLs", "top errors", "top user agents" — anything.

## 10. Environment variables, PATH, and "command not found"

Every process carries a set of **environment variables** — named strings inherited from its parent. The shell shows them with `echo`:

```bash
$ echo $HOME
/root
$ echo $USER
root
```

`NAME=value` sets a variable in the current shell only. `export NAME=value` marks it for inheritance by **child processes** — which is the entire mechanism by which configuration reaches programs, and why Laravel reads `APP_ENV` from the environment (Module 5 builds on this heavily):

```bash
$ export APP_ENV=production
$ bash -c 'echo $APP_ENV'      # a child process sees it
production
```

The most important variable is **`PATH`**: a colon-separated list of directories the shell searches, left to right, when you type a bare command name:

```bash
$ echo $PATH
/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

Now "command not found" stops being mysterious. It means exactly one thing: no executable with that name exists in any `PATH` directory. Either the program isn't installed, or it lives somewhere `PATH` doesn't cover. Notice `.` (the current directory) is *not* in `PATH` — deliberately, so an attacker can't drop a malicious `ls` into a directory you visit. That's why local scripts need an explicit path: `./deploy.sh`, and why `artisan` fails while `php artisan` works — `artisan` is a file in the current directory, not a command on `PATH`. Diagnose with `type`, which tells you what the shell would actually run:

```bash
$ type php
php is /usr/bin/php
$ type artisan
-bash: type: artisan: not found
```

## 11. Aliases, .bashrc, and getting help

An **alias** is a personal shorthand: `alias ll='ls -laF'` makes `ll` expand to the long form. Aliases die with your shell session; to keep them, add the line to `~/.bashrc`, the script bash runs at the start of every interactive session (also the place for `export`s you always want). Apply edits to your current session with `source ~/.bashrc`. Keep server aliases few and boring — you'll work on many machines, and muscle memory that only exists on one box will betray you.

For help: `cmd --help` gives a usage summary; `man cmd` gives the full manual, displayed in `less` (so `/pattern` searches it — told you that skill pays off). Manual sections occasionally matter: `man 5 crontab` documents the file *format* while `man 1 crontab` documents the *command*. When you don't know the command's name, `apropos keyword` searches manual descriptions.

## Hands-on with TicketHub

TicketHub isn't deployed yet — that's Lectures 2.2 and 3.3 — but its future logs are exactly what this toolkit is for. You'll build a practice copy of the app's log layout and run the real analyses you'll run for years. Work as root on the VPS (last time, promise).

**1. Build the practice tree** — one command, thanks to `mkdir -p`:

```bash
$ mkdir -p ~/practice/tickethub/storage/logs
$ cd ~/practice/tickethub
```

**2. Create a realistic Laravel log.** The `<<'EOF'` trick is a *here-document*: everything until the line `EOF` becomes the command's stdin — here, redirected into a file. Take it on faith today; paste exactly:

```bash
$ cat > storage/logs/laravel.log <<'EOF'
[2026-08-09 10:12:03] production.INFO: Order 1042 created {"user_id":88}
[2026-08-09 10:12:04] production.ERROR: Payment webhook signature mismatch {"order_id":1042}
[2026-08-09 10:13:11] production.INFO: Reservation expired {"order_id":1038}
[2026-08-09 10:14:27] production.ERROR: SQLSTATE[HY000] [2002] Connection refused {"exception":"PDOException"}
[2026-08-09 10:15:02] production.WARNING: Slow query: 2140ms {"sql":"SELECT * FROM tickets ..."}
EOF
```

**3. Watch it live.** Open a **second terminal** and SSH in again — two sessions to one server is completely normal; ops work usually involves several. In terminal A, follow the log filtered to errors:

```bash
$ tail -f storage/logs/laravel.log | grep -i error
[2026-08-09 10:12:04] production.ERROR: Payment webhook signature mismatch {"order_id":1042}
[2026-08-09 10:14:27] production.ERROR: SQLSTATE[HY000] [2002] Connection refused {"exception":"PDOException"}
```

In terminal B, append lines and watch A react — this uses `>>` exactly as designed:

```bash
$ cd ~/practice/tickethub
$ echo '[2026-08-09 10:16:40] production.ERROR: Stripe timeout {"order_id":1043}' >> storage/logs/laravel.log
$ echo '[2026-08-09 10:16:41] production.INFO: Retrying payment {"order_id":1043}' >> storage/logs/laravel.log
```

The ERROR line appears in terminal A instantly; the INFO line never does — `grep` filtered it from the live stream. This exact command, `tail -f storage/logs/laravel.log | grep -i error`, run in `/var/www/tickethub`, will be your first move in every TicketHub incident from Module 3 onward. Ctrl+C to stop.

**4. Analyze an Nginx access log.** Create a sample in the same format Nginx writes in Module 3:

```bash
$ cat > ~/practice/access.log <<'EOF'
203.0.113.7 - - [09/Aug/2026:10:12:03 +0000] "GET /api/events HTTP/1.1" 200 1547 "-" "Mozilla/5.0"
198.51.100.23 - - [09/Aug/2026:10:12:09 +0000] "POST /api/orders HTTP/1.1" 201 312 "-" "Mozilla/5.0"
203.0.113.7 - - [09/Aug/2026:10:12:31 +0000] "GET /api/events/55 HTTP/1.1" 200 2201 "-" "Mozilla/5.0"
198.51.100.23 - - [09/Aug/2026:10:13:02 +0000] "POST /api/orders HTTP/1.1" 500 98 "-" "Mozilla/5.0"
192.0.2.199 - - [09/Aug/2026:10:13:20 +0000] "GET /wp-login.php HTTP/1.1" 404 162 "-" "botnet/1.0"
198.51.100.23 - - [09/Aug/2026:10:13:41 +0000] "POST /api/orders HTTP/1.1" 500 98 "-" "Mozilla/5.0"
192.0.2.199 - - [09/Aug/2026:10:14:01 +0000] "GET /.env HTTP/1.1" 404 162 "-" "botnet/1.0"
203.0.113.7 - - [09/Aug/2026:10:14:44 +0000] "GET /api/events HTTP/1.1" 200 1547 "-" "Mozilla/5.0"
EOF
$ cd ~/practice
```

How many requests failed with a 500 during the on-sale? Two answers, increasingly robust:

```bash
$ grep -c ' 500 ' access.log
2
$ cut -d' ' -f9 access.log | sort | uniq -c | sort -rn
      3 200
      2 500
      2 404
      1 201
```

The `grep -c` version can lie if `500` appears elsewhere on a line (a byte count, part of a URL); the `cut` version counts *the status field itself* — prefer it. Who's hammering us?

```bash
$ cut -d' ' -f1 access.log | sort | uniq -c | sort -rn | head -3
      3 203.0.113.7
      3 198.51.100.23
      2 192.0.2.199
```

And notice `GET /.env` in the log: bots probe every server on the internet for carelessly exposed Laravel secrets. Modules 3 and 5 make sure they never get yours.

**5. Find what's eating the disk.** Full disks are a top-three cause of real outages — usually logs. `du -sh` summarizes a directory's size; the pipeline sorts human-readable sizes:

```bash
$ du -sh /var/* 2>/dev/null | sort -h | tail -5
16K     /var/tmp
924K    /var/backups
5.1M    /var/log
418M    /var/cache
1.1G    /var/lib
```

That `2>/dev/null` is your redirection knowledge at work, silencing permission-denied noise from stderr while the sizes flow through the pipe. When TicketHub misbehaves months from now, `du -sh /var/www/tickethub/storage/* | sort -h` will find the runaway log in seconds.

## Real-world best practices

- **Tab-complete everything; type almost nothing.** Beyond speed, completion is a spell-checker for paths — a completed path exists. Production engineers complete even paths they "know". The why: most destructive mistakes are typos, and completion makes typos structurally impossible.
- **Search your history instead of retyping.** **Ctrl+R**, then a fragment (`tail`), cycles through past commands. On a server you administer for months, your history *is* your runbook.
- **Use `less`, not `cat`, for anything you didn't just create.** `cat` on a 2 GB log floods your terminal and can hang your session; `less` opens instantly regardless of size because it reads on demand.
- **Build pipelines incrementally.** Run the first command, eyeball the output, add one stage, re-check. Professionals write `cut ... | head` four times before adding `sort | uniq -c`. The why: each stage validated is a class of silent wrong-answers eliminated.
- **Preview destructive globs** with `echo` or `ls` first, and prefer `mkdir -p`-style idempotent forms in anything you might re-run. Commands that are safe to run twice are the foundation of automation (Modules 8 and 10 depend on this mindset).
- **Prefer absolute paths in anything saved** — scripts, cron entries, documentation. Relative paths depend on where the runner happens to stand; absolute paths always mean the same thing. `cd /var/www/tickethub && ...` is the standard prelude you'll see in every deploy script.

## Common pitfalls

1. **Truncating a file you meant to append to.** You type `deploy.log` with `>` instead of `>>` and a month of history is gone instantly — `>` empties the file *before* the command even runs. People make this mistake because the two operators differ by one keystroke. Approach: pause on every `>`; when appending to anything valuable, consciously verify the doubled character.
2. **`2>&1` in the wrong position.** `cmd 2>&1 > file` looks equivalent to `cmd > file 2>&1` but isn't: redirections apply left to right, so the first form points stderr at your screen and only then redirects stdout. People assume order is cosmetic. Approach: memorize the working idiom `> file 2>&1` as a unit ("redirect, then clone").
3. **`uniq` without `sort`.** `cut -f1 | uniq -c` produces plausible-looking but wrong counts, because `uniq` only collapses *adjacent* duplicates. It's a silent failure — no error, just bad data driving bad decisions. Approach: treat `sort | uniq -c` as one inseparable phrase.
4. **Reckless `rm -rf`, especially with globs or trailing slashes.** A stray space (`rm -rf /var/www/tickethub /old`) or a glob matching more than you imagined deletes unrecoverable data; there is no trash. It happens because `rm` gives no preview and no confirmation with `-f`. Approach: `echo` the exact command first, Tab-complete every path, and never combine `-rf` with a hand-typed absolute path in one breath.
5. **Overwriting `PATH` instead of extending it.** Someone adds a tool with `export PATH=/opt/tool/bin` (forgetting `:$PATH`) in `~/.bashrc`, and suddenly *every* command is "not found" — including the editor to fix it. People copy half-remembered snippets. Approach: always `export PATH="/opt/tool/bin:$PATH"`, and test in a new shell *before* logging out of the current one (a ritual you'll meet again with SSH hardening in Lecture 2.4).
6. **Assuming `*` includes dotfiles.** `cp -r app/* /var/www/tickethub` looks complete but leaves `.env` and `.git` behind; the app then fails with missing-key errors that seem unrelated. Approach: copy the *directory itself* (`cp -r app /var/www/tickethub`) or verify with `ls -la` at the destination.

## Exercises

1. **Scavenger hunt.** Using only `cd`, `ls -la`, `less`, and Tab completion: find the SSH server's config file under `/etc`, the kernel's boot log in `/var/log`, and your shell's own binary. For each, note the absolute path and the file's owner and size from `ls -la`.
2. **Top offenders.** From `~/practice/access.log`, produce the top requested URLs (field 7) with counts, most frequent first, using one pipeline. Then modify it to show only URLs that returned 404.
3. **Live-log drill.** With `tail -f` running in one terminal filtered to `WARNING|ERROR` (hint: `grep -E`), append five mixed-level lines from a second terminal and confirm exactly the right ones appear. Then re-run with `-v` to invert the filter.
4. **Disk detective.** Find the three largest directories under `/usr` (hint: `du -sh /usr/* 2>/dev/null | sort -h`), then drill into the largest one level at a time until you can name the biggest single contributor. Write the full pipeline you'd save for reuse.
5. **Stretch: one-command incident report.** Build a single pipeline that reads `~/practice/access.log` and appends to `~/practice/report.txt` a section containing: total request count, count per status code (descending), and top 3 IPs — while *also* printing everything to your screen. You'll need `tee -a`, and you may discover you want `{ cmd1; cmd2; } | ...` to group commands; `man bash` (search `/Compound Commands` inside `less`) is your friend.

## What's next

You can now move, read, and analyze — but you've been doing it all as root, and nothing on this server is protected from anything. [Lecture 2.2 — Users, Permissions & Processes](02-users-permissions-processes.md) fixes that: you'll create the `deploy` user, put TicketHub's code at `/var/www/tickethub` for real, and learn the ownership and permission model behind the single most common Laravel production failure — `storage/logs/laravel.log could not be opened: Permission denied` — including why the internet's favorite "fix", `chmod -R 777`, is a security hole and what to do instead.
