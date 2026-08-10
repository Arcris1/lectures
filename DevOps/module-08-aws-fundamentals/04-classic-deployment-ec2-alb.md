# Lecture 8.4 — The Classic Deployment: EC2 + ALB

> **Module 8 — AWS Cloud Fundamentals** · Lecture 4 of 4 · Estimated time: ~120 min

This is the **last manual deployment in the course** — and that's the point. You'll launch two EC2 instances from one bootstrap script, put a real load balancer with real TLS in front of them, and serve `https://api.staging.tickethub.example` from the VPC you built in [8.2](02-vpc-networking.md) against the data tier from [8.3](03-core-services-rds-s3-redis.md). Then you'll do something most tutorials skip: **write down everything that hurt.** That pain audit is the actual deliverable — it becomes Module 9's requirements document, line for line. Along the way, three old promises get kept: Module 1's "Module 8 does access properly", Module 2's bastion, and Module 3.2's open question — *where does TLS end?*

## Learning objectives

- Choose EC2 fundamentals deliberately: Graviton/arm64 AMI, gp3 root volume, IMDSv2-only metadata, and user data as a one-shot bootstrap
- Operate instances with zero open admin ports using SSM Session Manager, and explain why it retires SSH keys and bastions
- Split instance configuration between Parameter Store and Secrets Manager, and write the instance role that reads exactly those and nothing more
- Bootstrap identical app servers from one script: Horizon under systemd, and a scheduler that's safe on N servers via `onOneServer()`
- Front the fleet with an ALB — target groups, `/up` health checks, connection draining, ACM certificates, Route 53 ALIAS records — and verify failover live
- Produce the pain audit: name each manual-deployment failure mode and the module that eliminates it

## 1. EC2 essentials, fast

You know most of EC2 already — it's the VPS from Modules 2–3 with an API. The four decisions that matter:

**AMI.** The Amazon Machine Image is the disk template an instance boots from. We use **Ubuntu 24.04 LTS, arm64** — same OS as the whole course, but on **Graviton** (AWS's ARM CPUs, the `g` in `t4g`): roughly 10–20% cheaper than x86 equivalents with better sustained performance, and PHP runs perfectly on ARM — every `php8.4-*` package and the ondrej PPA publish arm64 builds. Never copy an AMI ID from a blog (they're region-specific and rot); Canonical publishes the current ID in a public SSM parameter you query at launch time.

**Instance type and storage.** `t4g.small` (2 vCPU, 2 GB) per app server — burstable is fine here because 8.3's data tier absorbed the memory-hungry work; two smalls across two AZs beat one medium in one AZ, which is the whole lesson of this module. Root volume: **gp3**, 20 GB, 3,000 IOPS baseline, delete-on-termination.

**IMDSv2, always.** Every instance serves metadata — including its **role credentials** — at `http://169.254.169.254`. IMDSv1 answered plain GETs, which made every SSRF bug in every app a potential credential theft: trick the server into fetching that URL and it hands you AWS keys (this is the mechanism behind the 2019 Capital One breach). **IMDSv2** requires a session token obtained via a `PUT` with a hop-limit-controlled TTL — trivial for the SDK on the box, nearly impossible through an SSRF. `HttpTokens=required` on every launch, no exceptions; you already did it for 8.3's temp instance.

**User data** is a script handed to the instance at launch, executed by cloud-init **once, at first boot**, as root. It's how a blank Ubuntu image becomes a TicketHub app server with nobody typing anything — the closest thing to reproducibility that pre-container deployment offers, and (as the pain audit will note) not nearly close enough. Debugging happens in `/var/log/cloud-init-output.log`.

## 2. Access doctrine: Session Manager, not SSH

Module 2 hardened SSH and promised that production networks put machines behind a **bastion**. AWS lets you keep the bastion's *purpose* — one audited, policy-controlled entry point — and delete the bastion, the SSH keys, and port 22 itself.

**SSM Session Manager** works inside-out: the SSM agent (preinstalled on Ubuntu and Amazon Linux AMIs) makes an *outbound* HTTPS connection to the SSM service and waits. When you run `aws ssm start-session`, your shell is relayed over that existing outbound channel. The consequences are the doctrine:

- **No inbound rules at all.** `sg-app` accepts port 80 from `sg-alb` — and *nothing else*. No port 22 in the entire VPC (8.2 built none, deliberately). There is no key file to leak, rotate, or offboard.
- **Access is IAM, not key possession.** Who may open sessions is a policy question — revoke the IAM permission and access dies instantly, the exact thing SSH keys are terrible at.
- **Every session is in CloudTrail** — who, which instance, when. (Full keystroke logging to CloudWatch/S3 is a config away; Module 12 territory.) Module 1's Marcus-has-the-only-SSH-key problem is structurally gone.

