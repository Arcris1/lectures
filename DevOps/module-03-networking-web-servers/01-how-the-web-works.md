# Lecture 3.1 — How the Web Works

> **Module 3 — Networking & Web Servers** · Lecture 1 of 4 · Estimated time: ~60 min

In Module 2 you built a hardened Ubuntu 24.04 VPS: a `deploy` user, SSH key auth, ufw allowing only ports 22, 80 and 443. Right now that server does exactly one thing — accept SSH. By the end of this module it will serve the TicketHub API over HTTPS. Before installing anything, you need to understand the road a request travels, because every outage you will ever debug is a break somewhere on that road.

## Learning objectives

- Explain IPv4/IPv6 addressing and why the private ranges (`10/8`, `172.16/12`, `192.168/16`) matter for cloud networking later
- Describe TCP and UDP honestly, and define ports, sockets, and listening
- Audit listening sockets with `ss` and justify every bind address as a security decision
- Trace a DNS lookup through the resolver chain, read the common record types, and plan TTL changes around a migration
- Read raw HTTP with `curl -v` and map status codes — especially 502/503/504 — to operational causes
- Isolate connectivity failures methodically with the ping → dig → curl → ss ladder

## 1. IP addresses: how machines find each other

Every machine on a network has at least one IP address. IPv4 addresses are 32-bit numbers written as four octets — `203.0.113.10` — about 4.3 billion possible, exhausted years ago. That scarcity shaped modern networking: NAT, private ranges, and eventually IPv6.

Ranges use CIDR notation: `10.0.0.0/16` means "first 16 bits fixed, the rest vary" — 65,536 addresses. You'll read CIDR constantly from Module 8 on.

Three blocks are **private** (RFC 1918), never routed on the public internet:

| Range | CIDR | Typically seen in |
|---|---|---|
| `10.0.0.0` – `10.255.255.255` | `10.0.0.0/8` | Cloud VPCs, data centers |
| `172.16.0.0` – `172.31.255.255` | `172.16.0.0/12` | Docker networks, AWS default VPCs |
| `192.168.0.0` – `192.168.255.255` | `192.168.0.0/16` | Home and office LANs |

Plus `127.0.0.0/8` — **loopback**. Traffic to `127.0.0.1` never leaves the machine; that matters enormously in a moment.

Why care now? Because your architecture grows into these ranges: in Module 8, TicketHub's production VPC is `10.0.0.0/16`, its database and Redis get private addresses only, and `10.x`'s unreachability from the internet *is* the first layer of security. Your VPS already has a public IP (ours is `203.0.113.10` in every example — substitute yours) and likely a private one.

IPv6 solves scarcity with 128-bit hex addresses like `2001:db8:f00d::10` (`::` collapses zeros); most VPS providers assign one automatically. For this course you mainly need to recognize AAAA records and `[::]:80` ("IPv6 any address") in `ss` output.

## 2. TCP and UDP: two ways to ship bytes

IP alone delivers packets with no promises — late, duplicated, reordered, or lost. Two transports sit on top with different deals.

**TCP** is a connection: a three-way handshake (SYN → SYN-ACK → ACK) first, then every byte is numbered, acknowledged, retransmitted on loss, delivered in order, with congestion control backing off under load. The price is latency (a round trip before the first data byte) and per-connection state. Everything in TicketHub's data path — HTTP, TLS, MySQL, Redis, SSH — runs over TCP, because "all the bytes, in order, or an error" is exactly what an API and a database need.

**UDP** is fire-and-forget: stamp a destination on a datagram and send. No handshake, ordering, retransmission, or connection state. That is not "broken" — it's a different contract: the layer above must handle loss if it cares. UDP fits tiny query/response exchanges (classic DNS is one packet each way), metrics, and real-time media where a late packet is worthless. It is also the foundation of HTTP/3: QUIC rebuilds reliability *inside* UDP to escape TCP's limitations (section 6).

## 3. Ports, sockets, and what "listening" means

An IP address reaches the right *machine*; a **port** (16-bit, 0–65535) reaches the right *process*. A **socket** is the endpoint a process reads and writes: protocol + address + port. A TCP connection is identified by the 5-tuple (protocol, source IP/port, destination IP/port); the client's source port is ephemeral, OS-picked — how one laptop holds thousands of simultaneous connections.

A process **listens** when it asks the kernel to queue incoming connections on an address and port. Two decisions are baked in, and both are yours to own:

- **The port.** Ports below 1024 are privileged — only root binds them (why nginx's master runs as root while its workers don't).
- **The bind address.** `0.0.0.0` = every interface, including the public internet. `127.0.0.1` = this machine only — unreachable from outside *regardless of firewall rules*. Bind address is the first line of defense; ufw is the second. Defense in depth wants both.

The well-known ports of this course:

| Port | Service | On the TicketHub VPS |
|---|---|---|
| 22 | SSH | `sshd` — admin access (Module 2) |
| 53 | DNS | You query it; you don't run it |
| 80 | HTTP | nginx — redirects to 443 (Lecture 3.2) |
| 443 | HTTPS | nginx — TLS termination (Lecture 3.2) |
| 3306 | MySQL | Bound to `127.0.0.1` **only** (Lecture 3.3) |
| 6379 | Redis | Bound to `127.0.0.1` **only** (Lecture 3.3) |
| 9000 | PHP-FPM (TCP mode) | Not used — unix socket instead (Lecture 3.3) |

The inspection tool is `ss -tlnp`: **t**cp, **l**istening, **n**umeric, owning **p**rocess — used heavily in the hands-on.

## 4. DNS: turning names into addresses

Customers hit `api.tickethub.example`, not `203.0.113.10`. DNS — a globally distributed, heavily cached, hierarchical database — makes the translation. A cold lookup runs this chain:

1. **Stub resolver** — the tiny client in the OS: checks `/etc/hosts` and local cache, then forwards to a recursive resolver. Ubuntu's is `systemd-resolved` on `127.0.0.53` — you'll spot it in `dig` output.
2. **Recursive resolver** — ISP, cloud, or public (`1.1.1.1`, `8.8.8.8`). Does the legwork, caches aggressively.
3. **Root servers** — answer "who runs `.example`?"
4. **TLD servers** — answer "who is authoritative for `tickethub.example`?"
5. **Authoritative servers** — your DNS host, where you clicked "add record," gives the answer.

Steps 3–5 happen only on cache misses. Every answer carries a **TTL** (seconds it may be cached) — why DNS is fast, and why changes are slow to take effect.

A realistic zone for `tickethub.example` (a reserved placeholder TLD — substitute your real domain, per course conventions):

```zone
$ORIGIN tickethub.example.
$TTL 3600

@       IN NS    ns1.dnshost.example.
@       IN NS    ns2.dnshost.example.

@       IN A     203.0.113.10
@       IN AAAA  2001:db8:f00d::10
api     IN A     203.0.113.10
api     IN AAAA  2001:db8:f00d::10
www     IN CNAME tickethub.example.
@       IN MX    10 inbound.mailhost.example.
@       IN TXT   "v=spf1 include:amazonses.com ~all"
```

The record types, in the order you'll meet them:

- **A** — name → IPv4. The workhorse.
- **AAAA** — name → IPv6.
- **CNAME** — name → *another name* ("ask again over there"). A CNAME can't coexist with other records at the same name, and the zone apex can't be one — why AWS load balancers (Module 8) need alias records or a subdomain.
- **TXT** — text used for proving things: SPF mail policy (ours authorizes Amazon SES, TicketHub's mailer from Module 8), ownership verification, and the DNS-01 ACME challenge in the next lecture.
- **MX** — where inbound mail goes, with priority.
- **NS** — which servers are authoritative; the delegation glue of the hierarchy.

**TTL is an operational lever.** With TTL 3600, resolvers may serve a changed record's *old* value for up to an hour — you cannot flush the world's caches. So teams plan: one full old-TTL period **before** the migration window, drop the TTL (3600 → 300); cut over; traffic drains in minutes instead of an hour; raise it afterward. Dropping the TTL at the same moment as the change achieves nothing — the old TTL was cached with the old answer. And a minority of resolvers ignore TTLs entirely, so design cutovers so both endpoints work during the overlap.

## 5. HTTP: the protocol your API speaks

HTTP/1.1 is structured text. A request: request line, headers, blank line, optional body. A response mirrors it with a status line:

```http
GET /api/v1/events HTTP/1.1
Host: api.tickethub.example
Accept: application/json
```

```http
HTTP/1.1 200 OK
Server: nginx
Content-Type: application/json
Cache-Control: no-cache, private

{"data":[...]}
```

Four headers deserve ops-level attention:

- **`Host`** — the most important header you've never thought about. One IP, one port 443, many sites: `Host` tells nginx *which* site the client wants, matched against each server block's `server_name`. That is name-based virtual hosting; a mismatch lands you in the default server. When we build a load balancer in Lecture 3.4, forgetting to forward `Host` is bug number one.
- **`Content-Type`** — what the body is. Laravel returns `application/json` for API routes; mislabeling breaks strict clients.
- **`Cache-Control`** — who may cache, for how long. Laravel defaults APIs to `no-cache, private`; caching bugs are invisible until a customer sees someone else's data.
- **`X-Request-Id`** — not standard, but production teams attach a unique ID per request at the edge and log it at every hop to trace one failure through nginx, Laravel and queues. Module 12 wires it up; start noticing it now.

Status codes come in classes — 2xx success, 3xx redirection, 4xx *client* error, 5xx *server* error. The operationally relevant ones:

| Code | Meaning | TicketHub relevance |
|---|---|---|
| 200 | OK | Normal |
| 201 | Created | Successful `POST /api/v1/orders` |
| 301 | Moved permanently | HTTP→HTTPS redirect; browsers cache it hard |
| 302 | Found | Temporary redirect |
| 304 | Not modified | Conditional GET, cache hit |
| 400 | Bad request | Malformed request |
| 401 | Unauthenticated | Missing/invalid token |
| 403 | Forbidden | Authenticated, not allowed |
| 404 | Not found | Wrong URL — or stale route cache |
| 422 | Unprocessable | Laravel validation failure — not an incident |
| 429 | Too many requests | Rate limiter — expected during on-sale spikes |
| 500 | Internal server error | Uncaught exception — *your* bug, read Laravel logs |
| 502 | Bad gateway | nginx got no valid response from PHP-FPM |
| 503 | Service unavailable | Deliberate: maintenance mode or no healthy backends |
| 504 | Gateway timeout | PHP-FPM took too long to answer |

**502, 503 and 504 are the DevOps status codes** — the web tier is fine and the thing *behind* it is not:

- **502 Bad Gateway**: nginx connected onward and got refusal or garbage. Here: PHP-FPM down, crashed mid-request, or pool exhausted with the backlog overflowing. Check `systemctl status php8.4-fpm` and the nginx error log.
- **503 Service Unavailable**: something *chose* to say no — `php artisan down`, or a balancer with zero healthy targets. 503s are usually deliberate; find out who is being deliberate.
- **504 Gateway Timeout**: the backend is alive but too slow — a slow query, a hung external API — and nginx gave up waiting (`fastcgi_read_timeout`, default 60s). The request may *still be running* server-side, which is its own trouble.

You will cause and fix real 502s in Lecture 3.3.

## 6. One connection, many requests: HTTP/1.1, HTTP/2, HTTP/3

**HTTP/1.1 (1997)** brought keep-alive: reuse one TCP connection for consecutive requests instead of paying the handshake each time — but strictly one-at-a-time per connection: one slow response blocks everything behind it (head-of-line blocking), which is why browsers opened ~6 parallel connections per host.

**HTTP/2 (2015)** keeps the semantics but switches to binary frames and **multiplexes** many concurrent streams over one TCP connection, plus header compression. No application-level head-of-line blocking — but one lost packet stalls *every* stream until TCP retransmits: the blocking moved down a layer. Nginx enables it with one directive; we do so next lecture.

**HTTP/3 (2022)** abandons TCP for **QUIC over UDP**: reliability is per-stream (one lost packet stalls only its stream), TLS 1.3 is built into the handshake, and connections survive a phone hopping Wi-Fi → LTE — real money for a ticketing app at venue gates. Nginx 1.26 ships HTTP/3; this course sticks with HTTP/2 at the origin, treating HTTP/3 as a later edge/CDN optimization.

## 7. The complete journey

Everything that happens when a customer's phone requests `https://api.tickethub.example/api/v1/events` — the mental model this module installs, one layer per lecture:

1. **DNS.** Stub → recursive resolver; on a cold cache, root → TLD → authoritative → `A 203.0.113.10`, cached at every layer on the way back.
2. **TCP.** Ephemeral port → `203.0.113.10:443`; SYN, SYN-ACK, ACK. Accepted because nginx listens on `0.0.0.0:443` and ufw allows it.
3. **TLS.** TLS 1.3 negotiated; the server proves it *is* `api.tickethub.example` with a certificate (Lecture 3.2); ALPN agrees on HTTP/2.
4. **HTTP.** `GET /api/v1/events` with `Host: api.tickethub.example`; nginx matches `server_name`, applies `try_files`, forwards over a unix socket to PHP-FPM (Lecture 3.3).
5. **The app.** A PHP-FPM worker runs `public/index.php`; Laravel routes to `EventController@index`, queries MySQL on `127.0.0.1:3306`, returns JSON.
6. **The way back.** PHP-FPM → nginx → TLS connection → phone decrypts, parses, renders.

Every production incident is a failure at one of those six steps. The hands-on gives you the ladder for finding which.

## Hands-on with TicketHub

Work on your Module 2 VPS (SSH in as `deploy`) and your laptop. The VPS runs only `sshd` — perfect: watching this module fill the socket table is the point.

### Step 1 — What is listening today?

```
$ sudo ss -tlnp
State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port  Process
LISTEN  0       4096          0.0.0.0:22          0.0.0.0:*     users:(("sshd",pid=712,fd=3))
LISTEN  0       4096             [::]:22             [::]:*     users:(("sshd",pid=712,fd=4))
```

Read one line completely: `sshd` (PID 712) listens on port 22 on every IPv4 (`0.0.0.0`) and IPv6 (`[::]`) interface — necessarily public, or you couldn't SSH in. On a listening socket, `Send-Q` is the accept-backlog size and `Recv-Q` is connections waiting to be accepted; persistently nonzero `Recv-Q` means the process can't keep up. Remember that — it returns during PHP-FPM tuning.

Now probe from your **laptop**:

```
$ nc -vz 203.0.113.10 22
Connection to 203.0.113.10 port 22 [tcp/ssh] succeeded!
$ nc -vz 203.0.113.10 80
nc: connect to 203.0.113.10 port 80 (tcp) failed: Connection refused
```

**Refused, not timed out** — diagnostic gold. ufw allows 80 (Module 2), so your SYN reached the kernel, which answered "nothing listening" with an instant RST. A *timeout* would mean a firewall silently dropping packets. Refused → start the service. Timeout → fix the network path or firewall.

### Step 2 — The target state

By the end of Lecture 3.3 the same command shows this — keep it as your reference:

```
$ sudo ss -tlnp
State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port  Process
LISTEN  0       4096          0.0.0.0:22          0.0.0.0:*     users:(("sshd",pid=712,fd=3))
LISTEN  0       511           0.0.0.0:80          0.0.0.0:*     users:(("nginx",pid=9012,fd=6),...)
LISTEN  0       511           0.0.0.0:443         0.0.0.0:*     users:(("nginx",pid=9012,fd=8),...)
LISTEN  0       151         127.0.0.1:3306        0.0.0.0:*     users:(("mysqld",pid=8455,fd=23))
LISTEN  0       70          127.0.0.1:33060      0.0.0.0:*     users:(("mysqld",pid=8455,fd=21))
LISTEN  0       511         127.0.0.1:6379        0.0.0.0:*     users:(("redis-server",pid=8621,fd=6))
LISTEN  0       511             [::1]:6379           [::]:*     users:(("redis-server",pid=8621,fd=7))
```

The pattern to internalize: **nginx faces the world; MySQL and Redis face only this machine.** (33060 is MySQL's secondary "X protocol" listener — also loopback, also fine.) Exposed MySQL/Redis ports get found by internet-wide scanners within minutes — unauthenticated Redis is a famously instant compromise. Loopback binding plus ufw means two independent mistakes must happen before 3306 is public.

Notice what's *missing*: PHP-FPM. It listens on a **unix domain socket** — a file, not an IP:port — so it can never be network-exposed by accident. `ss -tlnp` won't show it; this will:

```
$ sudo ss -xlp | grep php
u_str LISTEN 0 4096 /run/php/php8.4-fpm.sock 31337 * 0 users:(("php-fpm8.4",pid=9210,fd=9),...)
```

### Step 3 — Interrogating DNS with dig

Create the `A` record for `api.<your-domain>` → your VPS IP at your DNS provider now — Lecture 3.2 needs it live. Then:

```
$ dig +short api.tickethub.example
203.0.113.10

$ dig +noall +answer api.tickethub.example
api.tickethub.example.  3600  IN  A  203.0.113.10

$ dig +noall +answer api.tickethub.example
api.tickethub.example.  3489  IN  A  203.0.113.10
```

`+short` gives just the answer; `+noall +answer` shows it with the TTL. Run it twice: the TTL counts down (3600 → 3489) because your recursive resolver is serving cache and telling you how long it will keep doing so. That countdown *is* the delay a record change suffers.

Query specific types, and specific servers:

```
$ dig +short tickethub.example MX
10 inbound.mailhost.example.
$ dig +short tickethub.example TXT
"v=spf1 include:amazonses.com ~all"
$ dig +short @1.1.1.1 api.tickethub.example
203.0.113.10
```

`@1.1.1.1` bypasses your local stub (`127.0.0.53`) and asks Cloudflare directly — essential when you suspect *your* cache is stale but the world's isn't, or vice versa. To watch the hierarchy itself, trace from the root:

```
$ dig +trace api.tickethub.example
.                      515869  IN  NS  a.root-servers.net.
...
example.               172800  IN  NS  a.iana-servers.net.
...
tickethub.example.      86400  IN  NS  ns1.dnshost.example.
tickethub.example.      86400  IN  NS  ns2.dnshost.example.
...
api.tickethub.example.   3600  IN  A   203.0.113.10
;; Received 66 bytes from 198.51.100.53#53(ns1.dnshost.example) in 12 ms
```

Root delegates to TLD, TLD to your DNS host, your DNS host answers. `+trace` skips all caches — the definitive check for "did my record change actually publish?"

### Step 4 — /etc/hosts: your private DNS override

The stub resolver consults `/etc/hosts` before any DNS server. On your **laptop**:

```
$ sudo tee -a /etc/hosts <<< '203.0.113.10  api.tickethub.example'
```

Now the name resolves to your VPS *for this machine only*, regardless of real DNS — which is how you test a server at its hostname **before** cutting DNS over, or before DNS exists at all. Two cautions: it fools only *you* (Let's Encrypt's validators use real public DNS), and a forgotten hosts entry is a classic source of "works on my machine, down for everyone." Remove it once real DNS resolves — or prefer curl's surgical version, scoped to one command:

```
$ curl --resolve api.tickethub.example:443:203.0.113.10 https://api.tickethub.example/up
```

### Step 5 — Reading a full conversation with curl -v

This transcript is against the *finished* VPS — after Lectures 3.2 and 3.3, your output will match. Read it now as the map of everything this module builds:

```
$ curl -v https://api.tickethub.example/api/v1/events
* Host api.tickethub.example:443 was resolved.
* IPv4: 203.0.113.10
*   Trying 203.0.113.10:443...                                   (1)
* Connected to api.tickethub.example (203.0.113.10) port 443
* ALPN: curl offers h2,http/1.1                                  (2)
* TLSv1.3 (OUT), TLS handshake, Client hello (1):
* TLSv1.3 (IN), TLS handshake, Server hello (2):
* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384          (3)
* Server certificate:
*  subject: CN=api.tickethub.example
*  expire date: Oct 30 09:14:21 2026 GMT
*  issuer: C=US; O=Let's Encrypt; CN=R11
*  SSL certificate verify ok.                                    (4)
* using HTTP/2
> GET /api/v1/events HTTP/2                                      (5)
> Host: api.tickethub.example
> User-Agent: curl/8.5.0
> Accept: */*
>
< HTTP/2 200                                                     (6)
< server: nginx
< content-type: application/json
< x-ratelimit-limit: 60
< x-ratelimit-remaining: 59
< cache-control: no-cache, private
<
{"data":[{"id":1,"name":"Laracon Manila 2026","starts_at":"2026-11-14T09:00:00+08:00",...
* Connection #0 to host api.tickethub.example left intact        (7)
```

1. DNS answered; TCP handshake to 443 succeeded — network path and firewall fine.
2. ALPN: inside the TLS handshake, both sides agree which HTTP version to speak.
3. TLS 1.3 with an AEAD cipher — next lecture explains every word.
4. Chain verified to a trusted root; name matches. That expiry date pages someone if it slips past — ~90 days out (Let's Encrypt).
5. `>` lines: the raw request. HTTP/2 in effect; `Host` still rules virtual hosting.
6. `<` lines: 200, JSON, Laravel's rate-limit headers (429 lives behind those numbers), `no-cache, private` so intermediaries don't cache API data.
7. Keep-alive: the connection stays open for reuse.

### Step 6 — The troubleshooting ladder

When "the API is down," climb in order — each rung isolates a layer:

| Rung | Command | If it fails, suspect |
|---|---|---|
| 1. Name | `dig +short api.tickethub.example` | DNS: wrong/missing record, stale cache (compare `@1.1.1.1`) |
| 2. Host | `ping -c3 203.0.113.10` | Routing/host down — but many networks drop ICMP; no-ping proves nothing alone |
| 3. Port | `nc -vz 203.0.113.10 443` | *Timeout* → firewall/network. *Refused* → service not listening |
| 4. Protocol | `curl -v https://api.tickethub.example/up` | TLS errors → certs; 5xx → backend; hangs → timeouts |
| 5. On the box | `sudo ss -tlnp`, `systemctl status nginx php8.4-fpm`, logs | The service itself |

The ladder's value is what each *success* eliminates: if rung 3 succeeds, DNS, routing, firewall and listener are all fine — the problem is in the application stack. Run rungs 1–3 against your VPS today: rung 3 fails with `Connection refused` on 443 — correct, and about to be fixed.

## Real-world best practices

- **Bind to the narrowest interface that works.** Loopback for anything only the box consumes (MySQL, Redis, FPM's socket); public only for the actual edge (nginx, sshd). The firewall should be the *second* thing between a scanner and your database, never the only thing.
- **Treat TTLs as change management.** Steady-state 300–3600s for records pointing at movable infrastructure; drop to 60–300s at least one old-TTL before planned cutovers; raise afterward. Runbook the TTL change as its own dated step — it has its own lead time.
- **Make the refused/timeout distinction reflex.** Half of "server is down" escalations resolve by knowing whether the connection was rejected (service problem) or dropped (network/firewall problem). A one-second `nc` tells you which team to page.
- **Adopt request IDs early.** Teams with correlation IDs debug distributed problems in minutes; teams without grep timestamps and guess. Module 12 formalizes it.
- **Use documentation ranges in docs** (`203.0.113.0/24`, `2001:db8::/32`, `.example`) so copy-pasted examples can never hit a stranger's real server — as this course does.

## Common pitfalls

1. **Changing a DNS record first, then lowering the TTL.** The TTL field is right there on the same form, so people do both at once — but resolvers cached the *old* TTL with the old answer, so convergence still takes the full old TTL. Correct order: lower TTL, wait out the old TTL, then change the record.
2. **Binding MySQL/Redis to `0.0.0.0` to "fix" a connection problem.** Tutorials suggest it because errors vanish instantly. It also puts your database one firewall mistake from the internet. Correct approach: keep loopback binding; for remote admin, tunnel: `ssh -L 3306:127.0.0.1:3306 deploy@…`.
3. **Declaring a host down because ping fails.** ICMP is routinely filtered; absence of ping is not evidence of absence. Test the actual service port with `nc`/`curl` before escalating.
4. **Reading 502 and restarting nginx.** Instinct says "the web server errored" — but 502 means nginx is fine and its *upstream* is not. Restart or inspect PHP-FPM, and read the nginx error log, which names the failing upstream explicitly.
5. **Forgetting an `/etc/hosts` override.** Weeks later the site "works" for you and is down for everyone — or vice versa — and you debug phantom DNS for an hour. Prefer `curl --resolve` for one-offs; if you must edit hosts, comment it `# TEMP` and delete it the same day.

## Exercises

1. On your VPS, run `sudo ss -tlnp` and write one sentence per socket: what it is and why its bind address is correct. Keep the note — you'll re-run this after Lecture 3.3 and explain the diff.
2. For a domain you own, query `A`, `NS` and `TXT` three ways: default resolver, `@1.1.1.1`, and directly against your authoritative server (`@ns1.…`). Compare TTLs and explain why the authoritative answer's TTL never counts down.
3. Run `curl -v` against any public HTTPS API and annotate it yourself: DNS result, TCP connect, TLS version and cipher, certificate expiry, HTTP version, status code, one cache-related header.
4. Simulate a cutover: point `api.<your-domain>` at your VPS via `/etc/hosts`, prove with `curl -v` that you reach the VPS (connection refused on 443 today — explain why that still proves it), then repeat with `curl --resolve`. State one advantage of each method.
5. **Stretch:** on the VPS, run `sudo tcpdump -ni any port 53` in one terminal while `dig example.com` runs (uncached) in another. Identify the stub (`127.0.0.53`) and the recursive resolver your VPS uses, and explain why you see *no* traffic to the root servers from your machine. Re-run the dig and explain the silence.

## What's next

Your VPS answers on 22 and refuses on 80 and 443 — and you now know exactly what those refusals mean. Next, nginx takes ports 80/443 and we solve what plain HTTP cannot: proving to a stranger's phone that your server really is `api.tickethub.example`, and encrypting everything in between. Continue to [Lecture 3.2 — TLS & Certificates](02-tls-and-certificates.md).
