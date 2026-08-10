# Module 2 — Linux & the Command Line

Every production system you will ever operate — from the $6 VPS in this module to the Kubernetes cluster in Module 11 — is, underneath, a Linux machine administered through a shell. This module takes you from "never seriously used a terminal" to confidently running a real, internet-facing server.

The setting is concrete: you provision a fresh **Ubuntu 24.04 VPS** — the exact machine TicketHub will run on through Module 3 — and build it up lecture by lecture. You'll learn the filesystem and the pipeline toolkit on real logs, create the `deploy` user and put the app at `/var/www/tickethub`, stage and properly fix the infamous Laravel `storage` permission error, write a systemd unit that keeps a TicketHub queue worker alive through kills and reboots, wire up Laravel's scheduler with cron and systemd timers, and finish by hardening the box: key-only SSH, firewall, fail2ban, and automatic security patches. Everything is done by hand on purpose — this is the manual work that Modules 8 and 10 later automate, and you can't automate what you don't understand.

**Prerequisites:** [Module 1 — DevOps Foundations](../module-01-devops-foundations/) (you know what TicketHub is and why we're deploying it). No prior Linux experience assumed. You'll need a small Ubuntu 24.04 VPS (~$5–6/month) from any provider.

## Lectures

1. [Shell Fundamentals](01-shell-fundamentals.md) — terminals vs shells, the filesystem tour, navigation, pipes and redirection, and the grep/cut/sort/uniq toolkit applied to real logs.
2. [Users, Permissions & Processes](02-users-permissions-processes.md) — sudo, ownership, the rwx/octal model, the classic Laravel permission failure fixed properly, plus processes, signals, and exit codes.
3. [Services & Logs: systemd and journald](03-systemd-services-logs.md) — unit files, a supervised TicketHub queue worker, journalctl, logrotate, and the Laravel scheduler via cron and timers.
4. [SSH & Server Hardening](04-ssh-and-server-hardening.md) — how SSH trust works, ed25519 keys and ssh-agent, sshd hardening without lockouts, ufw, fail2ban, and unattended upgrades.

## After this module you can…

- Navigate any Linux server and answer questions from its logs using composable pipelines.
- Diagnose and correctly fix ownership/permission failures — and explain why `chmod -R 777` is never the answer.
- Keep long-running processes (like queue workers) supervised, restarted, resource-capped, and logged with systemd and journald.
- Schedule recurring work with cron or systemd timers and rotate application logs safely.
- Provision and harden an internet-facing Ubuntu server: key-only SSH, default-deny firewall, brute-force banning, automatic security patches.
- Hand Module 3 a production-shaped box, with every step documented for future automation.
