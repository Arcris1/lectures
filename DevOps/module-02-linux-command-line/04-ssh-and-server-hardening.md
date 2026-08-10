# Lecture 2.4 — SSH & Server Hardening

> **Module 2 — Linux & the Command Line** · Lecture 4 of 4 · Estimated time: ~95 min

Since [Lecture 2.1](01-shell-fundamentals.md) you've been connecting to your VPS on faith while `/var/log/auth.log` quietly fills with brute-force attempts. Today faith becomes understanding, and the open box becomes a hardened one: how SSH actually establishes trust, key-only authentication, a client config that makes connecting effortless, then every remaining door closed — no passwords, no root login, a default-deny firewall, automatic banning, automatic security patches. The result is this module's finished deliverable: the exact server Module 3 installs Nginx and PHP-FPM on, and TicketHub's home until Module 8 moves it to AWS.

## Learning objectives

- Explain how an SSH connection establishes trust with host keys, `known_hosts`, and trust-on-first-use.
- Generate and manage ed25519 keys with passphrases and `ssh-agent`, and install them correctly (including the permission rules whose violation fails silently).
- Configure `~/.ssh/config` for one-word connections, and move files with `scp` and `rsync`.
- Harden `sshd` via drop-in config — key-only auth, no root login — using the lockout-prevention ritual (`sshd -t`, keep a session open, verify with `sshd -T`).
- Deploy fail2ban and ufw in an order that cannot lock you out, and verify both are working.
- Enable unattended security upgrades and articulate the "cattle, not pets" principle behind this module's manual work.

## 1. What SSH actually is

**SSH (Secure Shell)** is a protocol for operating a remote machine over an encrypted, authenticated channel. Your terminal runs the client (`ssh`); the server runs the daemon (`sshd`), which listens on TCP port 22, verifies who you are, and hands you a shell as some user. It replaced telnet and rlogin, which sent every keystroke — passwords included — across the network in plaintext. Everything in this course's server work rides on SSH: shells, file copies, Git pushes, and Module 9's deploy pipelines — ultimately a robot doing what you do by hand today.

Two problems must be solved for the channel to mean anything: *you* must know you're talking to the right server (not an impostor), and *the server* must know it's talking to the right human. SSH solves both with public-key cryptography — the same idea in both directions.

## 2. Host keys, known_hosts, and trust on first use

Every SSH server has **host keys** — key pairs generated at install time, stored in `/etc/ssh/` (`ssh_host_ed25519_key` and friends). The private halves never leave the server; they *are* its identity. During connection setup the server proves possession of its private key, and your client compares the public key against its records. The first time ever, there is no record — which produces the prompt you clicked past in Lecture 2.1:

```text
The authenticity of host '203.0.113.10' can't be established.
ED25519 key fingerprint is SHA256:hK9v1kXmPzR4cQ7Yw2sT8uB3nE5dJ6fA0gL1mN9oPqU.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

Read it properly now: "I've never seen this server. Here's a hash of the key it presented. You decide." This is **TOFU — trust on first use**. Answering `yes` stores the key in `~/.ssh/known_hosts` (hashed on Ubuntu clients); every later connection verifies against it silently. The rigorous move is verifying the fingerprint out of band first — providers show it in their web console, or run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` in their browser-based recovery console.

The moment TOFU pays off is when a *stored* key stops matching:

```text
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
```

Two explanations exist: the server was legitimately rebuilt (new install ⇒ new host keys), or someone is intercepting you. **Never** reflexively "fix" this — *find out which*. If you rebuilt the box yourself, clear the stale record with `ssh-keygen -R 203.0.113.10` and re-verify. If you didn't, stop and investigate before typing a single credential.

## 3. Authentication: why keys beat passwords

With the channel trusted, you must authenticate. Password auth is the obvious way and the wrong one, for reasons your own logs demonstrate:

```bash
$ sudo grep -c 'Failed password' /var/log/auth.log
3417
```

Three and a half thousand guesses since you provisioned the box. Passwords are guessable at network speed, reused, phishable, and shared-by-necessity. **Public-key authentication** replaces "something you know" with "something you have": you generate a key pair; the public half goes in the server's `~/.ssh/authorized_keys`; at login your client proves — by signing a challenge — that it holds the private half, which never leaves your laptop. Nothing secret crosses the wire, nothing is guessable at 22/tcp, each person and device has its own revocable key, and the scheme is automatable — which Module 9's CI deployments require anyway.