The agent's only requirement is outbound 443 to the SSM endpoints — satisfied by 8.2's NAT. (When Module 9's tasks go NAT-less, interface endpoints for SSM are the private-only alternative 8.2 flagged.)

## 3. The instance's identity and the config split

The app needs AWS powers: write PDFs to S3, send mail via SES, read its own secrets. On a laptop that meant your profile; on EC2 it's an **instance profile** — a role whose temporary credentials the instance fetches from IMDS, auto-rotated, never stored ([8.1](01-cloud-concepts-account-setup.md)'s "roles by default", finally embodied). The role is `tickethub-staging-app`, and its policy is the least-privilege union of what 8.3 previewed: bucket-scoped S3 read/write, identity-scoped SES send, `GetSecretValue` on exactly three secrets, plus `AmazonSSMManagedInstanceCore` for Session Manager and parameter reads.

Configuration itself splits by sensitivity, and the split is policy:

- **SSM Parameter Store** (`/tickethub/staging/env/*`) holds **non-secret config**: hostnames, flags, bucket names — things that would be merely inconvenient on a screen-share. Free at standard tier, versioned, readable by path.
- **Secrets Manager** holds **secrets**: the RDS-managed DB credentials (8.3), the Redis AUTH token (8.3), and — new today — `APP_KEY`. Encrypted with KMS, access-audited, rotatable.

Why does `APP_KEY` graduate to a shared secret? Because there are about to be *two* servers. `APP_KEY` encrypts cookies and anything using Laravel's `encrypt()`; if each instance generated its own at boot, a cookie written by instance A would fail decryption on instance B — an intermittent, load-balancer-shaped bug that costs teams days. One key, generated once, stored once, read by all. This is the first of many "N > 1 changes everything" moments today.

## 4. Bootstrap decisions worth defending

Four choices inside the user-data script deserve explanation before you read it:

**We build on the server — for the last time.** `git clone` + `composer install --no-dev` on every instance is exactly what Modules 6–7 taught you to reject: the artifact isn't built once, it's rebuilt N times, and each build can differ (a dependency patch release an hour apart, a PPA moving). Module 9 deploys the CI-built image from Module 7 instead — this script is the "before" photo.

**`.env` is rendered, not copied.** The script assembles `.env` at boot from Parameter Store + Secrets Manager. No secrets in the AMI, none in user data (user data is readable via `describe-instance-attribute` *and* from IMDS — treat it as public within your account), none in Git — Module 5's hygiene, now with a real backing store.

**Horizon replaces the hand-rolled worker.** Module 2's `tickethub-worker.service` ran a single `queue:work redis` process — one queue lane, manual scaling, no insight. **Horizon** (in the app since Module 5) is Laravel's queue *supervisor*: it spawns and balances worker pools across `default`, `pdfs`, and `mail` per `config/horizon.php`, restarts crashed workers, and exposes per-queue metrics. The migration is small and telling: the new `tickethub-horizon.service` runs `artisan horizon`, and its `ExecStop` runs `horizon:terminate --wait` — workers finish their current job before dying, so a reboot never kills a half-generated PDF. Module 2's unit file retires with the VPS.

**The scheduler now has the N-servers problem.** Both instances run the Module 2 cron entry (`schedule:run` every minute) — remove it from one and that one becomes special, which is drift; keep it on both and `tickethub:send-nightly-sales-reports` runs **twice**, and every organizer gets two emails, nightly, until someone notices. Module 2 named this "the exactly-once problem"; Module 5 pre-positioned the fix by moving the cache to Redis: **`onOneServer()`** takes an atomic lock in the *shared* cache before each task — both schedulers tick, one wins the lock, the other skips. The lock is only as shared as the cache store behind it, which is why this works today and didn't exist before Module 5. `routes/console.php` gains one call per task (hands-on §4). This problem class returns on Kubernetes — Module 11's CronJob is the platform-level answer — but `onOneServer()` stays as belt-and-braces.

## 5. The ALB layer: traffic, health, and TLS

The **Application Load Balancer** is Module 3.4's L7 theory productized: it terminates TLS, sees every request, and balances per-request across a **target group** — the set of backends plus the health-check policy that decides who deserves traffic.

**Health checks, tuned by doctrine.** Module 3.4's rule: *balancers get the shallow check, monitoring gets the deep check.* The target group probes `/up` (Laravel 12's framework-boot check) expecting HTTP 200 — it answers "can *this instance* serve?", which is the only question a balancer should ask. Wire the deep `/api/health` check here and a ten-second RDS blip fails *every* instance *simultaneously* — the balancer ejects all backends and amplifies a hiccup into an outage. Thresholds: interval 15s, healthy after 2 passes, unhealthy after 3 fails — detection in ~45s without flapping on a single slow probe. **Deregistration delay** is nginx's draining (Module 3.4) as a managed feature: a target being removed stops getting *new* requests but keeps its in-flight ones for up to N seconds. Default 300s is tuned for long-poll apps; our API's requests finish in milliseconds, so 30s — deploys and scale-ins get 10× faster for free.

