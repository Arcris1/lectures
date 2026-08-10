# Lecture 8.3 — Core Services for TicketHub: RDS, S3, ElastiCache, SES

> **Module 8 — AWS Cloud Fundamentals** · Lecture 3 of 4 · Estimated time: ~120 min

[Lecture 8.2](02-vpc-networking.md) left you a correct, empty network. Today the data tier moves in: MySQL becomes RDS, Redis becomes ElastiCache, ticket PDFs get their S3 bucket, and outbound mail gets SES. This is the payoff lecture for [Module 5](../module-05-configuration-twelve-factor/01-twelve-factor-laravel.md): you made every backing service an attached resource swappable by config alone, and today you swap all four — the application code does not change. It's also the lecture where you stop administering MySQL at 3 a.m., which deserves an honest accounting of what that costs and buys.

## Learning objectives

- Decide managed vs self-managed for each backing service using a real framework — and defend why the managed answer is almost always right for a small team
- Provision RDS MySQL 8.0 correctly: instance class, gp3 storage, subnet group, parameter group, managed master password, backups, deletion protection
- Explain what Multi-AZ failover actually does, what your Laravel app experiences during one, and the staging-vs-production policy
- Stand up ElastiCache Redis 7 with TLS and AUTH, and choose an eviction policy that cannot silently lose queued jobs
- Configure S3 as a private, encrypted, lifecycle-managed uploads bucket and wire Laravel's `s3` disk with presigned downloads
- Get SES sending authenticated mail: domain identity, DKIM, the sandbox exit, and bounce handling as a deliverability practice

## 1. Managed vs self-managed: the decision, made honestly

You could run `mysqld` on an EC2 instance tonight. Module 3 taught you how, it's roughly half the infrastructure price of RDS for the same vCPUs, and you'd have root: any plugin, any replication topology, `SUPER` privilege. That's the whole case for self-managing, and it's real.

Now the other column — what RDS actually sells:

- **Automated backups with point-in-time recovery.** Daily snapshots plus continuous binlog shipping. You can restore *to any second* within the retention window. The self-managed equivalent is a cron job, an S3 sync, binlog rotation config, and — the part everyone skips — periodic restore drills to prove the backups aren't decorative.
- **Patching.** Minor engine versions and the underlying OS, applied in a maintenance window you choose. Self-managed, that's your Sunday.
- **Multi-AZ failover.** A synchronously replicated standby in another AZ, promoted automatically in about a minute when the primary dies (section 3). Building that yourself — orchestration, fencing, split-brain protection — is a distributed-systems project, not a config file.
- **Snapshots, metrics, storage scaling, credential management** — each individually small, collectively a part-time job you no longer have.

The decision framework, as questions: *Is running this database differentiating for the business?* (For TicketHub: no — selling tickets is.) *Do we have someone who can be woken for it, plus cover for their holidays?* *Is there a hard requirement RDS can't meet?* *Does the price delta fund even a fraction of a DBA?* At small-team scale the arithmetic is lopsided: the RDS premium on our staging database is about eight dollars a month; the first backup-that-didn't-restore costs more than a decade of that. **For a small team, managed is almost always the correct answer** — say it plainly and move on. Self-managing is right when the database *is* the product, when you need what RDS forbids, or when your fleet is large enough that the premium genuinely funds dedicated database engineers. The same logic covers Redis (ElastiCache), object storage (S3 — "self-managed" barely means anything at eleven-nines durability), and mail (SES — deliverability reputation is bought with years, not config).

## 2. RDS anatomy: classes, storage, parameters, and the connection budget

**Instance classes** reuse EC2's taxonomy with a `db.` prefix: `db.t4g` (burstable, Graviton/ARM), `db.m7g` (general purpose), `db.r7g` (memory-optimized — the usual production pick for MySQL, since buffer pool is king). Burstable classes are honest only if you understand the credit model: a `t4g` earns CPU credits at a baseline rate and spends them to burst — perfect for mostly-idle staging, risky for TicketHub production, whose defining load is the on-sale spike that drains credits exactly when throttling hurts most. RDS softens this by running T-classes in *unlimited mode* by default: instead of throttling you pay a per-vCPU-hour surcharge, so the failure mode is a surprise bill rather than a brownout. Watch `CPUCreditBalance` either way. Course policy: **staging `db.t4g.micro`; production `db.m7g.large` or `r7g` when the working set outgrows RAM.**

**Storage** is `gp3` — the same EBS generation you'll use for EC2 roots in [8.4](04-classic-deployment-ec2-alb.md): 3,000 IOPS and 125 MB/s baseline included regardless of volume size (the old `gp2` scaled IOPS with gigabytes, forcing you to buy space you didn't need to get speed you did). 20 GB is the floor and plenty for staging.

**Parameter groups** are RDS's replacement for `my.cnf` — you can't SSH in to edit files, so configuration is an API object attached to the instance. The default group is immutable; you always create your own. Ours sets four things: `character_set_server=utf8mb4` and `collation_server=utf8mb4_unicode_ci` (matching the database Module 3 created by hand — charset drift between environments is a classic parity bug), and `slow_query_log=1` with `long_query_time=1` (queries slower than one second get logged; exported to CloudWatch, this is your free query profiler until Module 12 brings real APM). Most parameters are *dynamic* (apply live); some are *static* (need a reboot) — attach the group at creation and the point is moot.