This course uses **ed25519** keys: modern elliptic-curve cryptography — small keys, fast operations, no parameter-choice footguns. (RSA 4096 remains acceptable where ancient systems demand it; you have no such systems.)

## 4. Keys in practice: generate, hold, install

Generate on your **workstation** — private keys are born and die on the device that uses them, never copied elsewhere:

```bash
$ ssh-keygen -t ed25519 -f ~/.ssh/tickethub_ed25519 -C "deploy@workstation for tickethub-vps"
Generating public/private ed25519 key pair.
Enter passphrase (empty for no passphrase):
```

Set a real passphrase: it encrypts the key at rest, so a stolen laptop or leaked backup doesn't equal server access. Typing it every connection would be miserable — **ssh-agent** solves that, holding decrypted keys in memory for your login session:

```bash
$ eval "$(ssh-agent -s)"
Agent pid 4182
$ ssh-add ~/.ssh/tickethub_ed25519
Enter passphrase for /Users/you/.ssh/tickethub_ed25519:
Identity added: /Users/you/.ssh/tickethub_ed25519
```

One passphrase entry per boot, effortless connections after. (macOS can persist it in the Keychain: `ssh-add --apple-use-keychain`.) Install the *public* half on the server — `ssh-copy-id` does it over your existing password access:

```bash
$ ssh-copy-id -i ~/.ssh/tickethub_ed25519.pub deploy@203.0.113.10
Number of key(s) added: 1
```

Know the manual equivalent, because cloud-init and Terraform do exactly this in Modules 8–10 — it's just an append to a file:

```bash
$ cat ~/.ssh/tickethub_ed25519.pub | ssh deploy@203.0.113.10 \
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Those `chmod`s are not decoration. **sshd refuses to honor `authorized_keys` if the file, `~/.ssh`, or the home directory is group- or world-writable** (its `StrictModes` default) — and it refuses *silently*, falling through to a password prompt; engineers "re-install" perfectly good keys for hours over a 775 home directory. The law: `~/.ssh` is `700`; everything inside is `600`. The client enforces its own version, rejecting a world-readable private key loudly (`UNPROTECTED PRIVATE KEY FILE`). When key auth mysteriously fails, check permissions first, then the server's view: `sudo grep sshd /var/log/auth.log | tail` says `Authentication refused: bad ownership or modes` outright.

## 5. The client config file

Typing `ssh -i ~/.ssh/tickethub_ed25519 deploy@203.0.113.10` forever is error-prone toil. `~/.ssh/config` fixes it:

```text
Host tickethub
    HostName 203.0.113.10
    User deploy
    IdentityFile ~/.ssh/tickethub_ed25519
    IdentitiesOnly yes

Host *
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

Now `ssh tickethub` does everything — and so do `scp tickethub:…` and `rsync … tickethub:…`, which read the same file. `IdentitiesOnly yes` offers *only* the named key: without it, the agent tries every key it holds, and busy agents trip servers' auth-attempt limits (`Too many authentication failures`). The `Host *` block applies defaults everywhere: keepalive probes every 60 seconds so NAT routers and firewalls don't silently drop your idle session mid-incident. `chmod 600 ~/.ssh/config`, like everything in that directory.

## 6. Moving files: scp and rsync

`scp` is cp across SSH — fine for one file:

```bash
$ scp backup.sql tickethub:/tmp/
backup.sql                                    100%  842KB   3.1MB/s   00:00
```

For directories and repeat transfers, **rsync** is the professional tool: it compares source and destination and sends only differences. The flags to know: `-a` (archive: recurse, preserve permissions/times), `-v` (verbose), `-z` (compress in transit), `-n` (**dry run** — show what would happen), and `--delete` (remove destination files absent from the source — which makes the destination a true mirror, and makes mistakes catastrophic; never use it without a dry run first). One semantic trap: a trailing slash on the source means "the *contents* of"; no slash means "the directory itself". `rsync -avz site/ tickethub:/tmp/site/` and `rsync -avz site tickethub:/tmp/site/` produce different trees — dry-run when unsure.

You could "deploy" TicketHub with `rsync -avz --delete ./ tickethub:/var/www/tickethub/` — and plenty of small shops do. Hold the thought for Module 9, which shows why that's not enough (files change *under live traffic*, mid-request) and builds atomic releases instead.

## 7. Reaching servers behind servers