**TLS moves to the edge — the Module 3.2 hand-off.** Since Module 3, certbot on the VPS has renewed `api.tickethub.example`. Staging's cert comes from **ACM** instead: request a public certificate for `api.staging.tickethub.example`, prove domain control via a DNS CNAME (which Route 53 makes a one-command step), and ACM issues — then **renews automatically, forever, as long as the validation record stays in DNS**. No cron, no renewal outage class, and the private key is non-exportable, living only in AWS's TLS frontends — which is also ACM's limitation: it only works on managed frontends like ALB and CloudFront, never on your own nginx. Module 3.2's question — *where does TLS end?* — now has staging's answer: **at the ALB.** Traffic inside the VPC is plain HTTP on port 80, guarded by the security-group chain; the instances' nginx drops its TLS block entirely. The 443 listener gets a **TLS 1.3-capable security policy**, and the 80 listener's only job is a 301 to HTTPS — same redirect nginx served in Module 3, now at the edge.

**Route 53 completes the path.** The hosted zone exists since 8.3; **delegation** is the step that makes it authoritative: at your registrar, replace the domain's NS records with the four `awsdns` servers Route 53 assigned. From that moment the internet asks Route 53 for `*.tickethub.example` (your Module 3 records must be recreated in the zone before you flip — production still points at the VPS). Then `api.staging.tickethub.example` needs to reach the ALB — which has no stable IP, only a DNS name. A CNAME would work here, but the AWS-native answer is an **ALIAS record**: it resolves to the ALB's current IPs *at query time* inside Route 53, works at the zone apex (where CNAMEs are illegal — Module 3.1 flagged this exact limitation), and alias queries to AWS resources are free.

## Hands-on with TicketHub

⚠️ **Cost check — created in this lecture:** 2 × `t4g.small` (~$31/mo), 2 × 20 GB gp3 EBS (~$4/mo), ALB (~$18/mo + LCUs, call it $21), one Secrets Manager secret (~$0.40), ACM and Parameter Store free, Route 53 queries pennies. **Everything is kept for Module 9** (teardown notes at the end). `AWS_PROFILE=tickethub-staging` exported; four tags on everything, abbreviated to `Name` below.

### 1. The instance role

Trust EC2, attach SSM core, then the app policy — 8.3's S3 and SES statements, the three secrets, and path-scoped parameter reads (`AmazonSSMManagedInstanceCore` grants the agent's needs but not `GetParametersByPath`, so we add it, scoped):

```
$ aws iam create-role --role-name tickethub-staging-app \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
      "Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --tags Key=Name,Value=tickethub-staging-app
$ aws iam attach-role-policy --role-name tickethub-staging-app \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
$ aws iam put-role-policy --role-name tickethub-staging-app \
    --policy-name tickethub-staging-app-access --policy-document file://app-policy.json
$ aws iam create-instance-profile --instance-profile-name tickethub-staging-app
$ aws iam add-role-to-instance-profile --instance-profile-name tickethub-staging-app \
    --role-name tickethub-staging-app
```

`app-policy.json`, complete:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "UploadsList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::tickethub-staging-uploads"
    },
    {
      "Sid": "UploadsReadWrite",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::tickethub-staging-uploads/*"
    },
    {
      "Sid": "SendMail",
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "arn:aws:ses:ap-southeast-1:111122223333:identity/tickethub.example"
    },
    {
      "Sid": "ReadAppSecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:rds!db-3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9-AbCdEf",
        "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:tickethub/staging/redis-auth-*",
        "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:tickethub/staging/app-key-*"
      ]
    },
    {
      "Sid": "ReadAppParameters",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParametersByPath"],
      "Resource": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/*"
    }
  ]
}
```

(The `-*` suffixes match Secrets Manager's random ARN endings. All secrets use the AWS-managed KMS key, so no extra `kms:Decrypt` grant is needed.)

### 2. Config into Parameter Store, secrets into Secrets Manager

Non-secret env — one parameter per key, uploaded in a loop (values from 8.3's `.env` contract):

```
$ while IFS='=' read -r k v; do
    aws ssm put-parameter --name "/tickethub/staging/env/$k" \
      --type String --value "$v" --overwrite > /dev/null && echo "  $k"
  done <<'EOF'
APP_NAME=TicketHub
APP_ENV=staging
APP_DEBUG=false
APP_URL=https://api.staging.tickethub.example
LOG_CHANNEL=stderr
LOG_LEVEL=info
DB_CONNECTION=mysql
DB_HOST=tickethub-staging-mysql.c9akciq32rga.ap-southeast-1.rds.amazonaws.com
DB_PORT=3306
DB_DATABASE=tickethub
SESSION_DRIVER=redis
CACHE_STORE=redis
QUEUE_CONNECTION=redis
REDIS_CLIENT=phpredis
REDIS_HOST=tickethub-staging-redis.x1y2z3.ng.0001.apse1.cache.amazonaws.com
REDIS_PORT=6379
REDIS_SCHEME=tls
REDIS_QUEUE_RETRY_AFTER=180
FILESYSTEM_DISK=s3
AWS_BUCKET=tickethub-staging-uploads
AWS_DEFAULT_REGION=ap-southeast-1
MAIL_MAILER=ses
MAIL_FROM_ADDRESS=tickets@tickethub.example
EOF
```

The DB secret's ARN becomes a parameter too (so the boot script never hardcodes it), and `APP_KEY` — generated once, on your laptop — becomes the third secret:

```
$ aws ssm put-parameter --name /tickethub/staging/db-secret-arn --type String \
    --value 'arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:rds!db-3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9-AbCdEf'
$ aws secretsmanager create-secret --name tickethub/staging/app-key \
    --secret-string "$(php artisan key:generate --show)" --query 'ARN'
"arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:tickethub/staging/app-key-Qw7RtY"
```

### 3. The bootstrap script, in full

Save as `user-data.sh`. Read it top to bottom — every block is a Module 2–5 skill executing unattended:

```bash
#!/usr/bin/env bash
# TicketHub staging app server bootstrap (Lecture 8.4).
# Runs ONCE at first boot via cloud-init, as root.
# Progress/log: /var/log/cloud-init-output.log
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive COMPOSER_ALLOW_SUPERUSER=1

REGION="ap-southeast-1"
PREFIX="/tickethub/staging"
APP_DIR="/var/www/tickethub"

# --- 1. The stack: nginx + PHP 8.4 via ondrej PPA (Module 3's package list)
add-apt-repository -y ppa:ondrej/php
apt-get update -q
apt-get install -yq --no-install-recommends nginx composer git jq unzip \
  php8.4-fpm php8.4-cli php8.4-mysql php8.4-redis php8.4-mbstring php8.4-xml \
  php8.4-curl php8.4-zip php8.4-intl php8.4-gd php8.4-bcmath php8.4-opcache

# AWS CLI v2 (arm64) — the boot script's own tool for params/secrets
curl -s https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install

# --- 2. Application code — THE LAST TIME WE BUILD ON A SERVER.
# Module 9 ships the CI-built image from Module 7 instead of rebuilding here.
# (Public repo assumed; a private repo needs a read-only deploy token — one more secret.)
git clone --depth 1 --branch main https://github.com/tickethub/tickethub-api.git "$APP_DIR"
cd "$APP_DIR"
composer install --no-dev --prefer-dist --optimize-autoloader --no-interaction

# --- 3. Render .env: Parameter Store (config) + Secrets Manager (secrets)
aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX/env/" \
  --query 'Parameters[].[Name,Value]' --output text |
  while read -r name value; do printf '%s=%s\n' "${name##*/}" "$value"; done > .env

