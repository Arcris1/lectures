# Lecture 8.2 — Networking in AWS: VPC

> **Module 8 — AWS Cloud Fundamentals** · Lecture 2 of 4 · Estimated time: ~90 min

Everything you deploy on AWS lives inside a network you define — and every mysterious "connection timed out" you will ever debug on AWS is a fact about that network. This lecture builds `tickethub-staging-vpc` completely, from CIDR plan to security-group chain, entirely with the CLI. You already know the underlying concepts: [Module 3](../module-03-networking-web-servers/01-how-the-web-works.md) taught you IPs, private ranges, ports, and routing on one box. A VPC is those same ideas turned into API calls — which is precisely what makes them Terraform-able in Module 10. Build it by hand once; understand it forever.

## Learning objectives

- Map the networking concepts from Module 3 onto their AWS constructs: VPC, subnet, route table, gateway, security group
- Plan CIDR ranges that survive growth, peering, and a production twin — and defend the /20-per-tier-per-AZ layout
- State precisely what makes a subnet "public" (the two ingredients) and how route tables select a route
- Choose NAT topology with open eyes — cost vs AZ-independence — and eliminate the S3-through-NAT cost trap with a gateway endpoint
- Build the four-security-group chain (ALB → app → MySQL/Redis) using SG references instead of CIDRs, and explain why that's superior
- Read a VPC Flow Log line and diagnose a security-group mistake from it

## 1. From one box to a software-defined network

On the Module 3 VPS, the network was given to you: one public IP, one NIC, a kernel routing table you looked at once, and `ufw` guarding the ports. AWS hands you the whole network as a set of objects with APIs:

| You knew (Module 2–3) | AWS construct |
|---|---|
| The datacenter's LAN | **VPC** — your isolated slice of the region's network, spanning all AZs |
| A network segment / VLAN | **Subnet** — a CIDR slice of the VPC, pinned to exactly one AZ |
| The kernel routing table | **Route table** — attached to subnets, decides where packets go next |
| Your router's uplink | **Internet Gateway (IGW)** — the VPC's door to the internet |
| Home-router NAT | **NAT Gateway** — outbound-only internet for private subnets |
| `ufw` on the host | **Security group (SG)** — a stateful firewall attached to network interfaces |
| Rarely: subnet ACLs on managed switches | **Network ACL (NACL)** — stateless subnet-level filter |

"Software-defined" is not a slogan: every row above is created, inspected, and destroyed by API call. Today that means CLI commands you can re-run; in Module 10 it means fifty lines of Terraform.

## 2. CIDR planning that won't hurt later

Per [TICKETHUB.md](../TICKETHUB.md): production gets `10.0.0.0/16`, staging gets `10.1.0.0/16`. Two decisions are buried in that line, both load-bearing:

**Non-overlapping environments.** VPC peering, VPNs to an office, and Transit Gateways all refuse (or mangle) overlapping ranges. If staging and prod both squat on `10.0.0.0/16`, the day you need staging to reach a shared tooling VPC is the day you renumber a live network — a legendary misery. Distinct /16s per environment, decided on day one, cost nothing and prevent it.

**Room to subdivide.** A /16 is 65,536 addresses. We carve it into **/20 subnets (4,096 addresses each)** — one per tier per AZ. Sixteen /20s fit in a /16; staging uses six, leaving ten for the future (a third AZ, an EKS pod tier in Module 11, whatever 2027 brings). AWS reserves 5 addresses in every subnet (network, router, DNS, spare, broadcast), which only matters in tiny subnets — another reason not to be stingy. Oversized subnets are free; resizing live ones is impossible (you add new subnets instead, and the sprawl begins).

The standard three-tier layout — this module's reference diagram, worth committing to memory:

```
                             Internet
                                │
                          ┌─────┴─────┐
                          │    IGW    │  tickethub-staging-igw
                          └─────┬─────┘
tickethub-staging-vpc 10.1.0.0/16
┌───────────────────────────────┼───────────────────────────────────┐
│        ap-southeast-1a        │           ap-southeast-1b         │
│  ┌─────────────────────────┐  │  ┌─────────────────────────────┐  │
│  │ public-a   10.1.0.0/20  │◄─┴─►│ public-b    10.1.16.0/20    │  │
│  │  ALB node · NAT gateway │     │  ALB node                   │  │
│  └────────────┬────────────┘     └──────────────┬──────────────┘  │
│  ┌────────────▼────────────┐     ┌──────────────▼──────────────┐  │
│  │ app-a      10.1.32.0/20 │     │ app-b       10.1.48.0/20    │  │
│  │  EC2 (8.4) → ECS (M9)   │     │  EC2 → ECS                  │  │
│  └────────────┬────────────┘     └──────────────┬──────────────┘  │
│  ┌────────────▼────────────┐     ┌──────────────▼──────────────┐  │
│  │ data-a     10.1.64.0/20 │     │ data-b      10.1.80.0/20    │  │
│  │  RDS · ElastiCache      │     │  RDS standby (prod)         │  │
│  └─────────────────────────┘     └─────────────────────────────┘  │
│         10.1.96.0/20 … 10.1.240.0/20 reserved for the future      │
└───────────────────────────────────────────────────────────────────┘
```

Per AZ: a **public subnet** (things that must be internet-reachable: ALB nodes, the NAT gateway), a **private-app subnet** (EC2 now, ECS tasks in Module 9 — reachable only via the ALB), and a **private-data subnet** (RDS, ElastiCache — reachable only from the app tier). Staging uses two AZs — the minimum for the ALB, which *requires* subnets in at least two AZs, and enough to practice multi-AZ thinking. Production uses all three (`1a/1b/1c`); note it now, build it in Module 10.

## 3. What makes a subnet "public" — precisely

"Public subnet" is not a checkbox; it's an emergent property of **two ingredients people conflate**:

1. **Its route table has a route `0.0.0.0/0 → igw-…`** — packets to the internet have a way out (and the IGW a way in).
2. **Instances launched in it get a public IP** — either the subnet's *auto-assign public IPv4* setting or an explicit assignment at launch.

Miss #1 and traffic has no path regardless of IPs. Miss #2 and the path exists but your instance has no address the internet can reach — the IGW is a **stateless 1:1 NAT**: it translates a specific public IP to a specific private IP and back, nothing more. No public IP, no translation, no reachability. Half the "I can't SSH to my instance" posts on the internet are one of these two ingredients missing. (We won't be SSHing at all — [Lecture 8.4](04-classic-deployment-ec2-alb.md) — but the mechanics still gate the ALB and NAT.)

**Route table mechanics.** Every subnet is associated with exactly one route table (the VPC's *main* table if you don't say otherwise — leave the main table pristine so an unassociated subnet defaults to private). Routes match by **longest prefix**: a packet to `10.1.64.20` matches the automatic `10.1.0.0/16 → local` route (every VPC route table has it; it cannot be deleted; it always wins for intra-VPC traffic) rather than `0.0.0.0/0`. So one route table per *tier*, not per subnet: all public subnets share `…-public-rt` (default → IGW), all private subnets share `…-private-rt` (default → NAT). Prod refines this to one private RT per AZ — section 4 explains why.

## 4. Private egress: NAT gateway, its bill, and the free S3 fix

Instances in private subnets still need *outbound* internet — `apt upgrade`, Composer, calling Stripe. The **NAT gateway** is AWS's managed answer: many private IPs share one public IP for outbound connections; unsolicited inbound is impossible (it's the same trick your home router plays, run as a managed, auto-scaling service). It lives *in a public subnet* (it needs the IGW) and is billed **~$0.045–0.059/hr (region-dependent; ap-southeast-1 is $0.059 ≈ $43/month) plus the same again per GB processed**.

That per-GB meter is the famous trap, in two flavors:

- **S3 traffic through NAT.** Your app in a private subnet pushes ticket PDFs to S3; "S3" resolves to public IPs, so every byte transits the NAT at $0.059/GB. Teams have paid four figures monthly for traffic to a service *in the same region*. The fix is free and permanent: an **S3 Gateway Endpoint** — an entry in your route tables that sends S3-bound traffic across AWS's private fabric, no NAT, no charge, faster. There is no reason to ever run an AWS VPC without one (DynamoDB has the same free gateway type; other services use *interface endpoints*, which cost per-hour and are a later optimization). We wire it today, before the first byte flows.
- **Cross-AZ NAT.** One NAT gateway lives in one AZ. Instances in *other* AZs reaching it pay cross-AZ data transfer ($0.01/GB each way) on top — and, worse, if the NAT's AZ dies, *every* AZ loses egress, defeating your multi-AZ design.