And then there's **`max_connections`** — the parameter that ends scale-out honeymoons. RDS derives the default from instance memory: on a 1 GiB class like `db.t4g.micro` the formula lands in the low 80s. Now connect that to arithmetic you already own. Module 3 sized `pm.max_children` from worker memory; each busy FPM worker holds one MySQL connection. [Lecture 8.4](04-classic-deployment-ec2-alb.md) will run **two** app instances at ~20 FPM workers each — 40 potential connections — plus Horizon's queue workers (call it another 10–12 across both boxes), the scheduler, and your migration sessions. Peak ≈ 55 against a ceiling of ~80: fine. Scale to four instances during an on-sale and you're at 90+ — and MySQL starts refusing connections: `SQLSTATE[HY000] [1040] Too many connections`, an error that arrives *precisely when traffic is best*. This is the classic scale-out failure: **`max_connections` is a fleet-level budget** — FPM workers × instances + queue workers × instances + headroom — and every scale-out decision spends from it. Raising it costs memory (each connection buffers a few MB); the real fixes at scale are bigger classes, connection reuse, or a pooler like RDS Proxy. For now: know the number, do the multiplication before adding instances.

**Credentials** go straight to the platform: `--manage-master-user-password` makes RDS generate the master password, store it in Secrets Manager, and rotate it on demand — it never exists in your shell history, and the app reads it from the secret (8.4 automates that read at boot). **Deletion protection** goes on at creation: a flag that makes `delete-db-instance` fail until you consciously remove it. It has saved more production databases from fat-fingered cleanup scripts than any backup strategy.

## 3. Backups, Multi-AZ, and what failover feels like from Laravel

**Automated backups** = daily storage-level snapshot + transaction logs captured continuously, retained `--backup-retention-period` days (we use 7). Point-in-time restore replays logs onto the nearest snapshot: "the database as of 14:32:07 yesterday" becomes a *new* instance — restores never overwrite the original, which is exactly what you want mid-incident. Manual snapshots are the complement: taken before risky migrations, kept until you delete them.

**Multi-AZ** is the availability feature, and it's worth being precise because people conflate it with read replicas. Multi-AZ maintains a **synchronous** standby copy in a second AZ — every commit lands on both before returning, which is why 8.2's data subnets span two AZs. The standby serves *no traffic*. On failure (instance crash, AZ outage, storage failure) or during maintenance, RDS **promotes the standby and repoints the instance's DNS name** — `tickethub-staging-mysql.….rds.amazonaws.com` simply starts resolving to the other box. This is why 8.2 insisted RDS hands you hostnames, never IPs. Typical failover: **60–120 seconds**.

What does Laravel feel during those seconds? Every open connection dies mid-flight: in-progress requests throw PDO exceptions (`SQLSTATE[HY000] [2002] Connection refused`, `server has gone away`), and in-flight transactions roll back — TicketHub's `SELECT ... FOR UPDATE` inventory holds included, which is safe: the reservation either committed on both nodes or nowhere. PHP-FPM's request model is quietly an advantage here: with no long-lived connection pool, the *next* request simply connects to the new primary once DNS flips. Queued jobs that die are retried by Horizon within `retry_after` — your Module 5 queue settings are failover resilience, already paid for. The users mid-checkout during those 90 seconds see errors; the ones after don't. Policy, stated: **staging runs Single-AZ** (Multi-AZ doubles the instance cost, and staging's job is parity of shape, not resilience — same trade-off as 8.2's single NAT); **production runs Multi-AZ, non-negotiable.**

**Read replicas** are the other thing: *asynchronous* copies that do serve reads — read *scaling*, not high availability, since replication lags and promotion is slower and manual-ish. Laravel supports them natively: `config/database.php` takes separate `read`/`write` host arrays with a `sticky` option so a request that just wrote reads its own write. File that away for the day event-browse traffic outgrows one primary; it too needs no code changes.

## 4. ElastiCache Redis: topology, security, and the eviction policy that can lose orders

ElastiCache is Redis with the same deal as RDS: you choose topology and parameters; AWS runs, patches, and monitors the nodes. Topology first: a **single node** is one cache instance — cheap, and a single point of failure. A **replication group** is a primary plus replicas with automatic failover — the Multi-AZ story again. Policy mirrors the database: **staging runs one `cache.t4g.micro` node; production runs primary + replica with automatic failover.** (We create staging's single node *as* a one-member replication group — that's the API path that supports encryption, and it upgrades to primary+replica later without recreating.)

