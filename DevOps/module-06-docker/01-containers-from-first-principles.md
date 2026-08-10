# Lecture 6.1 — Containers from First Principles

> **Module 6 — Docker & Containerization** · Lecture 1 of 4 · Estimated time: ~75 min

Module 5 closed on an uncomfortable truth: your laptop, the VPS, and every future environment run different operating systems, different PHP builds, different service versions — and every difference is a place where "works on my machine" hides. Containers resolve this by making the environment itself a build artifact: the same bytes run everywhere, and parity stops being a discipline you maintain and becomes a property you ship. This lecture is about what a container *actually is* — because the engineers who treat Docker as magic incantations are the ones who can't debug it at 2 a.m., and because everything from Compose (Lecture 6.3) to Kubernetes (Module 11) is a layer on top of the three kernel mechanisms you'll meet today.

## Learning objectives

- Explain the difference between a VM and a container in terms of kernels, hypervisors, and processes — and predict the consequences for startup time, density, and isolation
- Demonstrate namespaces, cgroups, and overlay filesystems with real commands, and state what each contributes to a container
- Distinguish images from containers precisely, and explain why a container's writable layer must be treated as disposable
- Read any image reference (`registry/repo:tag@digest`) and explain which parts are mutable and which are cryptographically pinned
- Drive the container lifecycle — run, inspect, exec, logs, stop, rm — and explain what signals `docker stop` delivers and when
- Run MySQL 8.0 and Redis 7 as containers and attach the local TicketHub checkout to them by config alone

## 1. What a container actually is

Strip away the tooling and a container is **a normal Linux process (or process tree) that the kernel has been told to lie to**. The process is started with:

1. **Namespaces** — it sees its own process list, network stack, hostname, and filesystem mounts, instead of the host's.
2. **cgroups** — the kernel caps how much CPU and memory it may consume.
3. **An overlay filesystem** — its root filesystem is assembled from read-only image layers plus one writable scratch layer.

That's the whole trick. There is no guest operating system, no virtual hardware, no hypervisor. `mysqld` running "in a container" is `mysqld` running on your kernel, visible in the host's `ps`, scheduled by the host's scheduler — just wearing blinkers. Everything practical about containers follows from this: they start in milliseconds (it's just `fork`/`exec` plus some kernel bookkeeping), they're dense (no per-container OS overhead), and their isolation is *kernel-enforced but kernel-shared* — weaker than a VM's, which is why it's worth understanding rather than assuming.

Compare the machinery:

| | Virtual machine | Container |
|---|---|---|
| Isolation boundary | Hypervisor + virtual hardware | Kernel features (namespaces, cgroups) |
| Kernel | One **per VM** (full guest OS) | **Shared** with the host |
| Startup | Tens of seconds (boot an OS) | Milliseconds (start a process) |
| Size of the unit | Gigabytes (OS + app) | Megabytes (app + its userland deps) |
| Density per host | Tens | Hundreds to thousands |
| Isolation strength | Strong (separate kernels) | Good, but one kernel = one attack surface |
| "What is it, really?" | A computer pretending to be hardware | A process pretending to be alone |

Hold on to the last row. The most damaging misconception in container adoption is "a container is a lightweight VM" — it leads teams to run SSH daemons inside containers, treat them as long-lived servers to patch, and store data in them. A container is a *process*: it should run **one concern**, be **replaced rather than repaired**, and keep **nothing it can't afford to lose**. If that sounds like Module 5's factor IX (disposability), it should — containers are twelve-factor's assumptions cast in kernel code.

(One honesty note for macOS and Windows readers: Linux containers need a Linux kernel, so Docker Desktop runs a small hidden Linux VM and your containers live inside it. Everything in this lecture is true *inside that VM*; the practical differences — file sharing performance, how ports reach your host — get flagged where they bite.)

## 2. Namespaces: the lie about what exists

A **namespace** wraps one global kernel resource and gives a process group a private view of it. Linux has several; six do the heavy lifting:

| Namespace | The process gets its own… | Why containers need it |
|---|---|---|
| `pid` | Process ID space — its first process is PID 1 | Can't see or signal host processes |
| `net` | Network stack: interfaces, IPs, ports, routing table | Every container can bind "its" port 80 |
| `mnt` | Mount table | Its root filesystem is the image, not your disk |
| `uts` | Hostname | `hostname` returns the container ID, not the host |
| `ipc` | System V IPC / shared memory | No cross-container shared-memory snooping |
| `user` | UID/GID mappings | Root inside can map to non-root outside |

Prove the `pid` namespace with the course's own base image. First instinct — run `ps` inside it:

```
$ docker run --rm php:8.4-cli ps aux
/usr/local/bin/docker-php-entrypoint: 9: exec: ps: not found
```

Already a lesson, just not the intended one: production images ship a *minimal userland* — `php:8.4-cli` doesn't even contain `ps`, because PHP doesn't need it (Lecture 6.2 leans into this minimalism). So ask PHP itself:

```
$ docker run --rm php:8.4-cli php -r 'var_dump(getmypid());'
int(1)
```

PHP believes it is **PID 1** — the slot reserved for `init`, the ancestor of every process on a machine. On the host, this very same process appears in `ps aux` with an ordinary PID in the thousands. Same process, two truths: that's the pid namespace. (In an image that does carry `ps`, like `ubuntu:24.04`, the classic demo works: `docker run --rm ubuntu:24.04 ps aux` prints a process table containing exactly one line — `ps` itself, as PID 1, running as root.)

Being PID 1 carries responsibilities that will matter a lot in the next lecture: PID 1 receives the signals the runtime sends at shutdown, and the kernel gives PID 1 *no default signal handlers* — a naive PID 1 ignores SIGTERM outright. Remember Module 2's SIGTERM-then-SIGKILL discipline; in containers, *who ends up as PID 1* decides whether graceful shutdown happens at all.

The `net` namespace explains something you'll use constantly: every container has its own interfaces and port space, so ten containers can each bind port 9000 without conflict — and, conversely, "localhost" inside a container is *the container*, never the host. Half of all beginner container networking confusion is this one sentence. The `user` namespace deserves one honest caveat: Docker supports it but does **not** enable UID remapping by default — by default, UID 0 inside the container is UID 0 on the host kernel, one reason Lecture 6.2 insists on non-root images.

## 3. cgroups: the lie about what's available

Namespaces control what a process can *see*; **control groups** (cgroups) control what it can *use*. The kernel accounts CPU time, memory, and I/O per group and enforces limits. Docker exposes them as flags:

```
$ docker run --rm --memory=128m --cpus=1.5 php:8.4-cli php -v
```

Watch memory enforcement do its job. This PHP one-liner appends a megabyte to an array forever; `-d memory_limit=-1` disables PHP's *own* limit so the kernel's is the one that trips:

```
$ docker run --name oom-demo --memory=128m php:8.4-cli \
    php -d memory_limit=-1 -r '$a = []; while (true) { $a[] = str_repeat("x", 1024 * 1024); }'
$ echo $?
137
$ docker inspect -f 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}' oom-demo
OOMKilled=true ExitCode=137
$ docker rm oom-demo
```

The process crossed 128 MiB, the kernel's OOM killer destroyed it with SIGKILL, and the exit code says so: **137 = 128 + 9** (128 + signal number, the same convention Module 2 taught for shell exit codes). `docker inspect` — your X-ray for any container or image, one honest JSON document — confirms `OOMKilled`. File this away: when a production container dies with 137 and `OOMKilled=true`, it's memory; when it dies 137 with `OOMKilled=false`, something sent SIGKILL — usually a supervisor that lost patience (that thread continues in Lecture 6.2 and pays off in Modules 9 and 11, where CPU/memory limits stop being demo flags and become capacity planning).

Note the layering: PHP's `memory_limit = 256M` from Module 3 caps *one request*; the cgroup caps *the whole container* — FPM master, every worker, every exec'd process. Both matter, and Module 11 will insist you set the container one deliberately.

