# Lecture 11.3 — EKS in Production

> **Module 11 — Kubernetes** · Lecture 3 of 4 · Estimated time: ~75 min

In [Lecture 11.2](02-tickethub-on-kubernetes.md) you ran the full TicketHub workload on a kind cluster that costs nothing and dies with one command. That cluster taught you Kubernetes; it cannot serve customers. This lecture moves the same manifests to **Amazon EKS**, provisioned the only way this course provisions anything since Module 10: from a Terraform pull request — and adds the patterns that separate a demo cluster from a production one: IRSA, the AWS Load Balancer Controller, external-dns, External Secrets, and Karpenter.

⚠️ **Cost warning:** everything here bills by the hour — the EKS control plane alone is ~$0.10/hr, and the full stack lands around **$260+/month** if left running. The hands-on section ends with a teardown ritual; do not skip it, and never leave this running overnight.

## Learning objectives

- Explain the boundary between what AWS manages in EKS (API server, etcd) and what you own (nodes, add-ons, upgrades).
- Provision `tickethub-prod-eks` with `terraform-aws-modules/eks`, wired to Module 10's network outputs, and authenticate `kubectl` through EKS access entries.
- Implement IRSA end-to-end so TicketHub pods carry their own least-privilege AWS credentials — no node-role sharing.
- Expose TicketHub through the AWS Load Balancer Controller and external-dns instead of a hand-managed ALB and manual Route 53 records.
- Sync real secrets from AWS Secrets Manager into `tickethub-secrets` with External Secrets Operator.
- Combine HPA, Karpenter, PodDisruptionBudgets, and topology spread into a scaling story that survives node loss and Spot interruption.

## 1. What "managed" actually buys you — and what it doesn't

EKS is a **managed control plane**. AWS runs `kube-apiserver`, `etcd`, the scheduler, and the controller manager for you, replicated across three availability zones, patched and backed up, with a 99.95% SLA. There is no control-plane node you can SSH into. For $0.10/hour you delete an entire category of operational risk — etcd corruption alone has ended weekends for many self-hosted teams.

What the managed label does **not** cover is where your job starts:

- **Nodes.** The EC2 instances (or Fargate) that run your pods: you choose instance types, AMIs, and scaling, and you pay for them.
- **Add-ons.** Cluster plumbing — CNI networking, CoreDNS, kube-proxy, CSI drivers — ships as versioned add-ons you must keep compatible with the cluster version.
- **The upgrade treadmill.** Kubernetes releases roughly three minor versions per year, and EKS supports each for about 14 months of standard support (extended support exists, at extra cost). Clusters on end-of-life versions get auto-upgraded eventually, on AWS's schedule, not yours. Plan on a cluster upgrade every six to twelve months, forever. This is the "Kubernetes tax" from [Lecture 11.1](01-kubernetes-core-concepts.md) arriving as a calendar line item, and it's honest to name it: ECS never asked this of you.

The trade: accept the treadmill and node ownership, and in exchange get the ecosystem — the controllers you'll install in this lecture, and the observability stack Module 12 installs next.

## 2. The cluster is born from a pull request

Module 10 established the rule: no console-created infrastructure, ever. The payoff arrives now — `tickethub-prod-eks` is a module call in `tickethub-infra`, planned on a PR, applied on merge, with tflint and Checkov watching. We add `modules/eks` and call it from `envs/production`, using the community module `terraform-aws-modules/eks` (`~> 20.x`) at the same survey level as Module 10's VPC module: understand the shape, don't hand-roll the forty resources it wraps. The essential arguments:

```hcl
# tickethub-infra/envs/production/eks.tf
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "tickethub-prod-eks"
  cluster_version = "1.31"

  # Module 10's network contracts paying off: the cluster lands in the
  # private app subnets we already built, no new networking invented.
  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_app_subnet_ids

  cluster_endpoint_public_access = true # locked down further in the exercises

  cluster_addons = {
    vpc-cni            = {}
    coredns            = {}
    kube-proxy         = {}
    aws-ebs-csi-driver = {}
  }

  eks_managed_node_groups = {
    default = {
      instance_types = ["m7g.large"]
      ami_type       = "AL2023_ARM_64_STANDARD"
      min_size       = 2
      max_size       = 6
      desired_size   = 2
    }
  }

  enable_cluster_creator_admin_permissions = true

  tags = { Project = "tickethub", Environment = "production" }
}
```