Security is two switches you always set: **in-transit TLS** and an **AUTH token** (Redis's password). Yes, the network already isolates Redis behind `sg-redis` — defense in depth means the day someone mis-scopes a security group, the attacker still faces authentication and encryption. Laravel speaks both with two `.env` keys — `REDIS_SCHEME=tls` and `REDIS_PASSWORD=<token>` — plus a one-line addition to `config/database.php` (hands-on §4).

Now the decision this section exists for: **eviction policy**. Redis with `maxmemory` full must do something with the next write. `allkeys-lru` evicts the least-recently-used key — *correct for caches and tolerable for sessions* (worst case: someone re-logs-in). **It is catastrophic for queues.** A Horizon queue is a Redis list; under memory pressure, `allkeys-lru` will happily evict `queues:pdfs` — and every pending `GenerateTicketPdf` job in it. No exception, no log line: customers who paid simply never get tickets. Evicted jobs are lost orders.

Module 5 already made this call for the shared local Redis, and we carry it to AWS transparently: TicketHub's cache, sessions, *and* queues share one staging instance for cost, therefore the policy is **`noeviction`** — when memory fills, Redis *rejects writes with an error* instead of silently destroying data — paired with a **CloudWatch alarm at 80% memory** so you act before that happens. The trade we're accepting, stated in full: under memory pressure, cache writes (and job pushes) fail loudly with exceptions rather than jobs vanishing quietly. Loud beats silent, every time. The grown-up answer at scale is **separate clusters** — an `allkeys-lru` cache cluster that's allowed to be full, and a `noeviction` queue cluster that's monitored — and that's exactly what production should do the day the memory alarm becomes a regular visitor.

## 5. S3: a private bucket, encrypted, with a lifecycle

S3 stores objects (bytes + key + metadata) in buckets with 99.999999999% durability. For TicketHub it holds ticket PDFs and event images — the "local disk is a lie once you have 2 servers" problem, solved. Three decisions per bucket:

**Access: private, absolutely.** Every S3 breach headline you've read was a bucket someone made public. **Block Public Access stays on — all four settings** — and downloads happen via **presigned URLs**: the app authorizes a request (is this *your* ticket?), then asks S3 to mint a URL valid for a few minutes, signed with the app's own credentials. `Storage::temporaryUrl()` is Laravel's one-liner for it. The bucket never becomes a web server; authorization stays in your code where it belongs. (New buckets now default to BPA-on and ACLs disabled — we set it explicitly anyway: explicit survives audits and older accounts.)

**Encryption: SSE-S3 by default.** AES-256, keys managed by S3, zero operational cost, on by default for new buckets — we declare it explicitly. The upgrade, **SSE-KMS**, encrypts with a KMS key *you* control: every decrypt hits CloudTrail with the calling principal, key policy can gate readers independently of IAM, and compliance regimes love it. It costs per-request and adds a KMS dependency to every download. Rule of thumb: SSE-S3 for content like ticket PDFs; SSE-KMS where you must *prove who read what* — financial exports, PII dumps.

**Versioning + lifecycle.** Versioning keeps prior versions on overwrite/delete — cheap insurance against a buggy job clobbering PDFs. But it's delete-*protection*, not an archive: old versions bill at full price forever unless a **lifecycle rule** expires them (ours: noncurrent versions die at 30 days). A second rule does cost engineering: tickets are downloaded intensely for days after purchase, then almost never — so `tickets/` objects transition to **STANDARD_IA** at 90 days. The math: in `ap-southeast-1`, Standard ≈ $0.025/GB-mo vs IA ≈ $0.0138 — 45% off storage, with a $0.01/GB retrieval fee only when someone actually re-downloads. Pennies at staging's ~12 GB/yr of PDFs; the habit is what you're buying — at 5 TB of media the same two JSON rules save real money. (IA fine print: 30-day minimum storage charge, 128 KB minimum billable size — fine for PDFs, wrong for thousands of tiny thumbnails.)

## 6. SES: deliverability is earned, not configured

Email is the only backing service where a third party — Gmail's spam filter — decides whether your feature works. SES sells you Amazon's sending reputation, conditionally.

**The sandbox is real and you start in it.** New SES accounts can send only *to* verified identities, at 200 messages/day. This isn't bureaucracy; it's how AWS keeps its IP ranges off blocklists — which is precisely the asset you're renting. You develop in the sandbox (verify your own address, send to it), then request **production access** with a short form. What to write, concretely: *transactional email only — order confirmations and tickets to customers who just purchased; expected volume (say, 5,000/month growing); bounces and complaints handled automatically via a configuration set that suppresses recipients; no purchased or imported lists.* Specific and honest gets approved in about a day; vague gets questions.

**Authentication: a domain identity + DKIM.** You verify ownership of `tickethub.example` and SES gives you three CNAME records ("Easy DKIM") to publish in DNS. DKIM cryptographically signs every message as genuinely-from-your-domain — without it, modern providers junk or reject you regardless of content. (SPF, which Module 3.1 promised would authorize SES, comes along automatically: SES's default envelope domain carries its own SPF record; you'd add your own only with a custom MAIL FROM domain — a later refinement.)

**Bounce and complaint handling is not optional.** Providers measure your bounce and complaint *rates*; sustained high rates get your SES account paused — a production incident made of email. A **configuration set** tags your sending and routes BOUNCE/COMPLAINT events to an SNS topic; a small webhook in Laravel subscribes and suppresses those addresses so you never mail them again. That single loop is most of what "deliverability practice" means at this scale. Event *metrics* (deliveries, opens) land in CloudWatch through the same mechanism — Module 12 graphs them.

**Driver choice:** SES offers SMTP or its native API. Use the API driver (`MAIL_MAILER=ses`): it authenticates with IAM — on EC2, the instance role, zero mail credentials to store — while SMTP requires generating yet another long-lived username/password pair. Lecture 8.1's doctrine (roles over keys) applies to mail too.

## Hands-on with TicketHub

⚠️ **Cost check — created in this lecture:** RDS `db.t4g.micro` + 20 GB gp3 (~$17/mo), ElastiCache `cache.t4g.micro` (~$13/mo), Route 53 hosted zone ($0.50/mo), two Secrets Manager secrets (~$0.80/mo), S3/SNS/CloudWatch (pennies at this volume; first 10 alarms free), a temporary `t4g.nano` (~$0.005/hr, **terminated in §4**). Adds ≈ **$32/mo** to 8.2's ~$47 NAT baseline. **RDS, Redis, the bucket, the zone, and SES are all KEPT** — 8.4 and Modules 9–10 depend on them. `AWS_PROFILE=tickethub-staging` exported, all four governance tags applied everywhere (abbreviated to `Name` below, per 8.2).

### 1. RDS MySQL

Subnet group (RDS's way of saying "place me in the data tier"), parameter group, then the instance:

```
$ aws rds create-db-subnet-group \
    --db-subnet-group-name tickethub-staging-db-subnets \
    --db-subnet-group-description "TicketHub staging private-data subnets" \
    --subnet-ids subnet-0a6f1b528e3dc7005 subnet-0b7a2c639f4ed8006 \
    --tags Key=Name,Value=tickethub-staging-db-subnets
$ aws rds create-db-parameter-group \
    --db-parameter-group-name tickethub-staging-mysql80 \
    --db-parameter-group-family mysql8.0 \
    --description "TicketHub staging MySQL 8.0"
$ aws rds modify-db-parameter-group \
    --db-parameter-group-name tickethub-staging-mysql80 \
    --parameters \
      "ParameterName=character_set_server,ParameterValue=utf8mb4,ApplyMethod=immediate" \
      "ParameterName=collation_server,ParameterValue=utf8mb4_unicode_ci,ApplyMethod=immediate" \
      "ParameterName=slow_query_log,ParameterValue=1,ApplyMethod=immediate" \
      "ParameterName=long_query_time,ParameterValue=1,ApplyMethod=immediate"
```

```
$ aws rds create-db-instance \
    --db-instance-identifier tickethub-staging-mysql \
    --engine mysql --engine-version 8.0.42 \
    --db-instance-class db.t4g.micro \
    --allocated-storage 20 --storage-type gp3 --storage-encrypted \
    --db-name tickethub \
    --master-username admin --manage-master-user-password \
    --db-subnet-group-name tickethub-staging-db-subnets \
    --vpc-security-group-ids sg-0d1c7a9b0e2f30003 \
    --no-publicly-accessible --no-multi-az \
    --db-parameter-group-name tickethub-staging-mysql80 \
    --backup-retention-period 7 \
    --preferred-backup-window 19:00-20:00 \
    --preferred-maintenance-window sun:20:30-sun:21:30 \
    --enable-cloudwatch-logs-exports '["error","slowquery"]' \
    --deletion-protection \
    --tags Key=Name,Value=tickethub-staging-mysql \
    --query 'DBInstance.{Status:DBInstanceStatus,Secret:MasterUserSecret.SecretArn}'
{
    "Status": "creating",
    "Secret": "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:rds!db-3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9-AbCdEf"
}
$ aws rds wait db-instance-available --db-instance-identifier tickethub-staging-mysql   # ~10 min
$ aws rds describe-db-instances --db-instance-identifier tickethub-staging-mysql \
    --query 'DBInstances[0].Endpoint'
{
    "Address": "tickethub-staging-mysql.c9akciq32rga.ap-southeast-1.rds.amazonaws.com",
    "Port": 3306
}
```

Read the flags back as decisions: `sg-mysql` from 8.2, no public access, Single-AZ (section 3's policy), 7-day PITR, backup window 03:00–04:00 SGT (after the 02:00 nightly reports), maintenance the following hour, deletion protection on, slow query log exported. The password exists only inside Secrets Manager:

```
$ aws secretsmanager get-secret-value \
    --secret-id 'arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:rds!db-3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9-AbCdEf' \
    --query SecretString --output text
{"username":"admin","password":"EXAMPLE-Zq8!pW3xR7vK2mN9tY4u"}
```

(Staging uses the master user for brevity; production gets a dedicated least-privilege app user — exercise 2 territory.)

### 2. Prove connectivity the modern way — and migrate

No bastion, no SSH, no port 22 (8.2 built none). The pattern: a throwaway `t4g.nano` in a private-app subnet, managed purely through **SSM Session Manager** — the agent on the instance polls AWS over outbound 443 (through our NAT), so it needs *zero inbound rules*, and every session is CloudTrail-logged. First a minimal role and a sealed security group:

```
$ aws iam create-role --role-name tickethub-staging-ssm-temp \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
      "Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
$ aws iam attach-role-policy --role-name tickethub-staging-ssm-temp \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
$ aws iam create-instance-profile --instance-profile-name tickethub-staging-ssm-temp
$ aws iam add-role-to-instance-profile --instance-profile-name tickethub-staging-ssm-temp \
    --role-name tickethub-staging-ssm-temp
$ aws ec2 create-security-group --vpc-id vpc-0a1b2c3d4e5f67890 \
    --group-name tickethub-staging-temp-sg --description "temp admin box: no inbound" \
    --query 'GroupId'
"sg-0b5a4938271605f06"
$ AMI=$(aws ssm get-parameters --names \
    /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
    --query 'Parameters[0].Value' --output text)
$ aws ec2 run-instances --image-id $AMI --instance-type t4g.nano \
    --subnet-id subnet-0e4d9f306c1ba5003 \
    --security-group-ids sg-0b5a4938271605f06 \
    --iam-instance-profile Name=tickethub-staging-ssm-temp \
    --metadata-options HttpTokens=required \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=tickethub-staging-temp}]' \
    --query 'Instances[0].{Id:InstanceId,Ip:PrivateIpAddress}'
{ "Id": "i-0f1e2d3c4b5a69876", "Ip": "10.1.33.15" }
```

Deliberately, this instance does **not** carry `sg-app` yet — so you can watch the 8.2 chain refuse it. Install the Session Manager plugin on your laptop (`brew install --cask session-manager-plugin`, or the `.deb`/`.rpm` from AWS), wait for `aws ssm describe-instance-information` to show the instance `Online` (~2 min), then open a **port-forwarding session**: your laptop's port 13306 → through the instance → RDS's 3306:

```
$ aws ssm start-session --target i-0f1e2d3c4b5a69876 \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters '{"host":["tickethub-staging-mysql.c9akciq32rga.ap-southeast-1.rds.amazonaws.com"],"portNumber":["3306"],"localPortNumber":["13306"]}'
Starting session with SessionId: alice-0abc12345def67890
Port 13306 opened for sessionId alice-0abc12345def67890.
Waiting for connections...
```

In a second terminal, `mysql -h 127.0.0.1 -P 13306 -u admin -p` … hangs, then times out. Diagnose it the 8.2 way — ask the flow log who dropped it:

```
$ aws logs filter-log-events --log-group-name /tickethub/staging/vpc-flow-logs \
    --filter-pattern REJECT --limit 1 --query 'events[0].message' --output text
2 111122223333 eni-0d9e8f7a6b5c40123 10.1.33.15 10.1.65.20 43512 3306 6 1 40 1754725500 1754725559 REJECT OK
```

That is the *exact* line Lecture 8.2 §8 taught you to read — now produced by your own packets: source `10.1.33.15` (our temp box), destination port 3306, REJECT at the RDS ENI. Routing worked; `sg-mysql` correctly refused a source that isn't in `sg-app`. The fix is membership, not a new rule:

```
$ aws ec2 modify-instance-attribute --instance-id i-0f1e2d3c4b5a69876 \
    --groups sg-0b5a4938271605f06 sg-0e2d8b0c1f3a40002
```

The instance *joins the app tier* and `3306 ← app-sg` covers it that same second — 8.2's "SG references express intent" argument, demonstrated. Reconnect:

```
$ mysql -h 127.0.0.1 -P 13306 -u admin -p tickethub
mysql> SELECT VERSION();
+-----------+
| 8.0.42    |
+-----------+
mysql> SHOW VARIABLES WHERE Variable_name IN ('max_connections','character_set_server');
+----------------------+---------+
| character_set_server | utf8mb4 |
| max_connections      | 81      |
+----------------------+---------+
```

There's section 2's connection budget (81) and the parameter group doing its job. Now the real moment — TicketHub's schema moves into a database you don't administer. From your local checkout, through the same tunnel:

```
$ DB_HOST=127.0.0.1 DB_PORT=13306 DB_DATABASE=tickethub DB_USERNAME=admin \
  DB_PASSWORD='EXAMPLE-Zq8!pW3xR7vK2mN9tY4u' php artisan migrate --force

   INFO  Preparing database.
  Creating migration table ......................................... 52ms DONE

   INFO  Running migrations.
  0001_01_01_000000_create_users_table ............................. 61ms DONE
  0001_01_01_000001_create_cache_table ............................. 24ms DONE
  0001_01_01_000002_create_jobs_table .............................. 30ms DONE
  2025_11_08_000000_create_events_table ............................ 27ms DONE
  2025_11_08_000100_create_ticket_types_table ...................... 25ms DONE
  2025_11_09_000000_create_orders_table ............................ 33ms DONE
  ...
  2026_02_02_000000_add_pdf_path_to_tickets_table .................. 19ms DONE
```

Leave the temp instance running — §4 reuses it, then terminates it.

### 3. ElastiCache Redis with TLS and AUTH

Subnet group, a parameter group carrying the section-4 decision, an AUTH token stored in Secrets Manager (8.4's boot script will read it there), then the one-node replication group:

```
$ aws elasticache create-cache-subnet-group \
    --cache-subnet-group-name tickethub-staging-cache-subnets \
    --cache-subnet-group-description "TicketHub staging private-data subnets" \
    --subnet-ids subnet-0a6f1b528e3dc7005 subnet-0b7a2c639f4ed8006
$ aws elasticache create-cache-parameter-group \
    --cache-parameter-group-name tickethub-staging-redis7 \
    --cache-parameter-group-family redis7 \
    --description "noeviction: queues share this instance"
$ aws elasticache modify-cache-parameter-group \
    --cache-parameter-group-name tickethub-staging-redis7 \
    --parameter-name-values ParameterName=maxmemory-policy,ParameterValue=noeviction
$ REDIS_AUTH=$(openssl rand -hex 32)
$ aws secretsmanager create-secret --name tickethub/staging/redis-auth \
    --secret-string "$REDIS_AUTH" --query 'ARN'
"arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:tickethub/staging/redis-auth-Xy9ZaB"
$ aws elasticache create-replication-group \
    --replication-group-id tickethub-staging-redis \
    --replication-group-description "TicketHub staging Redis 7" \
    --engine redis --engine-version 7.1 \
    --cache-node-type cache.t4g.micro --num-cache-clusters 1 \
    --cache-parameter-group-name tickethub-staging-redis7 \
    --cache-subnet-group-name tickethub-staging-cache-subnets \
    --security-group-ids sg-0c0b6980fd1e20004 \
    --transit-encryption-enabled --at-rest-encryption-enabled \
    --auth-token "$REDIS_AUTH" \
    --tags Key=Name,Value=tickethub-staging-redis
$ aws elasticache wait replication-group-available --replication-group-id tickethub-staging-redis
$ aws elasticache describe-replication-groups --replication-group-id tickethub-staging-redis \
    --query 'ReplicationGroups[0].NodeGroups[0].PrimaryEndpoint'
{
    "Address": "tickethub-staging-redis.x1y2z3.ng.0001.apse1.cache.amazonaws.com",
    "Port": 6379
}
```

The memory alarm that makes `noeviction` operable — an SNS topic you'll reuse all course, then the alarm:

```
$ aws sns create-topic --name tickethub-staging-alerts --query 'TopicArn'
"arn:aws:sns:ap-southeast-1:111122223333:tickethub-staging-alerts"
$ aws sns subscribe --topic-arn arn:aws:sns:ap-southeast-1:111122223333:tickethub-staging-alerts \
    --protocol email --notification-endpoint you@example.com     # confirm the email!
$ aws cloudwatch put-metric-alarm \
    --alarm-name tickethub-staging-redis-memory \
    --namespace AWS/ElastiCache --metric-name DatabaseMemoryUsagePercentage \
    --dimensions Name=CacheClusterId,Value=tickethub-staging-redis-001 \
    --statistic Average --period 300 --evaluation-periods 2 \
    --threshold 80 --comparison-operator GreaterThanThreshold \
    --alarm-actions arn:aws:sns:ap-southeast-1:111122223333:tickethub-staging-alerts
```

Smoke-test from the temp instance — a plain SSM shell this time (`redis-cli` needs to run *inside* the VPC; TLS certificate names don't survive a laptop tunnel):

```
$ aws ssm start-session --target i-0f1e2d3c4b5a69876
Starting session with SessionId: alice-0def67890abc12345
$ sudo apt-get install -y redis-tools
$ REDISCLI_AUTH=<the-token> redis-cli --tls \
    -h tickethub-staging-redis.x1y2z3.ng.0001.apse1.cache.amazonaws.com ping
PONG
$ exit
```

(`REDISCLI_AUTH` keeps the token out of `ps` and shell history — Module 2 habits.) Done with the box:

```
$ aws ec2 terminate-instances --instance-ids i-0f1e2d3c4b5a69876 \
    --query 'TerminatingInstances[0].CurrentState.Name'
"shutting-down"
```

### 4. Point Laravel at managed Redis

Laravel's Redis connections accept a `scheme`; expose it as config. In `config/database.php`, add one line to both the `default` and `cache` connections:

```php
'default' => [
    'scheme' => env('REDIS_SCHEME', 'tcp'),   // ← add; 'tls' in staging/prod
    'url' => env('REDIS_URL'),
    'host' => env('REDIS_HOST', '127.0.0.1'),
    'username' => env('REDIS_USERNAME'),
    'password' => env('REDIS_PASSWORD'),
    'port' => env('REDIS_PORT', '6379'),
    'database' => env('REDIS_DB', '0'),
],
```

The staging values (full block in §8): `REDIS_HOST=tickethub-staging-redis.x1y2z3.ng.0001.apse1.cache.amazonaws.com`, `REDIS_SCHEME=tls`, `REDIS_PASSWORD=<the AUTH token>`. phpredis (Module 3's client choice) handles TLS natively; local dev stays `tcp` with no password — same code, different attachment, factor III doing its job.

### 5. The uploads bucket

```
$ aws s3api create-bucket --bucket tickethub-staging-uploads \
    --region ap-southeast-1 \
    --create-bucket-configuration LocationConstraint=ap-southeast-1
$ aws s3api put-public-access-block --bucket tickethub-staging-uploads \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
$ aws s3api put-bucket-encryption --bucket tickethub-staging-uploads \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
$ aws s3api put-bucket-versioning --bucket tickethub-staging-uploads \
    --versioning-configuration Status=Enabled
$ aws s3api put-bucket-tagging --bucket tickethub-staging-uploads \
    --tagging 'TagSet=[{Key=Project,Value=tickethub},{Key=Env,Value=staging},{Key=Owner,Value=platform},{Key=ManagedBy,Value=manual}]'
```

Lifecycle — section 5's two rules as JSON (`lifecycle.json`), then applied:

```json
{
  "Rules": [
    {
      "ID": "expire-noncurrent-versions",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
    },
    {
      "ID": "tickets-to-standard-ia",
      "Status": "Enabled",
      "Filter": { "Prefix": "tickets/" },
      "Transitions": [ { "Days": 90, "StorageClass": "STANDARD_IA" } ]
    }
  ]
}
```

```
$ aws s3api put-bucket-lifecycle-configuration --bucket tickethub-staging-uploads \
    --lifecycle-configuration file://lifecycle.json
```

### 6. Laravel on S3 — the Module 5 payoff

```
$ composer require league/flysystem-aws-s3-v3 "^3.0" --with-all-dependencies
```

(This pulls `aws/aws-sdk-php`, which the SES driver uses too — one SDK, both services.) The `s3` disk in `config/filesystems.php`, with one deliberate change from the framework default:

```php
's3' => [
    'driver' => 's3',
    'key' => env('AWS_ACCESS_KEY_ID'),        // unset on AWS: the instance role provides credentials
    'secret' => env('AWS_SECRET_ACCESS_KEY'),
    'region' => env('AWS_DEFAULT_REGION'),
    'bucket' => env('AWS_BUCKET'),
    'url' => env('AWS_URL'),
    'endpoint' => env('AWS_ENDPOINT'),        // MinIO locally (Module 6); null on AWS
    'use_path_style_endpoint' => env('AWS_USE_PATH_STYLE_ENDPOINT', false),
    'throw' => true,   // a failed PDF write must throw so the job retries — not return false silently
],
```

With `FILESYSTEM_DISK=s3`, **`GenerateTicketPdf` does not change.** Module 5 promised exactly this when it routed the job through the `Storage` facade with relative paths ("what changes when `FILESYSTEM_DISK` becomes `s3`? Nothing in this code") — today that check clears. Smoke test with your admin profile:

```
$ php artisan tinker
> Storage::disk('s3')->put('tickets/smoke-test.pdf', 'not really a pdf');
= true
> Storage::disk('s3')->temporaryUrl('tickets/smoke-test.pdf', now()->addMinutes(5));
= "https://tickethub-staging-uploads.s3.ap-southeast-1.amazonaws.com/tickets/smoke-test.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-Signature=..."
```

Downloads become authorize-then-presign — `app/Http/Controllers/TicketDownloadController.php`:

```php
<?php

namespace App\Http\Controllers;

use App\Models\Ticket;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;

class TicketDownloadController extends Controller
{
    public function __invoke(Request $request, Ticket $ticket)
    {
        abort_unless($request->user()->id === $ticket->order->customer_id, 403);

        return redirect()->away(
            Storage::temporaryUrl($ticket->pdf_path, now()->addMinutes(5), [
                'ResponseContentDisposition' => 'attachment; filename="ticket-'.$ticket->uuid.'.pdf"',
            ])
        );
    }
}
```

```php
// routes/api.php
Route::get('/tickets/{ticket:uuid}/download', TicketDownloadController::class)
    ->middleware('auth:sanctum');
```

The IAM statements the app tier needs — written now, attached to the instance role in [8.4](04-classic-deployment-ec2-alb.md):

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
    }
  ]
}
```

**Optional — only if browsers upload directly to S3** (presigned PUTs from a JS frontend; TicketHub's API doesn't today): the bucket needs CORS. Skip it otherwise — an absent CORS config is the correct config:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://app.staging.tickethub.example"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["Content-Type"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

### 7. SES: domain, DKIM, configuration set

DKIM needs DNS, so the Route 53 hosted zone arrives one lecture early — one command now; delegation and the API record are [8.4](04-classic-deployment-ec2-alb.md)'s story:

```
$ aws route53 create-hosted-zone --name tickethub.example \
    --caller-reference tickethub-$(date +%s) \
    --query '{Id:HostedZone.Id,NS:DelegationSet.NameServers}'
{
    "Id": "/hostedzone/Z0413857YT73GHIJKLMN",
    "NS": [ "ns-2048.awsdns-64.com", "ns-2049.awsdns-65.net",
            "ns-2050.awsdns-66.org", "ns-2051.awsdns-67.co.uk" ]
}
$ aws sesv2 create-email-identity --email-identity tickethub.example \
    --query 'DkimAttributes.Tokens'
[ "6gbrjpgwjskckoa6a5zn6vwk", "yybe3bf22edqq5jphmzhihmx", "wrair2f4dvzcmlbb3fromjfk" ]
```

Each token becomes a CNAME `<token>._domainkey.tickethub.example → <token>.dkim.amazonses.com`. One shown in full; repeat for the other two:

```
$ aws route53 change-resource-record-sets --hosted-zone-id Z0413857YT73GHIJKLMN \
    --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{
      "Name":"6gbrjpgwjskckoa6a5zn6vwk._domainkey.tickethub.example","Type":"CNAME","TTL":300,
      "ResourceRecords":[{"Value":"6gbrjpgwjskckoa6a5zn6vwk.dkim.amazonses.com"}]}}]}'
