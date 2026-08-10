# Lecture 6.4 — Registries & the Image Lifecycle

> **Module 6 — Docker & Containerization** · Lecture 4 of 4 · Estimated time: ~75 min

An image on your laptop is a build artifact with no audience. Deployment — CI pushing, ECS pulling (Module 9), Kubernetes nodes pulling (Module 11) — needs a shared, authoritative home for images, and a set of policies around it: what gets named what, what may be overwritten (nothing), what gets deleted, and what happens when yesterday's perfectly-built image turns up in today's CVE feed. This lecture sets up TicketHub's registry — ECR, per [`TICKETHUB.md`](../TICKETHUB.md) — and, more importantly, the *lifecycle discipline* around it. Registries are simple software; the operational maturity is all in the policies, and they're cheapest to set now, while the registry is empty.

## Learning objectives

- Explain what a registry stores — content-addressed blobs plus manifests — and why pushes and pulls deduplicate by layer
- Create and authenticate to an ECR repository with immutable tags and scan-on-push, and sketch least-privilege push vs pull IAM policies
- Apply the course tagging strategy: `sha-<gitsha>` as the only deployable truth, release tags by re-tag (never rebuild), environment pointers outside the registry
- Write lifecycle policies that cap storage growth without deleting anything you might roll back to
- Scan images with ECR and Trivy, and run a triage workflow that fixes, pins, or documents — never silently suppresses
- Operate the base-image refresh loop: why unchanged code needs rebuilds, and how digest pinning trades reproducibility for staleness

## 1. What a registry actually is

A registry is a content-addressed blob store with a standard HTTP API (the OCI distribution spec from Lecture 6.1) in front. It stores two kinds of objects: **blobs** — layer tarballs and image config files, addressed purely by digest (`sha256:…`) — and **manifests**, small JSON documents listing which blobs make up an image. A *tag* is nothing but a mutable name pointing at a manifest. That's the entire data model, and two operational facts fall straight out of it:

**Pushes and pulls move only missing blobs.** `docker push` first asks, per layer, "do you have `sha256:abc…`?" and uploads only the layers the registry lacks. Your 897 MB image (Lecture 6.2) costs ~900 MB the *first* push; a push after a code-only change moves the ~800 KB source layer and some kilobytes of manifest — because you ordered the Dockerfile so the fat layers (base system, extensions, vendor) sit below the layers that churn. Layer discipline is bandwidth and CI-minutes discipline; the ordering rule keeps paying.

**Deleting a tag deletes almost nothing.** Untagging dereferences a manifest; blobs are shared across every image that references them and are only garbage-collected when unreferenced. This is why "storage management" (section 5) is really *manifest* lifecycle management.

## 2. The landscape, briefly

**Docker Hub** is the default registry (`docker.io`) and where every base image you've pulled lives. For hosting *your* images it's less compelling: anonymous and free-tier pulls are rate-limited per IP — limits that have tightened repeatedly and that CI fleets or NAT'd offices hit as `429 Too Many Requests` at the worst moments. (Even as a pure *source* of base images this matters: Module 7's CI will authenticate pulls or cache images rather than trust anonymous quota.)

**GHCR** (GitHub Container Registry, `ghcr.io`) rides your GitHub org: same auth, same permissions model as the repo, generous free tier — excellent when GitHub is your platform and clusters can authenticate to it. Many open-source projects publish here.

**ECR** (Elastic Container Registry) is AWS's: private by default, regional, IAM-authenticated, integrated scanning, and — decisive for this course — *the same trust and network fabric as the things that will pull from it*. ECS tasks and EKS nodes in `ap-southeast-1` pull from ECR in `ap-southeast-1` over AWS's backbone with IAM roles, no cross-provider secrets anywhere. TicketHub uses ECR from here to the end.

## 3. Creating TicketHub's repository — with the settings that matter

One repository per image. TicketHub has two images but we'll create the second (`tickethub-nginx`) as an exercise; here's the one everything revolves around (yes, this is ClickOps-by-CLI — Module 10 recreates it in Terraform, and this command becomes documentation):