DB_SECRET_ARN=$(aws ssm get-parameter --region "$REGION" \
  --name "$PREFIX/db-secret-arn" --query 'Parameter.Value' --output text)
DB_JSON=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$DB_SECRET_ARN" --query 'SecretString' --output text)
{
  printf 'APP_KEY=%s\n' "$(aws secretsmanager get-secret-value --region "$REGION" \
      --secret-id tickethub/staging/app-key --query 'SecretString' --output text)"
  printf 'DB_USERNAME=%s\n' "$(jq -r .username <<<"$DB_JSON")"
  printf 'DB_PASSWORD=%s\n' "$(jq -r .password <<<"$DB_JSON")"
  printf 'REDIS_PASSWORD=%s\n' "$(aws secretsmanager get-secret-value --region "$REGION" \
      --secret-id tickethub/staging/redis-auth --query 'SecretString' --output text)"
} >> .env

chown -R www-data:www-data "$APP_DIR"
chmod 640 "$APP_DIR/.env"
sudo -u www-data php artisan config:cache
sudo -u www-data php artisan route:cache
# NOTE: no `artisan migrate` here — migrations ran once in 8.3 and are a
# deploy-time concern (Module 9), not a per-instance boot concern.

# --- 4. PHP-FPM pool sized for t4g.small (Module 3's arithmetic, 2 GB box,
# no local MySQL/Redis to reserve for anymore):
# 2048 MB − ~400 (OS + nginx + agents) ≈ 1650 for PHP; ÷ ~80 MB/worker ≈ 20
sed -ri \
  -e 's/^pm\.max_children = .*/pm.max_children = 20/' \
  -e 's/^pm\.start_servers = .*/pm.start_servers = 6/' \
  -e 's/^pm\.min_spare_servers = .*/pm.min_spare_servers = 4/' \
  -e 's/^pm\.max_spare_servers = .*/pm.max_spare_servers = 8/' \
  -e 's/^;?request_terminate_timeout = .*/request_terminate_timeout = 30s/' \
  /etc/php/8.4/fpm/pool.d/www.conf

cat > /etc/php/8.4/fpm/conf.d/99-tickethub.ini <<'INI'
; Module 3 §6 production overrides
expose_php = Off
display_errors = Off
log_errors = On
memory_limit = 256M
upload_max_filesize = 8M
post_max_size = 10M
INI
systemctl reload php8.4-fpm