```

(Verification needs public DNS to answer for `tickethub.example` — i.e. 8.4's delegation; expect `get-email-identity` to show `"Dkim": "SUCCESS", "Verified": true` shortly after that step. If your domain's DNS still lives at your registrar from Module 3, add the three CNAMEs there instead and it verifies today.) For sandbox testing, verify your own inbox and send through the API driver:

```
$ aws sesv2 create-email-identity --email-identity you@example.com    # click the link it emails
$ php artisan tinker
> config(['mail.default' => 'ses']);
> Mail::raw('SES smoke test', fn ($m) => $m->to('you@example.com')->subject('TicketHub staging'));
= null     # arrives with a valid DKIM signature once the domain verifies
```

The configuration set and the bounce loop:

```
$ aws sesv2 create-configuration-set --configuration-set-name tickethub-staging
$ aws sns create-topic --name tickethub-staging-ses-events --query 'TopicArn'
"arn:aws:sns:ap-southeast-1:111122223333:tickethub-staging-ses-events"
$ aws sesv2 create-configuration-set-event-destination \
    --configuration-set-name tickethub-staging \
    --event-destination-name bounces-complaints \
    --event-destination '{"Enabled":true,"MatchingEventTypes":["BOUNCE","COMPLAINT"],
      "SnsDestination":{"TopicArn":"arn:aws:sns:ap-southeast-1:111122223333:tickethub-staging-ses-events"}}'
