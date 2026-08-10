# Lecture 2.2 — Users, Permissions & Processes

> **Module 2 — Linux & the Command Line** · Lecture 2 of 4 · Estimated time: ~90 min

In [Lecture 2.1](01-shell-fundamentals.md) you worked as root, and everything just… worked. That's precisely the problem. Root can do anything, which means every typo can do anything, and every attacker who lands in a root session owns the machine outright. Real servers are structured around *identities with limits*: who may read the `.env` file, who may write a log, which user a web server runs as. This lecture teaches that model, then uses it to stage, diagnose, and properly fix the single most famous Laravel production error — the `storage/logs/laravel.log … Permission denied` failure — and finishes with processes and signals: what's actually running on your box and how to control it. By the end, TicketHub's code will be at `/var/www/tickethub`, owned correctly, and you'll never work as root again.

## Learning objectives

- Explain why Linux is multi-user, why you never work as root, and how `sudo` provides controlled privilege.
- Decode `/etc/passwd`, distinguish system users from humans, and explain why web servers run as `www-data`.
- Read and set permissions symbolically and in octal (644/755/600/775), including the special meaning of `x` and setgid on directories.
- Diagnose and properly fix Laravel's `storage` permission failure — and articulate exactly why `chmod -R 777` is unacceptable.
- Interpret `ps aux`, `top`, load average, and memory columns to answer "what is this server doing?"
- Control processes with signals, background jobs, and exit codes, and explain why SIGTERM-before-SIGKILL matters for queue workers.

## 1. One machine, many identities

Linux descends from systems where dozens of people shared one expensive computer, so separation between users is built into the kernel itself: every file has an owner, every process runs *as* someone, and the kernel checks permissions on every access. That design turned out to be perfect for servers — not to separate people, but to separate *programs*. On your VPS, the SSH daemon runs as root (it must, to log users in), the web server will run as `www-data`, MySQL as `mysql`, Redis as `redis`. If a bug in one service is exploited, the attacker holds only that identity's permissions — this containment is called limiting the **blast radius**, and it's the reasoning behind almost every decision in this lecture.

## 2. root and sudo: power, borrowed briefly

**root** is user ID 0, and the kernel skips permission checks for it entirely. That makes a root shell the most dangerous place on a server: no confirmation, no undo, no protection from typos — recall `rm -rf` from Lecture 2.1, now with nothing off-limits. Professionals therefore log in as a normal user and *borrow* root for individual commands with `sudo` ("superuser do"):

```bash
$ sudo systemctl restart ssh
[sudo] password for deploy:
```

Beyond safety, `sudo` gives you an **audit trail** — every invocation is logged to `/var/log/auth.log` with who ran what — and *revocability*: you can remove one person's access without changing a shared root password (there shouldn't be one; Lecture 2.4 disables root login entirely).

Who may sudo is defined in `/etc/sudoers` plus `/etc/sudoers.d/`. You never edit these files directly: `sudo visudo` opens them in an editor and **syntax-checks before saving**, because a malformed sudoers file locks *everyone* out of sudo. On Ubuntu you rarely edit it at all — this stock rule:

```text
%sudo   ALL=(ALL:ALL) ALL
```

means "members of group `sudo` may run any command as any user", so granting access is just group membership. Read the pattern as: on ALL hosts, as (any user : any group), run ALL commands. For a true root shell when you need many privileged commands, use `sudo -i`; leave it as soon as you're done.

## 3. Users and groups on disk

Users are rows in a plain text file, `/etc/passwd` (world-readable; despite the name, passwords live hashed in root-only `/etc/shadow`). One line, seven colon-separated fields:

```text
deploy:x:1000:1000:Deploy,,,:/home/deploy:/bin/bash
```

That's: username; `x` (password is in shadow); **UID** 1000; primary **GID** 1000; comment field; home directory; login shell. Ubuntu gives humans UIDs from 1000 up; UIDs below 1000 are **system users** — identities that exist only so services can run as them. Groups live in `/etc/group`, and `id` shows any user's memberships:

```bash
$ id www-data
uid=33(www-data) gid=33(www-data) groups=33(www-data)
$ grep www-data /etc/passwd
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
```