Production networks put most machines on private subnets behind one internet-facing **bastion** (Module 8 builds exactly this in a VPC). Two ways to reach the inner boxes: **agent forwarding** (`ssh -A bastion`, then `ssh inner` from there) forwards your local agent's *socket* to the bastion — convenient, but anyone with root on the bastion can use your agent, while you're connected, to authenticate anywhere your keys work. Prefer **ProxyJump**: `ssh -J bastion inner`, or `ProxyJump bastion` in the inner host's config block. The connection tunnels through end-to-end encrypted; the bastion sees ciphertext and never touches your agent — same convenience, none of the exposure.

## 8. Hardening sshd — without locking yourself out

Server-side SSH policy lives in `/etc/ssh/sshd_config`, but on Ubuntu 24.04 you don't edit that file. Its first effective line is `Include /etc/ssh/sshd_config.d/*.conf`, and sshd has a crucial rule: **for each option, the first value obtained wins**. Drop-ins are read at the `Include` position — *before* the main file's own settings — in filename order. Hence drop-ins beat main-file edits, your file should sort early, and `50-cloud-init.conf` matters: many provider images ship one containing `PasswordAuthentication yes`, silently overriding anything set later in the main file.

So: policy goes in a drop-in that sorts first — `/etc/ssh/sshd_config.d/00-hardening.conf`:

```text
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
MaxAuthTries 3
```

Line by line: no passwords (keys only — the entire brute-force class dies here); no keyboard-interactive fallback (a second password-shaped door some setups leave open); no root logins at all, even with a key (log in as `deploy`, escalate via `sudo` — preserving Lecture 2.2's audit trail); and at most 3 auth attempts per connection.

**What about changing the port?** Both sides, honestly. Moving sshd to, say, 2222 cuts drive-by bot noise by ~99% — smaller logs, fewer fail2ban events. It adds *zero* security against a targeted attacker: a port scan finds sshd in seconds, banner and all. Costs: every client, script, monitor, and rescue procedure must know the port forever, and on Ubuntu 24.04 sshd is socket-activated, so a change also needs `sudo systemctl daemon-reload && sudo systemctl restart ssh.socket`. This course keeps **port 22, keys-only, plus fail2ban** — obscurity is log hygiene, not a security control, and with passwords off the bots are rattling a welded door.

Now the **lockout-prevention ritual**, which you will follow every time you touch sshd for the rest of your career. A broken sshd config or an over-tightened rule doesn't fail politely — it strands you outside your own server, and your active session is the only ladder back in:

1. Make the change.
2. `sudo sshd -t` — syntax-check the full effective config. Silence means valid; errors mean **fix before restarting**.
3. `sudo systemctl restart ssh`.
4. **Do not close your current session.** From a *new* terminal, `ssh tickethub`. Only when the fresh login succeeds may you close the old one.
5. Verify effective policy from the daemon's own mouth: `sudo sshd -T | grep -E 'passwordauthentication|permitrootlogin'` — `-T` prints the merged result of all files, ending every "which file won?" debate.

Your break-glass fallback if it ever goes wrong: the provider's web/recovery console, which attaches like a physical keyboard, no SSH involved. Know where it is *before* you need it.

## 9. fail2ban: making the bots pay

Even with keys-only auth, every bot connection burns sshd CPU and bloats `auth.log`. **fail2ban** watches log files for repeated authentication failures per IP and inserts temporary firewall bans. Debian/Ubuntu packaging enables an `sshd` jail out of the box; you make settings explicit in `/etc/fail2ban/jail.local` (never edit `jail.conf` — same override philosophy as systemd drop-ins):

```text
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
ignoreip = 127.0.0.1/8 ::1 198.51.100.7

[sshd]
enabled = true
```

Five failures within ten minutes ⇒ banned for an hour. `ignoreip` is your insurance: list your own static IP (here `198.51.100.7` — substitute yours, or omit the line if your IP changes) so a fumbled passphrase can never ban *you*. With passwords disabled, fail2ban's role shifts from "prevents brute force" (keys already did) to cutting noise and slowing user-enumeration probes — still worth its 20 MB of RAM on every internet-facing box.

## 10. ufw: the firewall, raised in the right order

Right now every port on your VPS is reachable from the whole internet: Redis from Lecture 2.3 (localhost-bound, but one config mistake from exposure), tomorrow's MySQL, anything a compromised package starts. A host firewall inverts the posture: **deny everything inbound except what you explicitly allow**. Ubuntu's `ufw` front-ends the kernel's netfilter. The commands are simple; the **order** is everything — enabling a default-deny firewall over SSH before allowing SSH cuts off the branch you're sitting on:

```bash
$ sudo ufw default deny incoming
$ sudo ufw default allow outgoing
$ sudo ufw allow OpenSSH                 # 22/tcp — BEFORE enable, always
$ sudo ufw allow 80/tcp comment 'HTTP - Nginx (Module 3)'
$ sudo ufw allow 443/tcp comment 'HTTPS - Nginx (Module 3)'
$ sudo ufw enable
Command may disrupt existing ssh connections. Proceed with operation (y|n)? y
Firewall is active and enabled on system startup
```

That warning is exactly the trap the ordering defuses — your allow rule is already in place, so proceed. `OpenSSH` is an *application profile* (see `ufw app list`) shipped by the openssh package; 80 and 443 are pre-opened for the Nginx you'll install in Module 3. Verify:

```bash
$ sudo ufw status verbose
Status: active
Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
OpenSSH                    ALLOW IN    Anywhere
80/tcp                     ALLOW IN    Anywhere       # HTTP - Nginx (Module 3)
443/tcp                    ALLOW IN    Anywhere       # HTTPS - Nginx (Module 3)
```

MySQL (3306) and Redis (6379) are now unreachable from outside even if they someday bind publicly — defense in depth. Cloud providers add another firewall layer outside the box (security groups — Module 8); production uses both.

## 11. Patches while you sleep: unattended-upgrades

Most real-world compromises exploit vulnerabilities that were patched months earlier. The fix is boring and automatic: **unattended-upgrades** applies security updates daily. Ubuntu server installs and enables it by default — but "should be on" isn't a security posture, so verify:

```bash
$ cat /etc/apt/apt.conf.d/20auto-upgrades
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
$ systemctl list-timers apt-daily-upgrade.timer --no-pager
NEXT                        ...  UNIT                      ACTIVATES
Sun 2026-08-10 06:14:22 UTC ...  apt-daily-upgrade.timer   apt-daily-upgrade.service
```

If the file is missing: `sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`. The default policy (see `/etc/apt/apt.conf.d/50unattended-upgrades`) installs only the `-security` pocket — safe for a server; your PHP from `ppa:ondrej` won't be surprise-upgraded. One knob to decide consciously: `Automatic-Reboot` is `false` by default, so kernel patches wait for your reboot. On a single-VPS setup, leave it false and reboot on your schedule (you validated reboot recovery in Lecture 2.3's exercises); activity logs live in `/var/log/unattended-upgrades/`.

