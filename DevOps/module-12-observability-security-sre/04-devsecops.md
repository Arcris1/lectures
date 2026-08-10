# Lecture 12.4 — DevSecOps

> **Module 12 — Observability, Security & SRE** · Lecture 4 of 5 · Estimated time: ~110 min

Three lectures of observability tell you what your system is doing. This one is about who else might be doing things to it. TicketHub handles money, personal data, and — during an on-sale — the attention of every scalper bot on the internet. Security is not a review meeting before launch; it is a property of the pipeline you have built over eleven modules, verified on every commit the way tests are. This lecture threat-models the delivery system, then hardens it layer by layer, finishing with the full defense in one table.

## Learning objectives

- Threat-model a delivery pipeline, not just an application, and apply shift-left economics to security
- Automate dependency updates, secret scanning, and SAST as CI gates with a sane triage discipline
- Practice rotation: RDS managed rotation and a zero-downtime `APP_KEY` drill with `APP_PREVIOUS_KEYS`
- Sign images in CI with cosign keyless and enforce signatures at admission with Kyverno
- Harden runtime with SecurityContexts, NetworkPolicies, and Pod Security Standards
- Map the OWASP API Top 10 to concrete Laravel defenses and place a WAF honestly at the edge

## 1. Security shifts left for the same reason testing did

Module 1 drew the cost curve: a defect caught at commit time costs minutes; in production it costs an incident. Vulnerabilities sit on the same curve with a nastier tail — a bug found late embarrasses you; a vulnerability found late may already have been *used*. The fix is the one this course applied to quality: stop treating security as a gate at the end and make it a **pipeline property** — checks on every PR, guardrails that make the secure path the easy path.

This is also the modern security team's job description. The gatekeeper model does not scale to daily deploys; security's leverage is **platform work**: paved roads (hardened base image, blessed workflow, a secrets manager easier than pasting into `.env`) plus guardrails (scanners, admission policies) that catch departures from the road. You are about to build both.

## 2. Threat-model the delivery system first

Before hardening anything, ask the attacker's question: *how would I get code of my choosing running in `tickethub-prod-eks`?* The app is only one path — the delivery system is a richer target, because it is *designed* to put code into production:

| Surface | Example attack | Primary control (module) |
|---|---|---|
| Dependencies | Malicious update to a trusted Composer package | Audit + automated, reviewed updates (§3) |
| Base images | Compromised or stale `php:8.4-fpm` layer | Weekly refresh + scan (M6, §7) |
| Pipeline | Stolen credentials; poisoned third-party Action | OIDC (M7), SHA-pinning, least-privilege tokens (§6) |
| Registry | Overwrite a deployed tag with a hostile image | Immutable tags — already on (M6) |
| Runtime | Container escape, lateral movement post-breach | SecurityContext, NetworkPolicies, PSS (§8) |
| Humans | Phishing a maintainer or an AWS admin | MFA everywhere (M8), push protection (§4) |

One paragraph of grounding, because these are not hypotheticals: the defining incidents of the last decade were supply-chain attacks. SolarWinds shipped a compromised build of its own product to thousands of customers because the *build system* was breached; the xz-utils backdoor nearly put a remote-access hole in every major Linux distribution via a socially-engineered maintainership. The lesson: attackers go where trust concentrates — dependencies, pipelines, registries. Every control here exists because someone learned it the expensive way.

## 3. Dependencies: the code you didn't write

Most of TicketHub is not your code — it is Laravel, Monolog, Guzzle, and their transitive graph. Module 7 already runs `composer audit` in CI, failing builds on known-vulnerable versions. That is detection; you also need a *supply* of updates, because the fix for a CVE is usually "upgrade", and an upgrade you have never practiced is a Friday-night emergency.