# --- 5. nginx: Module 3's server block minus TLS — the ALB terminates now
cat > /etc/nginx/sites-available/tickethub <<'NGINX'
server {
    listen 80 default_server;
    server_name api.staging.tickethub.example;

    root /var/www/tickethub/public;
    index index.php;

    access_log /var/log/nginx/tickethub.access.log;
    error_log  /var/log/nginx/tickethub.error.log;

    client_max_body_size 10m;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Served-By $hostname always;   # Lecture 8.4 demo: which instance answered

    gzip on;
    gzip_types application/json application/vnd.api+json text/plain text/css application/javascript;
    gzip_min_length 1024;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass unix:/run/php/php8.4-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        fastcgi_hide_header X-Powered-By;
    }

    location ~ /\.(?!well-known) {
        deny all;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/tickethub /etc/nginx/sites-enabled/tickethub
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# --- 6. Horizon under systemd — supersedes Module 2's tickethub-worker.service
cat > /etc/systemd/system/tickethub-horizon.service <<'UNIT'
[Unit]
Description=TicketHub Horizon (queue worker supervisor)
After=network-online.target
Wants=network-online.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/var/www/tickethub
ExecStart=/usr/bin/php /var/www/tickethub/artisan horizon
ExecStop=/usr/bin/php /var/www/tickethub/artisan horizon:terminate --wait
Restart=always
RestartSec=3
TimeoutStopSec=150

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now tickethub-horizon

# --- 7. Scheduler tick — Module 2's cron entry, safety comes from onOneServer()
echo '* * * * * cd /var/www/tickethub && php artisan schedule:run >> /dev/null 2>&1' \
  | crontab -u www-data -

# --- 8. Smoke test
curl -sf http://localhost/up > /dev/null && echo "BOOTSTRAP OK"
```

`TimeoutStopSec=150` gives `horizon:terminate --wait` room to drain the longest job (120s timeout, Module 5) before systemd loses patience. Note what the script *doesn't* contain: not one secret, not one hostname — all fetched by role at boot.

### 4. The scheduler change — one line per task

In `routes/console.php`, before launching anything:

```php
use Illuminate\Support\Facades\Schedule;

Schedule::command('tickethub:expire-reservations')
    ->everyMinute()
    ->withoutOverlapping()
    ->onOneServer();

Schedule::command('tickethub:send-nightly-sales-reports')
    ->dailyAt('02:00')
    ->onOneServer();
```

`withoutOverlapping()` (already there since Module 1) stops a slow run stacking on the next tick *on one box*; `onOneServer()` stops two boxes running the same tick — different problems, both locks living in the shared Redis cache. Commit and push: the instances clone `main` at boot.

### 5. Launch the pair

Same AMI, same user data, different subnet per AZ — "identical" servers (the quotes are the pain audit's item 1):

```
$ AMI=$(aws ssm get-parameters --names \
    /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
    --query 'Parameters[0].Value' --output text)
$ aws ec2 run-instances --image-id $AMI --instance-type t4g.small \
    --subnet-id subnet-0e4d9f306c1ba5003 \
    --security-group-ids sg-0e2d8b0c1f3a40002 \
    --iam-instance-profile Name=tickethub-staging-app \
    --metadata-options HttpTokens=required \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' \
    --user-data file://user-data.sh \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=tickethub-staging-app-a}]' \
    --query 'Instances[0].{Id:InstanceId,Ip:PrivateIpAddress,Az:Placement.AvailabilityZone}'
{ "Id": "i-0aa11bb22cc33dd44", "Ip": "10.1.34.27", "Az": "ap-southeast-1a" }
$ aws ec2 run-instances ... --subnet-id subnet-0f5e0a417d2cb6004 \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=tickethub-staging-app-b}]' ...
{ "Id": "i-0ee55ff66aa77bb88", "Ip": "10.1.49.31", "Az": "ap-southeast-1b" }
```

Bootstrap takes 5–10 minutes (feel that — it's pain-audit item 4). Verify one over SSM — no key, no port, straight into an audited shell:

```
$ aws ssm start-session --target i-0aa11bb22cc33dd44
Starting session with SessionId: alice-0311aa22bb33cc44d
$ tail -2 /var/log/cloud-init-output.log
BOOTSTRAP OK
Cloud-init v. 24.1 finished
$ systemctl is-active nginx php8.4-fpm tickethub-horizon
active
active
active
$ exit
```

And prove the audit trail: `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=StartSession` names you, the instance, and the timestamp.

### 6. Target group and ALB

```
$ aws elbv2 create-target-group --name tickethub-staging-tg \
    --protocol HTTP --port 80 --vpc-id vpc-0a1b2c3d4e5f67890 \
    --target-type instance \
    --health-check-path /up --health-check-interval-seconds 15 \
    --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
    --matcher HttpCode=200 \
    --query 'TargetGroups[0].TargetGroupArn'
"arn:aws:elasticloadbalancing:ap-southeast-1:111122223333:targetgroup/tickethub-staging-tg/73e2d6bc24d8a067"
$ aws elbv2 modify-target-group-attributes \
    --target-group-arn arn:aws:elasticloadbalancing:...:targetgroup/tickethub-staging-tg/73e2d6bc24d8a067 \
    --attributes Key=deregistration_delay.timeout_seconds,Value=30