## 12. Cattle, not pets

Step back and notice what you've built by hand across four lectures: a user, ownership, a worker unit, a cron entry, logrotate, keys, sshd policy, a firewall, fail2ban, auto-patching — fifteen minutes of typing, *if* you remember every step. The industry phrase is **pets vs cattle**: a pet server is hand-raised, unique, irreplaceable — and therefore a liability, because "irreplaceable" means "unrecoverable". Cattle are numbered, identical, rebuilt on demand from a definition. Everything manual in this module *will* be automated — Module 8 provisions servers from launch-time scripts, Module 10 defines them in Terraform — so the discipline that matters most today is the humblest: **write down every command you run** in a provisioning notes file in the repo. Notes become a script, the script becomes IaC, and your pet becomes cattle. Undocumented manual work is work you'll redo — during an outage.

## Hands-on with TicketHub

This is the module's capstone: run the full sequence, end to end, and leave the box in its hand-off state for Module 3. Prerequisites: the `deploy` user (Lecture 2.2) and the worker + cron entries (Lecture 2.3).

**1. Key, agent, install, config** — on your workstation:

```bash
$ ssh-keygen -t ed25519 -f ~/.ssh/tickethub_ed25519 -C "deploy@workstation for tickethub-vps"
$ eval "$(ssh-agent -s)" && ssh-add ~/.ssh/tickethub_ed25519
$ ssh-copy-id -i ~/.ssh/tickethub_ed25519.pub deploy@203.0.113.10
```

Add the `Host tickethub` block from section 5 to `~/.ssh/config` (`chmod 600` it), then prove the whole chain: `ssh tickethub` should land you at `deploy@tickethub-vps` with no password and no passphrase prompt. On the server, verify what `ssh-copy-id` did — and that StrictModes will be satisfied:

```bash
$ ls -la ~/.ssh
drwx------ 2 deploy deploy 4096 Aug  9 16:02 .
-rw------- 1 deploy deploy   97 Aug  9 16:02 authorized_keys
$ cat ~/.ssh/authorized_keys
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ4x…q8Zk deploy@workstation for tickethub-vps
```

**2. Harden sshd — with the ritual.** First check for the cloud-image gotcha, then install policy:

```bash
$ ls /etc/ssh/sshd_config.d/
50-cloud-init.conf
$ sudo tee /etc/ssh/sshd_config.d/00-hardening.conf > /dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
MaxAuthTries 3
EOF
$ sudo sshd -t                # silence = syntactically valid
$ sudo systemctl restart ssh
```

**Keep this session open.** From a new terminal on your workstation, run the three verdicts:

```bash
$ ssh tickethub echo "key login OK"
key login OK
$ ssh root@203.0.113.10
root@203.0.113.10: Permission denied (publickey).
$ ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password deploy@203.0.113.10
deploy@203.0.113.10: Permission denied (publickey).
```

Key works; root is out; passwords aren't even offered. Confirm from the daemon itself, then you may close the old session:

```bash
$ sudo sshd -T | grep -E 'passwordauthentication|permitrootlogin'
passwordauthentication no
permitrootlogin no
```

**3. Raise the firewall** — the exact ordered sequence from section 10 (defaults, `allow OpenSSH`, 80, 443, *then* `enable`), finishing with `sudo ufw status verbose` matching the output shown there.

**4. Deploy fail2ban:**

```bash
$ sudo apt install -y fail2ban
$ sudo tee /etc/fail2ban/jail.local > /dev/null <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
EOF
$ sudo systemctl restart fail2ban && sudo systemctl enable fail2ban
$ sudo fail2ban-client status sshd
Status for the jail: sshd
|- Filter
|  |- Currently failed: 2
|  |- Total failed:     31
|  `- File list:        /var/log/auth.log
`- Actions
   |- Currently banned: 1
   |- Total banned:     3
   `- Banned IP list:   45.148.10.77
