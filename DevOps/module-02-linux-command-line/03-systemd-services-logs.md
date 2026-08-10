# Lecture 2.3 — Services & Logs: systemd and journald

> **Module 2 — Linux & the Command Line** · Lecture 3 of 4 · Estimated time: ~90 min

[Lecture 2.2](02-users-permissions-processes.md) ended on a cliffhanger: anything you start by hand dies with your SSH session, and `nohup` merely keeps a process alive — nothing restarts it after a crash, starts it at boot, collects its logs, or limits its memory. TicketHub needs exactly those things: queue workers running 24/7 for PDFs and emails, and a scheduler ticking every minute to expire reservations. The answer on every modern Linux server is **systemd**. You'll learn how Linux boots, write a production-grade unit for a TicketHub queue worker, kill it and watch it resurrect, read logs like an operator with `journalctl`, and wire up Laravel's scheduler two ways — cron and systemd timers — knowing when to use which.

## Learning objectives

- Describe what happens from power-on to a running system, and the special role of PID 1.
- Read and write systemd unit files, explaining every directive in `[Unit]`, `[Service]`, and `[Install]`.
- Operate services with `systemctl` (start/stop/restart/reload/enable/disable/status, daemon-reload) and interpret `systemctl status` output line by line.
- Query logs precisely with `journalctl` — by unit, time window, and priority — and ensure the journal survives reboots.
- Keep TicketHub's queue worker permanently alive with `Restart=always`, and explain why `--max-time` plus auto-restart is a memory-leak mitigation.
- Schedule Laravel's scheduler with cron *and* a systemd timer, rotate `laravel.log` with logrotate, and cap a service's memory.

## 1. From power button to PID 1

When your VPS boots, firmware loads a bootloader (GRUB), the bootloader loads the **Linux kernel**, and the kernel — once it has memory, disks, and drivers up — starts exactly one userspace program: **PID 1**, historically called **init**. PID 1 is special: every other process descends from it, it inherits ("reaps") orphaned processes, and if it dies the kernel panics. Its job is to bring the system from "kernel running" to "useful": mount filesystems, start networking, start services, present a login.

On Ubuntu 24.04 — and effectively every mainstream distribution — PID 1 is **systemd**. You saw it in Lecture 2.2's `ps aux` output: `/sbin/init` (a symlink to systemd) with PID 1. But systemd is more than an init: it's a **service manager** that supervises processes for their entire lives — starting them in the right order, restarting them when they crash, capturing their output, and accounting for their resources using the same kernel cgroups that will power Docker in Module 6. "Supervision" is the exact capability `nohup` lacked.

## 2. Units, and where they live

systemd's unit of management is — a **unit**: a small INI-style text file declaring something systemd should manage. The file's extension is its type:

| Type | Manages | You'll use it for |
|---|---|---|
| `.service` | A long-running process (or one-shot command) | Nginx, PHP-FPM, MySQL, **TicketHub's queue worker** |
| `.timer` | Scheduled activation of a service | The Laravel scheduler (cron's rival) |
| `.target` | A named grouping / synchronization point | `multi-user.target` ≈ "normal server boot" |
| `.socket` | A listening socket that starts a service on demand | Ubuntu 24.04's SSH daemon does this |

This module needs only services and timers. Units live in two places, and the distinction matters: `/usr/lib/systemd/system/` belongs to packages (`apt` installs Redis's unit there — never edit these, upgrades overwrite them), while **`/etc/systemd/system/`** belongs to you, the administrator; anything here overrides same-named package units. Your TicketHub units go in `/etc/systemd/system/`. To *modify* a package unit, you add a drop-in override with `systemctl edit <unit>` rather than touching the original — you'll do exactly that later to cap the worker's memory.

## 3. Anatomy of a unit file: TicketHub's queue worker

Instead of a toy example, here is the real unit this lecture builds — `/etc/systemd/system/tickethub-worker.service` — the file that keeps TicketHub's emails and PDFs flowing from now until Module 9 replaces this VPS:

```ini
[Unit]
Description=TicketHub queue worker
After=network.target redis-server.service

[Service]
User=www-data
Group=www-data
WorkingDirectory=/var/www/tickethub
ExecStart=/usr/bin/php /var/www/tickethub/artisan queue:work redis --sleep=3 --tries=3 --max-time=3600
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Walk it directive by directive, because you'll write dozens of these in your career.

**`[Unit]`** holds metadata and ordering. `Description` is what `systemctl status` displays — write it for the 3 a.m. version of yourself. `After=` declares *ordering, not dependency*: if Redis and this worker start in the same boot, start Redis first. (A hard dependency would be `Requires=`; we deliberately don't use it — a Redis blip shouldn't permanently down the worker, because `Restart=always` will keep retrying anyway.)

**`[Service]`** describes the process. `User`/`Group` run the worker as `www-data` — Lecture 2.2's "one writer identity" rule made real: the worker writes `laravel.log` as the same user FPM will, so the permission model stays coherent. `WorkingDirectory` sets the current directory before launch; Laravel resolves relative paths (like `storage/`) from it. `ExecStart` is the command — note it is **not a shell**: no pipes, no `&&`, no `$PATH` search worth trusting, which is why both the PHP binary and the artisan path are absolute.

The arguments are doing real operational work. `queue:work redis` pins the Redis connection. `--sleep=3` naps three seconds when the queue is empty instead of hammering Redis. `--tries=3` moves a job to `failed_jobs` after three attempts rather than retrying a poisoned job forever. And `--max-time=3600` makes the worker **exit cleanly after an hour** — which looks bizarre until you pair it with the next directive.

`Restart=always` tells systemd to restart the process whenever it exits — crash, kill, *or* clean exit. Combined with `--max-time=3600`, you get a deliberate pattern: PHP was designed for short-lived requests, and long-running PHP processes accumulate memory (leaky extensions, growing static caches, fragmentation). Rather than pretending the leak doesn't exist, the worker retires itself hourly at a *job boundary* — remember from Lecture 2.2 that `queue:work` finishes its current job before exiting — and systemd instantly starts a fresh process with a clean heap. Restart-on-schedule turns a slow leak from a 4 a.m. out-of-memory incident into a non-event. `RestartSec=3` waits three seconds between exit and restart, so a service that's crash-looping doesn't spin the CPU at full speed.

One directive we *don't* need yet but you must know: `Environment="APP_ENV=production"` injects environment variables. TicketHub reads its config from `.env` today, but in Module 5 (twelve-factor config) and Module 11 (Kubernetes) the environment block becomes the primary way configuration reaches the app — same mechanism as `export` from Lecture 2.1, formalized.

**`[Install]`** answers "when should this start automatically?" `WantedBy=multi-user.target` hooks the unit into normal server boot. This section is only consulted by `systemctl enable`, which is the next topic.

## 4. Driving systemd: systemctl

Seven verbs cover daily operations. `start` and `stop` act now. `restart` is stop-then-start; `reload` asks the service to re-read config without dropping (Nginx supports it via SIGHUP — Lecture 2.2's signal knowledge — a plain PHP worker doesn't). `status` shows current state plus recent logs. The pair people confuse: **`enable` does not start anything** — it creates the symlink that makes the unit start *at boot* (per `WantedBy`); `disable` removes it. Running now and starting at boot are independent axes; `systemctl enable --now unit` does both in one command. Finally, the one everyone forgets: systemd caches unit files in memory, so **after creating or editing any unit you must run `sudo systemctl daemon-reload`** before your changes exist as far as systemd is concerned.

Two read-only helpers you'll use constantly: `systemctl list-timers` (what's scheduled, when it last ran, when it fires next) and `systemctl is-enabled <unit>` for quick boot-behavior checks.

## 5. journald: where the logs went

systemd captures **everything a service writes to stdout and stderr** into a structured, indexed, binary journal — no config, no log files to invent. This is why the worker unit has no logging directives: `queue:work` prints processed-job lines to stdout, and journald files them under the unit's name with timestamps and metadata. (This "just write to stdout" model becomes a twelve-factor principle in Module 5 and the default in Docker and Kubernetes — systemd got there first.)

The query tool is `journalctl`. The forms worth memorizing:

```bash
$ journalctl -u tickethub-worker              # everything for one unit
$ journalctl -u tickethub-worker -f           # follow live, like tail -f
$ journalctl -u tickethub-worker -n 50        # last 50 lines
$ journalctl -u tickethub-worker --since "10 min ago"
$ journalctl -u tickethub-worker --since "2026-08-09 14:00" --until "2026-08-09 15:00"
$ journalctl -p err -b                        # priority err and worse, this boot
```

`--since`/`--until` accept human phrases ("10 min ago", "yesterday") — during an incident, "show me errors across *all* services in the five minutes before the alert" is one command: `journalctl --since "14:05" --until "14:10" -p err`. Priorities follow syslog levels (`emerg` … `debug`); `-p err` means "err and more severe".

One durability check: the journal is only kept across reboots if `/var/log/journal` exists (journald's `Storage=auto` behavior). Ubuntu 24.04 creates it by default — verify with `ls -d /var/log/journal` — so your logs survive reboots; if it were missing you'd `sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald`. journald also self-limits disk usage (typically 10% of the filesystem, tunable via `SystemMaxUse=` in `/etc/systemd/journald.conf`), which is why the journal never needs logrotate.

## 6. Rotating file logs: logrotate

journald manages itself, but `storage/logs/laravel.log` is a plain file that only ever grows — and Lecture 2.1's `du` drill foreshadowed the ending: a full disk, which takes down MySQL, Redis, and the app in one blow. **logrotate** is the standard answer for app-owned files: a system cron/timer runs it daily, and drop-in configs in `/etc/logrotate.d/` describe each file family. Here is TicketHub's, at `/etc/logrotate.d/tickethub`:

```text
/var/www/tickethub/storage/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su www-data www-data
}
```

Read it: rotate daily; keep 14 generations; gzip old ones, but not the newest rotation (`delaycompress`, so yesterday's log is still instantly `less`-able); tolerate missing files; skip empty ones. Two lines need real understanding. `su www-data www-data` makes logrotate operate as that user/group — required because `storage/logs` is group-writable, which logrotate otherwise (rightly) refuses to touch as root. And `copytruncate` copies the live file then truncates it in place, instead of the default rename-and-recreate — because Laravel holds `laravel.log` open and keeps writing to the *same handle*: rename the file and the app keeps writing to the renamed (or deleted) one while the "new" log stays empty. The cost is a tiny window where lines written between copy and truncate are lost — an accepted trade for app logs. (The cleaner long-term fix: Laravel's `daily` channel, or shipping logs off the box — Module 12.)

## 7. Scheduled work: cron and systemd timers

TicketHub's scheduler must tick every minute (`ExpireReservations` runs `everyMinute()`, the nightly sales report at `dailyAt('02:00')` — see [TICKETHUB.md](../TICKETHUB.md)). Laravel's design is elegant: the server triggers **one** entry point, `php artisan schedule:run`, every minute, and Laravel decides internally what's due. Two mechanisms can provide that tick.

**Cron** is the 50-year-old standard: a daemon that runs commands on a schedule from per-user tables edited with `crontab -e`. The classic Laravel entry — verbatim from the Laravel docs, and the exact line you'll add below:

```text
* * * * * cd /var/www/tickethub && php artisan schedule:run >> /dev/null 2>&1
```

Decode it with skills you already own. The five fields are minute, hour, day-of-month, month, day-of-week; five stars = every minute. Then a plain shell command: `cd` first because cron starts you in `$HOME`, `&&` so artisan only runs if the `cd` succeeded (Lecture 2.2's exit codes), and `>> /dev/null 2>&1` — Lecture 2.1's redirection — discards stdout and stderr, because cron's default behavior on output is to *email it to the user*, which on a VPS means an error queue nobody reads. Cron's environment is nearly empty (its `PATH` is typically just `/usr/bin:/bin`, no `.bashrc`), the number-one source of "works in my shell, fails in cron" mysteries; our `php` lives at `/usr/bin/php`, so the classic line works, but writing `/usr/bin/php` explicitly is the robust habit.

**systemd timers** do the same job with systemd's machinery: a `.timer` unit activates a matching `.service`. The equivalent pair:

```ini
# /etc/systemd/system/tickethub-scheduler.service
[Unit]
Description=TicketHub scheduler tick

[Service]
Type=oneshot
User=www-data
WorkingDirectory=/var/www/tickethub
ExecStart=/usr/bin/php /var/www/tickethub/artisan schedule:run
```

```ini
# /etc/systemd/system/tickethub-scheduler.timer
[Unit]
Description=Run TicketHub scheduler every minute

[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=1s
Persistent=false

[Install]
WantedBy=timers.target
```

`Type=oneshot` marks a run-and-exit task (no `Restart` — it's not long-running). `OnCalendar` uses systemd's calendar syntax ("any date, any hour:minute at second 0"); `AccuracySec=1s` matters because systemd otherwise batches timers within a default one-minute window to save power — fatal sloppiness for a must-run-every-minute tick. `Persistent=false` declines catch-up runs after downtime (`schedule:run` is momentary; stale ticks are worthless).

The honest trade-off: **cron** is universal, one line, documented everywhere — but invisible (`crontab -l` is all you get), output discarded, no dependency awareness. **Timers** give `list-timers` visibility, journald capture of every run (no more `/dev/null`), ordering, and per-run resource limits — at the cost of two files and systemd-only portability. Both are legitimate; **this course uses the cron entry** (the Laravel ecosystem default), and you'll build the timer once so it holds no mystery. Never run *both* — every task fires twice, and customers get two nightly-report emails. The deeper "exactly once *across many servers*" problem waits for Module 9 (`onOneServer`) and Module 11's Kubernetes CronJob.

## 8. Resource limits: a fence around the worker

Because systemd places each service in its own cgroup, it can enforce hard resource caps. Two directives cover most needs: `MemoryMax=256M` (if the service's memory exceeds this, the kernel's OOM killer terminates *it* — not some innocent bystander process) and `CPUQuota=50%` (throttle to half a core). For a queue worker, `MemoryMax` plus `Restart=always` is a beautiful failure mode: a runaway job (a malformed 500-page PDF, say) kills only the worker, systemd restarts it in three seconds, and the box — with MySQL, Redis, and Nginx on it come Module 3 — never feels a thing. Limits like this are the manual ancestor of the resource requests/limits you'll set on every Kubernetes pod in Module 11.

## Hands-on with TicketHub

Prerequisites from Lecture 2.2: `deploy` user, app at `/var/www/tickethub` with correct ownership, PHP 8.4 CLI. The worker needs a queue backend, so install Redis now (Module 3 completes the full stack; Redis is one `apt` away and correctly configured for localhost out of the box):

```bash
$ sudo apt install -y redis-server
$ redis-cli ping
PONG
```

**1. Create the unit.** `sudo tee` is the standard trick for writing a root-owned file from a here-document (Lecture 2.1's `>` can't cross sudo, but a pipe into `tee` can):

```bash
$ sudo tee /etc/systemd/system/tickethub-worker.service > /dev/null <<'EOF'
[Unit]
Description=TicketHub queue worker
After=network.target redis-server.service

[Service]
User=www-data
Group=www-data
WorkingDirectory=/var/www/tickethub
ExecStart=/usr/bin/php /var/www/tickethub/artisan queue:work redis --sleep=3 --tries=3 --max-time=3600
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

**2. Load, enable, start, inspect:**

```bash
$ sudo systemctl daemon-reload
$ sudo systemctl enable --now tickethub-worker
Created symlink /etc/systemd/system/multi-user.target.wants/tickethub-worker.service → /etc/systemd/system/tickethub-worker.service.
$ systemctl status tickethub-worker
● tickethub-worker.service - TicketHub queue worker
     Loaded: loaded (/etc/systemd/system/tickethub-worker.service; enabled; preset: enabled)
     Active: active (running) since Sat 2026-08-09 14:02:11 UTC; 12s ago
   Main PID: 2381 (php)
      Tasks: 1 (limit: 1101)
     Memory: 38.4M (peak: 39.0M)
        CPU: 592ms
     CGroup: /system.slice/tickethub-worker.service
             └─2381 /usr/bin/php /var/www/tickethub/artisan queue:work redis --sleep=3 --tries=3 --max-time=3600

Aug 09 14:02:11 tickethub-vps systemd[1]: Started tickethub-worker.service - TicketHub queue worker.
```

Read that status output line by line — an ops dashboard in ten lines. The bullet `●` is green when healthy. **Loaded** shows which file defines the unit and, crucially, `enabled` — it starts at boot. **Active** gives state and uptime; a fresh timestamp where you expected long uptime is how restart loops announce themselves. **Main PID** is the supervised process. **Tasks/Memory/CPU** come from the cgroup — real accounting (note ~38M resident per worker: multiply before sizing a box). **CGroup** shows the process tree, and the tail is recent journal lines — often the diagnosis itself.

**3. Prove the pipeline end to end.** Follow the worker's journal in terminal A:

```bash
$ journalctl -u tickethub-worker -f
```

In terminal B, dispatch a real queued job (as `www-data` — one writer identity):

```bash
$ cd /var/www/tickethub
$ sudo -u www-data php artisan tinker --execute="dispatch(function () { \Log::info('queued job executed'); })->onConnection('redis');"
```

Terminal A prints the processed job within seconds:

```text
Aug 09 14:06:40 tickethub-vps php[2381]:   2026-08-09 14:06:40 Illuminate\Queue\CallQueuedClosure ... RUNNING
Aug 09 14:06:40 tickethub-vps php[2381]:   2026-08-09 14:06:40 Illuminate\Queue\CallQueuedClosure ... 41.72ms DONE
```

And `tail -1 storage/logs/laravel.log` shows the job's log line, written by `www-data`, permitted by Lecture 2.2's fix. Tinker → Redis → worker → journal → laravel.log: you just traced TicketHub's entire asynchronous spine.

**4. Kill it and watch the resurrection.** This is the payoff over `nohup`:

```bash
$ systemctl show tickethub-worker -p MainPID,NRestarts
MainPID=2381
NRestarts=0
$ sudo kill 2381
$ systemctl show tickethub-worker -p MainPID,NRestarts
MainPID=2410
NRestarts=1
```

Three seconds after SIGTERM, a new PID. Try `sudo kill -9` on the new PID — same outcome, `NRestarts=2`. The journal narrates: `Deactivated successfully` … `Scheduled restart job` … `Started tickethub-worker.service`. Your worker is now effectively unkillable by accident; only `systemctl stop` (which sets the unit to a deliberate inactive state) turns it off.

**5. Install the scheduler — cron first.** Put the entry in **www-data's** crontab (writer identity, again):

```bash
$ sudo crontab -u www-data -e
```

Add the classic line, save, and verify:

```text
* * * * * cd /var/www/tickethub && php artisan schedule:run >> /dev/null 2>&1
```

```bash
$ sudo crontab -u www-data -l | tail -1
* * * * * cd /var/www/tickethub && php artisan schedule:run >> /dev/null 2>&1
$ journalctl -u cron -f
Aug 09 14:15:01 tickethub-vps CRON[2504]: (www-data) CMD (cd /var/www/tickethub && php artisan schedule:run >> /dev/null 2>&1)
```

Cron fires on the minute, every minute. Heads-up: scheduled tasks that need MySQL (like `ExpireReservations`) will fail and log to `laravel.log` until Module 3 installs the database — expected, and honestly useful: real errors to practice `grep -c ERROR storage/logs/laravel.log` and `journalctl` skills on. Leave the entry in place; it's the permanent production line.

**6. Build the timer equivalent, then stand it down.** Create the two units from section 7 (with `sudo tee` or `sudo nano`), then:

```bash
$ sudo systemctl daemon-reload
$ sudo systemctl enable --now tickethub-scheduler.timer
$ systemctl list-timers tickethub-scheduler.timer
NEXT                        LEFT  LAST                        PASSED  UNIT                       ACTIVATES
Sat 2026-08-09 14:19:00 UTC 31s   Sat 2026-08-09 14:18:00 UTC 28s ago tickethub-scheduler.timer  tickethub-scheduler.service
$ journalctl -u tickethub-scheduler --since "5 min ago" | tail -3
```

Note what cron never gave you: next-run prediction and captured output. Now the important discipline — **two mechanisms are running the scheduler**. Since the course standardizes on cron, stand the timer down (knowledge retained, duplication removed):

```bash
$ sudo systemctl disable --now tickethub-scheduler.timer
```

**7. Rotation and a memory fence.** Install the logrotate config from section 6 at `/etc/logrotate.d/tickethub`, then dry-run and force a rotation:

```bash
$ sudo logrotate -d /etc/logrotate.d/tickethub     # -d: debug/dry-run, shows the plan
$ sudo logrotate -f /etc/logrotate.d/tickethub
$ ls /var/www/tickethub/storage/logs
laravel.log  laravel.log.1
```

Finally, cap the worker via a drop-in override — the polite way to amend any unit:

```bash
$ sudo systemctl edit tickethub-worker
```

In the editor, between the marked lines, add:

```ini
[Service]
MemoryMax=256M
```

Save, then `sudo systemctl restart tickethub-worker` and confirm with `systemctl show tickethub-worker -p MemoryMax` (`MemoryMax=268435456`). The override lives at `/etc/systemd/system/tickethub-worker.service.d/override.conf`, leaving the original unit pristine.

## Real-world best practices

- **Every long-running process is a unit; nothing runs from a stray terminal.** If it matters, it has `Restart=always`, an `[Install]` section, and survives `sudo reboot` — which teams verify by *actually rebooting* after provisioning. The reboot test is cheap now and priceless during an unplanned 4 a.m. one.
- **Log to stdout; let the platform collect.** Apps that write to stdout work identically under systemd, Docker (Module 6), and Kubernetes (Module 11) — the collector changes, the app doesn't. Every hand-rolled "log file with custom rotation" is future migration debt.
- **Restart workers on every deploy.** Workers hold the *old* code in memory; after a deploy they happily process jobs with stale classes until restarted. Real pipelines end with `php artisan queue:restart` (a job-boundary restart signal) — wired up in Module 9. `--max-time` is the safety net, not the mechanism.
- **Never edit units in `/usr/lib/systemd/system/`; use `systemctl edit` drop-ins.** Package upgrades silently overwrite vendor files, reverting your changes at the worst possible moment. Drop-ins survive upgrades and make your modifications explicit and reviewable.
- **Treat restart counts as a signal, not a comfort.** `Restart=always` keeps the lights on, but a climbing `NRestarts` is an alarm — check it (and `journalctl -p err`) during any investigation. Teams alerting on restart frequency catch failing deploys minutes before teams alerting only on downtime.
- **Keep every unit, timer, cron line, and logrotate config in version control.** This VPS is hand-built; Modules 8 and 10 rebuild it from code, and configs copied into Git *now* make that migration trivial — today's file becomes tomorrow's Terraform/user-data template verbatim.

## Common pitfalls

1. **Editing a unit and forgetting `daemon-reload`.** You change `ExecStart`, restart, and the *old* command runs — systemd works from its in-memory copy, while file edits feel immediate everywhere else. It even warns (`unit file changed on disk`) in `status`, if you read it. Approach: make `daemon-reload` a reflex after every unit edit, and read `status` after every change.
2. **Writing `ExecStart` (or cron lines) as if they run in your shell.** Pipes, `&&`, bare command names, `~`, and `.bashrc` variables silently misbehave — `ExecStart` is not a shell, and cron's environment is nearly empty; this bites everyone once, usually as `php: command not found` at 2 a.m. Approach: absolute paths everywhere, no shell syntax in `ExecStart` (wrap in `/bin/bash -c '…'` when genuinely needed), and test cron commands with `env -i /bin/sh -c '<command>'`.
3. **Letting `Restart=always` hide a crash loop.** The service "is running" every time you look, but it died 400 times overnight — and systemd may eventually give up (`start-limit-hit`). People trust the green dot and skip the history. Approach: check uptime in `Active:` (seconds, not days, is a tell), `NRestarts`, and `journalctl -u <unit> --since "1 hour ago"`; fix the crash, not the symptom.
4. **Running the scheduler under both cron *and* a timer.** Every task fires twice: double expiry passes (harmless), double nightly sales-report emails (customer-visible). It happens when a tutorial's timer lands on a box that already had the crontab line. Approach: one mechanism per box — check `sudo crontab -u www-data -l` *and* `systemctl list-timers`; one should mention the scheduler, never both.
5. **Rotating an open log file with rename-based rotation (no `copytruncate`).** The app keeps writing through its open handle to the renamed — or deleted — file: the new log stays empty, and disk usage climbs while `du` finds nothing (`lsof | grep deleted` reveals the ghost). People copy generic logrotate configs without asking how the app holds its file. Approach: `copytruncate` for handle-holders like Laravel's single-file channel, or switch to the `daily` channel and let the app rotate itself.
6. **Assuming `enable` means "running" (or `start` means "survives reboot").** The service works all afternoon, then a reboot leaves it dead because nobody enabled it — or a "disabled" service is running because someone started it manually. The axes are independent. Approach: `systemctl status` shows both (`Active:`, plus `enabled/disabled` on the `Loaded:` line); read both, and prefer `enable --now` so intent and reality can't diverge.

## Exercises

1. **Status dissection.** Run `systemctl status ssh` and, in writing, identify: the unit file's path, whether it starts at boot, current uptime, main PID, and memory use. Then use `journalctl -u ssh --since today` to count how many SSH sessions you've opened today.
2. **A second worker.** TicketHub's PDF generation is CPU-heavy, so give the `pdfs` queue a dedicated worker: create `tickethub-worker-pdfs.service` (same shape, `--queue=pdfs` added to `ExecStart`), enable and start it, prove both workers run with `systemctl status` and `ps aux | grep queue:work` — then tear it down *cleanly* (`disable --now`, remove the file, `daemon-reload`).
3. **Sabotage drill.** Break the worker's `ExecStart` (change the binary to `/usr/bin/phpp`), `daemon-reload`, restart, and diagnose using only `systemctl status` and `journalctl -u tickethub-worker -n 30`. Note what `Active:` shows, what `NRestarts` does, and whether systemd eventually declares `start-limit-hit`. Repair it and confirm recovery.
4. **The reboot test.** Predict the post-reboot state of: the worker, the cron entry, Redis, and the (disabled) scheduler timer. Then `sudo reboot`, reconnect, and verify each with one command apiece. Investigate any prediction you got wrong.
5. **Stretch: template units.** Real deployments run one worker *per queue* from a single template. Read `man systemd.unit` (search "specifiers") and create `tickethub-worker@.service` where `%i` supplies the queue name to `--queue=`; run `tickethub-worker@default` and `tickethub-worker@pdfs` from the one file. Explain in two sentences why templates beat copy-pasted units as queues multiply — the same idea returns as Kubernetes Deployments in Module 11.

## What's next

Your VPS now runs TicketHub's background machinery like a real server: supervised, restarted, logged, rotated, scheduled. But it's still wide open — password logins, root SSH permitted, every port exposed, and those brute-force bots from Lecture 2.1 are still hammering away. [Lecture 2.4 — SSH & Server Hardening](04-ssh-and-server-hardening.md) closes the doors: key-only SSH done properly, a firewall raised in the right order, fail2ban to strike back at the bots, and automatic security patches — leaving exactly the hardened box that Module 3 builds the web tier on.
