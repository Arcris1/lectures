# Lecture 8.1 — Cloud Concepts & Setting Up AWS Properly

> **Module 8 — AWS Cloud Fundamentals** · Lecture 1 of 4 · Estimated time: ~90 min

Modules 1–7 took TicketHub from a laptop to a hardened VPS with CI building container images. Now the infrastructure itself moves to AWS — but not by clicking "Launch instance" on day one. This lecture is about doing the unglamorous groundwork correctly: an account that can't surprise you with a bill, an identity setup that won't leak credentials, and the IAM mental model that every later lecture (and every AWS incident postmortem) rests on. Module 7 already gave you a taste — the `tickethub-github-deploy` OIDC role that pushes images to ECR — and today you'll re-read that role's policy with full understanding. Nothing billable is created in this lecture; that starts in [Lecture 8.2](02-vpc-networking.md).

## Learning objectives

- Explain what cloud computing genuinely buys you (elasticity, opex, managed services) and what it costs you (bill complexity, vendor coupling) — without marketing gloss
- Apply the shared responsibility model to concrete decisions: what AWS patches, what you patch, and who owns a leaked access key
- Bootstrap an AWS account safely: root user locked away behind MFA, billing alerts before any resources, CloudTrail on
- Describe how real organizations structure AWS (multi-account Organizations + Identity Center) and why, while following the pragmatic solo-learner path
- Read and write IAM policy JSON: principals, effects, actions, resources, conditions, and the evaluation rules
- Configure AWS CLI v2 with named profiles and verify identity with `sts get-caller-identity`

## 1. What the cloud actually buys you — and what it costs you

Strip the marketing and the cloud sells three things.

**Elasticity.** Your VPS from Module 3 has a fixed capacity, paid for 24/7, sized for the worst hour of the year. TicketHub's traffic is the textbook case: near-zero at 4 a.m., a 50× spike the minute a popular on-sale opens. In the cloud you rent capacity by the hour (or second), add servers for the spike, and release them after. Capacity becomes a dial, not a purchase order.

**Capex → opex.** No servers bought, racked, or depreciated. You pay monthly for what ran. For a small company this converts a $20k up-front bet into a $200/month experiment — and makes it trivially easy to *waste* $200/month, which is why billing alarms come before anything else in this lecture.

**Managed services as outsourced undifferentiated heavy lifting.** Running MySQL is not TicketHub's business; selling tickets is. RDS does backups, patching, and failover; S3 does eleven-nines durability; SES does mail deliverability. You rent operational maturity that would take you years to build. [Lecture 8.3](03-core-services-rds-s3-redis.md) makes this trade-off precise.

Now the honest other column. **Bill complexity:** AWS has 200+ services with per-hour, per-GB, per-request, and per-something-you-didn't-know-existed pricing; the bill is a system you must engineer and monitor like any other. **Vendor coupling:** every managed service you adopt is API surface you'd have to replace to leave. Sensible teams accept coupling for commodity services (databases, object storage — portable concepts, swappable with effort) and think harder about proprietary glue. This course uses AWS because it's the largest ecosystem and its concepts map cleanly to the other clouds — the *concepts* are what you're really learning.

## 2. IaaS, PaaS, SaaS — and where this course sits

| Model | You manage | Provider manages | Example |
|---|---|---|---|
| On-prem / VPS (Modules 2–3) | Everything above the hardware contract | Physical machine, network drop | Your Ubuntu VPS |
| **IaaS** | OS, runtime, app, data | Hardware, virtualization, network fabric | EC2, VPC, EBS |
| **PaaS** | App and data only | OS, runtime, scaling | Elastic Beanstalk, Heroku, App Runner |
| **SaaS** | Your usage of it | Everything | GitHub, Gmail |

Managed data services (RDS, ElastiCache, S3, SES) sit between IaaS and PaaS: you control configuration and data, AWS runs the software. **This course deliberately runs IaaS + managed data services**: EC2 you configure yourself (this module), then containers on ECS (Module 9) and Kubernetes (Module 11), always with RDS/S3/ElastiCache underneath. PaaS hides exactly the mechanics a DevOps engineer must understand; you'll be able to *choose* PaaS later from knowledge, not necessity.