```

Read it: the filter counts matching log lines; actions shows live bans. Within the hour the internet's background radiation will grow that list — watch with `journalctl -u fail2ban -f`. (Add `ignoreip` with your address if it's stable.)

**5. Verify auto-patching** per section 11, then run the hand-off checklist — every row should pass before you call this module done:

| Check | Command | Expect |
|---|---|---|
| One-word key login | `ssh tickethub` | shell as `deploy`, no prompts |
| Root SSH | `ssh root@203.0.113.10` | `Permission denied (publickey)` |
| Passwords | `sudo sshd -T \| grep passwordauth` | `passwordauthentication no` |
| Firewall | `sudo ufw status verbose` | deny incoming; 22, 80, 443 only |
| Bans active | `sudo fail2ban-client status sshd` | jail running, bans accruing |
| Patching | `cat /etc/apt/apt.conf.d/20auto-upgrades` | both lines `"1"` |
| Worker alive | `systemctl status tickethub-worker` | `active (running)`, enabled |
| Scheduler | `sudo crontab -u www-data -l` | the `schedule:run` line |

This is the box Module 3 begins from: hardened, patched, supervised — and still not serving a single HTTP request. That changes next.

## Real-world best practices

- **One key pair per person per device, never shared, never copied off-device.** A key in two places can be stolen from either, and revocation stops meaning anything; lost laptop = delete one line from `authorized_keys`. This granularity is the point of key auth — don't trade it for a shared "team key".
- **Passwords off and root login off on every internet-facing server, no exceptions.** These two lines eliminate the attack class responsible for the overwhelming majority of SSH compromises, cost nothing operationally once keys are set up, and are the first thing any security audit checks.
- **Always have a second way in before you change the first.** Provider console confirmed, or a second admin key installed, *before* touching sshd or the firewall. Teams formalize this rule for one reason: those who needed it assumed they wouldn't.
- **ProxyJump over agent forwarding; bastions over many exposed boxes.** One hardened, heavily-logged entry point shrinks attack surface and audit scope; end-to-end tunneling keeps your agent yours. Module 8's private subnets use exactly this pattern.
- **Verify posture with the system's own answers, not your memory of edits.** `sshd -T`, `ufw status verbose`, `fail2ban-client status sshd` — effective state, not intended state. Layered config means what you wrote and what runs can differ; check the running truth after every change.
- **Log every provisioning command as you run it.** The notes file seeds the automation of Modules 8 and 10 — and separates a 15-minute rebuild from a lost weekend when the VPS dies.

## Common pitfalls

1. **Enabling ufw before allowing SSH.** Default-deny activates, the next packet to port 22 is dropped, and your session freezes — provider console required. People do it because `enable` feels like step one. Approach: the rule *is* the ordering — `allow OpenSSH` before `enable`, every time (and if you moved sshd's port, allow *that* port).
2. **Restarting sshd untested, then closing your only session.** A typo'd directive, and the closed session was your last ticket in. It happens because established connections survive a broken sshd, creating false confidence. Approach: the full ritual — `sshd -t`, restart, *new-terminal* login test, only then close the old session.
3. **Loose permissions making sshd silently ignore your key.** A group-writable home or `~/.ssh`, and StrictModes skips `authorized_keys` without a word — the client falls back to passwords, so people conclude the key is broken. Approach: `700` on `~/.ssh`, `600` inside, home not group-writable; when mystified, read the server's `auth.log`, which names the problem (`bad ownership or modes`).
4. **Believing you disabled passwords when a drop-in overrode you.** You set `PasswordAuthentication no` in the main `sshd_config`, but `50-cloud-init.conf` said `yes` first — and first value wins, so weeks later the box still accepts passwords. The main file *looks* authoritative. Approach: policy in an early-sorting drop-in (`00-hardening.conf`), verified with `sudo sshd -T`.
5. **Locking the door with the only key inside.** Passwords off, one key, one laptop — then the laptop dies. Approach: before disabling passwords, confirm provider-console access works and install a second key from another device; learn the rescue-mode procedure now, not during the incident.
6. **Forwarding your agent to hosts you don't fully trust.** `ForwardAgent yes` under `Host *` means every server you touch can — while connected — authenticate *as you* anywhere your keys reach; one compromised box becomes a skeleton key. Approach: never forward by default; use `ProxyJump` for hops; scope genuine forwarding needs to one trusted host block.

## Exercises

1. **Close the TOFU loop.** From your provider's web console (not SSH), print the host-key fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, then compare against your client's record (`ssh-keygen -F 203.0.113.10`, or `ssh -v tickethub 2>&1 | grep "Server host key"`). You've now done real out-of-band verification — once more than most engineers ever do.
2. **Second key, clean revocation.** Generate a second ed25519 pair (pretend it's your backup device), install it *manually* through your existing session (no `ssh-copy-id`), and prove both keys work using `ssh -i` with `IdentitiesOnly=yes`. Then revoke the first by deleting its `authorized_keys` line and prove it stopped working while the second still does — lost-laptop day, rehearsed.
3. **rsync fluency drill.** Copy Lecture 2.1's `~/practice` tree to the server with `rsync -avzn` (dry run) via your `tickethub` alias, read the plan, run it for real. Delete one local file, re-run with and without `--delete` (dry-run both), and write one sentence on what each did — including what the source's trailing slash changed.
4. **Tune and prove the jail.** Tighten fail2ban to `maxretry = 3`, `findtime = 1h`, `bantime = 24h`, add your IP to `ignoreip`, and reload (`sudo fail2ban-client reload`). Verify live values with `fail2ban-client get sshd maxretry`, then watch `journalctl -u fail2ban -f` until the internet donates a fresh ban. From a second network (phone hotspot), earn a ban with three bad logins — then unban yourself: `sudo fail2ban-client set sshd unbanip <ip>`.
5. **Stretch: `provision.sh`.** Turn your notes into one idempotent bash script taking a fresh Ubuntu 24.04 root box to this module's checklist state: `deploy` user with your public key, PHP toolchain, sshd drop-in, ufw (order!), fail2ban with jail.local, unattended-upgrades verified — safe to re-run (`mkdir -p`, `ufw --force`, guards before `adduser`). Test it on a rebuilt throwaway VPS and time it. Keep it in the repo: Module 8 turns it into EC2 user-data, and Module 10 makes even the script obsolete.

## What's next

Module 2 is complete: you can navigate, control permissions and processes, supervise services, read every log on the box — and you hold a hardened Ubuntu 24.04 server with TicketHub's code, worker, and scheduler in place, but no way for a customer to reach it. [Module 3 — Networking & Web Servers](../module-03-networking-web-servers/) opens the front door: how IP, DNS, and HTTP actually work, TLS from Let's Encrypt, and the Nginx + PHP-FPM pairing that serves Laravel to the internet — on this exact machine, ports 80 and 443 already waiting in your firewall.
