# Module 3 — Networking & Web Servers

**Level: Beginner → Intermediate**

This is the module where TicketHub goes live. Module 2 left you with a hardened Ubuntu 24.04 VPS running nothing but SSH; by the end of this module it serves the TicketHub API at `https://api.tickethub.example` — Nginx and PHP-FPM in front, MySQL and Redis behind, TLS certificates that renew themselves, and the whole stack deployed by a deliberately naive `git pull`. That deploy will feel fragile. It is meant to: the pain you accumulate here is the justification for almost every tool in the rest of the course.

Along the way you build the mental models that make later modules legible instead of magical: what a request physically is (IP, TCP, DNS, HTTP), what a certificate proves and how it renews unattended, how nginx's event loop and PHP-FPM's worker pool share the load — including the arithmetic that keeps an on-sale from melting the box — and what a load balancer changes about the world your Laravel app believes in. You will cause your own 502s, forge your own headers, and fix both.

## Prerequisites

- Modules 1–2 completed: the TicketHub context, plus the hardened VPS with the `deploy` user, ufw allowing 22/80/443, and working systemd/journald skills
- A domain you control (the lectures write `tickethub.example`; substitute your own) with access to its DNS records
- Your laptop with `curl`, `dig` and `git`; PHP 8.4 + Composer for local work

## Lectures

1. [How the Web Works](01-how-the-web-works.md) — IP addresses and private ranges, TCP/UDP, ports and listening, DNS from resolver to authority, HTTP anatomy and the status codes that page you, plus the ping → dig → curl → ss troubleshooting ladder.
2. [TLS & Certificates](02-tls-and-certificates.md) — what HTTPS actually guarantees, chains of trust, Let's Encrypt and ACME challenges, certbot with auto-renewal on the VPS, HSTS without self-injury, and monitoring expiry so certificates never surprise you.
3. [Nginx + PHP-FPM: Serving Laravel by Hand](03-nginx-php-fpm-laravel.md) — the flagship: the full request path, installing the PHP 8.4/MySQL/Redis stack, sizing `pm.max_children` from measurements, a line-by-line production server block and php.ini, and deploying TicketHub end to end.
4. [Reverse Proxies & Load Balancing](04-reverse-proxies-load-balancing.md) — forward vs reverse proxies, the `X-Forwarded-*` trust problem and Laravel 12's fix, balancing algorithms and L4/L7, shallow vs deep health checks, the statefulness traps of a second server, and a complete nginx balancer config.

## After this module you can…

- Diagnose "the site is down" methodically, isolating DNS, network, TLS, web server, PHP, or application failures with the right tool at each layer
- Issue, install, auto-renew and monitor TLS certificates with Let's Encrypt and certbot
- Configure nginx and PHP-FPM for a Laravel application from a blank server, and defend every line of the config
- Size a PHP-FPM worker pool from measured memory use and predict how it degrades under spike traffic
- Make a Laravel app proxy-ready (trusted proxies, health endpoints) and read or write an nginx load-balancer configuration
- Deploy a Laravel release by hand — and articulate precisely why nobody should keep doing it that way

**Next:** [Module 4 — Git & Collaboration Workflows](../module-04-git-collaboration/)