```
$ aws ecr create-repository \
    --repository-name tickethub-api \
    --image-tag-mutability IMMUTABLE \
    --image-scanning-configuration scanOnPush=true \
    --region ap-southeast-1
{
    "repository": {
        "repositoryArn": "arn:aws:ecr:ap-southeast-1:111122223333:repository/tickethub-api",
        "registryId": "111122223333",
        "repositoryName": "tickethub-api",
        "repositoryUri": "111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api",
        "createdAt": "2026-08-09T18:02:14.000000+08:00",
        "imageTagMutability": "IMMUTABLE",
        "imageScanningConfiguration": { "scanOnPush": true },
        "encryptionConfiguration": { "encryptionType": "AES256" }
    }
}
```

Both non-default flags are policy decisions, not tuning: `IMMUTABLE` makes every tag write-once (section 4 builds the whole strategy on it), and `scanOnPush` means no image enters the repository unscanned (section 6). The `repositoryUri` is the exact name from [`TICKETHUB.md`](../TICKETHUB.md) — registry host (your account, your region), repository `tickethub-api`.

**Authentication** is IAM wearing a Docker costume. ECR mints a temporary password (valid ~12 hours) that `docker login` understands:

```
$ aws ecr get-login-password --region ap-southeast-1 \
    | docker login --username AWS --password-stdin \
      111122223333.dkr.ecr.ap-southeast-1.amazonaws.com
Login Succeeded
```

Fine for a human at a laptop; wrong for CI — you'd need long-lived AWS keys stored in GitHub, exactly the credential class Module 5 taught you to distrust. Module 7 solves it properly with OIDC: GitHub Actions proves its identity to AWS and assumes a role, no stored keys at all. Forward reference only — but *this* is why we won't be pasting access keys into GitHub settings next module.

Because auth is IAM, push and pull are separable permissions — and should be. CI pushes; deploy targets pull; humans mostly pull. The action lists differ (deep IAM mechanics arrive in Module 8; the shape is worth seeing now):

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "PullTicketHubImages",
            "Effect": "Allow",
            "Action": [
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "ecr:BatchCheckLayerAvailability"
            ],
            "Resource": "arn:aws:ecr:ap-southeast-1:111122223333:repository/tickethub-api"
        },
        {
            "Sid": "EcrAuthToken",
            "Effect": "Allow",
            "Action": "ecr:GetAuthorizationToken",
            "Resource": "*"
        }
    ]
}
```

That's the *pull* role (`GetAuthorizationToken` is account-wide by API design; the repository ARN scopes everything real). A *push* role adds `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, and `ecr:CompleteLayerUpload` on the same resource — you can read the blob-store data model of section 1 right out of those action names. Least privilege here isn't ceremony: a compromised deploy target that can only pull cannot poison the images everyone else runs.

## 4. Tagging strategy: the SHA is the truth

Tags are mutable pointers by nature (section 1), and mutable names for deployable artifacts are how teams end up unable to answer "what exactly is running in production?" So the strategy, stated as rules first:

1. **Every CI build pushes exactly one immutable truth: `sha-<short-gitsha>`** — e.g. `tickethub-api:sha-a1b2c3d`. One commit ↔ one image, forever. Provenance ("what code is this?") and rollback ("redeploy what ran Tuesday") both reduce to Git archaeology, which Module 4 made trustworthy.
2. **Release tags (`v1.4.2`) are added to an existing image, never rebuilt.** The image you tested is the image you release — byte-identical. A rebuild "of the same commit" is a *different artifact* (new base-image patch level, new timestamps) that skipped your pipeline. The tool is `docker buildx imagetools create`, which writes a new tag on the registry pointing at an existing manifest — no pull, no push, no rebuild:

```
$ docker buildx imagetools create \
    -t 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:v1.4.2 \
       111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
```

3. **Environment pointers (`staging`, `prod`, `latest`) are banned as deploy references.** "Deploy `:prod`" means "deploy whatever that name means this minute" — undiagnosable ("which `prod` failed, the 3pm one or the 5pm one?"), un-rollback-able, and racy. **`latest` is not a version**; it's the absence of one. The course's verdict is absolute: *deployments reference `sha-` tags (or digests), and nothing else.*

ECR's `IMMUTABLE` mode turns rule 3 from policy into physics — a tag, once written, cannot be repointed:

```
$ docker push 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
…
tag invalid: The image tag 'sha-a1b2c3d' already exists in the 'tickethub-api'
repository and cannot be overwritten because the repository is immutable
```