## 3. The shared responsibility model

AWS's phrasing is precise: **AWS is responsible for security *of* the cloud; you are responsible for security *in* the cloud.** Concretely:

- **AWS secures:** physical datacenters, the hypervisor, the network fabric, and the managed-service software (they patch the MySQL binaries under RDS, the storage fleet under S3).
- **You secure:** your AMIs and OS patching on EC2 (your `unattended-upgrades` habit from Module 2 survives the move), your security group rules, your IAM users/roles/policies, your application code, your data's encryption choices, and your secrets.

The model kills two common fantasies. "It's on AWS so it's secure" — no: the S3 breaches you read about are misconfigured *customer* bucket policies, firmly in your column. And "AWS will stop me doing something dumb" — also no: AWS will happily let you open MySQL to `0.0.0.0/0`; the guardrails in your column are built by you, starting now. A leaked access key is yours too — AWS's fraud detection may email you when your key appears on GitHub, but the miner's EC2 bill is legally your bill.

## 4. Regions and Availability Zones

A **Region** is a geographic cluster of datacenters (`ap-southeast-1` = Singapore). Regions are isolated from each other by design: resources live in exactly one region, and most console/CLI views are region-scoped — the classic "where did my instance go?" is a region selector pointing elsewhere.

An **Availability Zone (AZ)** is one or more datacenters within a region with independent power, cooling, and networking, connected to its sibling AZs by high-bandwidth, low-latency (sub-2ms) private fiber. **The AZ is your unit of failure domain**: AWS designs so that a flood, fire, or grid failure takes out at most one AZ. `ap-southeast-1` has three: `ap-southeast-1a`, `1b`, `1c`. Everything highly available in this course means "spread across at least two AZs" — two EC2 instances in one AZ share a fate; in two AZs they don't. (One subtlety: the letter→physical-datacenter mapping is shuffled per AWS account, so your `1a` may be someone else's `1c` — irrelevant unless you compare notes across accounts.)

Two factors choose your region: **latency** to your users (Singapore for Southeast Asian ticket buyers; a Frankfurt API adds ~150ms per round trip) and **data residency** — some jurisdictions require personal data to stay in-country, which is a legal constraint, not a technical one. Price and service availability vary by region too; `ap-southeast-1` runs ~15–25% above `us-east-1` for many services. The course pins `ap-southeast-1`; substitute your nearest region consistently.

## 5. Day zero: the root user

Creating an AWS account creates the **root user** — the email/password identity with irrevocable, unlimited power. It cannot be restricted by any IAM policy. Treat it like the master key to a building you never enter through the front door:

1. Use a real, monitored email (a shared alias like `aws-root@yourcompany.com` in a team — not one person's inbox).
2. Set a long random password from your password manager.
3. **Enable MFA immediately** — Console → your account name → *Security credentials* → *Assign MFA device*. A hardware key (YubiKey) is best; a TOTP app is acceptable. Store the recovery information offline.
4. Delete any root access keys if they exist (*Security credentials* → *Access keys*). Root API access is never needed.
5. Then **never log in as root again**, except for the short list AWS reserves for root only:

- Changing the account name, email address, or root password; closing the account
- Restoring permissions if your only admin locks themselves out
- Activating *IAM user and role access to Billing* (do this once, today — it lets your IAM identity see bills)
- Enabling S3 **MFA Delete** on a bucket
- A handful of others: certain tax settings, Reserved Instance marketplace seller registration, recovering specific misconfigured resource policies

Everything else — including everything in this course — happens as an IAM identity.

## 6. Guardrail one: billing alarms before anything else

Set spending alerts *before creating any resource*. Bill shock almost never comes from what you meant to run; it comes from what you forgot. The classics, with numbers:

| Forgotten thing | Rough cost | Why it bites |
|---|---|---|
| Idle NAT gateway | ~$32–43/mo | Billed per hour whether traffic flows or not ([8.2](02-vpc-networking.md)) |
| Public IPv4 address (incl. unattached EIPs) | ~$3.65/mo each | Since Feb 2024 *every* public IPv4 bills $0.005/hr |
| "Stopped" RDS misconception | storage + backups keep billing; stopped instances auto-restart after 7 days | People assume stopped = free |
| Deleted-instance leftovers | EBS volumes/snapshots ~$0.08–0.12/GB-mo | Deleting an instance can orphan its volumes |
| Unmonitored data transfer | ~$0.09–0.12/GB out to internet | Invisible until a traffic spike or a chatty script |
| EKS control plane (Module 11) | ~$73/mo | Bills from the second the cluster exists |

**AWS Budgets** is the alarm system: define a monthly limit, get emailed at thresholds. The hands-on creates a $20/month budget with alerts at 50/80/100% of actual spend plus a forecast alert. Two budgets are free (then ~$0.02/day each). Pair it with a weekly two-minute **Cost Explorer** habit: Billing console → Cost Explorer → group by *Service*, then by *Tag: Project* once tags flow (section 9). Reading your own cost curve weekly is the cheapest FinOps practice that exists — you'll catch the forgotten NAT in days, not on the invoice.

Budgets alert *after* spend happens (with hours of billing-data lag). They are a smoke detector, not a circuit breaker — teardown discipline at the end of every hands-on remains your real protection.

## 7. Identity: the solo path and the real-org path

### The solo learner path (this course)

One human, one account: create **one IAM user for yourself** with MFA, in an admin group, and use it for everything — never root. The hands-on builds: group `Administrators` with the `AdministratorAccess` managed policy **plus a policy that denies everything until MFA is present** (so a phished password alone is useless), your user in that group, and CLI access via an access key on your own user. Yes — section 8 declares access keys a last resort; a solo learner's own admin key, MFA-protected at the console and rotated, is the accepted pragmatic exception until you adopt Identity Center. Admin-for-yourself is also pragmatic: you're learning the platform and will touch dozens of services. The *workload* identities you create (instance roles, the CI role) get real least privilege — that discipline is non-negotiable.

### How real organizations do it

Real orgs don't put staging and production in one account with clever IAM separating them. They use **AWS Organizations**: many AWS accounts under one management umbrella, grouped into Organizational Units (OUs):

```
                    ┌──────────────────────┐
                    │  Management account   │  billing, org config only —
                    │  (pays the bills)     │  no workloads, ever
                    └──────────┬───────────┘
        ┌──────────────┬───────┴────────────────┐
   ┌────┴─────┐   ┌────┴─────┐         ┌────────┴────────┐
   │ Security │   │ Infra OU │         │  Workloads OU   │
   │    OU    │   │ (shared  │      ┌──┴───────┐  ┌──────┴────┐
   │ logging, │   │ network, │      │ tickethub │  │ tickethub │
   │ audit    │   │ DNS)     │      │ -staging  │  │ -prod     │
   │ accounts │   └──────────┘      │  account  │  │  account  │
   └──────────┘                     └───────────┘  └───────────┘
```

Why multi-account is the enterprise default:

- **Hard security boundary.** IAM mistakes are contained: a compromised staging credential *cannot* touch production, because production is a different account. This is the real blast-radius tool — stronger than any policy, because there's nothing to get wrong.
- **Billing separation.** Per-account bills need no tagging discipline to attribute cost.
- **Quota isolation.** AWS limits (instances per region, API rates) are per-account; a runaway staging test can't starve production's quota.

Access is then **AWS IAM Identity Center** (SSO): humans authenticate once against a central directory, and `aws sso login` issues **short-lived credentials** for a chosen account+role — no long-lived keys on laptops at all. Guardrails called **Service Control Policies (SCPs)** set the outer bounds of what *any* identity in an account can do ("nobody in this OU can leave `ap-southeast-1`", "nobody can disable CloudTrail"). You'll meet this again when Module 10's Terraform makes multi-account practical to manage; for now, know that the course's single account with `Env` tags is the scale-appropriate simplification of this picture.

## 8. IAM from first principles

Every AWS API call is authenticated (who is calling?) then authorized (may they?). IAM is the authorization engine, and it's the same engine whether the caller is you, GitHub Actions, or an EC2 instance.

**Principals** are identities that can make calls: IAM **users** (long-lived, human or legacy-machine, can hold passwords/access keys), IAM **roles** (assumable identities that issue *temporary* credentials), and AWS services acting on your behalf. **Policies** are JSON documents that grant or deny; **identity-based policies** attach to a principal ("what can this user/role do?"), **resource-based policies** attach to a thing ("who may act on this bucket/queue?" — S3 bucket policies and the trust policy on every role are the two you'll meet most).

### Policy anatomy — re-reading Module 7's ECR policy

In [Module 7](../module-07-ci-github-actions/04-building-images-in-ci.md) you attached this to `tickethub-github-deploy` and took it on faith. Read it properly now:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GetAuthToken",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "PushPullTicketHubImage",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": "arn:aws:ecr:ap-southeast-1:111122223333:repository/tickethub-api"
    }
  ]
}
```

- **`Version`** is the policy-language version — always the literal `2012-10-17` (an older one exists; never use it).
- Each **`Statement`** grants or denies one coherent capability; **`Sid`** is a human label.
- **`Effect`** is `Allow` or `Deny`.
- **`Action`** lists API calls as `service:Operation`, wildcards allowed (`ecr:Get*`). The docker-login handshake needs `GetAuthorizationToken`, which is account-wide by nature — hence `Resource: "*"` *for that action only*.
- **`Resource`** scopes by ARN — this role can push to `tickethub-api` and *no other repository*. Least privilege lives mostly in this field.
- **`Condition`** (absent here) adds context tests — you'll write one in the hands-on that checks `aws:MultiFactorAuthPresent`. Conditions power some of IAM's best tricks: source-IP restrictions, region pinning, and the OIDC `sub` claim check that limits `tickethub-github-deploy` to your repository.

### Users vs roles — and why roles are the default answer

A user's access key is a password that never expires, sitting in a file, waiting to be committed to Git. A **role** has no permanent credentials: a principal *assumes* it (if the role's **trust policy** — a resource-based policy on the role — allows) and receives temporary credentials that expire in minutes to hours. Every mechanism you'll use from here is a role:

- **EC2 instance profiles** ([8.4](04-classic-deployment-ec2-alb.md)): the instance fetches auto-rotating temporary credentials from its metadata service; your Laravel app uses the AWS SDK with *zero* keys in `.env`.
- **The Module 7 OIDC role**: GitHub proves a workflow's identity with a signed token; STS swaps it for 15-minute credentials. No secret stored in GitHub at all.
- **Cross-account access**: staging's CI assumes a role in the prod account — the multi-account glue.

Doctrine for this course: **access keys are a last resort.** Before creating one, ask which role should exist instead. The honest exceptions: your own solo-admin CLI key (section 7), and third-party tools that can't do OIDC or SSO.

### Evaluation, boundaries, and the least-privilege workflow

Evaluation basics: everything is **implicitly denied** until an `Allow` matches; an **explicit `Deny` always wins** over any Allow — which is why the MFA-enforcement policy below can override `AdministratorAccess`. Two outer fences exist beyond identity policies: **permissions boundaries** (a per-principal ceiling) and **SCPs** (the per-account ceiling from section 7). A request must survive *every* applicable layer — one paragraph of awareness now; they matter when you run platforms for other teams.

Nobody writes perfect least-privilege policies on day one — the action lists are too vast. The pragmatic workflow real teams use: **start** from an AWS managed policy or a broad-but-resource-scoped statement; **run** the workload so CloudTrail records what it actually calls; **narrow** using IAM Access Analyzer, which can generate a policy from CloudTrail activity (IAM console → role → *Generate policy*); **repeat** after features change. Access Analyzer also flags unused permissions and externally shared resources continuously. Least privilege is a process, not an event.

## 9. Tags, cost allocation, and the audit trail

**Tagging governance starts with resource one**, because retro-tagging hundreds of resources is a punishment. The course standard, on everything that supports tags:

| Key | Value |
|---|---|
| `Project` | `tickethub` |
| `Env` | `staging` or `production` |
| `Owner` | your team/email |
| `ManagedBy` | `manual` for now — becomes `terraform` in Module 10 |

Tags drive cost attribution (activate them as **cost-allocation tags** so Cost Explorer can group by `Project`/`Env`), automation ("stop everything tagged `Env=staging` at night"), and IAM conditions. Module 10 sets these automatically via Terraform `default_tags` — the governance you define today becomes one block of HCL there.

**CloudTrail** is the flight recorder: every management API call (who, what, when, from which IP) is retained 90 days for free in *Event history* — on by default, nothing to enable. When someone asks "who opened port 3306 to the world?", CloudTrail answers. Creating a *trail* (copying events to S3 for longer retention/alerting) is the production step — the first copy of management events is free beyond S3 storage pennies; Module 12 builds alerting on it. Today, just verify you can query Event history.

## Hands-on with TicketHub

⚠️ **Cost check: this lecture creates $0.00 of infrastructure.** Budgets (first two free), IAM, and CloudTrail Event history are free. The meter starts in Lecture 8.2.

### 1. Root hygiene (console)

Sign in as root → *Security credentials*: assign MFA (TOTP or hardware key), confirm zero root access keys. Then Billing console → *Account* → activate **IAM user and role access to Billing information**. Sign out of root. You should not need it again this course.

### 2. Install AWS CLI v2 and a temporary bootstrap

On your laptop (Linux/WSL2 shown; macOS uses the `.pkg` or Homebrew):

```
$ curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
$ unzip -q awscliv2.zip && sudo ./aws/install
$ aws --version
aws-cli/2.17.30 Python/3.11.9 Linux/6.8.0 exe/x86_64
```

Chicken-and-egg: the CLI needs credentials, but your IAM user doesn't exist yet. Create the first pieces in the console as root *one last time*, or — cleaner — create the IAM user in the console now, log in as it, and do everything below from there. Either way, the commands are the record of what exists.

### 3. Admin group with enforced MFA

Write the MFA-enforcement policy (condensed from AWS's documented version — it lets a user manage only their own MFA/password, and denies everything else until MFA is present):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSelfServiceMFA",
      "Effect": "Allow",
      "Action": [
        "iam:ChangePassword", "iam:GetUser",
        "iam:CreateVirtualMFADevice", "iam:EnableMFADevice",
        "iam:ListMFADevices", "iam:ResyncMFADevice"
      ],
      "Resource": [
        "arn:aws:iam::111122223333:user/${aws:username}",
        "arn:aws:iam::111122223333:mfa/${aws:username}"
      ]
    },
    {
      "Sid": "DenyAllExceptSelfServiceWithoutMFA",
      "Effect": "Deny",
      "NotAction": [
        "iam:ChangePassword", "iam:GetUser",
        "iam:CreateVirtualMFADevice", "iam:EnableMFADevice",
        "iam:ListMFADevices", "iam:ResyncMFADevice",
        "sts:GetSessionToken"
      ],
      "Resource": "*",
      "Condition": {
        "BoolIfExists": { "aws:MultiFactorAuthPresent": "false" }
      }
    }
  ]
}
```

