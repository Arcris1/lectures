# Lecture 3.2 — TLS & Certificates

> **Module 3 — Networking & Web Servers** · Lecture 2 of 4 · Estimated time: ~55 min

In [Lecture 3.1](01-how-the-web-works.md) you traced a request from a phone to your VPS and saw TLS sitting between the TCP handshake and the first HTTP byte. This lecture demystifies that layer, then makes it real: by the end, nginx is installed on your VPS and serving `https://api.tickethub.example` with a free, automatically renewing Let's Encrypt certificate — before the Laravel app even arrives in Lecture 3.3.

## Learning objectives

- State precisely what HTTPS protects — confidentiality, integrity, authentication — and what it does not
- Explain the TLS 1.3 handshake at the intuition level: asymmetric crypto to authenticate and agree on keys, symmetric crypto for the data
- Read a certificate (subject, SANs, validity, issuer) and follow its chain of trust from leaf to root
- Choose between ACME's HTTP-01 and DNS-01 challenges, and issue a certificate with certbot's nginx plugin
- Configure HTTP→HTTPS redirects, modern protocol settings, and HSTS without locking yourself out
- Verify certificates from the outside with `openssl s_client` and monitor expiry so renewal failures page you, not your customers

## 1. What HTTPS protects — and what it doesn't

HTTPS is HTTP running inside a TLS (Transport Layer Security) tunnel. The tunnel gives you three distinct guarantees, and it pays to name them separately because they fail separately:

- **Confidentiality.** Everyone between the phone and your VPS — café Wi-Fi, the ISP, backbone carriers — sees only ciphertext. Ticket orders carry names, emails and payment references; without TLS they cross the internet as readable text.
- **Integrity.** Any tampering in transit is detected and the connection dies. No ISP-injected ads, no altered order totals, no rewritten JavaScript.
- **Authentication.** The server *proves* it is `api.tickethub.example` before any application data flows. Without this, encryption is pointless — you'd just be having a very private conversation with an attacker sitting in the middle.

Equally important is what HTTPS does **not** do. It does not hide metadata: an observer still sees that your customer talked to your IP, roughly when, and how much data moved — and usually the hostname too, since SNI (the hostname in the TLS handshake) is commonly unencrypted. It does not make your application secure: SQL injection over TLS is still SQL injection, delivered confidentially. It does not protect data at rest on your disk or in MySQL. And a padlock does not mean a site is *trustworthy* — a domain-validated certificate proves control of a domain name, nothing about the humans behind it; phishing sites have valid certificates too. Finally, TLS protects exactly one hop: once we add a load balancer in Module 8, traffic *behind* the point of termination is only encrypted if you decide it should be (section 5).

## 2. The cryptography, at intuition level

Two families of encryption power TLS, and each is bad at what the other is good at.

**Symmetric encryption** (AES, ChaCha20): both sides share one secret key, used to encrypt and decrypt. It is extremely fast — modern CPUs have AES instructions and push gigabytes per second — but it has a bootstrap problem: how do two machines that have never met agree on a secret key *over the network an attacker is watching*?

**Asymmetric encryption** (elliptic-curve and RSA cryptography): each party has a key *pair*. What one key locks, only the other unlocks; the public key can be handed to anyone, the private key never leaves the server. This solves the bootstrap problem — but it is orders of magnitude slower than symmetric crypto, so nobody encrypts bulk traffic with it.

TLS uses each for what it is good at: **asymmetric crypto to authenticate the server and agree on a fresh shared secret, then symmetric crypto for everything else.** Conceptually, a TLS 1.3 handshake is:

1. **ClientHello.** The phone says: here are the TLS versions and cipher suites I speak, the hostname I want (SNI — this is how one IP serves many HTTPS sites, the TLS-layer cousin of the `Host` header), the HTTP versions I can talk (ALPN), and my half of a key agreement.
2. **ServerHello + Certificate + proof.** The server picks the cipher suite, sends its half of the key agreement, sends its certificate chain, and signs the handshake with its private key — proving it actually *holds* the key matching the certificate.
3. **Verification.** The client checks the signature, validates the certificate chain to a root it trusts (section 3), and checks the name matches. Both sides now independently derive the same symmetric session keys, and application data flows encrypted.