```

Laravel attaches the set per-mailer in `config/mail.php` (`'ses' => ['transport' => 'ses', 'options' => ['ConfigurationSetName' => 'tickethub-staging']]`), and the IAM statement for 8.4's role is send-only, scoped to the identity:

```json
{
  "Sid": "SendMail",
  "Effect": "Allow",
  "Action": ["ses:SendEmail", "ses:SendRawEmail"],
  "Resource": "arn:aws:ses:ap-southeast-1:111122223333:identity/tickethub.example"
}
```

The webhook is a stub today, wired for real once 8.4 gives the topic an HTTPS subscription to the staging URL: SNS first POSTs a `SubscriptionConfirmation` (fetch its `SubscribeURL` once), then delivers bounce/complaint JSON; the handler's whole job is *suppress that address* — a `suppressed_recipients` table your mailables check before sending. One route, one table, and your complaint rate stays survivable; Module 12 turns the same event stream into dashboards. Finally, request production access (SES console → Account dashboard → *Request production access*) using section 6's wording.

### 8. The staging `.env`, complete

The contract for everything above — Module 5's `# Module 8 (RDS) — the ONLY change` comment, honored. Secret-marked values never get typed by hand: 8.4's boot script reads them from Secrets Manager.

```dotenv
APP_NAME=TicketHub
APP_ENV=staging
APP_KEY=                 # secret — shared across instances (8.4 stores it in Secrets Manager)
APP_DEBUG=false
APP_URL=https://api.staging.tickethub.example

LOG_CHANNEL=stderr
LOG_LEVEL=info

DB_CONNECTION=mysql
DB_HOST=tickethub-staging-mysql.c9akciq32rga.ap-southeast-1.rds.amazonaws.com
DB_PORT=3306
DB_DATABASE=tickethub
DB_USERNAME=admin        # secret — from the RDS-managed secret
DB_PASSWORD=             # secret — from the RDS-managed secret

SESSION_DRIVER=redis
CACHE_STORE=redis
QUEUE_CONNECTION=redis
REDIS_CLIENT=phpredis
REDIS_HOST=tickethub-staging-redis.x1y2z3.ng.0001.apse1.cache.amazonaws.com
REDIS_PORT=6379
REDIS_SCHEME=tls
REDIS_PASSWORD=          # secret — tickethub/staging/redis-auth
REDIS_QUEUE_RETRY_AFTER=180

FILESYSTEM_DISK=s3
AWS_BUCKET=tickethub-staging-uploads
AWS_DEFAULT_REGION=ap-southeast-1
# No AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY: the EC2 instance role provides credentials (8.4)

MAIL_MAILER=ses
MAIL_FROM_ADDRESS=tickets@tickethub.example
MAIL_FROM_NAME="TicketHub"
```

