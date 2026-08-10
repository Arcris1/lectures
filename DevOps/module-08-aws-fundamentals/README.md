# Module 8 — AWS Cloud Fundamentals

**Level: Intermediate**

This is the module where TicketHub's infrastructure leaves the single VPS and becomes cloud architecture. Not by clicking "Launch instance" on day one — the order is deliberate: first an AWS account that can't surprise you (root locked behind MFA, budgets before resources, the IAM mental model every later policy rests on), then a network built entirely from the CLI (`tickethub-staging-vpc`: six subnets across two AZs, NAT, and a security-group chain with no port 22 anywhere), then the managed data tier — RDS MySQL, ElastiCache Redis, S3, and SES — which Module 5's twelve-factor work lets you adopt with essentially zero application changes.

The finale is the classic deployment: two EC2 instances bootstrapped from one script, Horizon under systemd, a scheduler made safe on N servers, and an ALB with ACM TLS and Route 53 in front — **the last manual deployment in the course**, done once and audited honestly. The pains you record become Module 9's requirements, and every resource you build is kept: Module 9 deploys containers onto this VPC and data tier, and Module 10 rebuilds all of it as Terraform.

⚠️ **This is the first module that costs real money** — roughly $135/month while the full staging stack runs (~$4.50/day). Every lecture lists what it creates, with rates, and ends with teardown or keep-for-next-module notes.

## Prerequisites

- Modules 1–7 completed — this module leans hard on Module 2 (systemd, hardening mindset), Module 3 (nginx/PHP-FPM tuning, TLS, proxy and health-check theory), Module 5 (twelve-factor config, Redis sessions/cache/queues, `Storage` facade), and Module 7 (the `tickethub-github-deploy` OIDC role and ECR images)
- An AWS account with a payment method attached, and the willingness to spend a few dollars while labs run
- A domain you control (the lectures write `tickethub.example`) with access to its registrar's NS settings
- AWS CLI v2 and the Session Manager plugin on your machine; PHP 8.4 + Composer and your TicketHub checkout for the Laravel work

## Lectures

1. [Cloud Concepts & Setting Up AWS Properly](01-cloud-concepts-account-setup.md) — what the cloud buys and costs, shared responsibility, regions and AZs, root-user hygiene, budgets before resources, IAM policy JSON from first principles, users vs roles, tagging governance, and CloudTrail. Creates $0 of infrastructure.
2. [Networking in AWS: VPC](02-vpc-networking.md) — CIDR planning that survives growth, what "public subnet" precisely means, NAT economics and the free S3 gateway endpoint, the four-security-group chain built on SG references, NACLs honestly, and flow-log debugging. The cost meter starts here.
3. [Core Services for TicketHub](03-core-services-rds-s3-redis.md) — the managed-vs-self-managed decision framework, then RDS MySQL (parameter groups, the connection budget, Multi-AZ failover as Laravel experiences it), ElastiCache Redis with TLS and a queue-safe eviction policy, a locked-down S3 bucket with lifecycle rules, SES with DKIM and bounce handling — and the schema migrated over an SSM tunnel with no bastion.
4. [The Classic Deployment: EC2 + ALB](04-classic-deployment-ec2-alb.md) — Graviton instances bootstrapped from one user-data script, SSM-only access with zero open admin ports, Parameter Store/Secrets Manager config, Horizon and `onOneServer()`, ALB + ACM + Route 53, a live failover demo — and the pain audit that becomes Module 9's requirements.

## After this module you can…

- Bootstrap an AWS account that can't silently drain your wallet, and read or write IAM policy JSON with least privilege as a process
- Design and build a multi-AZ VPC from the CLI — subnets, routing, NAT, endpoints — and encode an architecture in a security-group chain
- Argue managed vs self-managed per service, and provision RDS, ElastiCache, S3, and SES the way production teams do
- Reach private infrastructure through SSM Session Manager — no SSH keys, no bastion, no open ports — and migrate a Laravel schema onto RDS through it
- Put an ALB with ACM TLS, tuned health checks, and connection draining in front of a fleet, and prove failover works before users need it to
- Name each failure mode of manual deployment and which upcoming module eliminates it

**Next:** [Module 9 — Continuous Delivery & Deployment Strategies](../module-09-cd-deployment-strategies/)