That error is the system working — a rebuilt (therefore different) artifact just tried to impersonate an existing one, and was refused. Note the nuance immutability forces: it applies to **all** tags, so mutable pointer tags can't live in this registry *at all*. Good — it clarifies where pointers belong: **in the deploy system, not the registry.** "What's on staging" is a value in the pipeline and the ECS task definition (Module 9), pointing at an immutable `sha-` reference and updated by promotion. The registry stores artifacts; the delivery system holds opinions about them. (For belt-and-braces, the pipeline can resolve and record the *digest* at deploy time — the one identifier no one can even create a duplicate of.)

## 5. Lifecycle policies: storage math and deletion rules

Now for the consequence of "every commit pushes an image." Twenty merges a working day is ~440 images a month. Layer dedup means each typically adds only tens of megabytes of *unique* blobs — call it 40 MB — so the repository grows ~18 GB/month: at ECR's ~$0.10/GB-month that's pocket money at first ($1.80/month) but *linear forever*, plus hundreds of stale entries drowning the console and the scan reports. Worse are **untagged** manifests: build metadata pushes and superseded multi-arch entries that nothing will ever reference again. ECR lifecycle policies delete by rule, evaluated highest-priority first:

```json
{
    "rules": [
        {
            "rulePriority": 1,
            "description": "Expire untagged manifests after 14 days",
            "selection": {
                "tagStatus": "untagged",
                "countType": "sinceImagePushed",
                "countUnit": "days",
                "countNumber": 14
            },
            "action": { "type": "expire" }
        },
        {
            "rulePriority": 2,
            "description": "Keep only the most recent 50 sha- builds",
            "selection": {
                "tagStatus": "tagged",
                "tagPrefixList": ["sha-"],
                "countType": "imageCountMoreThan",
                "countNumber": 50
            },
            "action": { "type": "expire" }
        }
    ]
}
```

```
$ aws ecr put-lifecycle-policy \
    --repository-name tickethub-api \
    --lifecycle-policy-text file://ecr-lifecycle.json
```

Fifty `sha-` images ≈ two-plus weeks of builds at TicketHub's pace — a comfortable rollback horizon (if you're reaching back further than that, you're doing archaeology, not rollback; Git can always rebuild older commits through the pipeline). Release tags (`v*`) match neither rule and live indefinitely — deliberate: releases are the artifacts with compliance and audit value. Sanity-check any policy against a real question before applying: *"could this delete something I'd redeploy tonight?"* — and remember expiry deletes *image entries*; shared base layers survive as long as any remaining image references them.

## 6. Vulnerability scanning: from report to workflow