### Cost recap & keep note

| Resource | Rate | ~Monthly |
|---|---|---|
| RDS `db.t4g.micro` (Single-AZ) + 20 GB gp3 | ~$0.020/hr + storage | **$17** |
| ElastiCache `cache.t4g.micro` | ~$0.018/hr | **$13** |
| Route 53 hosted zone | $0.50/zone | $0.50 |
| Secrets Manager (RDS-managed + redis-auth) | ~$0.40/secret | $0.80 |
| S3, SNS, CloudWatch alarm, SES sandbox | usage | <$1 |
| Temp `t4g.nano` (terminated in §3) | $0.005/hr | ~$0.05 total |

Running total with 8.2's NAT: **≈ $80/mo while everything is up.** **Keep it all** — RDS, Redis, the bucket, the zone, the secrets, and SES are the data tier for 8.4, Module 9's Fargate services, and Module 10's Terraform import. If you pause the course: 8.2's NAT-deletion trick still applies, and `aws rds stop-db-instance` pauses RDS compute — but remember 8.1's table: storage keeps billing and it auto-restarts after 7 days.

## Real-world best practices

- **Default to managed; write down the exceptions with an owner and a review date.** "We self-host Redis to save $40/mo" is a decision someone made in 2023 and nobody remembers — until its maintainer resigns. The inverse too: revisit managed premiums at 10× scale; the answer can legitimately flip.
- **Deletion protection plus versioning on anything stateful, from day one.** The cost is a flag; the alternative is explaining to customers where their tickets went.
- **One eviction policy per Redis *purpose* — separate clusters when purposes conflict.** Cache alone: `allkeys-lru`, let it be full. Anything holding queues or locks: `noeviction` plus a memory alarm. Sharing one instance is a cost call that must come with the alarm — ours does.
- **Buckets are private; access is presigned; the app is the only authorizer.** No public ACLs, no "temporarily public for the demo". If something must be world-readable later (event posters), that's CloudFront in front of a *still-private* bucket — never BPA off.
- **Treat deliverability as an SLO, not a checkbox.** DKIM before the first real send, bounce/complaint suppression before production access, rates watched in CloudWatch. Email reputation is the only infrastructure you cannot restore from a snapshot.
- **Drill failover and restores in staging before you need them.** A reboot-with-failover and one PITR restore per quarter turn "we think it fails over" into "94 seconds, and Horizon reconnects" — numbers you'll want mid-incident (exercises 3 and 5).