Note the moves: `NotAction` + `Deny` means "deny everything *except* this self-service list", and `BoolIfExists` catches requests where the MFA key is absent entirely. Explicit deny beats the `AdministratorAccess` allow — section 8's evaluation rule doing real work. Create the pieces (shown with the user `alice`; use your name):

```
$ aws iam create-policy --policy-name ForceMFA \
    --policy-document file://force-mfa.json
{
    "Policy": { "PolicyName": "ForceMFA",
        "Arn": "arn:aws:iam::111122223333:policy/ForceMFA" }
}
$ aws iam create-group --group-name Administrators
$ aws iam attach-group-policy --group-name Administrators \
    --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
$ aws iam attach-group-policy --group-name Administrators \
    --policy-arn arn:aws:iam::111122223333:policy/ForceMFA
$ aws iam create-user --user-name alice
$ aws iam add-user-to-group --group-name Administrators --user-name alice
$ aws iam create-login-profile --user-name alice \
    --password 'use-a-long-generated-password' --password-reset-required
```

Log in to the console as `alice` (account ID `111122223333`, not the root email), set your password, register MFA — the deny policy will block everything until you do, which proves it works.

### 4. CLI profile

```
$ aws iam create-access-key --user-name alice
{
    "AccessKey": {
        "AccessKeyId": "AKIAIOSFODNN7EXAMPLE",
        "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    }
}
$ aws configure --profile tickethub-staging
AWS Access Key ID [None]: AKIAIOSFODNN7EXAMPLE
AWS Secret Access Key [None]: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Default region name [None]: ap-southeast-1
Default output format [None]: json
$ export AWS_PROFILE=tickethub-staging
$ aws sts get-caller-identity
{
    "UserId": "AIDACKCEVSQ6C2EXAMPLE",
    "Account": "111122223333",
    "Arn": "arn:aws:iam::111122223333:user/alice"
}
```