Meet **`www-data`**: the user Nginx and PHP-FPM run as on Debian/Ubuntu. Notice its shell is `/usr/sbin/nologin` — nobody can log in as it; it exists purely as a low-privilege identity for web-facing processes. When a request hits TicketHub in Module 3, the PHP code executes *as www-data*, so www-data's permissions decide what your Laravel app can read and write. That single sentence explains the next twenty minutes.

## 4. Ownership and the rwx model

Every file has one owner and one group, and three permission sets — for the **u**ser (owner), the **g**roup, and **o**thers. Each set holds three bits: **r**ead, **w**rite, e**x**ecute. Now you can fully decode `ls -la` from Lecture 2.1:

```text
-rw-r--r--  1 deploy www-data   1082 Aug  9 12:01 composer.json
drwxrwxr-x  5 deploy www-data   4096 Aug  9 12:01 storage
```

`composer.json`: a file (`-`), owner may read/write (`rw-`), group may read (`r--`), others may read (`r--`). On **directories** the bits shift meaning: `r` = list names, `w` = create/delete/rename entries inside, and `x` = *enter or traverse* it — you need `x` on every directory along a path to reach anything below it. A directory with `r` but no `x` lets you list names yet open nothing; `x` without `r` lets you reach files whose names you already know. When a permission problem "makes no sense", check the `x` bits on the *parent directories* first.

Each triad is also a binary number — r=4, w=2, x=1 — giving the **octal** shorthand every ops engineer speaks fluently:

| Octal | Symbolic | Typical use |
|---|---|---|
| `644` | `rw-r--r--` | Normal files: owner edits, world reads |
| `755` | `rwxr-xr-x` | Directories and executables: world may enter/run, only owner writes |
| `600` | `rw-------` | Secrets: private keys, and stricter `.env` setups |
| `775` | `rwxrwxr-x` | Group-writable directories: **Laravel's `storage/`** |

`chmod` sets permissions either way — `chmod 640 .env` or the surgical symbolic form `chmod g+w storage` (add write for group), `chmod o-rwx .env` (strip others). `chown deploy:www-data file` sets owner and group; both take `-R` to recurse. Where do *default* permissions come from? The **umask**, a per-process mask subtracted from the maximum (666 for files, 777 for directories). The default umask `022` yields 644 files and 755 directories — remember that "new files aren't group-writable by default"; it's the root cause of a gotcha you'll hit later this lecture.

One more bit matters for web apps: **setgid on a directory** (`chmod 2775`, shown as `rwxrwsr-x`). Files created inside a setgid directory inherit the *directory's group* instead of the creator's primary group. It keeps a shared tree consistently group-owned no matter which user writes there — exactly what `storage/` needs when `deploy` and `www-data` both touch it. Note its limit: setgid inherits the *group*, not the *mode* — umask still decides the write bits.

## 5. The classic Laravel failure — staged, diagnosed, fixed

Here is the error that has greeted more Laravel developers on deploy day than any other:

```text
The stream or file "/var/www/tickethub/storage/logs/laravel.log" could not be
opened in append mode: Failed to open stream: Permission denied
```

Why it happens is now obvious to you: the code was put on the server by one user (you, or `deploy`), so every file is owned `deploy:deploy` with 755/644 defaults — but the code *executes* as `www-data`, which is "others" here, and others can't write. Diagnosis is a three-step ritual. First, what are the permissions actually?

```bash
$ ls -la /var/www/tickethub/storage/logs
drwxr-xr-x 2 deploy deploy 4096 Aug  9 12:01 .
```

Second, who am I being denied as — `id www-data`. Third, *prove* which user the code runs as instead of assuming — on a live box, look at the PHP-FPM worker processes:

```bash
$ ps aux | grep php-fpm
root       912  0.0  1.9 231708 19788 ?  Ss  11:58  0:00 php-fpm: master process (/etc/php/8.4/fpm/php-fpm.conf)
www-data   913  0.0  1.2 232092 12480 ?  S   11:58  0:00 php-fpm: pool www
www-data   914  0.0  1.2 232092 12480 ?  S   11:58  0:00 php-fpm: pool www
```

(The master runs as root; the workers that execute your code run as `www-data`. FPM arrives in Module 3 — the hands-on below simulates it faithfully with `sudo -u www-data`.) Mismatch established: owner `deploy`, writer `www-data`, no shared path to write. The **proper fix** expresses ownership intent — deploy owns the code, the web user may write only the runtime directories:

```bash
$ cd /var/www/tickethub
$ sudo chown -R deploy:www-data .
$ sudo find storage bootstrap/cache -type d -exec chmod 2775 {} \;
$ sudo find storage bootstrap/cache -type f -exec chmod 664 {} \;
```

Directories 2775 (group-writable, setgid so new files stay group `www-data`), files 664, everything else untouched at 755/644 where `www-data` can read and execute but not modify code. `find -type d/-type f` with `-exec` applies different modes to directories and files — the reason we don't just `chmod -R 775`, which would pointlessly mark every PHP file executable.

Now, the internet's favorite answer: **`chmod -R 777` — never.** It "works" for the same reason leaving your front door open "fixes" losing your keys. 777 means *any process under any user on the machine* may write those paths. `storage/` contains sessions (steal one, hijack a logged-in organizer), cached views (PHP that gets *executed* — writeable views are a straight path to remote code execution), and uploaded content. Any compromised service — a WordPress on the same box, a vulnerable cron script — can now plant code your app will run as `www-data`, or read every session. 777 also destroys the diagnostic value of ownership: the *real* mismatch is still there, papered over. It is the canonical example of fixing the symptom by deleting the security model. If you remember one thing from this module, let it be this paragraph.

## 6. Processes: what is this server doing?

A **process** is a running instance of a program: the code plus its memory, open files, environment variables, and an identity (the user it runs as). Each has a **PID** (process ID) and a **PPID** (parent PID) — every process is started by another, all the way up to PID 1 (next lecture's star). The panoramic view is `ps aux`:

```bash
$ ps aux | head -4
USER   PID %CPU %MEM     VSZ    RSS TTY   STAT START   TIME COMMAND
root     1  0.0  1.1  166892  11512 ?     Ss   11:52   0:02 /sbin/init
root   688  0.0  0.4   15436   4380 ?     Ss   11:52   0:00 sshd: /usr/sbin/sshd -D
deploy 1450  0.0  0.3   11224   3900 pts/0 Ss  12:20   0:00 -bash
```

Column by column: **USER** the process runs as (your `ps aux | grep php-fpm` diagnostic); **PID**; **%CPU** and **%MEM** as shares of the machine; **VSZ** virtual memory (everything *mapped*, mostly meaningless for capacity questions) versus **RSS** resident memory (actual RAM occupied — the number that fills your server); **TTY** the controlling terminal (`?` = none, i.e. a daemon); **STAT** (`S` sleeping, `R` running, `Z` zombie, leading `s` = session leader); **START**, cumulative CPU **TIME**, and the **COMMAND** line. `pgrep -f queue:work` finds PIDs matching a pattern without the grep-matching-itself noise.

For a live view, run `top` (always installed) or the friendlier `htop` (`sudo apt install htop`). The header line to actually understand is **load average**:

```text
load average: 0.42, 1.87, 0.96
```

Three numbers: the average count of processes *running or waiting to run* (plus those stuck in uninterruptible disk I/O) over the last 1, 5, and 15 minutes. Load is meaningful **relative to core count** (`nproc`): 1.0 on a 1-vCPU VPS means saturated; 4.0 on a 4-core box means fully busy, and 8.0 means work is queueing — requests are waiting, latency is climbing. %CPU can read 100% while load stays low (one hot process, otherwise idle) — the 5- and 15-minute loads tell you whether pain is a blip or a trend. In memory columns, read **RES** (real RAM, same as RSS) and ignore **VIRT**; a PHP-FPM worker showing VIRT 230M / RES 12M is using 12M.

## 7. Signals, kill, and exit codes

You control processes by sending **signals** — small numbered notifications delivered by the kernel. `kill` is misnamed: it *sends a signal*, default **SIGTERM** (15), the polite "please shut down". A process can catch SIGTERM and clean up: flush buffers, close connections, *finish the current job*. **SIGKILL** (9) is not deliverable to the process at all — the kernel simply destroys it mid-instruction; nothing is flushed, nothing finishes. **SIGHUP** (1) historically meant "your terminal hung up"; daemons repurpose it as "reload your config" (Nginx uses exactly this in Module 3).

```bash
$ kill 1450          # SIGTERM — graceful
$ kill -9 1450       # SIGKILL — last resort only
$ pkill -f "queue:work"   # signal by matching the command line
```

This distinction is a production-critical Laravel fact: when Module 5 brings queue workers, `php artisan queue:work` **traps SIGTERM and finishes the job it's processing before exiting**. Deploy tooling and systemd send SIGTERM, so a worker halfway through emailing an order confirmation completes it; `kill -9` instead guillotines the job mid-flight — half-sent email, and the job marked neither done nor failed. Always SIGTERM, wait, and only escalate to SIGKILL if a process truly ignores you.

Every process that exits reports an **exit code**: `0` means success, anything else means failure (by convention 1–255). The shell stores the last command's code in `$?`:

```bash
$ ls /var/www/tickethub >/dev/null
$ echo $?
0
$ ls /nonexistent 2>/dev/null; echo $?
2
```

Exit codes are the contract automation is built on: `a && b` runs `b` only if `a` succeeded, `a || b` only if it failed — and in Module 7 an entire CI pipeline passes or fails on nothing but exit codes.

## 8. Foreground, background, and why nohup isn't the answer

Your shell runs commands in the **foreground**: it waits, and Ctrl+C (SIGINT) interrupts them. Append `&` to start a command in the **background** — the shell returns immediately and tracks it as a *job*. `jobs` lists them, `fg %1` brings one back, **Ctrl+Z** suspends a foreground process (SIGTSTP), and `bg` resumes the suspended job in the background:

```bash
$ tail -f storage/logs/laravel.log &
[1] 1893
$ jobs
[1]+  Running    tail -f storage/logs/laravel.log &
$ fg %1
```

The catch: background jobs still belong to your login session — log out, and they receive SIGHUP and die. `nohup cmd &` makes a process ignore SIGHUP (output lands in `nohup.out`), and it's how people have historically kept things running after logout. But look at what nohup *doesn't* do: nothing restarts the process if it crashes, nothing starts it at boot, its logs are an orphaned file, and no resource limits apply. For a queue worker that must always be running, "survives logout" is nowhere near enough — you need a supervisor. That supervisor is systemd, and it's the whole subject of [Lecture 2.3](03-systemd-services-logs.md).

## Hands-on with TicketHub

Time to make it real: create `deploy`, install a minimal PHP toolchain, put TicketHub at its permanent home, then break and fix `storage` exactly as production would.

**1. Create the deploy user** (as root, one last task):

```bash
$ adduser deploy
New password:
...
$ usermod -aG sudo deploy
$ id deploy
uid=1000(deploy) gid=1000(deploy) groups=1000(deploy),27(sudo)
```

Log out, reconnect as `ssh deploy@203.0.113.10`, and verify privilege borrowing works: `sudo whoami` → `root`. From here to the end of the course, you work as `deploy`.

**2. Install git and PHP 8.4 CLI.** Ubuntu 24.04's repositories carry PHP 8.3; the course pins 8.4, which comes from the standard, well-maintained `ppa:ondrej/php` archive. This is the *minimal* toolchain — the full FPM stack is Module 3's job:

```bash
$ sudo apt update && sudo apt install -y git unzip software-properties-common
$ sudo add-apt-repository -y ppa:ondrej/php
$ sudo apt install -y php8.4-cli php8.4-mbstring php8.4-xml php8.4-curl php8.4-zip php8.4-mysql php8.4-redis
$ php --version
PHP 8.4.10 (cli) (built: Jul  4 2026 10:12:33) (NTS)
```

Install Composer to `/usr/local/bin` — the FHS home for hand-installed programs, already on `PATH`:

```bash
$ cd /tmp && curl -sS https://getcomposer.org/installer -o composer-setup.php
$ php composer-setup.php && sudo mv composer.phar /usr/local/bin/composer
$ composer --version
Composer version 2.8.4
```

**3. Put TicketHub at `/var/www/tickethub`.** `/var/www` is root-owned, so create the app directory with sudo, then hand it to `deploy` — after which no sudo is needed to work on the code:

```bash
$ sudo mkdir -p /var/www/tickethub
$ sudo chown deploy:deploy /var/www/tickethub
$ git clone https://github.com/tickethub/tickethub-api.git /var/www/tickethub   # use your own fork's URL
$ cd /var/www/tickethub
$ composer install --no-dev --optimize-autoloader
$ cp .env.example .env
$ php artisan key:generate
```

(No MySQL or Redis yet — fine. Nothing today touches the database.)

**4. Break it, authentically.** Everything is `deploy:deploy` right now — exactly the state after any fresh clone. Execute app code *as www-data*, precisely as PHP-FPM will:

```bash
$ sudo -u www-data php artisan tinker --execute="Log::info('hello from www-data');"
...
The stream or file "/var/www/tickethub/storage/logs/laravel.log" could not be
opened in append mode: Failed to open stream: Permission denied
```

There it is — on your terms, in a lab, instead of at 6 p.m. on launch day. Run the diagnosis ritual for real: `ls -la storage/logs` (owner `deploy`, mode 755 — others can't write), `id www-data` (not `deploy`, not in group `deploy`).

**5. Fix it properly.**

```bash
$ cd /var/www/tickethub
$ sudo chown -R deploy:www-data .
$ sudo find storage bootstrap/cache -type d -exec chmod 2775 {} \;
$ sudo find storage bootstrap/cache -type f -exec chmod 664 {} \;
$ sudo usermod -aG www-data deploy    # let deploy read/manage www-data's files
$ sudo -u www-data php artisan tinker --execute="Log::info('hello from www-data');"
$ ls -la storage/logs
drwxrwsr-x 2 deploy   www-data 4096 Aug  9 13:05 .
-rw-r--r-- 1 www-data www-data  103 Aug  9 13:05 laravel.log
```

Success — note the `s` in `rwxrwsr-x` (setgid did its job: the new file's group is `www-data`) and re-log-in once so your shell picks up deploy's new group (`id` should now list `www-data`).

**6. Meet the sequel gotcha.** Try logging as `deploy` now:

```bash
$ php artisan tinker --execute="Log::info('hello from deploy');"
...could not be opened in append mode: Failed to open stream: Permission denied
```

Diagnose it yourself before reading on: `ls -la` shows `laravel.log` is `-rw-r--r-- www-data www-data` — 644, because www-data's umask (022) didn't grant group write; setgid inherited the *group*, not the *mode*. You could `chmod 664` the file, but tomorrow's new log hits the same wall. The production rule that dissolves the whole class of problem: **one writer identity — everything that *executes* the app on a server runs as `www-data`.** FPM already does; Lecture 2.3 runs the queue worker and scheduler as `www-data` too; and one-off artisan commands follow suit:

```bash
$ sudo -u www-data php artisan tinker --execute="Log::info('one writer identity');"
```

**7. Watch some processes.** In one terminal: `tail -f storage/logs/laravel.log`. Suspend it with Ctrl+Z, run `jobs`, resume with `bg`, confirm it still prints when you log from another terminal, then `fg` and Ctrl+C. Finally rehearse signals safely:

```bash
$ sleep 600 &
[1] 2004
$ kill 2004
[1]+  Terminated    sleep 600
$ sleep 600 & kill -9 $!      # $! = PID of the last background job
[1]+  Killed        sleep 600
```

`Terminated` (SIGTERM) versus `Killed` (SIGKILL) — the shell even reports them differently. Remember which one lets a queue worker finish its job.

## Real-world best practices

- **Personal accounts + sudo; root login disabled.** Every admin gets their own user in the `sudo` group, so `/var/log/auth.log` answers "who restarted MySQL at 02:14?". Shared root makes that question unanswerable and makes offboarding a password-rotation fire drill. (This course uses one `deploy` user because you're a team of one; the pattern generalizes.)
- **Secrets are 640 or 600, group-owned by their reader.** TicketHub's `.env` holds database and AWS credentials; production teams set `chown deploy:www-data .env && chmod 640 .env` — deploy edits, the app reads, *others* (any other compromised service) get nothing. World-readable secrets turn any foothold on the box into full credential theft.
- **Run app-executing commands as the app user, always.** `sudo -u www-data php artisan …` for anything that writes caches or logs. The single most common self-inflicted outage in Laravel ops is a root-owned file in `storage/framework` created by a careless `sudo php artisan config:cache` — FPM then can't overwrite it and the whole site 500s.
- **SIGTERM, wait, then — rarely — SIGKILL.** Graceful shutdown is not a nicety; it's data integrity. Teams bake the escalation (TERM → grace period → KILL) into tooling, which is exactly what systemd and Kubernetes do for you in Lectures 2.3 and Module 11.
- **Look before you leap on shared boxes: `ps aux` first.** Before killing "the stuck process" or rebooting, know what's running and as whom. `pkill -f php` on a box where FPM runs would take down the site, not just your stray script.

## Common pitfalls

1. **`chmod -R 777` to "fix" permissions.** People do it because it instantly makes errors vanish and half the internet recommends it. It grants every process on the machine write access to your sessions and executable cached views — a session-hijack and RCE buffet — while hiding the real ownership mismatch. Correct approach: the owner/group model from section 5 (`deploy:www-data`, 2775/664 on `storage` and `bootstrap/cache`), one writer identity for execution.
2. **Editing `/etc/sudoers` with a plain editor.** A one-character syntax error makes sudo refuse to run *for everyone*, and without sudo you can't fix the file — on a root-login-disabled box that's a locked door. It happens because `nano /etc/sudoers` feels equivalent. Always `sudo visudo`, which refuses to save invalid syntax.
3. **Running one-off artisan commands as root.** `sudo php artisan config:cache` works today and creates root-owned files in `bootstrap/cache`; hours later the site 500s and nobody connects cause and effect. Use `sudo -u www-data php artisan …`, and if you've already made the mess, re-apply the ownership fix from section 5.
4. **Reaching for `kill -9` first.** It feels decisive, and it's what half of Stack Overflow suggests. SIGKILL denies the process any cleanup: queue jobs die mid-payment-email, file writes tear, locks are left behind. Send SIGTERM, give it ten seconds, watch `ps`; escalate only if it's genuinely hung.
5. **Misreading load average as a percentage.** "Load 2.0 = 200%?!" — panic reboots have been issued over healthy numbers. Load counts *waiting-plus-running processes*, so it only means trouble relative to `nproc`: 2.0 is congestion on 1 vCPU and a shrug on 8. Check `nproc`, then read the 5/15-minute values for the trend before acting.
6. **Recursive chown/chmod on a mistyped path.** `sudo chown -R deploy:www-data / var/www/tickethub` (stray space) re-owns the entire filesystem and effectively destroys the OS — services check ownership of their own files and refuse to start. It happens under deadline pressure with hand-typed paths. Tab-complete the path, `ls` it first, and on `-R` commands read the line twice before Enter.

## Exercises

1. **Passwd safari.** From `/etc/passwd`, list every user that owns a running process right now (cross-reference `ps aux`). Which are system users? What shell do `www-data`, `deploy`, and `root` have, and why does the difference matter?
2. **Octal fluency.** Without touching the server, write the symbolic form (`rwx…`) for 640, 2775, 600, and 755 — then verify each by creating a file/directory, applying the mode, and reading `ls -la`. Finish by putting the real `.env` at `deploy:www-data` 640 and proving with `sudo -u www-data head -1 /var/www/tickethub/.env` that the app can still read it.
3. **Break/fix speedrun.** Reset the app to the broken state (`sudo chown -R deploy:deploy /var/www/tickethub && sudo chmod -R u=rwX,go=rX /var/www/tickethub`), then perform the full diagnosis (three commands) and fix (four commands) from memory. Time yourself; under two minutes is production-ready.
4. **Process detective.** Using `ps aux` and its `--sort` option (see `man ps`), find the process with the largest RSS on your VPS. Identify its PPID and follow the chain to PID 1. What user runs it, and what would you expect to break if you sent it SIGKILL?
5. **Stretch: prove the setgid claim.** Design an experiment demonstrating both halves of "setgid inherits group, not mode": as `deploy`, create files inside a `2775 deploy:www-data` directory and a plain `775` one, compare owners/groups/modes, then repeat with `umask 002` set first. Write three sentences explaining how the results justify the "one writer identity" rule better than directory permissions alone can.

## What's next

TicketHub's code now lives at `/var/www/tickethub` with ownership a security reviewer would sign off on — but nothing *runs* it yet, and anything you start by hand dies with your SSH session. [Lecture 2.3 — Services & Logs: systemd and journald](03-systemd-services-logs.md) turns processes into *services*: you'll write a real unit file that keeps a TicketHub queue worker alive through crashes and reboots, watch systemd resurrect it when you kill it, schedule Laravel's scheduler with both cron and systemd timers, and learn to read every log on the box with `journalctl`.