Two properties worth knowing by name: TLS 1.3 does this in **one round trip** (TLS 1.2 needed two — real latency you can feel on mobile), and the key agreement is **ephemeral** (ECDHE), giving *forward secrecy*: session keys are thrown away, so even if someone records your traffic for years and later steals your private key, they still cannot decrypt the recordings.

## 3. Certificates and the chain of trust

The handshake above hinges on one object: the **X.509 certificate**. Strip the mystique and a certificate is a small signed document saying: *"This public key belongs to these domain names, from date A to date B — signed, someone you trust."* Inside you'll find:

- **Subject** — who the certificate is for (`CN=api.tickethub.example`).
- **Subject Alternative Names (SANs)** — the list of hostnames the certificate is valid for. This is the field browsers actually match against the URL; the CN alone stopped being sufficient years ago.
- **Validity** — `notBefore` / `notAfter`. Let's Encrypt certificates live 90 days.
- **Issuer** — who signed it.
- **The public key**, and the issuer's **signature** over the whole document.

Who is "someone you trust"? Your OS and browser ship with a **trust store**: a few hundred root certificates belonging to Certificate Authorities (CAs) that have passed audits and are accountable to browser/OS root programs — that is the entire, slightly anticlimactic answer to "why does my phone trust anyone at all." Roots are too precious to use daily (their private keys live in offline hardware), so CAs sign **intermediate** certificates, which sign **leaf** certificates like yours. Validation walks the chain: your leaf is signed by `R11` (a Let's Encrypt intermediate), `R11` is signed by `ISRG Root X1`, and `ISRG Root X1` is in the phone's trust store. Chain complete, identity proven.

One operational consequence you will hit in real life: **the server must send the leaf *and* the intermediates** (that's the `fullchain.pem` file certbot produces). Clients only have roots pre-installed. Serve just the leaf and some clients limp along (browsers cache or fetch missing intermediates) while `curl`, PHP and mobile SDKs fail with verification errors — the classic "works in Chrome, fails in production code" certificate bug.

Certificate shapes and tiers, honestly:

- **Single-name vs multi-SAN vs wildcard.** One cert can cover several explicit names (`api.tickethub.example`, `tickethub.example`, `www.tickethub.example`) — that's multi-SAN, and certbot builds it from repeated `-d` flags. A **wildcard** (`*.tickethub.example`) covers any *single* label at one level — `api.` yes, `a.b.tickethub.example` no, and not the bare apex — and can only be issued via the DNS-01 challenge (section 4).
- **DV / OV / EV.** Domain Validation proves control of the domain, is fully automatable, and is what Let's Encrypt issues. Organization and Extended Validation add human vetting of a legal entity, cost real money — and give **no cryptographic advantage and no browser UI advantage** (the EV "green bar" was removed years ago). The honest guidance: DV is what most production APIs run, including very large ones. Buy OV/EV only when a compliance regime or enterprise customer contractually demands it.

## 4. Let's Encrypt and the ACME protocol

Before 2015, certificates cost money and were installed by hand once a year — which is precisely why "the cert expired" became a legendary outage class. Let's Encrypt made certificates free and, more importantly, made issuance a *protocol* — **ACME** — so machines do it without humans. The 90-day lifetime is a deliberate design decision: short enough that manual renewal is impractical, forcing you to automate, and shrinking the window in which a stolen key is useful.

ACME's core is proving control of an identifier. Two challenge types matter:

**HTTP-01.** The CA gives your ACME client a token; the client must serve a derived value at `http://api.tickethub.example/.well-known/acme-challenge/<token>`, and Let's Encrypt fetches it — **over port 80, from multiple vantage points on the public internet, using public DNS**. Three operational facts fall straight out of that sentence: port 80 must be reachable (your `/etc/hosts` tricks are invisible to their validators), it must *stay* reachable forever because renewal repeats the challenge every ~60 days, and you can't get certificates this way for internal hosts the internet can't reach. This is the challenge certbot's nginx plugin uses — it answers the challenge from within your running nginx via a temporary config, so nothing in your site needs to change.

**DNS-01.** Instead of serving a file, you publish the token as a TXT record at `_acme-challenge.tickethub.example`. Proving DNS control is stronger and more flexible: it works for machines with no public exposure, and it is the **only** challenge that can issue wildcards. The cost is automation: for renewal to be unattended, certbot needs API credentials for your DNS provider (via a DNS plugin) so it can create and remove TXT records itself.

Let's Encrypt also enforces rate limits (for example, five duplicate certificates per week) and offers a **staging environment** for experiments. Every `certbot` invocation you're unsure about should be tried with `--dry-run` first; getting rate-limited while firefighting is self-inflicted misery.

## 5. Where TLS terminates

"Termination" means: the point where TLS is decrypted and traffic becomes plaintext. Today that point is nginx on your VPS — which is also the origin, so the plaintext never touches a wire. From Module 8, an AWS Application Load Balancer will terminate TLS at the edge of the VPC instead, and you inherit a decision:

- **Terminate at the LB, plain HTTP to the app tier.** Simple, one place to manage certificates, and the LB gets the plaintext it needs for L7 routing anyway. Acceptable when the LB→app network is genuinely private (VPC, security groups); this is the most common setup.
- **Terminate and re-encrypt.** The LB decrypts (it must, to route), then opens a *new* TLS connection to the app tier. More moving parts, but no plaintext on any wire — the posture zero-trust environments require.
- **End-to-end passthrough (L4).** The LB never decrypts, just forwards TCP. Maximum secrecy, but you lose every L7 feature: path routing, header injection, per-request metrics.

You don't need to choose today. What you must carry forward is the question — *"where does TLS end, and what does the traffic look like after that point?"* — because it changes what `X-Forwarded-Proto` means in [Lecture 3.4](04-reverse-proxies-load-balancing.md) and how the ALB is configured in Module 8.

## Hands-on with TicketHub

Goal: nginx installed, a placeholder page for `api.tickethub.example`, a real certificate, automatic renewal proven. You need the DNS `A` record from Lecture 3.1 pointing `api.<your-domain>` at your VPS — verify before starting, because Let's Encrypt will do exactly this lookup:

```
$ dig +short api.tickethub.example
203.0.113.10
```

### Step 1 — Install nginx

Ubuntu 24.04's own repository carries nginx 1.24; the course pins 1.26+ (stable), so add the well-maintained `ondrej/nginx` PPA — the same maintainer whose PHP PPA we'll use next lecture:

```
$ sudo add-apt-repository ppa:ondrej/nginx
$ sudo apt update && sudo apt install -y nginx
$ nginx -v
nginx version: nginx/1.26.3
$ systemctl status nginx --no-pager | head -3
● nginx.service - A high performance web server and a reverse proxy server
     Loaded: loaded (/usr/lib/systemd/system/nginx.service; enabled; preset: enabled)
     Active: active (running)
```

ufw already allows 80/443 from Module 2 (`sudo ufw status` to confirm). From your laptop, `curl -I http://203.0.113.10` now returns `200 OK` with the default nginx page — the port-80 "connection refused" from last lecture is gone.

### Step 2 — A server block for the API hostname

Give the API hostname its own server block with a placeholder root (the real Laravel root replaces it next lecture). Create `/etc/nginx/sites-available/tickethub`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name api.tickethub.example;

    root /var/www/html;
    index index.html;
}
```

```
$ echo 'TicketHub API — coming soon' | sudo tee /var/www/html/index.html
$ sudo ln -s /etc/nginx/sites-available/tickethub /etc/nginx/sites-enabled/
$ sudo nginx -t
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
$ sudo systemctl reload nginx
```

`nginx -t` before every reload is a lifelong habit, not a suggestion — reload with a broken config and nginx keeps running the old one, but a later *restart* (or reboot) will fail at the worst possible moment. Verify virtual hosting is working: `curl http://api.tickethub.example` returns the placeholder, proving nginx matched the `Host` header to your `server_name`.

### Step 3 — Issue the certificate

Install certbot with its nginx plugin from Ubuntu's repos, then run it:

```
$ sudo apt install -y certbot python3-certbot-nginx
$ sudo certbot --nginx -d api.tickethub.example
Saving debug log to /var/log/letsencrypt/letsencrypt.log
Enter email address (used for urgent renewal and security notices): ops@tickethub.example
Please read the Terms of Service ... (Y)es/(N)o: Y
Account registered.
Requesting a certificate for api.tickethub.example

Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/api.tickethub.example/fullchain.pem
Key is saved at:         /etc/letsencrypt/live/api.tickethub.example/privkey.pem
This certificate expires on 2026-11-07.
These files will be updated when the certificate renews.
Certbot has set up a scheduled task to automatically renew this certificate in the background.

Deploying certificate
Successfully deployed certificate for api.tickethub.example to /etc/nginx/sites-enabled/tickethub
Congratulations! You have successfully enabled HTTPS on https://api.tickethub.example
```

In those few seconds: certbot generated a key pair on your VPS, asked Let's Encrypt for a certificate, answered an HTTP-01 challenge through your running nginx, received the signed certificate — and rewrote your server block.

### Step 4 — Read what certbot changed

Open `/etc/nginx/sites-available/tickethub` again:

```nginx
server {
    server_name api.tickethub.example;

    root /var/www/html;
    index index.html;

    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/api.tickethub.example/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/api.tickethub.example/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}
server {
    if ($host = api.tickethub.example) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    listen [::]:80;
    server_name api.tickethub.example;
    return 404; # managed by Certbot
}
```

Line by line: your server block now listens on 443 with `ssl`; `ssl_certificate` points at **fullchain** (leaf + intermediate — section 3 explained why never just the leaf); the private key sits in `/etc/letsencrypt/live/...` (root-readable only — check with `sudo ls -l`); and the included `options-ssl-nginx.conf` carries the protocol and cipher policy:

```
$ grep -E 'ssl_(protocols|prefer|session_tickets)' /etc/letsencrypt/options-ssl-nginx.conf
ssl_session_tickets off;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
```

That matches the **Mozilla "intermediate" profile** — the industry-reference TLS configuration (see ssl-config.mozilla.org): TLS 1.2 + 1.3 only, modern AEAD cipher suites, client preference order. This is the correct amount of cipher tuning for you to do, which is to say: none by hand. Crypto guidance ages badly; track a maintained profile instead of copying decade-old blog posts.

The second server block is the **HTTP→HTTPS redirect**: port 80 now exists only to `301` visitors to HTTPS — and, invisibly, to answer future ACME challenges. This is exactly why port 80 stays open forever on an "HTTPS-only" server.

Confirm both behaviors from your laptop:

```
$ curl -I http://api.tickethub.example
HTTP/1.1 301 Moved Permanently
Location: https://api.tickethub.example/
$ curl -s https://api.tickethub.example
TicketHub API — coming soon
```

### Step 5 — Prove renewal will work

Certbot's Ubuntu package installs a systemd timer (Module 2 taught you these) that runs `certbot -q renew` twice daily; certbot renews any certificate with fewer than 30 days left and reloads nginx through the same plugin that issued it:

```
$ systemctl list-timers certbot.timer --no-pager
NEXT                        LEFT      LAST                        PASSED   UNIT          ACTIVATES
Sun 2026-08-09 23:41:12 UTC 8h left   Sun 2026-08-09 11:02:45 UTC 4h ago   certbot.timer certbot.service
```

A timer *existing* is not evidence renewal *works* — the challenge path can rot (firewall changes, config drift, DNS moves) while the timer fires green for weeks because nothing is due yet. Rehearse the real thing against Let's Encrypt's staging environment:

```
$ sudo certbot renew --dry-run
Processing /etc/letsencrypt/renewal/api.tickethub.example.conf
Simulating renewal of an existing certificate for api.tickethub.example

Congratulations, all simulated renewals succeeded:
  /etc/letsencrypt/live/api.tickethub.example/fullchain.pem (success)
```

Run that dry-run after **any** change to nginx, ufw, or DNS. Expired certificates remain a top-3 embarrassing outage across the industry — not because renewal is hard, but because it fails *silently* and nobody is watching. Watching looks like this — check expiry from the outside, the way clients see it:

```
$ echo | openssl s_client -connect api.tickethub.example:443 -servername api.tickethub.example 2>/dev/null \
    | openssl x509 -noout -subject -issuer -dates
subject=CN=api.tickethub.example
issuer=C=US, O=Let's Encrypt, CN=R11
notBefore=Aug  9 10:31:04 2026 GMT
notAfter=Nov  7 10:31:03 2026 GMT
```

(`-servername` sets SNI so a multi-site server presents the right certificate.) An alertable one-liner — nonzero exit if the cert dies within 14 days:

```
$ echo | openssl s_client -connect api.tickethub.example:443 -servername api.tickethub.example 2>/dev/null \
    | openssl x509 -noout -checkend 1209600 || echo 'WARN: certificate expires within 14 days'
Certificate will not expire
```

Fourteen days, not one: renewal attempts start at 30 days out, so an alert at 14 means renewal has already been failing for ~16 days — plenty of margin to fix it calmly. In Module 12 this check becomes a proper blackbox-exporter probe with paging; until then, this line in a daily cron is infinitely better than nothing. Finish with the outside-in audit: run your hostname through **SSL Labs** (ssllabs.com/ssltest) — expect an A with this configuration, and read the report; it's a free TLS education.

### Step 6 — HSTS, carefully

One header remains between you and "browsers never even try HTTP": **HSTS**. `Strict-Transport-Security: max-age=N` tells a browser: for the next N seconds, upgrade every request to this host to HTTPS internally — no 301 round trip, no SSL-stripping window. The caution: browsers *remember*. Ship a year-long `max-age` with a broken HTTPS setup and you cannot take it back; users' browsers will refuse HTTP for a year. So ramp. Add inside the 443 server block:

```nginx
add_header Strict-Transport-Security "max-age=300" always;
```

Reload, verify with `curl -sI https://api.tickethub.example | grep -i strict`, live with it for a week, then raise to `max-age=31536000`. Two escalations to treat with respect: `includeSubDomains` commits *every* subdomain — present and future — to HTTPS (fine for us; fatal for orgs with forgotten http-only internal tools), and `preload` submits you to a list hard-coded into browsers, from which removal takes months. Skip preload in this course.

## Real-world best practices

- **Automation is the product; the certificate is a byproduct.** The 90-day lifetime exists to make manual cert handling impossible. If any step of issue→install→reload involves a human copying files, you have built a future outage. Certbot + timer is the minimum bar; Modules 8 and 11 move this to ACM and cert-manager, same principle.
- **Monitor expiry from outside the box, and alert at 14 days.** An external probe validates what clients actually receive — catching broken renewal, a forgotten SAN, and "wrong cert served after a config change" with one check. On-box checks miss the last two.
- **Track a maintained TLS profile (Mozilla intermediate) instead of hand-tuning ciphers.** Teams that hand-tune either break old clients chasing an A+ or ossify into insecurity. The certbot-shipped options file is that profile; leave it alone and update the package.
- **Port 80 stays open forever: redirect + ACME, never content.** Closing it breaks HTTP-01 renewal and strands every http:// link ever shared. Serving real content on it undermines HSTS.
- **Rehearse renewal after every infra change** (`certbot renew --dry-run`) and do experiments against staging. Rate-limit lockouts (5 duplicate certs/week) always happen at the worst time otherwise.
- **DV certificates are professionally sufficient.** Spend the OV/EV budget on monitoring instead, unless a contract or regulator says otherwise — that is where the actual risk reduction lives.

## Common pitfalls

1. **Closing port 80 "because we're HTTPS-only now."** It feels like hardening, and everything keeps working — for up to 60 days, until the first real renewal silently fails, and 30 days later the certificate expires in production. Keep 80 open, serving only the 301 and ACME challenges; that *is* the hardened configuration.
2. **Serving `cert.pem` instead of `fullchain.pem`.** Browsers paper over the missing intermediate, so the site "works" — then `curl`, PHP HTTP clients and mobile apps fail certificate verification and you debug everything except the server. Always configure fullchain; verify with `openssl s_client` and confirm the chain shows both leaf and intermediate.
3. **Assuming the renewal timer working equals renewal working.** The timer fires and exits 0 even when no cert is due, so dashboards stay green while the challenge path is broken. Prove the path with `--dry-run` after changes, and let the external expiry alert be the backstop.
4. **Copying TLS config from old blog posts.** They surface confidently in search results, complete with TLS 1.0 and RC4. Cryptography advice has a shelf life; take configuration only from the Mozilla generator or the maintained certbot include, and note the generated-on date.
5. **Going straight to `max-age=31536000; includeSubDomains; preload` on day one.** It scores points on hardening checklists, and it is nearly irreversible: one http-only subdomain (staging tools, internal dashboards) becomes unreachable for every prior visitor, and preload removal takes months. Ramp max-age 300 → 1 week → 1 year, add `includeSubDomains` only after auditing every subdomain, and treat `preload` as a one-way door.

## Exercises

1. Dump your live certificate with `sudo openssl x509 -text -noout -in /etc/letsencrypt/live/api.tickethub.example/cert.pem`. Identify subject, SAN list, issuer, validity window and signature algorithm — and name the field browsers actually match against the URL.
2. Run `openssl s_client -connect api.tickethub.example:443 -servername api.tickethub.example </dev/null` and read the `Certificate chain` section. Which certificates does your server send, which one does the client supply, and where does the client get it from?
3. Break renewal on purpose: `sudo ufw deny 80/tcp`, then `sudo certbot renew --dry-run`. Read the exact error, explain it in one sentence, fix the rule (`sudo ufw allow 80/tcp`), and prove recovery with a clean dry-run.
4. Put the 14-day `-checkend` one-liner into a script at `/usr/local/bin/check-cert-expiry`, run it from a daily systemd timer (Module 2 skills), and test the failure path by temporarily checking against `-checkend 15552000` (180 days — guaranteed to "fail").
5. **Stretch:** issue a wildcard for `*.tickethub.example` using the manual DNS-01 flow: `sudo certbot certonly --manual --preferred-challenges dns -d '*.tickethub.example'`. Create the `_acme-challenge` TXT record it demands, verify it with `dig TXT`, and complete issuance. Then explain (a) why HTTP-01 fundamentally cannot issue this certificate and (b) why this manual certificate cannot auto-renew — and what kind of certbot plugin fixes that.

## What's next

Your VPS now speaks HTTPS with a certificate that renews itself — but behind the padlock is a static placeholder page. The next lecture is the heart of this module: installing PHP 8.4 FPM, MySQL and Redis, understanding exactly how nginx hands requests to PHP workers, tuning the pool so an on-sale spike degrades gracefully instead of collapsing, and deploying the actual TicketHub Laravel application into `/var/www/tickethub`. Continue to [Lecture 3.3 — Nginx + PHP-FPM: Serving Laravel by Hand](03-nginx-php-fpm-laravel.md).