Three decisions deserve scrutiny.

**Graviton (arm64) nodes.** `m7g.large` is ARM — roughly 15–20% cheaper per unit of performance than the x86 equivalent, and PHP-FPM runs beautifully on it. It only works because Module 6 built images with BuildKit: CI's `docker buildx build` must now pass `--platform linux/amd64,linux/arm64` so ECR holds a multi-arch manifest and each node pulls its native layer. One flag in `ci.yml` (plus QEMU via `docker/setup-qemu-action`), verified once in staging — that's the entire migration. Skip it and pods die with `exec format error`: the kernel telling you it was handed an x86 binary.

**Add-ons declared, not clicked.** `vpc-cni` deserves a spotlight: unlike most CNI plugins, it gives every pod a **real VPC IP address** from your subnets. Module 8's security-group story continues to make sense — pods are first-class network citizens, and (soon) the ALB can target them directly. The cost is IP consumption; **prefix delegation** (an aws-node setting) multiplies IPs per node when you need density. `ebs-csi` is installed because real clusters need it eventually — but pause and enjoy this: **TicketHub needs zero PersistentVolumeClaims.** Sessions in Redis, files in S3, config from the environment. Module 5's 12-factor discipline means every workload can be rescheduled anywhere, anytime. That was the point all along.

**Node group sizing.** `min 2` because one node is zero availability during maintenance; `max 6` caps cost blast radius. Karpenter will later make this group boringly static — the reliable floor that runs the cluster's own controllers.

## 3. Getting in: access entries and how kubectl talks to EKS

Who can call this API server? For years the answer lived in a fragile in-cluster ConfigMap called `aws-auth` — edit it wrong and you locked everyone out. The modern mechanism is **EKS access entries**: IAM principals mapped to Kubernetes permissions via AWS API, managed from Terraform like everything else.

```hcl
  access_entries = {
    platform_admins = {
      principal_arn = "arn:aws:iam::111122223333:role/platform-admin"
      policy_associations = {
        admin = {
          policy_arn   = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = { type = "cluster" }
        }
      }
    }
    ci_deployer = {
      principal_arn = "arn:aws:iam::111122223333:role/tickethub-github-deploy"
      policy_associations = {
        edit = {
          policy_arn   = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"
          access_scope = { type = "namespace", namespaces = ["tickethub"] }
        }
      }
    }
  }
```

Note the CI role — Module 7's OIDC-assumed `tickethub-github-deploy` — gets **edit scoped to the `tickethub` namespace only**. Least privilege survives the platform change. Wiring `kubectl` up is one command:

```console
$ aws eks update-kubeconfig --region ap-southeast-1 --name tickethub-prod-eks
Added new context arn:aws:eks:ap-southeast-1:111122223333:cluster/tickethub-prod-eks to /Users/you/.kube/config
```

What did that do? It wrote a kubeconfig entry whose `user` section is an **exec plugin**: whenever kubectl needs credentials it runs `aws eks get-token`, producing a short-lived, SigV4-signed token from your current AWS credentials. No Kubernetes passwords exist anywhere — your IAM identity *is* your cluster identity, evaluated per request. `kubectl get nodes` is an AWS-authenticated API call wearing a Kubernetes hat.

## 4. IRSA: pods that carry their own AWS identity

The centerpiece pattern of the lecture. Learn it well; you will meet it at every Kubernetes shop on AWS.

**The problem.** TicketHub pods call AWS APIs — S3 for ticket PDFs, SES for mail, Secrets Manager (soon). On EC2 and ECS you gave the *instance* or *task* a role. On EKS the naive path is the **node role**: any pod on the node can hit the instance metadata service and use it. But nodes are shared — give the node role S3 access and every pod on that node (the ingress controller, a batch job, a compromised container) has it too. That is the shared-credential smell Module 8 taught you to reject.