Named profiles keep future environments separate (`--profile` or `AWS_PROFILE`); `get-caller-identity` is the "who am I" you'll run before anything destructive, forever. Output formats: `json` for scripts, `--output table` for humans, `--output text` for piping — and `--dry-run` exists on many EC2 commands to test permissions without acting. Every lecture from here assumes `AWS_PROFILE=tickethub-staging` is exported.

### 5. The $20 budget with tiered alerts

```json
{ "BudgetName": "tickethub-monthly", "BudgetType": "COST",
  "TimeUnit": "MONTHLY",
  "BudgetLimit": { "Amount": "20", "Unit": "USD" } }
```

```json
[
  { "Notification": { "NotificationType": "ACTUAL", "ComparisonOperator": "GREATER_THAN",
      "Threshold": 50, "ThresholdType": "PERCENTAGE" },
    "Subscribers": [ { "SubscriptionType": "EMAIL", "Address": "you@example.com" } ] },
  { "Notification": { "NotificationType": "ACTUAL", "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80, "ThresholdType": "PERCENTAGE" },
    "Subscribers": [ { "SubscriptionType": "EMAIL", "Address": "you@example.com" } ] },
  { "Notification": { "NotificationType": "ACTUAL", "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100, "ThresholdType": "PERCENTAGE" },
    "Subscribers": [ { "SubscriptionType": "EMAIL", "Address": "you@example.com" } ] },
  { "Notification": { "NotificationType": "FORECASTED", "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100, "ThresholdType": "PERCENTAGE" },
    "Subscribers": [ { "SubscriptionType": "EMAIL", "Address": "you@example.com" } ] }
]
```