$ aws elbv2 register-targets \
    --target-group-arn arn:aws:elasticloadbalancing:...:targetgroup/tickethub-staging-tg/73e2d6bc24d8a067 \
    --targets Id=i-0aa11bb22cc33dd44 Id=i-0ee55ff66aa77bb88
$ aws elbv2 create-load-balancer --name tickethub-staging-alb \
    --type application --scheme internet-facing \
    --subnets subnet-0c2b7d1e4a9f83001 subnet-0d3c8e2f5b0a94002 \
    --security-groups sg-0f3a9c1d2e4b50001 \
    --tags Key=Name,Value=tickethub-staging-alb \
    --query 'LoadBalancers[0].{Arn:LoadBalancerArn,Dns:DNSName}'
{
    "Arn": "arn:aws:elasticloadbalancing:ap-southeast-1:111122223333:loadbalancer/app/tickethub-staging-alb/50dc6c495c0c9188",
    "Dns": "tickethub-staging-alb-1234567890.ap-southeast-1.elb.amazonaws.com"
}
```

Public subnets from 8.2 (the ALB places a node in each), `sg-alb` at the edge — the 8.2 chain is now fully populated: internet → `sg-alb` → `sg-app` → `sg-mysql`/`sg-redis`.

### 7. The certificate

```
$ aws acm request-certificate --domain-name api.staging.tickethub.example \
    --validation-method DNS --query 'CertificateArn'
"arn:aws:acm:ap-southeast-1:111122223333:certificate/12345678-1234-1234-1234-123456789012"
$ aws acm describe-certificate --certificate-arn arn:aws:acm:...:certificate/12345678-... \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
{
    "Name": "_a79865eb4cd1a6ab990a45779b4e0b96.api.staging.tickethub.example.",
    "Type": "CNAME",
    "Value": "_424c7224e9b0146f9a8808af955727d0.acm-validations.aws."
}
$ aws route53 change-resource-record-sets --hosted-zone-id Z0413857YT73GHIJKLMN \
    --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{
      "Name":"_a79865eb4cd1a6ab990a45779b4e0b96.api.staging.tickethub.example.","Type":"CNAME","TTL":300,
      "ResourceRecords":[{"Value":"_424c7224e9b0146f9a8808af955727d0.acm-validations.aws."}]}}]}'
$ aws acm wait certificate-validated --certificate-arn arn:aws:acm:...:certificate/12345678-...
```

This requires **delegation to be live**: at your registrar, the domain's NS records must point at the four `awsdns` servers from 8.3 (`dig NS tickethub.example` should return them). Once validated, that CNAME must *stay* — it's how ACM re-proves control at every renewal. Delete it and the cert silently fails to renew a year later: the modern equivalent of the expired-certbot page.

### 8. Listeners: 443 forwards, 80 redirects

```
$ aws elbv2 create-listener \
    --load-balancer-arn arn:aws:elasticloadbalancing:...:loadbalancer/app/tickethub-staging-alb/50dc6c495c0c9188 \
    --protocol HTTPS --port 443 \
    --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
    --certificates CertificateArn=arn:aws:acm:...:certificate/12345678-... \
    --default-actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:...:targetgroup/tickethub-staging-tg/73e2d6bc24d8a067
$ aws elbv2 create-listener \
    --load-balancer-arn arn:aws:elasticloadbalancing:...:loadbalancer/app/tickethub-staging-alb/50dc6c495c0c9188 \
    --protocol HTTP --port 80 \
    --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}'
```

### 9. The ALIAS record

```
$ aws route53 change-resource-record-sets --hosted-zone-id Z0413857YT73GHIJKLMN \
    --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{
      "Name":"api.staging.tickethub.example","Type":"A",
      "AliasTarget":{"HostedZoneId":"Z1LMS91P8CMLE5",
        "DNSName":"tickethub-staging-alb-1234567890.ap-southeast-1.elb.amazonaws.com",
        "EvaluateTargetHealth":false}}}]}'
```

(`Z1LMS91P8CMLE5` is the fixed hosted-zone ID for all ALBs in `ap-southeast-1` — an AWS constant, not yours.) One Laravel loose end from Module 3.4: `bootstrap/app.php` trusted proxies at `10.0.0.0/16` — prod's VPC. Add staging's so the ALB's `X-Forwarded-For`/`-Proto` headers are believed (otherwise `url()` generates `http://` links and rate-limiting keys on ALB node IPs):

```php
$middleware->trustProxies(at: [
    '10.0.0.0/16',   // production VPC (Module 3.4)
    '10.1.0.0/16',   // staging VPC — the ALB nodes live here
]);
```

### 10. Verify end to end — then break something

```
$ curl -sv https://api.staging.tickethub.example/up -o /dev/null 2>&1 | grep -E 'SSL connection|issuer|HTTP/'
* SSL connection using TLSv1.3 / TLS_AES_128_GCM_SHA256
*  issuer: C=US; O=Amazon; CN=Amazon RSA 2048 M03
< HTTP/2 200
$ curl -sI http://api.staging.tickethub.example/up | head -2
HTTP/1.1 301 Moved Permanently
location: https://api.staging.tickethub.example:443/up
$ for i in {1..6}; do curl -s -D- -o /dev/null https://api.staging.tickethub.example/up \
    | grep -i x-served-by; done
x-served-by: ip-10-1-34-27
x-served-by: ip-10-1-49-31
x-served-by: ip-10-1-34-27
x-served-by: ip-10-1-49-31
x-served-by: ip-10-1-34-27
x-served-by: ip-10-1-49-31
```