**The mechanism: IRSA** (IAM Roles for Service Accounts). It is the same OIDC federation trick you already trust from Module 7, where GitHub Actions traded a workflow identity token for AWS credentials with no stored keys. Here, the token issuer is your cluster:

1. EKS exposes an **OIDC provider** for the cluster; the Terraform module registers it with IAM.
2. You annotate a Kubernetes **ServiceAccount** with an IAM role ARN.
3. Kubernetes injects a **projected service-account token** (a signed JWT naming the namespace and service account) into any pod using that ServiceAccount, plus env vars pointing the AWS SDK at it.
4. The SDK silently calls `sts:AssumeRoleWithWebIdentity`, trading the JWT for short-lived credentials — **for that role, for that pod, and nothing else on the node**.

The trust policy is where least privilege is enforced — this is IAM role `tickethub-prod-app` (Module 8's role name; only its trust changes shape):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::111122223333:oidc-provider/oidc.eks.ap-southeast-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.ap-southeast-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:tickethub:tickethub-app",
          "oidc.eks.ap-southeast-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

Read the `sub` condition out loud: *only a token for the ServiceAccount `tickethub-app`, in namespace `tickethub`, from this cluster, may assume this role.* A pod in another namespace gets nothing. The permissions policy stays boringly scoped:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Uploads",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::tickethub-prod-uploads/*"
    },
    {
      "Sid": "Mail",
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*"
    },
    {
      "Sid": "Secrets",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:tickethub/production/*"
    }
  ]
}
```

The Kubernetes side is two small edits. The ServiceAccount:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tickethub-app
  namespace: tickethub
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::111122223333:role/tickethub-prod-app
```

…and one line in each Deployment's pod spec (`tickethub-web` and `tickethub-horizon`):

```yaml
    spec:
      serviceAccountName: tickethub-app
```

No Laravel code change: the AWS SDK's default credential chain finds the injected token before it ever looks at instance metadata. `AWS_ACCESS_KEY_ID` disappears from your environment permanently.

**One honest paragraph on EKS Pod Identity**, the newer alternative: it replaces the OIDC provider with an EKS-run agent and moves the role association into an AWS API call, which is genuinely simpler — no per-cluster OIDC registration, easier multi-cluster reuse. It's a fine choice for greenfield clusters. The course teaches IRSA because it is today's ubiquitous pattern: nearly every third-party controller's documentation (including the two you're about to install) assumes it, and you *will* inherit clusters that use it. Learn IRSA first; adopting Pod Identity later is a Tuesday afternoon.

## 5. Production ingress: the ALB controller and external-dns

In kind you used ingress-nginx. In production on AWS, the idiomatic choice is the **AWS Load Balancer Controller**: a controller (a watch→diff→act loop, per Lecture 11.1) that watches Ingress objects and reconciles *actual AWS load balancers* into existence. Your Ingress manifest becomes the declarative source of truth for an ALB.

Install it via the Helm provider in Terraform — and notice the pattern eating its own dogfood: the controller itself needs AWS permissions (it creates ALBs!), so *it* gets IRSA too. Every serious controller on EKS authenticates this way.

The Ingress that replaces both the kind version and — migration day — the hand-managed `tickethub-prod-alb` of Modules 8–10:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tickethub-web
  namespace: tickethub
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:ap-southeast-1:111122223333:certificate/abc12345-6789-abcd-ef01-234567890abc
    alb.ingress.kubernetes.io/healthcheck-path: /up
spec:
  ingressClassName: alb
  rules:
    - host: api.tickethub.example
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: tickethub-web
                port:
                  number: 80
```

`target-type: ip` is the vpc-cni payoff: the ALB targets **pod IPs directly**, no NodePort hop — Module 8's target-group mechanics, now reconciled automatically from your pods' Endpoints. `healthcheck-path: /up` is Module 3's shallow health check doing ALB duty, and Module 9's deregistration-delay dance maps onto the preStop/termination choreography from Lecture 11.2.

**Migration-day note:** when TicketHub cuts over from ECS, the Terraform-managed `tickethub-prod-alb` retires. Bring up the controller-managed ALB, verify with a hosts-file override, flip DNS, watch old-ALB requests drain to zero, then remove it from `tickethub-infra`. The K8s-workload ALB now lives in Kubernetes manifests, not HCL — one source of truth per resource.

**external-dns** completes the loop: another controller that watches Ingress `host:` fields and reconciles Route 53 records. When the ALB controller provisions the load balancer, external-dns writes the `api.tickethub.example` alias record pointing at it, plus an **ownership TXT record** (via `--txt-owner-id=tickethub-prod-eks`) so two clusters — or external-dns and a human — don't fight over the same name. The boundary rule: **records for Kubernetes workloads belong to external-dns; everything else (apex, MX, the marketing site) stays in Terraform.** Never define the same record in both, or each reconciler will "correct" the other forever.

## 6. Secrets, finally done right: External Secrets Operator

Lecture 11.2 left `tickethub-secrets` with honestly-labeled placeholders and a promise. Module 5 built the maturity ladder — `.env` files → environment injection → a managed secret store — and Module 8 put the RDS password in Secrets Manager with managed rotation. **External Secrets Operator (ESO)** is the top rung: a controller that reads Secrets Manager and continuously materializes native Kubernetes Secrets.

ESO installs via Helm and — of course — authenticates with IRSA: its ServiceAccount maps to a role allowed `secretsmanager:GetSecretValue` on `tickethub/*` secrets. Two custom resources then do all the work. A **ClusterSecretStore** describes *how* to reach the backend:

```yaml
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: aws-secretsmanager
spec:
  provider:
    aws:
      service: SecretsManager
      region: ap-southeast-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

An **ExternalSecret** maps remote values to a Kubernetes Secret:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: tickethub-secrets
  namespace: tickethub
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: tickethub-secrets
    creationPolicy: Owner
  data:
    - secretKey: APP_KEY
      remoteRef:
        key: tickethub/production/app
        property: APP_KEY
    - secretKey: DB_PASSWORD
      remoteRef:
        key: tickethub/production/rds   # the RDS-managed secret from Module 8
        property: password
    - secretKey: REDIS_PASSWORD
      remoteRef:
        key: tickethub/production/app
        property: REDIS_PASSWORD
```

`creationPolicy: Owner` means ESO owns the resulting `tickethub-secrets` Secret — delete the ExternalSecret and the Secret goes with it; hand-edit the Secret and reconciliation reverts you. `refreshInterval: 1h` closes Module 8's rotation loop: RDS rotates its password on schedule, ESO updates the Secret within the hour, and a rollout (or the checksum trick in [Lecture 11.4](04-helm-gitops-argocd.md)) delivers it to pods. **No human ever sees, types, or commits the production database password.** That sentence took eight modules to earn.

## 7. Scaling in three layers

Production scaling is three distinct mechanisms answering three distinct questions.

**Layer 1 — more pods (HPA).** Built in Lecture 11.2: `tickethub-web` scales 2→10 on 60% CPU. Unchanged here; metrics-server installs as trivially on EKS as on kind.

**Layer 2 — more nodes.** When the HPA wants pod #7 and no node has room, pods go `Pending`; something must add capacity. The incumbent, **cluster-autoscaler**, resizes *pre-defined node groups* — it can only make more copies of instance shapes you declared in advance. **Karpenter**, the AWS-born successor, watches Pending pods themselves and provisions right-sized instances directly from their aggregate CPU/memory requests, then **consolidates** — actively replacing underutilized nodes with fewer, cheaper ones. Honest comparison: cluster-autoscaler is simpler and battle-tested everywhere; Karpenter is more capable and cheaper on AWS but is one more controller with its own upgrade cadence. On EKS in 2026, Karpenter is the better default, and it's what we use. Its two resources:

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: workers
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
      expireAfter: 720h   # nodes retire monthly → fresh AMIs, forced drain practice
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m
```

(The companion `EC2NodeClass` names the AMI family, subnets, security groups, and node IAM role — survey level; the Karpenter docs' example is near production-ready.)

**Spot as cost engineering.** Spot instances are ~60–90% off in exchange for a 2-minute interruption notice. Which workload tolerates that? `tickethub-horizon`: queue workers are interruption-tolerant *by design* — Lecture 11.2 gave Horizon a graceful `horizon:terminate` drain, and un-acked jobs return to Redis for the next worker. Pin Horizon to Spot with a nodeSelector on `karpenter.sh/capacity-type: spot`; keep `tickethub-web` on on-demand, because customers mid-checkout are not interruption-tolerant. This is real cost engineering, not a toggle: it works *because* the shutdown choreography exists.

**Layer 3 — surviving disruption.** Karpenter consolidation, node upgrades, AZ failure — pods will be evicted; your job is bounding the damage. A **PodDisruptionBudget** limits *voluntary* disruptions (drains and consolidation — not crashes):

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: tickethub-web
  namespace: tickethub
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: tickethub-web
```

With 2 replicas, `minAvailable: 1` forces drains to move web pods one at a time. And **topologySpreadConstraints** put Module 8's Multi-AZ story at pod granularity — RDS is Multi-AZ, but that's worthless if both web replicas share one zone:

```yaml
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: tickethub-web
```

`ScheduleAnyway` makes it a strong preference, not a hard rule — during a zone outage you'd rather run skewed than not at all.

## Hands-on with TicketHub

⚠️ **Creates billable resources:** EKS control plane, 2× m7g.large, ALB, NAT gateway traffic. Budget the session and tear down at the end.

**1. Provision.** Add `eks.tf` (plus the IRSA roles) to `tickethub-infra/envs/production`, open a PR, read the plan in CI as Module 10 taught (~60 resources), merge:

```console
$ terraform apply
...
module.eks.aws_eks_cluster.this[0]: Creation complete after 8m12s
module.eks.module.eks_managed_node_group["default"].aws_eks_node_group.this[0]: Creation complete after 2m41s

Apply complete! Resources: 58 added, 0 changed, 0 destroyed.
Outputs:
cluster_name = "tickethub-prod-eks"
cluster_endpoint = "https://EXAMPLED539D4633E53DE1B71EXAMPLE.gr7.ap-southeast-1.eks.amazonaws.com"
```

**2. Connect and verify.**

```console
$ aws eks update-kubeconfig --region ap-southeast-1 --name tickethub-prod-eks
$ kubectl get nodes -o wide
NAME                                             STATUS   ROLES    AGE   VERSION               ARCH
ip-10-0-11-24.ap-southeast-1.compute.internal    Ready    <none>   3m    v1.31.5-eks-5d632ec   arm64
ip-10-0-12-187.ap-southeast-1.compute.internal   Ready    <none>   3m    v1.31.5-eks-5d632ec   arm64
```

Two Graviton nodes in two AZs, in the private subnets Module 10 built. Before deploying anything, confirm `docker manifest inspect …/tickethub-api:sha-a1b2c3d` lists both `amd64` and `arm64`.

**3. Install the platform controllers** (ALB controller, external-dns, ESO — each Helm-installed from Terraform, each with its own IRSA role) and verify the loops are alive:

```console
$ kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
NAME                                            READY   STATUS    RESTARTS   AGE
aws-load-balancer-controller-7d98b5c9d4-kx2vp   1/1     Running   0          90s
aws-load-balancer-controller-7d98b5c9d4-m4nqt   1/1     Running   0          90s
```

**4. Deploy TicketHub.** The Lecture 11.2 manifests with three production edits: `serviceAccountName: tickethub-app` in both Deployments, the ExternalSecret replacing the placeholder Secret, the alb-class Ingress replacing the nginx one.

```console
$ kubectl apply -f k8s/
$ kubectl get externalsecret -n tickethub
NAME                STORE                REFRESH INTERVAL   STATUS         READY
tickethub-secrets   aws-secretsmanager   1h                 SecretSynced   True

$ kubectl get ingress -n tickethub
NAME            CLASS   HOSTS                   ADDRESS                                                                PORTS
tickethub-web   alb     api.tickethub.example   k8s-tickethu-tickethu-abc123def4-1234567890.ap-southeast-1.elb.amazonaws.com   80
```

`SecretSynced: True` means real Secrets Manager values are in `tickethub-secrets` — the migration Job and app pods consume them exactly as before. Within minutes external-dns logs `CREATE api.tickethub.example A [alias]` and:

```console
$ curl -s https://api.tickethub.example/up
<!DOCTYPE html>...        # 200 — live on EKS, TLS by ACM, DNS by a controller
```

**5. Prove IRSA.** From a web pod, ask AWS who you are:

```console
$ kubectl exec -it deploy/tickethub-web -n tickethub -c app -- \
    php artisan tinker --execute="echo json_encode((new Aws\Sts\StsClient(['region'=>'ap-southeast-1','version'=>'latest']))->getCallerIdentity()->get('Arn'));"
"arn:aws:sts::111122223333:assumed-role/tickethub-prod-app/eks-tickethub-..."
```

The pod is `tickethub-prod-app` — not the node role. Place a test order and watch the PDF land in `tickethub-prod-uploads` with zero static credentials in the system.

**6. Cost reality and teardown.** What this stack costs if left running (ap-southeast-1, on-demand, approximate):

| Item | ~Monthly |
|---|---|
| EKS control plane | $73 |
| 2 × m7g.large nodes | $140 |
| ALB | $25 |
| NAT gateway (from Module 10, + data) | $35+ |
| **Floor, before RDS/Redis/traffic** | **≈ $260+** |

The teardown ritual — order matters:

```console
$ kubectl delete -f k8s/          # 1. Delete Ingress FIRST: the controller must
                                  #    deprovision the ALB while it still exists
$ terraform destroy               # 2. Then destroy the cluster
```

Two gotchas the ritual exists to avoid: destroy the cluster while the ALB controller still owns a load balancer and the ALB (plus its security groups) **orphans and keeps billing** — nothing remains to reconcile it away; and vpc-cni's pod ENIs can briefly block subnet/VPC deletion — re-running `terraform destroy` after a few minutes clears it. Verify in the console that the ALB and cluster are gone. And remember: **kind remains your free lab.** Everything in Lectures 11.1–11.2 and most of 11.4 needs zero AWS spend — bring up EKS only when the lesson demands it.

## Real-world best practices

- **Every controller gets IRSA, every role gets one job.** One ServiceAccount per workload, one role per ServiceAccount, `sub`-conditioned trust. Two workloads sharing a role rebuilds the node-role problem one layer up — blast-radius containment is the entire point of pod-level identity.
- **Practice upgrades in staging, on a schedule, before EKS's schedule practices on you.** Read the K8s changelog for API removals, upgrade a staging cluster, verify add-on compatibility (each add-on publishes a matrix), upgrade the prod control plane, then rotate nodes (Karpenter's `expireAfter` makes rotation routine). Teams that defer upgrades don't skip the treadmill — they pay it back with interest under deadline.
- **One owner per resource.** K8s-workload ALBs belong to the ALB controller; Ingress-host records belong to external-dns; everything else belongs to Terraform. Two reconcilers on one resource means infinite correction loops and 3 a.m. mysteries.
- **Spot only where the drain story is proven.** Horizon earned Spot because Lecture 11.2 built and tested its graceful shutdown. Spot doesn't cause incidents — unhandled interruption does.
- **Alarm on cost, not just health.** A Module 8 billing alarm at your expected floor (~$300 here) catches orphaned ALBs and forgotten clusters faster than any dashboard you'll forget to open.

## Common pitfalls

1. **Shipping amd64-only images to Graviton nodes.** Pods crash-loop with `exec format error`. Why it happens: the ECS era never needed multi-arch, so CI still builds one platform. Correct approach: `--platform linux/amd64,linux/arm64` in buildx (Modules 6/7), verified with `docker manifest inspect` before the first EKS deploy.
2. **Granting AWS permissions to the node role "just to unblock".** S3 works, ticket closed — and now every pod on every node has S3 access. Why: it's the fastest visible fix and the IMDS fallback makes it silently work. Correct approach: IRSA per workload; treat any node-role permission beyond the EKS-required ones as a finding.
3. **A trust-policy typo that fails closed and cryptic.** `sub` says `system:serviceaccount:default:tickethub-app` (wrong namespace) and pods get `AccessDenied` on `sts:AssumeRoleWithWebIdentity`. Why: the string is long, hand-typed, and unvalidated. Correct approach: template it in Terraform (`system:serviceaccount:${var.namespace}:${var.sa_name}`); debug by decoding the projected token's `sub` claim and diffing.
4. **Destroying the cluster before deleting Ingress/Service resources.** `terraform destroy` first, ALB orphans and bills for weeks. Why: it feels like destroy cleans up everything — but the ALB isn't in Terraform state; it belonged to a controller that no longer exists. Correct approach: the teardown ritual — delete Kubernetes-owned cloud resources via Kubernetes, *then* destroy.
5. **external-dns and Terraform both managing `api.tickethub.example`.** The record flip-flops as each reconciler "fixes" it. Why: the record predates the cluster (Modules 8–10) and nobody removed the old definition. Correct approach: at cutover, delete the record from `tickethub-infra` and let external-dns own it — one writer per record, the ownership TXT as audit trail.
6. **Treating ESO's Secret as editable.** `kubectl edit secret tickethub-secrets` to hot-fix a value; it reverts within the refresh interval. Why: old habits from hand-created Secrets. Correct approach: change the value in Secrets Manager — the source of truth — and let reconciliation deliver it. (It's Lecture 11.1's "hand-changes don't stick", one system higher.)

## Exercises

1. **Trace the token.** `kubectl exec` into a web pod and inspect `/var/run/secrets/eks.amazonaws.com/serviceaccount/token`. Decode the JWT payload and identify the `sub`, `aud`, and `exp` claims; match each to a line of the trust policy.
2. **Scope the CI role down.** The `ci_deployer` access entry grants namespace-scoped edit. Try `kubectl get nodes` as that role, explain the error, then explain why deploy-time CI shouldn't read cluster-scoped resources at all. (Keep this thought — Lecture 11.4 removes CI's cluster access entirely.)
3. **Add an ExternalSecret for staging.** Create `tickethub/staging/app` in Secrets Manager and a second ExternalSecret targeting a `tickethub-staging` namespace. What changes: the ClusterSecretStore, the IAM policy resource ARN, or only the ExternalSecret? Why?
4. **Interrupt a Spot node.** Move Horizon to a Spot NodePool, then interrupt the instance (EC2 fault injection, or `kubectl drain` as a stand-in) mid-job-run. Verify via Horizon that no job was lost, only retried, and write down the exact sequence of signals and requeues you observed.
5. **Stretch: private API endpoint.** Set `cluster_endpoint_public_access = false` with private access enabled, and get `kubectl` working again from a bastion or SSM session inside the VPC (Module 8 skills). Document what got safer, what got harder for CI, and how Lecture 11.4's pull-based model dissolves the CI problem entirely.

## What's next

TicketHub now runs on production-grade EKS — but you deployed it with `kubectl apply -f` from a laptop, ten YAML files that staging and production would each need diverging copies of. That's the configuration sprawl Module 10 taught you to refuse. [Lecture 11.4](04-helm-gitops-argocd.md) packages the manifests into the `helm/tickethub` chart, reduces each environment to ~20 lines of values, and hands deployment itself to a reconciliation loop: Argo CD watching Git, converging the cluster to it — the course's deepest idea, applied to the last thing still done by hand.