`scanOnPush` gives every pushed image a basic scan (OS packages against CVE databases; AWS's *enhanced* scanning, via Amazon Inspector, adds continuous re-scanning and language-package coverage for extra cost). But you also want scanning **before** push — on a laptop, in a PR — and a scanner you can run anywhere. The course standard is **Trivy**, and its first run on TicketHub is a rite of passage:

```
$ trivy image --severity HIGH,CRITICAL tickethub-api:dev

tickethub-api:dev (debian 12.7)
==============================
Total: 9 (HIGH: 8, CRITICAL: 1)

┌────────────────┬────────────────┬──────────┬──────────────┬─────────────────┬───────────────┐
│    Library     │ Vulnerability  │ Severity │    Status    │    Installed    │     Fixed     │
├────────────────┼────────────────┼──────────┼──────────────┼─────────────────┼───────────────┤
│ zlib1g         │ CVE-2023-45853 │ CRITICAL │ will_not_fix │ 1:1.2.13.dfsg-1 │               │
│ libicu72       │ CVE-2025-5222  │ HIGH     │ fixed        │ 72.1-3          │ 72.1-3+deb12u1│
│ libperl5.36    │ CVE-2023-31484 │ HIGH     │ affected     │ 5.36.0-7+deb12u2│               │
│ …              │                │          │              │                 │               │
└────────────────┴────────────────┴──────────┴──────────────┴─────────────────┴───────────────┘
```

Don't panic, *triage* — every finding takes one of three exits, in strict order of preference:

1. **Fixable → rebuild or bump.** A `fixed` status with a newer Debian package usually means upstream `php:8.4-fpm` already rebuilt on the patched base — pull fresh and rebuild (that's the whole refresh loop, next section). PHP-level dependency CVEs (Trivy also reads `vendor/` via Composer's installed manifest) mean a lockfile-updating PR — routine after Module 5.
2. **Not fixable yet, but real → track it.** `affected` with no fixed version: nothing to install. Assess exposure honestly (is the vulnerable code even reachable in an FPM API context?), and track upstream.
3. **Assessed and accepted → document, with governance.** `will_not_fix` from Debian (like the famous `zlib1g` minizip finding — in the vendored minizip code PHP never executes) can sit in reports forever. Move it to `.trivyignore` **only** with owner, reason, and a review date — an ignore entry is a *decision with an expiry*, not a suppression:

```
# .trivyignore — reviewed entries only.
# CVE in vendored minizip inside zlib source; not compiled into zlib1g's
# shared library that PHP links. Debian: will-not-fix.
# Owner: arcris · Reviewed: 2026-08-09 · Re-review by: 2026-11-09
CVE-2023-45853
```

The rule that keeps this honest: **an ignore file that only grows is a suppression file.** Review dates make entries expire into fresh decisions. Today scanning is a habit; Module 7 puts Trivy in CI, and Module 12 decides *gating* — which findings may block a deploy, and who owns the exception process.

## 7. The refresh loop, provenance labels, and architectures

**Your image inherits its base image's CVEs — so unchanged code still needs rebuilds.** `FROM php:8.4-fpm` copied several hundred megabytes of Debian into TicketHub's image; when Debian patches `libicu` next Tuesday, your image stays vulnerable until *you* rebuild from the refreshed base. Ship weekly and this mostly self-heals; let a service go quiet for a quarter and it accumulates every CVE of the interval. Hence a discipline that surprises newcomers: **a scheduled rebuild — weekly is the course default — of every production image, with zero code changes**, straight through the normal pipeline (new `sha-` tag against the same commit… now you *really* know why release tags re-tag rather than rebuild: rebuilds legitimately differ). The workflow lands with Modules 7 and 12's scheduled jobs; adopt the reasoning now.

This collides head-on with reproducibility, and the tension deserves honest treatment. You *could* pin the base by digest — `FROM php:8.4-fpm@sha256:9467f1…` — making builds byte-reproducible and immune to upstream surprises… including upstream *security patches*, which now require a manual digest bump nobody remembers. Or float on `php:8.4` and absorb patch *and minor* drift unreviewed. The course's position: **pin the minor tag (`php:8.4-fpm`), rebuild weekly, keep the scanner as the tripwire.** You accept small, bounded, *scanned* drift within a patch line in exchange for automatic security updates — for an application team, the right trade. (Digest pinning is the right call where reproducibility is the product — build toolchains, compliance artifacts — and teams who choose it must staff the bump automation.)

**Label what you ship.** Once dozens of `sha-` images exist, "which commit, when, from where?" should be answerable from the image itself — the OCI annotation spec standardizes the keys, and build args carry the values (append to the `app` stage):

```dockerfile
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.source="https://github.com/tickethub/tickethub-api" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
```

```
$ docker build --target app \
    --build-arg GIT_SHA=$(git rev-parse --short HEAD) \
    --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
    -t tickethub-api:dev .
$ docker inspect -f '{{json .Config.Labels}}' tickethub-api:dev
{"org.opencontainers.image.created":"2026-08-09T10:41:22Z",
 "org.opencontainers.image.revision":"a1b2c3d",
 "org.opencontainers.image.source":"https://github.com/tickethub/tickethub-api"}
```

This isn't decoration: deploy tooling reads `revision` to post "deployed a1b2c3d" to Slack, and incident responders `docker inspect` a mystery container at 3 a.m. and get a commit instead of a shrug. CI fills the args automatically in Module 7.

**Architectures, honestly.** `docker build` produces images for the host's architecture — which, on an Apple Silicon Mac, is `arm64`, and an `arm64`-only image on `amd64` ECS dies instantly with `exec format error`. This asymmetry hides locally because Docker Desktop runs both (emulating `amd64` when asked). `docker buildx` can build multi-arch manifests — one tag serving `amd64` and `arm64` — but building the *other* architecture rides QEMU emulation, and a two-minute PHP image build becomes ten-plus; native runner pairs fix the speed at the cost of pipeline complexity. The course keeps it simple and explicit: **CI builds `linux/amd64` (Module 7), matching every deploy target until Module 11**, where Graviton (`arm64`) nodes reopen the question with real price-performance stakes. Until then, remember the one command that bites Mac users pushing from laptops: add `--platform linux/amd64` — or better, don't push from laptops (next module exists for a reason).

## Hands-on with TicketHub

Push the Lecture 6.2 image through the full flow. (Cost note, per course policy: ECR charges ~$0.10/GB-month for storage — this lab stores under 1 GB, i.e., cents; teardown at the end regardless.) Repository and auth are set up in section 3; tag and push — Apple Silicon readers, build `--platform linux/amd64 --target app` first:

```
$ docker tag tickethub-api:dev \
    111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
$ docker push 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
The push refers to repository [111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api]
5f70bf18a086: Pushed
c9d4a1b7e2f0: Pushed
8a3c51e2b944: Pushed
…
sha-a1b2c3d: digest: sha256:ed4cb47b9b11f6d827865ee671a8e3ddb01d1bfe3c99b36375b45a104f240d62 size: 4297
```

(`docker tag` costs nothing — it's a local alias for the same image ID.) Now the dedup proof: change one line of PHP, rebuild, tag `sha-b2c3d4e`, push again:

```
$ docker push 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-b2c3d4e
f1e8a7c30d12: Pushed
c9d4a1b7e2f0: Layer already exists
8a3c51e2b944: Layer already exists
…
```

`Layer already exists` on every fat layer; only the rebuilt source layer uploaded — section 1's data model plus Lecture 6.2's layer ordering, visible on the wire. Pull by digest to see the only truly immutable reference, then exercise the strategy — a release re-tag, then a forbidden overwrite:

```
$ docker pull 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api@sha256:ed4cb47b…
$ docker buildx imagetools create \
    -t 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:v1.0.0 \
       111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
$ docker push 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
tag invalid: The image tag 'sha-a1b2c3d' already exists in the 'tickethub-api'
repository and cannot be overwritten because the repository is immutable
```

The re-tag succeeded instantly (new tag → existing manifest; nothing moved); the overwrite bounced (existing tag → refused). Both behaviors are the strategy, enforced. Apply the lifecycle policy from section 5, then check what scan-on-push found — and compare with a local Trivy run:

```
$ aws ecr put-lifecycle-policy --repository-name tickethub-api \
    --lifecycle-policy-text file://ecr-lifecycle.json
$ aws ecr describe-image-scan-findings \
    --repository-name tickethub-api --image-id imageTag=sha-a1b2c3d \
    --query 'imageScanFindings.findingSeverityCounts'
{
    "HIGH": 8,
    "CRITICAL": 1,
    "MEDIUM": 23,
    "LOW": 41
}
$ trivy image --severity HIGH,CRITICAL \
    111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
```

Run the section-6 triage on the HIGH/CRITICAL list for real: bucket every finding into *rebuild*, *track*, or *documented ignore*, and open the PR for anything in bucket one. Finally, teardown (course rule: no lab resources left running — `--force` deletes the repository along with its images):

```
$ aws ecr delete-repository --repository-name tickethub-api --force
```

…unless you're continuing straight into Module 7, which will want this repository back — in which case keep it, note the cents, and consider the lifecycle policy your cost control.

## Real-world best practices

- **One immutable identifier from commit to production.** The `sha-` tag (or its digest) appears in CI logs, deploy records, `docker inspect`, and incident timelines — one join key across every system. Teams with mutable tags spend incident time *establishing what's running*; teams with SHA discipline spend it fixing the problem.
- **Registries hold artifacts; deploy systems hold pointers.** "What's on staging" lives in the pipeline and task definition (Module 9), versioned and auditable — never as a floating registry tag someone repoints by hand. If you can't `git log` your environment pointers' history, you don't have promotion, you have vibes.
- **Scan continuously, not just at push.** Scan-on-push checks images against *today's* CVE database; tomorrow's CVEs apply to already-pushed images. Enhanced scanning (Inspector) or a scheduled re-scan of currently-deployed tags closes the gap — an image that was clean in March can be your worst finding in June without a byte changing.
- **Budget the refresh loop like a feature.** Weekly base rebuilds + scanner tripwire + quarterly review of the `.trivyignore` — about an hour a month once automated, and the difference between "we patched libicu Tuesday" and explaining eighteen months of inherited CVEs after an audit. Unpatched base images are the container era's unattended servers (Module 2's lesson, one abstraction up).
- **Least-privilege registry access from day one.** Push rights for CI only; pull rights for deploy targets; humans read-mostly. The registry is executable code storage — whoever can write to it can eventually run code on everything that pulls from it. Treat `PutImage` like `sudo`.

## Common pitfalls

1. **Deploying `latest` (or any mutable tag).** It works in the demo, then one day staging and production resolve the same word to different bytes and you debug a deploy that "didn't change anything." People do it because tutorials do. Correct approach: `sha-` references everywhere; make the registry enforce it with `IMMUTABLE` so the shortcut isn't merely discouraged but impossible.
2. **Rebuilding to create a release tag.** "Just rebuild v1.4.2 from the tag" produces an artifact that skipped your entire testing history — new base layers, new resolution timing — while wearing a tested version's name. It happens because rebuilds *usually* match. Correct approach: `imagetools create` re-tags the tested manifest; rebuilds only ever produce *new* `sha-` truths.
3. **No lifecycle policy until the bill (or the console) hurts.** Growth is silent — a few dollars a month, then someone pages through 2,000 untitled images looking for a rollback target. Then a panicked bulk delete removes something referenced. Correct approach: the two-rule policy ships the same day the repository does, sized to your actual rollback horizon.
4. **Treating the scanner as a verdict instead of a feed.** Two failure modes, same root: teams that ignore the report entirely (until an auditor reads it to them), and teams that chase every LOW to zero and burn out into ignoring it entirely. Correct approach: severity-triaged workflow — HIGH/CRITICAL get the three-exit treatment within a sprint; ignores carry owners and expiry dates; zero is not the goal, *decided* is.
5. **The Apple Silicon architecture surprise.** An image built on an M-series Mac, pushed by hand, deployed to amd64 — `exec format error`, an incident that a laptop should never have been positioned to cause. Correct approach: CI builds and pushes (`linux/amd64`, declared explicitly); laptop pushes are for labs like today's, with `--platform` stated; and check `docker inspect -f '{{.Architecture}}'` whenever an image's origin is fuzzy.

## Exercises

1. Create the second repository, `tickethub-nginx`, with the same immutability and scanning settings, push the Lecture 6.2 nginx image as `sha-a1b2c3d`, and compare push output with the app image's — how much did the two pushes share, and why exactly that amount? (Check both images' base layers before answering.)
2. Write and apply a lifecycle-policy *addition* that expires images tagged with prefix `pr-` after 7 days (Module 7 will push per-PR images for review environments). Prove rule-priority reasoning: could your rule ever race rule 2 for the same image, and which wins?
3. Using only registry/inspect data — no Git checkout — determine for `tickethub-api:v1.0.0`: the commit it was built from, when it was built, and whether it's byte-identical to `sha-a1b2c3d`. List the commands, and name which of section 7's practices made each answer possible.
4. Simulate the refresh loop: `docker pull php:8.4-fpm` (grab any newer patch digest), rebuild with no code changes, and diff `trivy image` results between the old and new builds. Write three sentences: what changed, what didn't, and what tag the new artifact must get (and must *not* get).
5. **Stretch:** run the multi-arch experiment honestly. Set up `docker buildx` with QEMU, build `--platform linux/amd64,linux/arm64 --target app`, and time it against your native build. Push to ECR and inspect with `docker buildx imagetools inspect` — find the manifest *list* and per-arch digests. Conclude with a recommendation for TicketHub's CI today (not Module 11): is the emulation cost worth it before Graviton exists in the stack, and what specifically would change your answer?

## What's next

Module 6 is complete: TicketHub builds an immutable, non-root, scanned production image; develops against a full-parity Compose stack; and stores artifacts in a registry with real lifecycle discipline. What's still human-powered is *everything between a merged PR and a pushed image* — building, testing, tagging, pushing, all currently your fingers. Module 7 hands the whole sequence to CI: GitHub Actions running Pest against the same MySQL and Redis your Compose file pins, quality gates that block bad merges, and — via OIDC, no stored keys — BuildKit-cached image builds pushing `sha-` tags to this very repository on every merge. Continue to [Module 7 — Continuous Integration with GitHub Actions](../module-07-ci-github-actions/).