Two AZs, round-robin, one URL — Module 3.4's diagrams, live. Now kill a backend *without logging in*: SSM Run Command stops nginx on instance B:

```
$ aws ssm send-command --instance-ids i-0ee55ff66aa77bb88 \
    --document-name AWS-RunShellScript \
    --parameters 'commands=["systemctl stop nginx"]' --query 'Command.CommandId'
"7f2c1b3a-9d8e-4f5a-b6c7-d8e9f0a1b2c3"
```

~45 seconds later (3 failed checks × 15s), the target group has ejected it:

```
$ aws elbv2 describe-target-health \
    --target-group-arn arn:aws:elasticloadbalancing:...:targetgroup/tickethub-staging-tg/73e2d6bc24d8a067 \
    --query 'TargetHealthDescriptions[].{Id:Target.Id,State:TargetHealth.State,Why:TargetHealth.Reason}'
[
  { "Id": "i-0aa11bb22cc33dd44", "State": "healthy",   "Why": null },
  { "Id": "i-0ee55ff66aa77bb88", "State": "unhealthy", "Why": "Target.FailedHealthChecks" }
]
$ for i in {1..4}; do curl -s -D- -o /dev/null https://api.staging.tickethub.example/up \
    | grep -i x-served-by; done
x-served-by: ip-10-1-34-27
x-served-by: ip-10-1-34-27
x-served-by: ip-10-1-34-27
x-served-by: ip-10-1-34-27
```

No 502s, no user-visible failure — an instance died and traffic simply flowed around it. Restart nginx the same way (`systemctl start nginx`); within two passing checks it's back in rotation. That's the machinery Module 9 will lean on for zero-downtime deploys.

### 11. The pain audit — write it down

You just deployed TicketHub to AWS. Before the relief fades, record what it cost — each item maps 1:1 to its fix:

1. **"Identical" instances aren't.** Booted an hour apart, they can hold different package patch versions, different Composer resolutions, different everything the script fetched live. There is no way to *know* they match. → **Immutable images built once in CI** (Module 9, standing on Modules 6–7).
2. **A deploy is "repeat the bootstrap N times" — with downtime.** Changing one line of PHP means re-cloning and re-building on every instance, by hand, in sequence, while users are served by whichever mix of versions is live mid-deploy. → **Automated pipelines with rolling deploys** (Module 9).
3. **There is no rollback.** `git clone --depth 1 --branch main` has no memory; if `main` is broken, "roll back" means *another forward deploy* under adrenaline. → **Sha-tagged image artifacts: rollback = redeploy the previous tag** (Module 9, from Module 7's tagging).
4. **Scale-out latency is measured in coffee breaks.** New capacity = launch + 5–10 min bootstrap + manual target registration. An on-sale spike is over before your third instance is. → **Containers that start in seconds under a service scheduler** (Module 9).
5. **None of this is reviewable or repeatable.** Today's infrastructure exists as ~60 CLI commands in your scrollback. No PR reviewed them; no one can rebuild them from memory; the next change is another untracked mutation. → **Terraform: infrastructure as reviewed, versioned code** (Module 10).

Keep this list. Module 9's first lecture opens by reading it back as a requirements document.

### Cost recap & keep note

The full staging stack, monthly, on-demand in `ap-southeast-1`:

| Resource | ~Monthly |
|---|---|
| 2 × EC2 `t4g.small` | $31 |
| 2 × 20 GB gp3 EBS | $4 |
| ALB (hours + light LCUs) | $21 |
| NAT gateway + EIP (8.2) | $47 |
| RDS `db.t4g.micro` + storage (8.3) | $17 |
| ElastiCache `cache.t4g.micro` (8.3) | $13 |
| Route 53 zone, secrets, S3, CloudWatch, data | ~$4 |
| **Total** | **≈ $135–140/mo (~$4.50/day)** |

That's the honest price of a two-AZ managed staging stack (us-east-1 lands nearer $100; Module 12's cost lecture optimizes it). **Teardown guidance: STOP — do not terminate — the two EC2 instances** when you finish the module (`aws ec2 stop-instances --instance-ids i-0aa11bb22cc33dd44 i-0ee55ff66aa77bb88`): stopped instances bill only their EBS (~$4/mo), and Module 9 replaces them with Fargate tasks — terminate them after your first successful ECS deploy. **KEEP everything else**: VPC, RDS, ElastiCache, S3, ACM, Route 53, and the ALB (≈$18/mo idle — Module 9 attaches its services to this same ALB). Pausing the course entirely? 8.2's NAT-deletion trick and 8.1's RDS-stop caveats still apply.

## Real-world best practices