```
$ aws budgets create-budget --account-id 111122223333 \
    --budget file://budget.json \
    --notifications-with-subscribers file://notifications.json
$ aws budgets describe-budgets --account-id 111122223333 \
    --query 'Budgets[].BudgetName'
[
    "tickethub-monthly"
]
```

Confirm the subscription emails arrive. The FORECASTED alert is the early-warning one: it fires when the month's *trajectory* crosses $20, often days before actual spend does. While you're in the Billing console, open **Cost Explorer** once so it starts populating (it needs ~24h to backfill).

### 6. Cost-allocation tags and CloudTrail check

Cost-allocation activation only lists tag keys AWS has already *seen* on a resource, so run this after Lecture 8.2 creates the first tagged resources (it also takes up to 24h to appear):

```
$ aws ce update-cost-allocation-tags-status --cost-allocation-tags-status \
    TagKey=Project,Status=Active TagKey=Env,Status=Active TagKey=ManagedBy,Status=Active
```

Finally, prove the flight recorder is rolling — find your own user creation:

```
$ aws cloudtrail lookup-events \
    --lookup-attributes AttributeKey=EventName,AttributeValue=CreateUser \
    --max-results 1 --query 'Events[0].{When:EventTime,Who:Username}'
{
    "When": "2026-08-09T07:14:52+00:00",
    "Who": "root"
}
```

There it is: the fact that `alice` was created by root, timestamped, unerasable. Everything you do from now on leaves the same trail.

## Real-world best practices