Automate it with **Renovate** or **Dependabot**: both open PRs when dependencies update; Dependabot is zero-setup and GitHub-native, Renovate offers finer control — grouping updates into one PR, scheduling, lockfile maintenance (refreshing transitive pins even when nothing you require changed). Either is fine; unmanaged dependencies are not. TicketHub uses Renovate, weekly and grouped, security fixes exempt from the schedule:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "schedule": ["before 7am on monday"],
  "packageRules": [
    { "matchManagers": ["composer"], "groupName": "composer non-major", "matchUpdateTypes": ["minor", "patch"] }
  ],
  "vulnerabilityAlerts": { "schedule": ["at any time"], "labels": ["security"] },
  "lockFileMaintenance": { "enabled": true, "schedule": ["before 7am on the first day of the month"] }
}
```

Should update PRs auto-merge? It is a trust spectrum. TicketHub's position: **patch-level updates auto-merge when the full Module 7 CI suite is green**; minors get a human skim; majors a real review. The counterargument — a malicious patch rides your automation into production — is real but mitigated by the rest of this lecture (a hostile package still runs non-root, network-restricted, in a signed image); the stronger counter-counter: teams hand-reviewing every patch fall months behind and ship *known* CVEs — the common failure, not the exotic one. Two disciplines round it out: review the **lockfile diff** when you do review (`composer.lock` is what ships — a new transitive package deserves a glance), and audit quarterly for **abandoned packages** — an unmaintained dependency is a CVE with a delivery date.

## 4. Secrets: hygiene by machines, rotation by practice

You built the secrets ladder across three modules; here is the whole thing in three lines:

| Stage | Where secrets lived | Module |
|---|---|---|
| Keep them out of Git | `.env`, gitignored; `.env.example` as the contract | 5 |
| Central, audited store | AWS Secrets Manager, IAM-scoped access | 8 |
| Delivered to workloads | External Secrets Operator → `tickethub-secrets`, via IRSA | 11 |

What is missing is *enforcement against the human mistake* — the secret that lands in Git anyway. Two machines close the gap: **gitleaks in CI**, scanning the diff for credential patterns and failing the PR; and, better, **GitHub push protection** (an org setting), which *rejects the push before it lands*. Prevention beats detection for a mechanical reason — a secret that touches a remote branch is compromised (forks, CI logs, clones) and must be rotated no matter how fast you delete it. Turn push protection on today; one checkbox, the highest ROI in this lecture.

Scanning is not management, and management is not rotation. **Rotation you've never tested is rotation you don't have** — so TicketHub practices two. The easy one: Secrets Manager's managed rotation rotates `tickethub-prod-mysql`'s app password on schedule via a Lambda it owns; External Secrets syncs it; pods pick it up on the next rollout. The scarier one is Laravel's `APP_KEY`, which encrypts cookies and anything passed through `Crypt` — rotated naively, it logs out every user and breaks every encrypted value. `APP_PREVIOUS_KEYS` makes it a drill instead of an outage:

```bash
# 1. Mint a new key locally — do NOT write it to your .env
$ php artisan key:generate --show
base64:NEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNEWKEY=

# 2. Move the current APP_KEY onto APP_PREVIOUS_KEYS; set APP_KEY to the new value.
$ aws secretsmanager put-secret-value --secret-id tickethub/prod/app \
    --secret-string '{"APP_KEY":"base64:NEWKEY...","APP_PREVIOUS_KEYS":"base64:OLDKEY..."}'

# 3. External Secrets syncs tickethub-secrets; roll the workloads.
$ kubectl -n tickethub rollout restart deploy/tickethub-web deploy/tickethub-horizon

# 4. Verify: an existing session still works (decrypted with the previous key,
#    re-encrypted with the new one on next write).