Hence the honest trade-off, stated as course policy: **staging runs one NAT total** (≈$43/mo, accepting the shared fate — staging's job is parity of shape, not parity of resilience); **production runs one NAT per AZ** with per-AZ private route tables pointing at the local NAT (≈$130/mo for three, buying AZ-independence). This is a genuinely contested cost/availability dial in real teams; what's not contested is that you should *decide* it, not inherit it from a tutorial.

## 5. Security groups, deeply

A security group is a **stateful, allow-only firewall attached to network interfaces (ENIs)** — not to subnets. Every EC2 instance, RDS instance, ElastiCache node, and ALB has ENIs, and therefore SGs.

- **Stateful:** allow the inbound request and the response flows automatically — no return rule, no ephemeral-port gymnastics (contrast with NACLs, section 6). Same for outbound: your app can call `api.stripe.com:443` because outbound is open by default, and the response comes back regardless of inbound rules.
- **Allow-only:** rules only permit; anything unmatched is dropped. There is no "deny" rule to order — SGs have no rule numbers at all.
- **The killer feature — rules can reference other SGs.** "Allow 3306 *from sg-app*" means: from any ENI that has `sg-app` attached, *right now*. Membership follows instances automatically: scale from two app servers to ten and the database rule already covers them; an instance removed from the app tier loses access the same second. A CIDR rule (`allow 3306 from 10.1.32.0/20`) is a statement about *addresses* — it trusts whatever occupies the subnet, including the compromised bastion someone parks there next year, and silently misses the app tier's move to new subnets in Module 11. **SG references express intent ("the app tier"), CIDRs express coordinates.** Intent survives change.

TicketHub's chain — the whole staging security model in one table:

| SG name | Inbound | Source | Why |
|---|---|---|---|
| `tickethub-staging-alb-sg` | 443, 80 | `0.0.0.0/0` | Public HTTPS; 80 exists only to serve the 301 redirect ([8.4](04-classic-deployment-ec2-alb.md)) |
| `tickethub-staging-app-sg` | 80 | `alb-sg` | Only the ALB may reach nginx; no SSH — no port 22 at all |
| `tickethub-staging-mysql-sg` | 3306 | `app-sg` | Only the app tier may reach RDS |
| `tickethub-staging-redis-sg` | 6379 | `app-sg` | Only the app tier may reach ElastiCache |

Read it as a directed graph: internet → ALB → app → data, each arrow an SG reference, no CIDR anywhere except the internet edge. This is Module 2's hardening mindset ("every open port is a promise") upgraded: the database's exposure isn't "a firewall rule you remembered" — it's a structural property of the graph.

## 6. NACLs, honestly

Network ACLs are the *other* firewall: **stateless, subnet-level, numbered allow/deny rules evaluated in order**. Stateless means return traffic needs its own rule — allow inbound 443 and you must also allow outbound **ephemeral ports (1024–65535)** for the responses, and vice versa. Get it half-right and you produce maddening hangs (SYN arrives, SYN-ACK dies leaving).

Plain guidance: **leave the default NACL (allow-all) alone.** SGs already give you stateful least privilege at the resource level. NACLs earn their pain in narrow cases — compliance regimes that demand subnet-level segmentation evidence, or a blunt "block this abusive /24 at the door" (the one thing allow-only SGs can't express). If you ever do use them, change one direction at a time and keep the ephemeral-port rule pinned to your monitor. Interviews love NACL-vs-SG; production loves default NACLs.

## 7. DNS inside the VPC

Two VPC attributes control name resolution: `enableDnsSupport` (the VPC's resolver works) and `enableDnsHostnames` (instances get DNS names). New custom VPCs default hostnames **off** — we switch both on, because RDS and ElastiCache hand you *hostnames*, not IPs (their IPs change on failover; the DNS flip is the failover mechanism — [8.3](03-core-services-rds-s3-redis.md)).

The resolver lives at **VPC base + 2** (`10.1.0.2` for us) — the Route 53 Resolver, reachable only from inside. It resolves public names, AWS service names (including the magic that makes the S3 endpoint transparent), and **private hosted zones**: Route 53 zones visible only within chosen VPCs, so `mysql.staging.internal` can point wherever you like without touching public DNS. One paragraph of awareness now; they become useful when service counts grow.

## 8. The debugging toolkit: Flow Logs and Reachability Analyzer

You can't `tcpdump` an ALB or an RDS instance. **VPC Flow Logs** are the substitute: metadata records (no payloads) of every connection attempt an ENI sees — accepted *and rejected* — delivered to CloudWatch Logs or S3. Enable REJECT-only logging on the whole VPC and you get a permanent, near-free answer to "is a firewall eating my packets?". Read one:

```
2 111122223333 eni-0d9e8f7a6b5c40123 10.1.33.15 10.1.65.20 43512 3306 6 1 40 1754725500 1754725559 REJECT OK
```

Fields: version, account, the ENI that saw it, **source `10.1.33.15`** (an address in `app-a`, 10.1.32.0/20), **destination `10.1.65.20`** (in `data-a`, 10.1.64.0/20), source port 43512 (ephemeral), **destination port 3306**, protocol 6 (TCP), packets/bytes, window start/end, **REJECT**. Diagnosis, straight off the line: an app-tier instance tried to reach MySQL and the packet was *dropped at the destination ENI* — routing was fine (the packet arrived), so this is `mysql-sg` lacking (or mis-scoping) its inbound rule — say, someone wrote a CIDR for the wrong subnet instead of referencing `app-sg`. Fix the rule; the retry logs ACCEPT. That's the workflow: *symptom (timeout) → flow log (who dropped it) → SG/NACL (why)*.

**Reachability Analyzer** is the static complement: give it source and destination (instance, ENI, IGW), and it analyzes your route tables, SGs, and NACLs to prove a path exists — or names the exact hop that blocks it — without sending a packet (~$0.10 per analysis). Perfect for "should this work?" before anything is even running.

## Hands-on with TicketHub

Build `tickethub-staging-vpc` end to end. ⚠️ **Cost warning — the meter starts here:** the NAT gateway bills **$0.059/hr (~$43/mo) + $0.059/GB** and its public IPv4 **$0.005/hr (~$3.65/mo)** from the moment they exist. Everything else in this lecture — VPC, subnets, route tables, IGW, SGs, S3 endpoint — is $0. REJECT-only flow logs cost pennies. **This VPC is kept**: Lectures 8.3–8.4 and Modules 9–10 build inside it.

Export your profile (`AWS_PROFILE=tickethub-staging`) and tag everything. The full tag set is shown once; every subsequent `--tag-specifications` abbreviates to `Name` for page-width, but **you apply all four keys every time** (Lecture 8.1's governance):

### 1. VPC and DNS attributes

```
$ aws ec2 create-vpc --cidr-block 10.1.0.0/16 \
    --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=tickethub-staging-vpc},{Key=Project,Value=tickethub},{Key=Env,Value=staging},{Key=Owner,Value=platform},{Key=ManagedBy,Value=manual}]' \
    --query 'Vpc.{Id:VpcId,Cidr:CidrBlock}'
{
    "Id": "vpc-0a1b2c3d4e5f67890",
    "Cidr": "10.1.0.0/16"
}
$ aws ec2 modify-vpc-attribute --vpc-id vpc-0a1b2c3d4e5f67890 --enable-dns-support
$ aws ec2 modify-vpc-attribute --vpc-id vpc-0a1b2c3d4e5f67890 --enable-dns-hostnames
```

### 2. Six subnets across two AZs

```
$ aws ec2 create-subnet --vpc-id vpc-0a1b2c3d4e5f67890 \
    --cidr-block 10.1.0.0/20 --availability-zone ap-southeast-1a \
    --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=tickethub-staging-public-a}]' \
    --query 'Subnet.SubnetId'
"subnet-0c2b7d1e4a9f83001"
```

Repeat for the remaining five (same command shape; IDs you'll reuse all module):

| Name | CIDR | AZ | SubnetId |
|---|---|---|---|
| `tickethub-staging-public-a` | 10.1.0.0/20 | 1a | `subnet-0c2b7d1e4a9f83001` |
| `tickethub-staging-public-b` | 10.1.16.0/20 | 1b | `subnet-0d3c8e2f5b0a94002` |
| `tickethub-staging-app-a` | 10.1.32.0/20 | 1a | `subnet-0e4d9f306c1ba5003` |
| `tickethub-staging-app-b` | 10.1.48.0/20 | 1b | `subnet-0f5e0a417d2cb6004` |
| `tickethub-staging-data-a` | 10.1.64.0/20 | 1a | `subnet-0a6f1b528e3dc7005` |
| `tickethub-staging-data-b` | 10.1.80.0/20 | 1b | `subnet-0b7a2c639f4ed8006` |

Public-subnet ingredient #2 — auto-assign public IPs — on the two public subnets only:

```
$ aws ec2 modify-subnet-attribute --subnet-id subnet-0c2b7d1e4a9f83001 --map-public-ip-on-launch
$ aws ec2 modify-subnet-attribute --subnet-id subnet-0d3c8e2f5b0a94002 --map-public-ip-on-launch
```

### 3. Internet Gateway and NAT

```
$ aws ec2 create-internet-gateway \
    --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=tickethub-staging-igw}]' \
    --query 'InternetGateway.InternetGatewayId'
"igw-0fedcba9876543210"
$ aws ec2 attach-internet-gateway --internet-gateway-id igw-0fedcba9876543210 \
    --vpc-id vpc-0a1b2c3d4e5f67890

$ aws ec2 allocate-address --domain vpc --query 'AllocationId'
"eipalloc-0abc123def4567890"
$ aws ec2 create-nat-gateway --subnet-id subnet-0c2b7d1e4a9f83001 \
    --allocation-id eipalloc-0abc123def4567890 \
    --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=tickethub-staging-nat}]' \
    --query 'NatGateway.{Id:NatGatewayId,State:State}'
{
    "Id": "nat-0a1b2c3d4e5f11111",
    "State": "pending"
}
$ aws ec2 wait nat-gateway-available --nat-gateway-ids nat-0a1b2c3d4e5f11111
```

The NAT sits in `public-a` — one NAT total, the staging policy from section 4. `aws ec2 wait` blocks until it's usable (a minute or two). Billing has begun.

### 4. Route tables: one per tier

```
$ aws ec2 create-route-table --vpc-id vpc-0a1b2c3d4e5f67890 \
    --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=tickethub-staging-public-rt}]' \
    --query 'RouteTable.RouteTableId'
"rtb-00aaaa1111bbbb001"
$ aws ec2 create-route --route-table-id rtb-00aaaa1111bbbb001 \
    --destination-cidr-block 0.0.0.0/0 --gateway-id igw-0fedcba9876543210
{
    "Return": true
}
$ aws ec2 create-route-table --vpc-id vpc-0a1b2c3d4e5f67890 \
    --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=tickethub-staging-private-rt}]' \
    --query 'RouteTable.RouteTableId'
"rtb-00bbbb2222cccc002"
$ aws ec2 create-route --route-table-id rtb-00bbbb2222cccc002 \
    --destination-cidr-block 0.0.0.0/0 --nat-gateway-id nat-0a1b2c3d4e5f11111
{
    "Return": true
}
```

Associate: public RT with both public subnets, private RT with all four private subnets (app + data — the data tier gets NAT egress too, for RDS to reach AWS APIs during maintenance; nothing *inbound* changes):

```
$ for s in subnet-0c2b7d1e4a9f83001 subnet-0d3c8e2f5b0a94002; do
    aws ec2 associate-route-table --route-table-id rtb-00aaaa1111bbbb001 --subnet-id $s \
      --query 'AssociationId'; done
"rtbassoc-0a0a0a0a0a0a0a001"
"rtbassoc-0b0b0b0b0b0b0b002"
$ for s in subnet-0e4d9f306c1ba5003 subnet-0f5e0a417d2cb6004 \
           subnet-0a6f1b528e3dc7005 subnet-0b7a2c639f4ed8006; do
    aws ec2 associate-route-table --route-table-id rtb-00bbbb2222cccc002 --subnet-id $s \
      --query 'AssociationId'; done
"rtbassoc-0c0c0c0c0c0c0c003"
...
```

### 5. The security-group chain

```
$ aws ec2 create-security-group --vpc-id vpc-0a1b2c3d4e5f67890 \
    --group-name tickethub-staging-alb-sg --description "ALB: public 443/80" \
    --query 'GroupId'
"sg-0f3a9c1d2e4b50001"
$ aws ec2 create-security-group --vpc-id vpc-0a1b2c3d4e5f67890 \
    --group-name tickethub-staging-app-sg --description "App tier: 80 from ALB only" \
    --query 'GroupId'
"sg-0e2d8b0c1f3a40002"
$ aws ec2 create-security-group --vpc-id vpc-0a1b2c3d4e5f67890 \
    --group-name tickethub-staging-mysql-sg --description "RDS: 3306 from app only" \
    --query 'GroupId'
"sg-0d1c7a9b0e2f30003"
$ aws ec2 create-security-group --vpc-id vpc-0a1b2c3d4e5f67890 \
    --group-name tickethub-staging-redis-sg --description "Redis: 6379 from app only" \
    --query 'GroupId'
"sg-0c0b6980fd1e20004"
```

Now the rules — note `--source-group` where the section-5 chain references SGs, CIDR only at the internet edge:

```
$ aws ec2 authorize-security-group-ingress --group-id sg-0f3a9c1d2e4b50001 \
    --protocol tcp --port 443 --cidr 0.0.0.0/0
$ aws ec2 authorize-security-group-ingress --group-id sg-0f3a9c1d2e4b50001 \
    --protocol tcp --port 80 --cidr 0.0.0.0/0
$ aws ec2 authorize-security-group-ingress --group-id sg-0e2d8b0c1f3a40002 \
    --protocol tcp --port 80 --source-group sg-0f3a9c1d2e4b50001
$ aws ec2 authorize-security-group-ingress --group-id sg-0d1c7a9b0e2f30003 \
    --protocol tcp --port 3306 --source-group sg-0e2d8b0c1f3a40002
$ aws ec2 authorize-security-group-ingress --group-id sg-0c0b6980fd1e20004 \
    --protocol tcp --port 6379 --source-group sg-0e2d8b0c1f3a40002
```

Notice what's absent: no port 22 anywhere. That's not an oversight — it's [8.4](04-classic-deployment-ec2-alb.md)'s access doctrine arriving early.

### 6. S3 gateway endpoint — wired before the first byte

```
$ aws ec2 create-vpc-endpoint --vpc-id vpc-0a1b2c3d4e5f67890 \
    --vpc-endpoint-type Gateway \
    --service-name com.amazonaws.ap-southeast-1.s3 \
    --route-table-ids rtb-00aaaa1111bbbb001 rtb-00bbbb2222cccc002 \
    --query 'VpcEndpoint.{Id:VpcEndpointId,State:State}'
{
    "Id": "vpce-0530e9d8c7b6a5001",
    "State": "available"
}
```

It manifests as an extra route (destination = an S3 *prefix list* `pl-…`, target = the endpoint) in both route tables. From now on, every byte between TicketHub and S3 — ticket PDFs included — bypasses the NAT: free, private, faster. Thirty seconds of work; teams that skip it fund AWS's margins.

### 7. Flow logs (REJECT-only)

Flow logs delivering to CloudWatch need a role the VPC Flow Logs service can assume (Lecture 8.1's trust-policy concept, immediately useful):

```
$ aws iam create-role --role-name tickethub-staging-flowlogs \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
      "Principal":{"Service":"vpc-flow-logs.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --query 'Role.Arn'
"arn:aws:iam::111122223333:role/tickethub-staging-flowlogs"
$ aws iam put-role-policy --role-name tickethub-staging-flowlogs \
    --policy-name write-logs --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
      "Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents",
      "logs:DescribeLogGroups","logs:DescribeLogStreams"],"Resource":"*"}]}'
$ aws logs create-log-group --log-group-name /tickethub/staging/vpc-flow-logs
$ aws ec2 create-flow-logs --resource-type VPC --resource-ids vpc-0a1b2c3d4e5f67890 \
    --traffic-type REJECT \
    --log-group-name /tickethub/staging/vpc-flow-logs \
    --deliver-logs-permission-arn arn:aws:iam::111122223333:role/tickethub-staging-flowlogs \
    --query 'FlowLogIds'
[
    "fl-0123456789abcdef0"
]
```

REJECT-only keeps volume (and cost) near zero while capturing exactly the lines you debug with. The log group stays empty until something is denied — Lecture 8.3's connectivity tests will feed it.

### 8. Verify: diagram vs reality

No instances exist yet, so verification is reading the control plane against the section-2 diagram:

```
$ aws ec2 describe-route-tables \
    --filters Name=vpc-id,Values=vpc-0a1b2c3d4e5f67890 \
    --query 'RouteTables[].{Name:Tags[?Key==`Name`]|[0].Value,
      Routes:Routes[].{To:DestinationCidrBlock,Via:GatewayId||NatGatewayId},
      Subnets:length(Associations[?SubnetId])}' --output json
[
  { "Name": "tickethub-staging-public-rt",
    "Routes": [ {"To": "10.1.0.0/16", "Via": "local"},
                {"To": "0.0.0.0/0",  "Via": "igw-0fedcba9876543210"} ],
    "Subnets": 2 },
  { "Name": "tickethub-staging-private-rt",
    "Routes": [ {"To": "10.1.0.0/16", "Via": "local"},
                {"To": "0.0.0.0/0",  "Via": "nat-0a1b2c3d4e5f11111"} ],
    "Subnets": 4 },
  { "Name": null, "Routes": [ {"To": "10.1.0.0/16", "Via": "local"} ], "Subnets": 0 }
]
```

(The nameless third table is the untouched main RT — local-only, exactly as intended. Both custom tables also show the `pl-…` S3 endpoint route in full output.) Then walk the checklist:

| Diagram claim | Check | Expect |
|---|---|---|
| 6 subnets, right CIDRs/AZs | `aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-0a1b… --query 'Subnets[].[Tags[?Key==\`Name\`]\|[0].Value,CidrBlock,AvailabilityZone]' --output table` | The section-2 table, verbatim |
| Public subnets auto-assign IPs | same, add `MapPublicIpOnLaunch` | `true` ×2, `false` ×4 |
| Default routes per tier | `describe-route-tables` above | IGW ×1, NAT ×1, main = local-only |
| SG chain matches section 5 | `aws ec2 describe-security-groups --filters Name=vpc-id,Values=vpc-0a1b… --query 'SecurityGroups[].[GroupName,IpPermissions]'` | 443/80 from `0.0.0.0/0`; 80←`alb-sg`; 3306←`app-sg`; 6379←`app-sg`; no port 22 |
| S3 endpoint in both RTs | `aws ec2 describe-vpc-endpoints` | `available`, 2 route tables |
| Flow logs active | `aws ec2 describe-flow-logs` | `ACTIVE`, traffic type `REJECT` |

Every row green means the network in your head, the diagram, and the cloud agree — the exact property Terraform will later enforce continuously.

### Cost recap & keep note

| Resource | Rate | ~Monthly |
|---|---|---|
| NAT gateway (1) | $0.059/hr + $0.059/GB | **$43 + data** |
| Public IPv4 (NAT EIP) | $0.005/hr | $3.65 |
| Flow logs (REJECT-only) | per-GB ingested | <$0.50 |
| VPC, subnets, RTs, IGW, SGs, S3 endpoint | free | $0 |

**Keep this VPC — Lectures 8.3/8.4 and Modules 9–10 build in it.** If you pause the course for more than a few days, delete the NAT (`aws ec2 delete-nat-gateway --nat-gateway-id nat-0a1b…`, then release the EIP once it's deleted) — it's the only meter running — and recreate it plus the private default route when you return. Ten minutes of work saves $1.50/day.

## Real-world best practices

- **Write the CIDR plan for the whole company before the first VPC.** A one-page table (env × region × /16, tiers × /20) prevents the unfixable: overlapping ranges meeting in a peering connection. Renumbering a live VPC is effectively a migration; a spreadsheet is free.
- **Three tiers, private by default.** Only load balancers and NAT belong in public subnets. If an app server "needs" a public IP, that's a design smell — the answer is the ALB (ingress) or NAT (egress), never exposure. TicketHub's app tier will serve thousands of users without one internet-reachable port.
- **S3/DynamoDB gateway endpoints in every VPC, day one, unconditionally.** Free, invisible, and they cap the NAT bill's worst component. Interface endpoints for other services (SSM, ECR, Secrets Manager) are a *cost optimization to revisit* once NAT data charges or private-only requirements justify their per-hour price — Module 9's Fargate tasks pulling images make that math interesting.
- **SG references everywhere; CIDRs only at the true edges.** "From `app-sg`" survives autoscaling, subnet moves, and platform migrations (the same chain carries into ECS and EKS). CIDR rules inside a VPC are almost always a smell — someone encoding today's topology instead of intent.
- **One NAT in non-prod, per-AZ NAT in prod — and write the decision down.** The $86/mo delta and the AZ-independence it buys is a business decision; make it consciously, record it (your future Terraform variables in Module 10 literally encode it as `single_nat_gateway = true`).
- **REJECT flow logs on every VPC as a standing fixture.** Near-zero cost, and the first question in any connectivity incident ("who dropped it?") is pre-answered. ACCEPT logging is situational (forensics, traffic studies) — enable on demand; it's the expensive direction.

## Common pitfalls

1. **Overlapping CIDRs across environments.** Every tutorial uses `10.0.0.0/16`, so both your VPCs do too; peering then refuses to route and the "quick fix" is rebuilding a VPC. Correct approach: the TICKETHUB.md allocation — `10.0.0.0/16` prod, `10.1.0.0/16` staging — decided before anything exists.
2. **"I put it in the public subnet but can't reach it."** The subnet had the IGW route but the instance launched without a public IP (auto-assign off) — the two ingredients conflated again. Correct approach: memorize section 3's pair; check `MapPublicIpOnLaunch` *and* the route table, in that order.
3. **Databases with a CIDR rule "temporarily" widened to `10.1.0.0/16` (or worse, a public IP "just for one import").** It works, nobody rolls it back, and the DB is now reachable from every future resource in the VPC — or the internet. Correct approach: SG references only (`3306 ← app-sg`); for one-off admin access, [8.3](03-core-services-rds-s3-redis.md)'s SSM port-forward pattern — no rule changes at all.
4. **Blaming SGs for what NACLs broke (or vice versa).** Someone "hardened" a NACL, forgot ephemeral return ports, and now connections half-open while every SG looks correct; hours die. Correct approach: default NACLs unless mandated; when debugging, flow logs first — the REJECT tells you the ENI and direction, which tells you which layer to inspect.
5. **Egress that silently transits the NAT forever.** S3 backups, ECR pulls, apt mirrors — gigabytes daily at $0.059/GB, invisible inside "EC2-Other" on the bill until someone asks. Correct approach: gateway endpoints immediately (done today), then check Cost Explorer's NAT line monthly; if it grows, add interface endpoints for the top talkers.

## Exercises

1. Without looking: draw the six-subnet diagram from memory, including CIDRs, and mark where the IGW, NAT, ALB nodes, and RDS will live. Check against section 2 — this diagram is the map for the rest of the course.
2. A packet leaves an app instance (`10.1.33.15`) for `10.1.81.44`, and another for `151.101.1.140` (a public IP). For each: which route table, which route wins (state the prefix-match reasoning), which gateway if any, and what source IP does the far end see?
3. Using only the CLI, prove the mysql SG is closed to the world: show the command and output demonstrating no rule with `0.0.0.0/0`, then explain in two sentences why `3306 ← app-sg` beats `3306 ← 10.1.32.0/20` when Module 9 replaces EC2 instances with Fargate tasks.
4. Run a Reachability Analyzer path (console or `aws ec2 create-network-insights-path`) from the IGW to `subnet-…data-a` on port 3306. Read the result and explain which hop blocks it and why that's exactly the design working. (~$0.10.)
5. **Stretch:** design production's network on paper to prod spec: `10.0.0.0/16`, three AZs, per-AZ NAT with per-AZ private route tables, same SG chain. List every resource with name and CIDR in a table — you have just written the spec Module 10's Terraform module will implement, and the diff against staging (3 AZs, 3 NATs) is your first taste of environment parameterization.

## What's next

The network exists: six subnets across two AZs, routing that distinguishes public from private, a firewall chain that encodes TicketHub's architecture, and a free path to S3. It's also completely empty. [Lecture 8.3 — Core Services for TicketHub](03-core-services-rds-s3-redis.md) fills the data tier: RDS MySQL and ElastiCache Redis land in the private-data subnets behind their SGs, S3 gets its bucket, SES its domain — and TicketHub's schema migrates into a database you no longer administer at 3 a.m.