- **Root exists to be unused.** MFA'd, keyless, monitored inbox, touched only for the root-only list. Teams go further: hardware key in a literal safe. The measure of good root hygiene is that nobody remembers the last login.
- **Billing alarms are infrastructure, priority zero.** Every horror story ("$14k weekend") includes the sentence "we had no alerts". Budget + weekly Cost Explorer review from day one; in Module 10 the budget itself becomes Terraform code.
- **Roles by default; keys need a justification written down.** Instance profiles, OIDC, SSO — every modern access path is a role issuing temporary credentials. Where a long-lived key truly is required, it gets an owner, a rotation date, and a least-privilege policy.
- **Multi-account is the real isolation tool — adopt it when a second human or first real customer arrives.** IAM inside one account separates *permissions*; accounts separate *blast radius*. Solo learning in one account is fine; production companies in one account is technical debt with a countdown timer.
- **Least privilege is iterative — budget for the iteration.** Start scoped-but-generous, generate tighter policies from CloudTrail with Access Analyzer, review quarterly. Teams that demand perfect policies up front end up rubber-stamping `*:*` "temporarily," forever.
- **Tag at creation, enforce in review.** A resource without `Project`/`Env`/`Owner` tags is unattributable cost and unanswerable pages. Make tags part of the definition of "created properly" — the habit pays compound interest in Modules 10 and 12.

## Common pitfalls

1. **Daily-driving the root account.** It works, it's already logged in, and IAM feels like ceremony — until a phished root password owns everything with no policy able to stop it. Correct approach: root → MFA → walk away; admin IAM user (later SSO) for daily work.
2. **Skipping billing alerts because "I'll only run small stuff".** The forgotten NAT gateway doesn't know it was small stuff; it bills $1+/day for months. Correct approach: the $20 budget *before* the first resource — it took four commands.
3. **Access keys in `.env`, committed "just for a second".** Scanners find keys on GitHub in under a minute; miners spend your quota within the hour. Correct approach: roles everywhere (instance profiles, OIDC); for your solo key, `.aws/credentials` only — never inside a repo — plus MFA enforcement so the key alone can't do console damage. If a key ever touches Git: revoke first, investigate second.
4. **Testing policies by "it worked for me".** An over-broad policy also "works" — you can't feel excess permissions until they're abused. Correct approach: scope `Resource` ARNs always, read the policy asking "what's the *worst* this allows", and let Access Analyzer generate the narrow version from real activity.
5. **Building in the wrong region and discovering it at bill time.** The console remembers its own last region, not your intent; half your resources end up in `us-east-1`, unfindable and billing. Correct approach: region pinned in your CLI profile, region visible in every console session, and (in real orgs) an SCP that denies everything outside approved regions.

## Exercises

1. Write down, from memory, the split of responsibilities for TicketHub-on-EC2: who patches the hypervisor, the Ubuntu kernel, PHP 8.4? Who is at fault if port 3306 is open to the internet? Check yourself against section 3.
2. Using only `aws iam` read commands (`list-groups-for-user`, `list-attached-group-policies`, `get-policy-version`), reconstruct exactly what `alice` can do and paste the JSON of every attached policy.
3. Trigger your own MFA guardrail: from a fresh terminal, configure a profile with `alice`'s key and run `aws iam list-users`. It succeeds — explain precisely why the ForceMFA policy doesn't block CLI access-key calls (hint: `BoolIfExists`, and what "MFA present" means for an access-key request). Then write the two-sentence risk assessment of this gap for a solo learner.
4. Draft the least-privilege policy for a hypothetical `tickethub-billing-viewer` user for your accountant: Cost Explorer + Budgets read, nothing else. Attach it to a test user, verify Cost Explorer loads and `aws s3 ls` fails with `AccessDenied`.
5. **Stretch:** create a second AWS account with a `+alias` email, build a two-account Organization (management + `tickethub-sandbox` under a `Workloads` OU), and attach an SCP to the OU denying all actions outside `ap-southeast-1` (`aws:RequestedRegion` condition). Verify from the sandbox account that `aws ec2 describe-instances --region us-east-1` is denied. Total cost: $0 — and you've built a miniature landing zone.

## What's next

You now have an AWS account that can't silently drain your wallet, an identity model you can defend, and the IAM grammar every later policy will use. Time to build the first real infrastructure: [Lecture 8.2 — Networking in AWS: VPC](02-vpc-networking.md) constructs `tickethub-staging-vpc` — subnets, routing, NAT, and the security-group chain — entirely from the CLI, and it's where the cost meter officially starts.