## 4. Images, layers, and the writable lie

The third mechanism answers "where does the container's filesystem come from?". An **image** is an ordered stack of read-only **layers** — each layer a tarball of filesystem changes — plus a small JSON config (default command, env vars, working directory, exposed ports). An overlay filesystem (Docker's `overlay2` driver) mounts the stack so it looks like one normal root filesystem: upper layers shadow lower ones, and a file deleted in a later layer is hidden by a marker (a "whiteout"), *not* removed from the layer below — which is why Lecture 6.2 will make such a fuss about never copying a secret into any layer, ever.

When a container starts, Docker adds exactly one **writable layer** on top. Every write the container performs — logs, temp files, a careless `apt-get install` in a running container — lands there via copy-on-write. Precisely, then:

> **Image** = read-only layers + config. Immutable, shareable, content-addressed.
> **Container** = one image + one writable layer + namespaces + cgroups + a process.

Two consequences run the rest of this module. First, **layers are shared**: fifty containers from one image add fifty thin writable layers, not fifty copies — that's the density win, and it's also why layer-conscious Dockerfiles (Lecture 6.2) and layer-deduplicating registries (Lecture 6.4) work the way they do. Second, **the writable layer dies with the container**. `docker rm` deletes it — MySQL data, uploaded files, everything. This isn't a flaw; it's factor VI enforced by the filesystem: anything worth keeping lives in a backing service or an explicitly attached volume (section 7). The image never changes; the container is scratch paper.

## 5. OCI, registries, and what an image reference really says

None of this is Docker-proprietary. The **Open Container Initiative** standardizes three things: the **image format** (layers + manifest + config), the **runtime contract** (how to unpack a filesystem bundle and start it — implemented by `runc`, which Docker itself uses under the hood via `containerd`), and the **distribution API** (the HTTP protocol registries speak). This is why the ecosystem interoperates: an image you build with Docker runs unmodified under Podman, containerd on a Kubernetes node (Module 11), or AWS Fargate (Module 9). You are learning a standard, not a vendor tool.

A **registry** is a server that stores and serves images — a content-addressed blob store with an HTTP API in front (Lecture 6.4 dissects one properly). Every image reference has four parts, most of them defaulted away in casual use:

```
docker.io / library/php : 8.4-cli @ sha256:9467f10bf42897dec0abb73ee20c747ebd45463ec9d6fcc4044cb83eba6dade7
registry    repository    tag       digest
```

`php:8.4-cli` is shorthand for registry `docker.io`, repository `library/php` (official images live in the `library/` namespace), tag `8.4-cli`. TicketHub's production reference, per [`TICKETHUB.md`](../TICKETHUB.md), spells everything out: `111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d`.

The part that matters operationally: **a tag is a mutable pointer; a digest is the truth.** A digest is the SHA-256 of the image manifest — content-addressed, so it identifies exactly one sequence of bytes forever. `php:8.4-cli` pointed at different bytes last month than it does today (patch releases move the tag); `php@sha256:9467f1…` can only ever be one image. Digests are the *only* true pin — the foundation of Lecture 6.4's tagging strategy and its "never deploy a mutable tag" rule.

## 6. Anatomy of `docker run`

Time to slow down the command you've been typing and watch every phase:

```
$ docker run --rm -it php:8.4-cli php -v
Unable to find image 'php:8.4-cli' locally
8.4-cli: Pulling from library/php
59e22667830b: Pull complete
7d371d640b0e: Pull complete
04eafe6100b3: Pull complete
90fed10f56cf: Pull complete
667ce1e6a2ac: Pull complete
0f24d0e082f1: Pull complete
a684dbc4d915: Pull complete
54b90b30bc5c: Pull complete
23ab8d5d34dd: Pull complete
Digest: sha256:9467f10bf42897dec0abb73ee20c747ebd45463ec9d6fcc4044cb83eba6dade7
Status: Downloaded newer image for php:8.4-cli
PHP 8.4.24 (cli) (built: Aug  5 2026 00:29:09) (NTS)
Copyright (c) The PHP Group
Zend Engine v4.4.24, Copyright (c) Zend Technologies
    with Zend OPcache v8.4.24, Copyright (c), by Zend Technologies
```

Four phases hide in there:

1. **Pull.** The image isn't local, so Docker asks `docker.io` for the `8.4-cli` manifest, gets back the digest and a list of layer digests, and downloads *only the layers it doesn't already have* — each `Pull complete` line is one layer, identified by content hash. Run another PHP-based image later and the shared Debian base layers won't download again: content addressing gives deduplication for free.
2. **Create.** Docker assembles the overlay mount, allocates namespaces and a cgroup, and records the config — but nothing is running yet (this is `docker create`, fused into `run`).
3. **Start.** The kernel starts `php -v` as PID 1 inside the prepared sandbox.
4. **Attach.** `-it` wires your terminal to the process's stdin/stdout (`-i` keeps stdin open, `-t` allocates a TTY). Without them the process still runs; you just aren't attached — which is exactly what you want for servers, via `-d`.

Then PHP prints its version, exits, and `--rm` deletes the container (that disposable writable layer) on the way out. Two rules of thumb from day one: `--rm` for experiments, `-d` for services, and never both expectations of the same container.

## 7. The lifecycle: ps, logs, exec, stop, rm

Start a real service and manage it. Note `-d`, a name, and no `--rm`:

```
$ docker run -d --name tickethub-redis -p 127.0.0.1:6379:6379 redis:7-alpine
b3f1c22ae1f0…
$ docker ps
CONTAINER ID   IMAGE           COMMAND                  CREATED         STATUS         PORTS                      NAMES
b3f1c22ae1f0   redis:7-alpine  "docker-entrypoint.s…"   5 seconds ago   Up 4 seconds   127.0.0.1:6379->6379/tcp   tickethub-redis
```

- **`docker ps`** lists *running* containers; **`docker ps -a`** includes exited ones — the first place to look when a container "isn't there" (it started, crashed, and is sitting in `Exited (1)` with its logs intact).
- **`docker logs -f tickethub-redis`** streams whatever the process wrote to stdout/stderr. This is Module 5's factor XI made native: no files, no rotation config in the app — the runtime captures the streams, exactly as journald did for your systemd units in Module 2. Every serious container image (Redis, MySQL, nginx, and the one you build next lecture) logs to the streams for this reason.
- **`docker exec -it tickethub-redis sh`** starts an *additional* process inside the container's existing namespaces — a shell beside the server, not a new container. It is the container equivalent of SSH-ing into a box, and like SSH it's for *diagnosis*, never for repair: any change you make lands in the disposable writable layer and dies with the container. (`sh`, not `bash` — Alpine-based images don't ship bash; Debian-based ones do.)
- **`docker stop tickethub-redis`** is Module 2's signal discipline, automated: it sends **SIGTERM to PID 1, waits a grace period (default 10 seconds), then SIGKILLs**. A well-built image exits promptly and cleanly — Redis flushes and exits on SIGTERM in milliseconds. A badly built one ignores SIGTERM for the full 10 seconds and gets guillotined, taking in-flight work with it; you'll see in Lecture 6.2 how an innocent-looking Dockerfile line causes exactly that. `docker kill` skips straight to SIGKILL; treat it like `kill -9` — a last resort.
- **`docker stop`** leaves the container stopped but intact (`docker start` resumes it, writable layer preserved); **`docker rm`** deletes it and that layer forever. **`docker inspect <anything>`** dumps full state — IPs, mounts, restart counts, the `OOMKilled` flag from section 3.

## 8. Ports, volumes, and the holes you punch on purpose

**Publishing ports.** The container's net namespace is isolated, so nothing reaches it until you map a host port onto a container port: `-p 8080:80` means *host* 8080 → *container* 80 (host first — the order trips everyone once). The full form is `-p [bind-address:]host:container`, and the bind address is a security decision you already know how to make from Module 3's "MySQL binds 127.0.0.1" discussion: `-p 3306:3306` binds `0.0.0.0` — **every interface, reachable from the network**; `-p 127.0.0.1:3306:3306` is loopback-only. Default is all interfaces. Make loopback your reflex for anything that isn't deliberately public.

And one gotcha this course refuses to soften: **on a Linux host, Docker's port publishing bypasses ufw.** Docker implements `-p` with its own iptables NAT rules (DNAT in `PREROUTING`, its own `DOCKER` chain consulted from `FORWARD`), and published-port traffic never traverses the `INPUT` chain where ufw's rules from Module 2 live. Run `docker run -p 3306:3306 mysql:8.0` on the VPS and MySQL is open to the internet *even though `ufw status` says deny incoming*. The fixes, in order of preference: bind to `127.0.0.1` unless public exposure is the point; put host-level filtering in the `DOCKER-USER` iptables chain, which Docker guarantees to consult first; and keep a firewall *outside* the box (AWS security groups, Module 8) so no host misconfiguration is fatal. On macOS/Windows this doesn't apply — ports are forwarded out of the hidden VM — which is exactly why teams discover it only in production.

**Volumes and bind mounts.** Two ways to give a container storage that outlives it:

- A **named volume** (`-v tickethub-mysql-data:/var/lib/mysql`) is a Docker-managed directory attached into the container. Docker owns its location and lifecycle; it survives `docker rm` and is deleted only when *you* delete it. Right for **data**: databases, MinIO buckets in Lecture 6.3. (On macOS, volumes live inside the hidden VM — another reason to treat them as Docker's, not yours.)
- A **bind mount** (`-v "$PWD":/var/www/html`) maps a *host path you choose* into the container — both sides see the same files instantly. Right for **source code in development**: edit in your IDE, the container sees it immediately. Wrong for data (ties the container to one machine's paths) and wrong in production (the whole point of Lecture 6.2 is that production code ships *inside* the image).

One-line rule: **volumes for state, bind mounts for source, nothing important in the writable layer.**

## Hands-on with TicketHub

The claim from Module 5, factor IV: backing services are attached resources, swappable by config alone. TicketHub's code shouldn't care whether MySQL is an apt-installed daemon (the VPS), a container (today), or RDS (Module 8). Prove it — run production's exact engine versions as containers and point your *local checkout* (your normal `php artisan`, no containers for the app yet) at them.

```
$ docker volume create tickethub-mysql-data
tickethub-mysql-data
$ docker run -d --name tickethub-mysql \
    -p 127.0.0.1:3306:3306 \
    -e MYSQL_ROOT_PASSWORD=root \
    -e MYSQL_DATABASE=tickethub \
    -e MYSQL_USER=tickethub \
    -e MYSQL_PASSWORD=secret \
    -v tickethub-mysql-data:/var/lib/mysql \
    mysql:8.0
Unable to find image 'mysql:8.0' locally
8.0: Pulling from library/mysql
…
Status: Downloaded newer image for mysql:8.0
9d1b7de9f5a2…
$ docker run -d --name tickethub-redis -p 127.0.0.1:6379:6379 redis:7-alpine
b3f1c22ae1f0…
```

The `-e` variables are the MySQL image's initialization contract: on *first start with an empty data directory*, its entrypoint creates the database and user — the container equivalent of Module 3's `CREATE DATABASE` / `CREATE USER` session, driven by environment config. Both ports bind loopback-only, per section 8. Watch MySQL initialize (first boot takes ~15 seconds — worth remembering when Lecture 6.3 adds health checks):

```
$ docker logs -f tickethub-mysql
2026-08-09 12:04:11+00:00 [Note] [Entrypoint]: Initializing database files
…
2026-08-09T12:04:26.118186Z 0 [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections.
Version: '8.0.43'  socket: '/var/run/mysqld/mysqld.sock'  port: 3306  MySQL Community Server - GPL.
```

Now the swap. In your local checkout's `.env` — and this is the *entire* migration:

```dotenv
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=tickethub
DB_USERNAME=tickethub
DB_PASSWORD=secret

REDIS_CLIENT=phpredis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
SESSION_DRIVER=redis
CACHE_STORE=redis
QUEUE_CONNECTION=redis
```

`127.0.0.1` works because `-p` published the containers' ports onto your loopback interface; your locally-running PHP connects to "localhost MySQL" exactly as the VPS's FPM does. (If some previous experiment left a MySQL on your laptop's 3306, the `docker run` fails with `port is already allocated` — stop one or change the *host* side of the mapping.) Migrate and verify:

```
$ php artisan migrate
   INFO  Preparing database.
  Creating migration table ...................... 46ms DONE
   INFO  Running migrations.
  0001_01_01_000000_create_users_table .......... 162ms DONE
  …
  2026_01_17_000000_create_tickets_table ........ 24ms DONE
$ php artisan tinker --execute="Cache::put('hello', 'from-container-redis'); echo Cache::get('hello');"
from-container-redis
$ docker exec -it tickethub-redis redis-cli --scan --pattern 'tickethub*'
tickethub_cache_:hello
```

The same Redis key prefix you saw on the VPS in Module 5 — same app behavior, different attachment, zero code changes. Factor IV, demonstrated. Two more experiments while you're here. **Disposability of containers, durability of volumes:**

```
$ docker rm -f tickethub-mysql
$ docker run -d --name tickethub-mysql -p 127.0.0.1:3306:3306 \
    -e MYSQL_ROOT_PASSWORD=root -v tickethub-mysql-data:/var/lib/mysql mysql:8.0
$ php artisan migrate:status | tail -2
  2026_01_17_000000_create_tickets_table ................... Ran
```

The container was destroyed and replaced; the data survived because it lived in the volume, not the writable layer. Skip `-v` in that second run and you'd get a factory-fresh empty MySQL — try it mentally, or actually, but understand which layer just saved you. **And the host's view of the "isolated" process** — on Linux, `ps aux | grep mysqld` on the host shows the container's MySQL as an ordinary process; it was never anything else.

Leave both containers running (or `docker stop` them — `docker start` brings them back, data intact). They're TicketHub's local backing services until Lecture 6.3 replaces these hand-typed commands with one declarative file.

## Real-world best practices

- **Treat containers as processes, not machines.** No SSH servers inside, no `docker exec` to "fix" running containers, no data in the writable layer. Anything you'd want to keep goes in a volume or a backing service; anything you'd want to change goes through a new image. Teams that violate this rebuild their mental model painfully during their first Kubernetes incident, where containers are replaced without asking.
- **Bind published ports to `127.0.0.1` unless exposure is the point** — and on any Linux box with ufw, know the `DOCKER-USER` chain exists before you run your first `-p` in production. The Docker-vs-ufw surprise has a permanent place in "how we got breached" write-ups; defense in depth (security groups outside the host, Module 8) exists because host firewalls have exactly this kind of blind spot.
- **Name your containers and volumes deliberately** (`tickethub-mysql`, `tickethub-mysql-data`), even for experiments. Auto-generated names like `vigorous_hopper` are cute until you're deciding which of three anonymous volumes holds real data. This habit scales straight into Compose service names and Kubernetes resource names.
- **Read `docker inspect` before guessing.** Exit code, `OOMKilled`, mounts, IPs, restart count — the JSON answers most "why is this container weird" questions in one command. Engineers who reach for inspect first debug in minutes; engineers who re-run with tweaked flags debug by lottery.
- **Pin versions in every image reference you type** — `mysql:8.0`, `redis:7-alpine`, never bare `mysql` (which means `mysql:latest`). You pinned tool versions in [`TICKETHUB.md`](../TICKETHUB.md) for a reason; the tag is where that promise is kept or broken. Lecture 6.4 sharpens this into a full tagging policy.

## Common pitfalls

1. **Expecting data to survive `docker rm`.** People run MySQL without a volume, load it with data, remove the container, and learn about writable layers the hard way. It happens because containers *feel* like small servers. Correct approach: a named volume for every stateful path (`/var/lib/mysql`, `/data`), verified with `docker inspect -f '{{json .Mounts}}'` before you trust it with anything real.
2. **Using `localhost` across a namespace boundary.** From inside a container, `127.0.0.1` is the container itself — so an app container connecting to "localhost MySQL" finds nothing, and (mirror image) your laptop's PHP can only reach container MySQL because `-p` published it onto *your* loopback. The correct model: each net namespace has its own localhost; cross the boundary with published ports (host↔container) or container networking (Lecture 6.2's `docker network`, then Compose DNS).
3. **Publishing `0.0.0.0` ports on a Linux server and trusting ufw.** The firewall says deny; the DNAT rules say otherwise; scanners find the port within hours (they found your `/.env` probe target in Module 3 the same way). Correct approach: loopback binds by default, `DOCKER-USER` rules for real filtering, security groups as the outer wall.
4. **Debugging with `docker exec` and keeping the "fix".** Editing config or installing packages inside a running container works — until the container is replaced and the fix evaporates, usually during an incident, definitely without documentation. Exec is a read-mostly diagnostic tool; every real change goes into the image (next lecture) or the environment config.
5. **Reading "Exited (137)" as a crash bug.** Teams hunt application bugs while `docker inspect` plainly says `OOMKilled=true` — or the reverse: blame memory when 137 came from a SIGKILL after an ignored SIGTERM. Correct approach: 137 = killed by SIGKILL; check `OOMKilled` to learn *who* sent it, then either raise the limit/fix the leak, or fix signal handling (Lecture 6.2 shows the usual culprit).

## Exercises

1. Run `docker run --rm ubuntu:24.04 hostname` and `hostname` on your machine, then explain which namespace made the outputs differ. Do the same for `docker run --rm ubuntu:24.04 ps aux` versus your host's `ps aux` — which namespace, and why does the container's list have one entry?
2. Start `tickethub-redis` if it isn't running, then: `docker exec` a `redis-cli` session, `SET` a key, `docker stop` + `docker start` the container, and check whether the key survived. Explain the result in terms of the writable layer versus `docker rm` (careful: Redis holds data in memory — what does *stop* do to a process, and does Redis 7's default persistence save it?). Verify your explanation with `docker logs`.
3. Re-run the OOM demo from section 3 with `--memory=512m` and PHP's default `memory_limit` (drop the `-d` flag). Which limit trips now, what does the container's exit code become, and what does that tell you about the difference between an application-level and a kernel-level limit?
4. On your machine, find every port Docker has published: `docker ps --format '{{.Names}}\t{{.Ports}}'`. For each mapping, state the bind address and whether a teammate on your Wi-Fi network could reach it. If you're on Linux, compare with `sudo ss -tlnp` and find dockerd holding the sockets — then explain to your past self from Module 3 what's listening and why ufw was never asked.
5. **Stretch:** on a Linux machine or VM (not Docker Desktop), explore the raw mechanisms without Docker: `sudo unshare --pid --fork --mount-proc bash` gives you a shell that believes it's PID 1 (`ps aux` inside it), and `ls /sys/fs/cgroup/` shows the cgroup tree systemd already manages — find the slice your session lives in. Write three sentences connecting what you saw to sections 2 and 3: what did `unshare` create, and what would Docker add on top?

## What's next

You can now run other people's images with full understanding of what the kernel is doing. But TicketHub still has no image of its own — the app that runs in production is still "whatever is on the VPS's disk." The next lecture is the flagship of this module: a production-grade, multi-stage Dockerfile that turns a Git commit into an immutable, non-root, healthcheck-equipped artifact — Module 5's build stage, finally made real — plus the nginx image that rides alongside it. Continue to [Lecture 6.2 — A Production-Grade Dockerfile for Laravel](02-production-dockerfile-laravel.md).