## Common pitfalls

1. **Making the database publicly accessible "just to connect from my laptop".** The console makes it one checkbox, and scanners find every public 3306 within hours. Correct approach: `--no-publicly-accessible` forever; humans connect through the SSM port-forward you just used — no inbound rules, fully audited.
2. **Keeping default parameter groups.** The defaults are generic: wrong charset (schema drift vs local's `utf8mb4`), slow query log off, and a `max_connections` you first learn about from `SQLSTATE[HY000] [1040]` during your best traffic hour. Correct approach: a custom parameter group attached *at creation*, and the fleet-connection multiplication from section 2 before every scale-out.
3. **`allkeys-lru` on the Redis that holds queues.** It's the "sensible cache default" every blog suggests, so it lands on the shared instance — and under memory pressure your queued jobs (paid orders!) evaporate without a log line. Correct approach: `noeviction` + the 80% memory alarm while sharing; separate cache and queue clusters at scale.
4. **Treating S3 like a disk with public URLs.** Devs flip the bucket public because `Storage::url()` gave 403s, and the ticket PDFs of every customer are now enumerable. Correct approach: BPA all-on is non-negotiable; downloads are `temporaryUrl()` behind your own authorization — 403s mean the *app* should sign, not that the bucket should open.
5. **Going straight from sandbox to blasting production email.** No DKIM, no bounce handling, first campaign lands in spam, complaint rate spikes, SES pauses the account — email-shaped outage. Correct approach: domain identity + DKIM verified first, configuration set with suppression wired, *then* production access with an honest use-case description.

## Exercises

1. From memory, write the two-column table: Multi-AZ vs read replica — replication mode, purpose, behavior on primary failure, Laravel config touched. Which one helps an on-sale's *browse* traffic, and why does it do nothing for checkout writes?
2. Through the SSM tunnel, create a dedicated `tickethub_app` MySQL user (`GRANT SELECT, INSERT, UPDATE, DELETE` — deliberately no DDL), store it as secret `tickethub/staging/db-app-user`, and note which later step would use it. You've just built production's credential layout.
3. Recreate the eviction disaster locally: Docker Redis with `--maxmemory 10mb --maxmemory-policy allkeys-lru`, queue 50 fake jobs, write cache keys until `LLEN` of the queue drops. Repeat with `noeviction` and observe the write exception instead. Which failure would you rather explain to a customer?
4. Price the lifecycle: 500 GB of `tickets/` PDFs, 90% older than 90 days — monthly cost with and without the STANDARD_IA rule (section 5's rates), and the break-even retrieval volume where IA stops winning.
5. **Stretch — the failover drill:** convert staging to Multi-AZ (`aws rds modify-db-instance --multi-az --apply-immediately`), hit a DB-backed endpoint once per second in a loop, then `aws rds reboot-db-instance --force-failover`. Measure seconds of errors, the exceptions Laravel threw, and whether Horizon retried cleanly. Convert back, write the numbers down — that's your production failover budget.

## What's next

TicketHub's data tier is now fully managed: RDS holding the schema, Redis with TLS waiting for sessions and queues, a locked-down bucket ready for PDFs, and a domain that can send authenticated mail. What's missing is the application itself — nothing in the VPC runs PHP yet. [Lecture 8.4 — The Classic Deployment: EC2 + ALB](04-classic-deployment-ec2-alb.md) launches two app instances from a single bootstrap script, puts an ALB with real TLS in front, and deploys TicketHub the manual way — once, deliberately, so the pain becomes Module 9's requirements list.