- **Never repair a running instance — replace it.** The moment you hand-patch a live server it diverges from its bootstrap and becomes a snowflake nobody can rebuild. If the script is wrong, fix the script and relaunch; that discipline is 90% of being ready for immutable infrastructure.
- **IMDSv2-required is an account standard, not a per-launch choice.** One SSRF away from stolen role credentials is not a place to live. Enforce it at launch, and check the account-level default so consoles and scripts can't regress it.
- **Port 22 should not exist in your security groups.** SSM gives you shells, port-forwards, and fleet-wide commands with IAM control and CloudTrail audit. "But I need SCP" — `aws s3 cp` through the instance role. Every exception you carve out is a key-management program you re-inherit.
- **One store per config class, and the instance reads both at boot.** Parameter Store for config, Secrets Manager for secrets, nothing in user data, nothing hand-edited on a box — a hand-edited `.env` is drift that survives until the next relaunch deletes it, which is worse than either consistent state.
- **Balancers probe shallow, monitors probe deep — and tune the draining delay to your traffic.** `/up` decides rotation; `/api/health` pages humans (Module 12). Default 300s deregistration delay on a fast API turns every deploy into a five-minute wait for no benefit.
- **Treat ACM validation CNAMEs as permanent infrastructure.** They're the renewal mechanism, not setup residue. Deleting "unused DNS records" during a cleanup is how certificates expire a year after the person who understood them left.

## Common pitfalls

1. **Secrets in user data.** It's right there and it works — and it's readable by anyone with `ec2:DescribeInstanceAttribute` and by any process on the box via IMDS, forever. Correct approach: user data holds only logic; secrets are fetched at boot through the instance role, which is exactly what it's for.
2. **Opening port 22 "just while I debug this".** Muscle memory from Module 2, and it quietly re-creates the key-distribution problem AWS just solved for you — plus the rule never gets removed. Correct approach: `aws ssm start-session` does everything SSH did; if you typed `-i keypair.pem` this module, something's wrong.
3. **Each instance generating its own `APP_KEY`.** `key:generate` in the bootstrap feels natural and boots fine — then sessions randomly die and encrypted payloads fail, but only for the ~50% of requests that cross instances, which makes it look like anything but config. Correct approach: one key, generated once, in Secrets Manager, read by all instances.
4. **Two schedulers, no `onOneServer()`.** Nothing errors; the system is simply wrong twice a day — duplicate nightly reports, double reservation-expiry sweeps — and it's customers who notice, not monitoring. Correct approach: `onOneServer()` on every scheduled task the moment instance count can exceed one; it's free insurance even at N=1.
5. **Pointing the ALB health check at `/` or the deep check.** `/` might redirect (301 ≠ 200 → all targets "unhealthy" while the site works fine), and the deep check turns any shared-dependency blip into a full-fleet ejection. Correct approach: `/up`, matcher 200, exactly as Module 3.4's doctrine prescribed — the deep check belongs to monitoring.

## Exercises

1. From memory, draw the full request path — client → Route 53 → ALB (which subnets?) → target group → nginx → FPM → RDS/Redis — labeling the security group at every hop and where TLS terminates. Check yourself against 8.2's diagram plus this lecture.
2. Fleet operations without a loop: use one `aws ssm send-command` targeting *both* instances to report `php -v`, `systemctl is-active tickethub-horizon`, and FPM's `max_children` — then check both boxes agree. (They should today. Item 1 of the pain audit says they won't forever.)
3. Time a scale-out: launch a third instance from the same `user-data.sh` into `app-a`, register it, and measure launch-to-healthy-target. Serve six curls proving three `X-Served-By` values, then deregister (watch the 30s drain) and terminate. The number you measured is pain-audit item 4 made concrete.
4. Kill Horizon (not nginx) on one instance via Run Command. Verify the ALB keeps sending it traffic (health checks only see HTTP), figure out from `php artisan horizon:status` and queue depth which box went dark, then restart it. One paragraph: what *should* have alerted you, and which lecture builds it? (Module 12.)
5. **Stretch — feel Module 9 before building it:** write `deploy.sh` that "deploys" a new commit with zero downtime using only today's tools: for each instance — deregister from the target group, wait for draining, SSM Run Command (`git pull`, `composer install --no-dev`, `config:cache`, `horizon:terminate --wait`, reload FPM), re-register, wait for healthy, next instance. Run it, time it, and list every step that could fail half-way and what state that leaves. You have just written a worse version of Module 9 — which is the best possible preparation for it.

## What's next

TicketHub now runs on real cloud architecture — two AZs, a load balancer, managed data services, TLS at the edge, zero exposed admin ports — and per [TICKETHUB.md](../TICKETHUB.md)'s roadmap, "still deployed semi-manually" is the operative phrase. You felt why: five numbered pains, each with a named fix. Module 9 collects the debt — [CD concepts and environments](../module-09-cd-deployment-strategies/01-cd-concepts-environments.md) first, then zero-downtime Laravel deploys, then ECS Fargate running Module 7's images through this very ALB, VPC, and data tier. Nothing you built today is thrown away; almost everything you *did by hand* today stops being your job.