# 5. After the longest session lifetime passes, remove the old key from
#    APP_PREVIOUS_KEYS. Rotation complete, nobody noticed.
```

Run this in staging first, then in production on a calm Tuesday — never for the first time during the incident that forces it.

## 5. SAST and DAST, honestly scoped

Static analysis you already have: Larastan (Module 7) catches type-level defects, some of which are security bugs. What it cannot see is *patterns* — code that type-checks perfectly and is still dangerous. That is **Semgrep**'s niche: rules matching code shapes, with maintained `php` and `laravel` rulesets. A worked finding from a TicketHub PR:

```php
$events = DB::select("SELECT * FROM events WHERE city = '{$request->city}' AND published = 1");
```

Larastan is happy: strings in, array out. Semgrep's ruleset fires `tainted-sql-string` — user input interpolated into raw SQL, textbook injection. The fix is parameterization:

```php
$events = DB::select('SELECT * FROM events WHERE city = ? AND published = 1', [$request->city]);
```

Add Semgrep as a CI job (`semgrep ci --config p/php --config p/laravel`) and set the triage discipline before the first false positive: when a finding is wrong, **tune the rule or annotate the line — never mute the tool**; a silenced scanner manufactures false confidence. One paragraph on **DAST**: tools like OWASP ZAP attack the *running* app from outside — a nightly baseline scan against `api.staging.tickethub.example` catches deployed-configuration issues SAST is structurally blind to: missing security headers, routable debug endpoints, TLS misconfiguration. SAST reads the code; DAST rattles the doors.

## 6. Securing the pipeline itself

Your pipeline can deploy to production, so it is production. Module 7's foundation was **OIDC to AWS** — no long-lived keys to steal, short-lived credentials scoped to `tickethub-github-deploy`. Four hardenings finish the job:

- **Pin third-party Actions by commit SHA**, not tag: `uses: aws-actions/configure-aws-credentials@e3dd6a4…` with a version comment. Tags are mutable — a compromised Action repo retags `v4` to malicious code and every workflow using `@v4` runs it with your secrets (the 2025 `tj-actions/changed-files` compromise exfiltrated CI secrets exactly this way). Renovate updates SHA pins for you, so pinning costs nothing.
- **Least-privilege `GITHUB_TOKEN`**: top-level `permissions: contents: read`, elevated per-job only where needed (`id-token: write` for OIDC). The default token can write to your repo; a poisoned step should not.
- **Environment-gated production credentials** (Module 9): the prod OIDC role binding lives in the `production` GitHub Environment with required reviewers — a compromised PR workflow cannot even *request* prod credentials.
- **Self-hosted runner warning** (Module 7 recap): never attach self-hosted runners to a public repo — a fork PR executes attacker code on your machine. TicketHub uses GitHub-hosted runners throughout.

## 7. Supply chain: refresh, inventory, signature

Three controls take the image from "built" to "provably yours, provably current"; concepts here, working YAML in the hands-on.

**Scheduled base refresh.** Your Dockerfile (Module 6) inherits `php:8.4-fpm`'s packages; a CVE fixed upstream does you no good until you rebuild, and trivy at build time (Module 7) only helps when builds *happen* — a quiet fortnight with no deploys is a fortnight of unpatched images. So a weekly workflow rebuilds on fresh base layers, scans, and — if clean — opens a values-PR through the Module 11 GitOps flow. **Patch latency becomes a measured property** (bounded at ~7 days plus one review) instead of an accident of the release calendar.

**SBOM.** A Software Bill of Materials is the machine-readable inventory of everything in the image — OS packages, PHP deps, all of it. Generate one per build with **syft**, store it as an artifact. The why is the next xz-style event: when the industry asks "who is running the vulnerable liblzma?", teams with SBOMs answer with a grep in minutes; teams without spend days exec-ing into pods. In supply-chain incidents, **response speed is the product**.

**Signing.** Immutable tags stop overwrites, but nothing yet proves an image *came from your CI*. **cosign keyless** signing closes that: the CI job signs the image digest with its ephemeral OIDC identity (the same trust root as Module 7's AWS auth — no key to manage or leak), recording a certificate that says "signed by workflow `ci.yml` in `tickethub/tickethub-api`". A **Kyverno** admission policy then verifies the signature before any pod runs in namespace `tickethub`. Registry to runtime, the chain is closed: stolen ECR push credentials still cannot get an image *scheduled*, because they cannot forge your CI's identity.

## 8. Runtime and network hardening

Assume the layers above fail — a dependency goes hostile, an RCE lands. Runtime hardening decides whether that becomes contained weirdness in one pod or cluster compromise.

**SecurityContext.** Module 6's Dockerfile set `USER www-data`; the pod spec now *enforces* it and removes everything else a payload wants: `runAsNonRoot: true` (refuses a root container outright), `readOnlyRootFilesystem: true` (malware cannot write itself to disk), `allowPrivilegeEscalation: false`, `capabilities: drop: [ALL]`, `seccompProfile: RuntimeDefault`. The Laravel reality most guides skip: read-only root breaks the framework's writable paths — `storage/framework/*`, `bootstrap/cache`, `/tmp` — and nginx's cache and pid paths. The answer is `emptyDir` mounts over exactly those paths (working YAML below). It also explains why nginx has listened on **8080** since Module 6: ports below 1024 need `NET_BIND_SERVICE`, and not needing a capability beats granting one.

**NetworkPolicies.** By default every pod can talk to every pod — one compromised container reaches anything routable. NetworkPolicies are firewall rules selected by labels: **default-deny** the namespace, then allow exactly the flows the architecture needs — ALB to `tickethub-web` on 8080; app egress to MySQL (3306) and Redis (6379) in the VPC; egress 443 for S3/SES/payments. The classic gotcha: default-deny also blocks **DNS**, and every symptom looks like "the network is broken" while the real failure is name resolution — always ship the DNS-egress rule with the deny.

**Pod Security Standards.** Individual SecurityContexts are opt-in; PSS makes them mandatory. One namespace label — `pod-security.kubernetes.io/enforce: restricted` — makes the API server reject any pod that runs as root, escalates privileges, keeps capabilities, or skips seccomp. It keeps next year's new Deployment as hardened as today's.

## 9. The edge: WAF, and what it is not

In front of everything sits `tickethub-prod-alb`, and AWS WAF attaches to it directly. Two things earn their cost: **managed rule groups** (Common, Known Bad Inputs, SQLi, IP Reputation — cheap filtering of commodity scanner noise) and **rate-based rules** on the endpoints attackers want: login (credential stuffing) and `/api/v1/orders` (on-sale bots). Ticketing honesty: bot management is an arms race against residential proxy pools and real budgets; WAF rate rules are the *floor*, not the solution — but a floor that stops one IP making 2,000 checkout attempts a minute is worth having. Deploy new rules in **count mode first**, watch a week of would-have-blocked metrics, then enforce — or discover your mobile app matches a bot rule at peak sales. And say it plainly: **a WAF is not an appsec substitute**. It pattern-matches requests; it cannot know that user 8712 must not fetch order 48211. That is the application's job:

| OWASP API Top 10 (2023) | Risk in one line | TicketHub's control |
|---|---|---|
| API1 Broken object-level auth | Fetching someone else's order by ID | Policies + `$this->authorize('view', $order)` on every object route |
| API2 Broken authentication | Weak/stuffable login | Sanctum tokens, `throttle:` on login, WAF rate rule |
| API3 Property-level auth | Mass assignment; over-exposed fields | `$fillable`, FormRequests, API Resources shaping output |
| API4 Resource consumption | One client exhausts the platform | Route rate limits, queue timeouts, WAF rules, HPA limits |
| API5 Broken function-level auth | Customer calls organizer endpoints | Route-group middleware + role checks in policies |
| API6 Sensitive business flows | Bots buying out an on-sale | Rate rules + reservation TTLs + per-user purchase limits |
| API7 SSRF | Server fetches attacker-chosen URLs | Outbound allowlist; never fetch raw user URLs; egress policy |
| API8 Security misconfiguration | Debug mode, permissive CORS | `APP_DEBUG=false` enforced, config in code (M5), ZAP baseline |
| API9 Improper inventory | Forgotten unversioned endpoints | Versioned `/api/v1`, `route:list` audits, staging behind auth |
| API10 Unsafe 3rd-party consumption | Trusting payment webhooks blindly | Verify webhook signatures, timeouts, validate payloads |

## 10. Compliance, quietly

One quiet paragraph: when a SOC 2 or ISO 27001 auditor eventually arrives, most of the evidence they want *already exists as a by-product of how you work*. Protected branches plus required PRs are change management with an approval trail; Git history plus CloudTrail plus Argo CD's sync log is an audit trail from commit to cluster; this module's scanners are your vulnerability-management program. Do not oversell it — auditors also want policies, risk registers, and paperwork engineering does not produce — but the hard technical substrate is largely done, and that is not an accident.

## Hands-on with TicketHub

Ship the four artifacts that turn this lecture from policy into enforcement.

**1. The weekly base-refresh workflow** (`.github/workflows/base-refresh.yml`) — rebuild on fresh base layers, scan, and route the result through GitOps:

```yaml
name: weekly-base-refresh
on:
  schedule:
    - cron: "0 20 * * 0"   # Mondays 04:00 SGT
  workflow_dispatch:

permissions:
  contents: read

env:
  ECR_REPO: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api

jobs:
  refresh:
    runs-on: ubuntu-latest
    permissions:
      id-token: write        # OIDC to AWS
      contents: read
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
      - uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502 # v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/tickethub-github-deploy
          aws-region: ap-southeast-1
      - uses: aws-actions/amazon-ecr-login@062b18b96a7aff071d4dc91bc00c4c1a7945b076 # v2
      - name: Rebuild on fresh base layers
        run: |
          TAG="sha-$(git rev-parse --short HEAD)-r$(date +%Y%m%d)"
          docker build --pull -t "$ECR_REPO:$TAG" .
          echo "TAG=$TAG" >> "$GITHUB_ENV"
      - name: Scan before push
        uses: aquasecurity/trivy-action@18f2510ee396bbf400402947b394f2dd8c87dbb0 # 0.29.0
        with:
          image-ref: ${{ env.ECR_REPO }}:${{ env.TAG }}
          severity: HIGH,CRITICAL
          exit-code: "1"
      - name: Push and open values-PR
        run: |
          docker push "$ECR_REPO:$TAG"
          gh pr create --repo tickethub/tickethub-api \
            --title "chore: weekly base image refresh ($TAG)" \
            --body "Fresh base layers; trivy clean. Updates prod image tag." \
            --head "base-refresh/$TAG"
        env:
          GH_TOKEN: ${{ secrets.VALUES_PR_TOKEN }}
```

(The PR edits `helm/tickethub/values-production.yaml`'s image tag; Argo CD does the rest — the Module 11 flow unchanged. If trivy fails, the workflow fails loudly — *that* is your patch-latency alarm.)

**2. SBOM + signature in the existing CI build job** (Module 7's `ci.yml`, after the push step):

```yaml
      - name: Generate SBOM
        uses: anchore/sbom-action@df80a981bc6edbc4e220a492d3cbe9f5547a6e75 # v0
        with:
          image: ${{ env.ECR_REPO }}@${{ steps.build.outputs.digest }}
          format: spdx-json
          artifact-name: sbom-${{ github.sha }}.spdx.json
      - uses: sigstore/cosign-installer@dc72c7d5c4d10cd6bcb8cf6e3fd625a9e5e537da # v3
      - name: Sign image (keyless)
        run: cosign sign --yes "$ECR_REPO@$DIGEST"
        env:
          ECR_REPO: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api
          DIGEST: ${{ steps.build.outputs.digest }}
```

Enforce at admission — Kyverno (installed via the Module 11 Terraform/Helm pattern) with a `verifyImages` policy: only images signed by *this repo's CI identity* run in namespace `tickethub`:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-tickethub-image-signatures
spec:
  validationFailureAction: Enforce
  webhookTimeoutSeconds: 30
  rules:
    - name: require-ci-signature
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [tickethub]
      verifyImages:
        - imageReferences:
            - "111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api*"
          attestors:
            - entries:
                - keyless:
                    issuer: https://token.actions.githubusercontent.com
                    subject: "https://github.com/tickethub/tickethub-api/.github/workflows/*"
```

Test it: `kubectl -n tickethub run test --image=nginx` → rejected, unsigned. That error message is the supply chain closing.

**3. Hardened SecurityContext** for `tickethub-web` (Helm deployment template; Horizon gets the same treatment minus nginx):

```yaml
spec:
  securityContext:
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: php-fpm
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - { name: laravel-storage, mountPath: /var/www/html/storage/framework }
        - { name: bootstrap-cache, mountPath: /var/www/html/bootstrap/cache }
        - { name: tmp, mountPath: /tmp }
    - name: nginx
      ports:
        - containerPort: 8080   # unprivileged — no NET_BIND_SERVICE needed
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - { name: nginx-cache, mountPath: /var/cache/nginx }
        - { name: nginx-run, mountPath: /var/run }
  volumes:
    - { name: laravel-storage, emptyDir: {} }
    - { name: bootstrap-cache, emptyDir: {} }
    - { name: tmp, emptyDir: {} }
    - { name: nginx-cache, emptyDir: {} }
    - { name: nginx-run, emptyDir: {} }
```

(The entrypoint's `config:cache` writes into `bootstrap/cache`, hence its mount; sessions live in Redis, files in S3 — Module 5's twelve-factor discipline is what makes read-only root *possible*.) Then make it mandatory:

```bash
$ kubectl label namespace tickethub pod-security.kubernetes.io/enforce=restricted
```

**4. NetworkPolicies** — deny everything, then re-allow the architecture:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: tickethub
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-web-ingress-from-alb
  namespace: tickethub
spec:
  podSelector:
    matchLabels: { app: tickethub-web }
  policyTypes: [Ingress]
  ingress:
    - from:
        - ipBlock: { cidr: 10.0.0.0/16 }   # ALB ENIs in tickethub-prod-vpc
      ports:
        - { protocol: TCP, port: 8080 }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-app-egress
  namespace: tickethub
spec:
  podSelector:
    matchExpressions:
      - { key: app, operator: In, values: [tickethub-web, tickethub-horizon, tickethub-scheduler] }
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: kube-system }
      ports:                                  # DNS — forget this and *everything* breaks
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
    - to:
        - ipBlock: { cidr: 10.0.0.0/16 }
      ports:                                  # RDS + ElastiCache
        - { protocol: TCP, port: 3306 }
        - { protocol: TCP, port: 6379 }
    - to:
        - ipBlock: { cidr: 0.0.0.0/0 }
      ports:                                  # S3, SES, payment gateway — TLS only
        - { protocol: TCP, port: 443 }
```

Verify the fence: `kubectl -n tickethub exec deploy/tickethub-web -c php-fpm -- php -r 'echo @file_get_contents("http://example.com") ? "open" : "blocked";'` → `blocked` — port 80 egress is not on the list, exactly right.

**The layered defense, assembled:**

| Layer | Control | Built in |
|---|---|---|
| Code | Larastan types, Semgrep patterns, review + branch protection | M7, M4, 12.4 |
| Dependencies | `composer audit`, Renovate + auto-merge policy, lockfile review | M7, 12.4 |
| Secrets | Secrets Manager + ESO/IRSA, push protection, practiced rotation | M8, M11, 12.4 |
| Pipeline | OIDC (no static keys), SHA-pinned actions, env-gated prod | M7, M9, 12.4 |
| Artifact | Multi-stage non-root image, trivy, weekly refresh, SBOM, cosign | M6, M7, 12.4 |
| Admission | Immutable tags, Kyverno signature verification, PSS `restricted` | M6, 12.4 |
| Runtime | SecurityContext, read-only root, dropped capabilities, seccomp | M6, 12.4 |
| Network | Private subnets + SGs, NetworkPolicies, TLS everywhere | M8, M3, 12.4 |
| Edge | WAF managed rules + rate limits, ALB, rate-limited auth | 12.4, M8 |
| Humans | MFA, least-privilege IAM, blameless culture (next lecture) | M8, 12.5 |

No single row stops a determined attacker; the stack means defeating *several* independent controls without tripping the observability from 12.1–12.3 — the honest definition of defense in depth.

## Real-world best practices

- **Turn on push protection first.** It prevents rather than detects, and a prevented leak costs zero rotation work. Why first: every other control needs a PR; this one needs a checkbox.
- **Route security findings into the same queue as bugs** — a work item with an owner and an SLA (criticals in 48h), not an emailed report. Why: findings without a workflow decay into ignored red that trains everyone to look away.
- **Practice rotations and restores on a calendar.** APP_KEY drill quarterly in staging; one backup-restore test (Module 8) per quarter. Why: untested recovery procedures fail exactly when needed — mid-incident.
- **Prefer removing a capability to monitoring its abuse.** Read-only root beats file-integrity alerting; no egress beats exfiltration detection. Why: a control that makes the attack impossible has no false negatives at 3 a.m.
- **Keep the paved road nicer than the dirt path.** The blessed Dockerfile, workflow, and chart templates should be the *easiest* way to ship. Why: developers route around security that slows them and adopt security that is the default.
- **Budget WAF and bot mitigation before your biggest on-sale, not after.** Why: ticketing attracts industrialized botting; a floor discovered too low mid-on-sale converts directly to lost revenue and headlines.

## Common pitfalls

1. **Scanning everything, fixing nothing.** Five scanners get wired up, the dashboard turns red, the reds become wallpaper — adding tools is easy, triage is work. Correct: fewer tools, each with a fail-the-build threshold and an owner for every finding.
2. **Pinning nothing because "we trust the ecosystem".** Floating action tags and unreviewed lockfile churn hand your CI's credentials to whoever compromises an upstream repo. Correct: SHA-pin actions, let Renovate manage the pins, review lockfile diffs.
3. **Deleting a leaked secret instead of rotating it.** The force-push makes the incident feel closed — but forks, clones, and CI logs remember. Correct: any secret that touched a remote is compromised; rotate immediately, clean history as hygiene, not remedy.
4. **Enabling `readOnlyRootFilesystem` without the emptyDir mounts.** The pod crash-loops on a Blade compile or `config:cache` write; the team concludes "hardening breaks Laravel" and reverts forever. Correct: mount `storage/framework`, `bootstrap/cache`, and `/tmp` as `emptyDir` — then it just works.
5. **Applying default-deny NetworkPolicies without the DNS rule.** Every connection times out, it looks like an outage, panic revert, "NetworkPolicies don't work here". Correct: ship the kube-system:53 egress rule in the same apply as the deny; test in staging with the probe.
6. **Treating the WAF as the application security program.** "We have a WAF" answers every appsec question while BOLA — which no WAF can see — sits open. Correct: the WAF filters commodity noise and rate-limits hot endpoints; authorization and validation live in the application, tested like any other behavior.

## Exercises

1. **Close the front door.** Enable push protection and add a gitleaks CI job, then push a fake AWS key (`AKIA...`) to a branch and document what each control does with it.
2. **The rotation drill.** Execute the full `APP_KEY` rotation from §4 in staging. Prove a login survives, and that a value encrypted before rotation still decrypts. Time yourself — that number goes in the runbook.
3. **Find the injection.** Plant the §5 `DB::select` interpolation bug in a scratch branch, confirm Semgrep fires, fix it, confirm clean — then triage one real finding as fix / tune / annotate, with a one-line justification.
4. **Fence one more workload.** Write and apply the *ingress* posture for `tickethub-horizon` (what should reach it? nothing). Confirm with a probe from a web pod that Horizon is unreachable — and that jobs still process.
5. **Stretch: break the chain, watch it hold.** Build the image locally, push it to ECR under a new tag *without* CI, and try to deploy it to namespace `tickethub`. Watch Kyverno reject it. Then answer from the SBOM artifact, in under ten minutes: "which exact version of `openssl` is in the deployed image?" — the xz-day drill.

## What's next

The system now defends itself in layers and tells you what is happening at every one. What remains is the part no tool automates: people running the system under pressure — humane on-call, incidents managed instead of flailed at, postmortems that make the system stronger, and the capstone checklist distilling all twelve modules into questions you can ask of any application. [Lecture 12.5 — SRE in Practice: Incidents & the Capstone](05-sre-incidents-capstone.md) closes the course where Module 1 opened it: the loop from change to production to learning, finally running end to end.
