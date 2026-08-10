# Lecture 7.4 — Building & Pushing Images in CI

> **Module 7 — Continuous Integration with GitHub Actions** · Lecture 4 of 4 · Estimated time: ~70 min

Three lectures in, the pipeline can tell you a merge is safe. It still can't *give* you anything. The production image from [Module 6](../module-06-docker/02-production-dockerfile-laravel.md) gets built on whichever laptop last ran `docker build` and pushed with whoever's AWS keys were configured — which means the artifact you'll deploy is exactly as reproducible, auditable, and trustworthy as one developer's Tuesday afternoon.

This lecture finishes the module by making the pipeline's output a *thing*: **every merge to `main` produces one immutable, scanned, provenance-stamped image in ECR, tagged `sha-<short-sha>`** — the artifact Module 9 will deploy to staging on merge and promote to production on a `v*` tag, without ever rebuilding it. Along the way you get the single highest-leverage security upgrade in this course: authenticating CI to AWS with **OIDC**, so not one long-lived cloud credential is stored anywhere. The finished `ci.yml`, printed in full at the end, is the course's reference CI pipeline from here to Kubernetes.

## Learning objectives

- Explain why the deployable artifact must be produced by CI, and what "build once, promote everywhere" changes downstream
- Place the build job in the DAG so red builds never publish and PRs validate the Dockerfile without pushing
- Replace long-lived AWS keys with GitHub OIDC — provider, trust policy, scoped permissions — and justify every line of both policies
- Configure Buildx, `metadata-action` tagging, and BuildKit layer caching that survives fresh runners
- Stamp images with provenance (`APP_VERSION`, OCI labels) and gate them with a smoke test and a Trivy scan before any push
- Assemble the module's complete `ci.yml` and leave the `deploy.yml` stub that Module 9 completes

## 1. The artifact, not the checkmark

A laptop build fails as a release process on every axis that matters. Nobody can say which commit an image contains (uncommitted changes ride along silently), which dependencies were resolved that day, or who built it — and the AWS keys that pushed it live in a developer's `~/.aws`, which Module 8 will teach you to treat as a standing incident. CI inverts all of it: the build runs from an exact commit on a throwaway VM (7.1's known-clean-state property), the workflow file *is* the documented build procedure, and the run log is the audit trail.

That enables the principle this lecture plants and Module 9 harvests: **build once, promote everywhere.** The image built from merge commit `9f2c1d7` is tagged `sha-9f2c1d7` and never rebuilt. Staging runs that image; when it proves out, production runs *the same digest* — a release tag re-points at it rather than triggering a second build. The alternative, rebuilding per environment, quietly deploys something you never tested: hours later, the base image has moved, a dependency re-resolved, and "the same Dockerfile" is not the same image. Module 6 made ECR tags immutable for exactly this discipline — an immutable `sha-` tag *is* the promise that what staging validated is what production gets.

## 2. Where the build sits in the pipeline

Two placement decisions, both about trust:

- **`needs: [tests, quality]`.** The build job runs only after both gates pass, so a red commit can never become a pushable artifact. This costs a little wall time versus building in parallel, and buys something worth more: *the existence of an image in ECR means the commit passed everything*. Module 9 gets to treat the registry as a menu of deployable versions with no further questions.
- **PRs build too — without pushing.** The Dockerfile, the nginx config, `docker/entrypoint.sh` — all of it is code, and code that only gets exercised after merge fails after merge, on `main`, where it blocks everyone (7.1's red-`main` fire drill). So every PR runs the full build to validate it, then simply skips the push and the AWS login. With the warm caches from section 6, the extra PR cost is about 90 seconds, inside the module's ten-minute budget.

## 3. Killing the long-lived key: OIDC

### 3.1 The anti-pattern

The tutorial-default approach is an IAM user with an access key pair pasted into GitHub secrets. Every part of that ages badly. The key is **long-lived** — valid until someone rotates it, and nobody rotates it. It is **ambient** — any step in any workflow with secret access can read it, which after 7.1's action-hijack story (`tj-actions/changed-files` exfiltrating exactly such secrets from thousands of repos) should make your skin crawl. It **spreads** — copied to a second workflow, a teammate's fork experiment, a terminal history. And when it leaks, the blast radius is whatever the IAM user can do, from anywhere on the internet, indefinitely. The industry's verdict is in: stored cloud keys in CI are rotation debt plus leak surface, purchased for no benefit — because GitHub can prove a workflow's identity cryptographically instead.

### 3.2 The flow

OpenID Connect turns "I have a copied secret" into "I can prove who I am, right now":

1. A job declares `permissions: id-token: write` — the 7.1 escalation you've been waiting to use. Only that job may request an identity token.
2. At the `configure-aws-credentials` step, the runner asks GitHub's OIDC issuer (`token.actions.githubusercontent.com`) for a **JWT**: a short-lived, signed statement of exactly what is running. Its claims include the repository, the ref, the commit SHA, the actor, the run id — and two that AWS will interrogate:

```json
{
  "iss": "https://token.actions.githubusercontent.com",
  "aud": "sts.amazonaws.com",
  "sub": "repo:tickethub/tickethub-api:ref:refs/heads/main",
  "repository": "tickethub/tickethub-api",
  "ref": "refs/heads/main",
  "sha": "9f2c1d7e5b8c41d2a90f37e6c2a41b7d8e19c3f4",
  "run_id": "17308821406"
}
```

3. The action calls AWS STS: `AssumeRoleWithWebIdentity`, presenting the JWT and naming the role `tickethub-github-deploy`.
4. AWS verifies the token's signature against the **IAM OIDC provider** you registered for GitHub's issuer, checks the role's **trust policy conditions** against the claims, and — only if both hold — returns temporary credentials that expire in an hour.
5. Those credentials exist in that job's environment and nowhere else. Nothing is stored, so nothing can leak from storage, and there is nothing to rotate.

The role's ARN appears in plain text in the workflow, and that is fine: **an ARN is not a secret.** Knowing it grants nothing — only a workflow whose signed claims satisfy the trust policy can assume the role. The security moved from "who holds the string" to "who can prove the claims", which is the entire point.

### 3.3 The provider and the role

One warning before the JSON, because it is the sharpest edge in all of OIDC: GitHub's issuer signs tokens for **every repository on GitHub**. Your OIDC provider trusts the issuer; therefore *the trust policy's conditions are the only thing standing between your AWS account and every workflow on the internet.* A trust policy without a `sub` condition is an open door with good intentions. Here is `trust-policy.json`, in full:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GitHubActionsMainBranchOnly",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:tickethub/tickethub-api:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

Read the conditions as the two questions AWS asks the token. **`aud` (`StringEquals`)**: was this token minted *for AWS STS*? — `configure-aws-credentials` requests exactly that audience, and pinning it stops a token minted for some other service being replayed here. **`sub` (`StringLike`)**: is this *my* repo, on *the* branch? The subject format is `repo:<org>/<repo>:ref:<ref>` for branch runs, and locking it to `refs/heads/main` means a PR run, a feature branch, or any other repository presenting a perfectly valid GitHub token gets `AccessDenied`. `StringLike` (rather than `StringEquals`) is the conventional choice because subjects are patterns in practice — and when Module 9 introduces GitHub *environments* for production approvals, the subject for those jobs changes shape to `repo:tickethub/tickethub-api:environment:production`, and this condition grows a second entry. Same mechanism, tighter scope, later.

The permissions policy is just as deliberately small — `ecr-push-policy.json`, granting pushes to **the two TicketHub repositories and nothing else**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrLogin",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "PushPullTicketHubImages",
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
      "Resource": [
        "arn:aws:ecr:ap-southeast-1:111122223333:repository/tickethub-api",
        "arn:aws:ecr:ap-southeast-1:111122223333:repository/tickethub-nginx"
      ]
    }
  ]
}
```

(`GetAuthorizationToken` must be `Resource: "*"` — an AWS API constraint, since login isn't per-repository; every other action is pinned to the two repo ARNs from Module 6.) Even a fully compromised `main` workflow can push images and do *nothing else* in the account — no S3, no EC2, no IAM. Module 8 goes deep on IAM's model; this role is your first taste of least privilege done properly, and Module 9 will extend it consciously, not accidentally.

## 4. The build toolchain: Buildx and metadata

Three actions turn "docker build on a runner" into a production build system. **`docker/setup-buildx-action@v3`** starts a BuildKit builder in a container — needed because the runner's default Docker driver can't export the cache backends section 6 depends on. **`docker/metadata-action@v5`** computes tags and labels from the Git context, one invocation per image, so naming lives in configuration rather than in shell string-gluing:

```yaml
tags: |
  type=sha,format=short,prefix=sha-   # every build: sha-9f2c1d7 — Module 6's scheme
  type=ref,event=tag                  # a run for tag v1.4.2 would add v1.4.2
flavor: |
  latest=false                        # TICKETHUB.md: latest is never deployed
```

The `type=sha` rule produces exactly the `sha-<short-sha>` tag TicketHub standardized in Module 6. The `type=ref,event=tag` rule is how teams map release tags to image tags — and understanding it is how you'll understand why our final `ci.yml` **omits it**: `ci.yml` never runs on tags. Releases don't rebuild; Module 9 promotes by re-tagging the already-validated digest. Wiring a tag trigger into `ci.yml` would rebuild on release — an image you never tested — and then ECR's immutable tags would reject the duplicate `sha-` tag anyway. Module 6's immutability decision is quietly designing your pipeline for you, which is what good constraints do. So: `ci.yml` mints `sha-` tags only; `v*` belongs to `deploy.yml`.

Finally **`docker/build-push-action@v6`** runs the build itself — twice per pipeline, because Module 6 split TicketHub into two images: the PHP-FPM **app image** from the root `Dockerfile`, and the **nginx image** from `docker/nginx/Dockerfile` that serves static files and proxies FPM. They version together (same `sha-` tag from the same commit), so Module 9 can always deploy a matched pair.

## 5. Provenance: the image knows what it is

An image in a registry is a black box unless you stamp it. Two stamps, both nearly free. The `metadata-action`'s `labels` output writes the OCI standard labels — `org.opencontainers.image.revision` (the full SHA), `.source` (the repo URL), `.created` — into the image config, machine-readable forever via `docker inspect`. And a build arg carries the version *into the application*:

```yaml
build-args: |
  APP_VERSION=${{ github.sha }}
```

Wire it through in three small pieces. The final stage of Module 6's `Dockerfile` accepts it — **placed at the end of the stage**, because an `ARG` changing every commit invalidates the layer that uses it and everything after; put it last and the per-commit rebuild is one trivial layer instead of the whole image:

```dockerfile
# Dockerfile — final stage, last instructions
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
```

Then `config/app.php` gains `'version' => env('APP_VERSION', 'dev'),` and TicketHub's health endpoint returns it — replace the framework's default `/up` view with JSON:

```php
// routes/web.php
Route::get('/up', fn () => response()->json([
    'status'  => 'ok',
    'version' => config('app.version'),
]));
```

Now any environment can answer "what exactly is running?" with one curl. That single field is load-bearing for the rest of the course: Module 9's deploy verification asserts `/up` reports the SHA it just deployed, and Module 12 hands the same value to Sentry as the release marker.

## 6. Warm layers on cold runners

On your laptop, Docker rebuilds only what changed because the layer cache lives on disk between builds. A CI runner has no "between" — every run is a fresh VM (7.1's rule), so every build is cold: base image pulled, PHP extensions compiled, Composer packages installed, assets built, ~7 minutes, every merge, forever. BuildKit fixes this by making the cache *exportable*:

```yaml
cache-from: type=gha,scope=app        # import: restore layers from the GitHub cache service
cache-to:   type=gha,scope=app,mode=max
```

`type=gha` stores layers in the same GitHub cache service as your Composer and PHPStan caches. `mode=max` matters more than it looks: the default (`min`) caches only final-stage layers, which for a multi-stage Dockerfile like Module 6's means the expensive intermediate stages — the Composer install, the asset build — are *not* cached and rebuild every time. `mode=max` exports every stage. `scope` keeps the app and nginx images from evicting each other's entries. The honest numbers on a warm cache:

| Build | Wall time |
|---|---|
| Cold (first run, or cache evicted) | ~6–8 min |
| Warm, only PHP code changed | ~90 s |
| Warm, `composer.lock` changed | ~3–4 min |
| Re-build for push after an identical in-job build | ~20–30 s |

Know the ceiling before you hit it: the GitHub cache service holds **10 GB per repo, LRU-evicted** — and image layer caches are hundreds of megabytes per scope, now competing with every other cache in the repo. When eviction makes builds randomly cold (the symptom: intermittent 8-minute builds with no lock-file change), the upgrade is a **registry cache**: `type=registry` with `mode=max`, exporting the cache itself to ECR (`image-manifest=true,oci-mediatypes=true` for ECR compatibility) — cross-runner, no size cliff, at pennies of storage. One trap for that day: a moving `:buildcache` tag can't live in the immutable `tickethub-api` repo — give the cache its own *mutable* repository. The course starts on `type=gha` because it's zero-setup and sufficient at this scale; the upgrade is named so future-you recognizes the moment. Either way, 7.1's law holds: cache is an accelerator, never a dependency — a fully evicted cache means a slow build, not a broken one.

## 7. Verify before you publish

The push is the point of no return — after it, the image is a deployment candidate (and with Module 9 wired up, staging deploys it *automatically*). So everything cheap and decisive happens before it, on the image built into the runner's Docker with `load: true`.

**The smoke test** answers "is this image even alive?" for the cost of two `docker run`s: boot the framework (`php artisan --version` exercises the autoloader and every service provider) and verify the compiled extension list matches what [Lecture 7.2](02-tickethub-test-pipeline.md) declared for the test environment — the exact parity check that catches a broken `docker-php-ext-install` or a Dockerfile edit that dropped `pcntl`, *before* it becomes a CrashLoopBackOff mystery in Module 11. Ten seconds, and an entire failure class never reaches the registry.

**The Trivy scan** gates on known vulnerabilities: `--severity CRITICAL --exit-code 1` — a critical CVE in the image blocks the push, full stop. `ignore-unfixed: true` keeps the gate actionable: a critical with no released fix would otherwise block every merge while offering nothing to do about it (it stays visible in ECR's scanning, below). Waivers follow Module 6's `.trivyignore` governance — an entry needs a written reason and an owner, reviewed like code. And no, this doesn't duplicate ECR's `scanOnPush` from Module 6 — that scan runs *after* the artifact exists and reports asynchronously, which makes it a monitor, not a gate. The division of labor: **Trivy in the pipeline blocks vulnerable images from existing; ECR scanning watches already-pushed images as new CVEs are published.** You want both, because a clean image today is a vulnerable image eventually.

## Hands-on with TicketHub

**Step 1 — create the OIDC provider and role** (one-time, admin credentials, from your machine — after this, CI never sees a stored key). Nothing here bills by the hour; ECR storage for images and Actions cache usage are the only costs, and they are cents.

```console
$ aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
$ aws iam create-role --role-name tickethub-github-deploy \
    --assume-role-policy-document file://trust-policy.json
$ aws iam put-role-policy --role-name tickethub-github-deploy \
    --policy-name ecr-push-tickethub \
    --policy-document file://ecr-push-policy.json
```

(The thumbprint argument is required by the API but no longer load-bearing — AWS now validates GitHub's issuer against its own trusted CA store. The JSON files are section 3's, kept in the repo under `.github/aws/` in the settings-as-code spirit of Module 4's ruleset.)

**Step 2 — wire the provenance** from section 5: the two `Dockerfile` lines, the `config/app.php` entry, the `/up` route.

**Step 3 — the complete `ci.yml`.** This is the module's deliverable — the reference pipeline the rest of the course builds on. The `tests` job is 7.2's, the `quality` job is 7.3's, the `build` job is new:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  tests:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: secret
          MYSQL_DATABASE: tickethub_test
        ports:
          - 3306:3306
        options: >-
          --health-cmd="mysqladmin ping --silent"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd="redis-cli ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5

    env:
      APP_ENV: testing
      DB_CONNECTION: mysql
      DB_HOST: 127.0.0.1
      DB_PORT: 3306
      DB_DATABASE: tickethub_test
      DB_USERNAME: root
      DB_PASSWORD: secret
      REDIS_HOST: 127.0.0.1
      REDIS_PORT: 6379
      CACHE_STORE: redis
      QUEUE_CONNECTION: redis
      MAIL_MAILER: array
      FILESYSTEM_DISK: local

    steps:
      - uses: actions/checkout@v4

      - name: Set up PHP 8.4
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.4'
          extensions: mbstring, intl, gd, bcmath, pdo_mysql, redis, pcntl
          coverage: pcov

      - name: Determine Composer cache directory
        id: composer-cache
        run: echo "dir=$(composer config cache-files-dir)" >> "$GITHUB_OUTPUT"

      - name: Cache Composer downloads
        uses: actions/cache@v4
        with:
          path: ${{ steps.composer-cache.outputs.dir }}
          key: composer-${{ runner.os }}-${{ hashFiles('composer.lock') }}
          restore-keys: composer-${{ runner.os }}-

      - name: Install dependencies
        run: composer install --prefer-dist --no-progress --no-interaction

      - name: Generate application key
        run: echo "APP_KEY=$(php artisan key:generate --show)" >> "$GITHUB_ENV"

      - name: Run migrations
        run: php artisan migrate --force

      - name: Run tests (parallel, with coverage)
        run: php artisan test --parallel --coverage --min=80 --coverage-html=coverage-report

      - name: Upload coverage report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage-report
          retention-days: 7

  quality:
    runs-on: ubuntu-latest
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@v4

      - name: Set up PHP 8.4
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.4'
          coverage: none

      - name: Validate composer.json and lock file
        run: composer validate --strict

      - name: Determine Composer cache directory
        id: composer-cache
        run: echo "dir=$(composer config cache-files-dir)" >> "$GITHUB_OUTPUT"

      - name: Cache Composer downloads
        uses: actions/cache@v4
        with:
          path: ${{ steps.composer-cache.outputs.dir }}
          key: composer-${{ runner.os }}-${{ hashFiles('composer.lock') }}
          restore-keys: composer-${{ runner.os }}-

      - name: Install dependencies
        run: composer install --prefer-dist --no-progress --no-interaction

      - name: Check code style (Pint)
        run: ./vendor/bin/pint --test

      - name: Cache PHPStan result cache
        uses: actions/cache@v4
        with:
          path: var/phpstan
          key: phpstan-${{ runner.os }}-${{ github.run_id }}
          restore-keys: phpstan-${{ runner.os }}-

      - name: Static analysis (PHPStan + Larastan)
        run: ./vendor/bin/phpstan analyse --error-format=github --no-progress

      - name: Audit dependencies for known vulnerabilities
        run: composer audit --abandoned=report

      - name: Review dependency changes (PRs only)
        if: github.event_name == 'pull_request'
        uses: actions/dependency-review-action@v4
        with:
          fail-on-severity: high

  build:
    needs: [tests, quality]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      id-token: write            # this job alone may request an OIDC identity token
    env:
      ECR_REGISTRY: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Docker metadata (app image)
        id: meta_app
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.ECR_REGISTRY }}/tickethub-api
          flavor: |
            latest=false
          tags: |
            type=sha,format=short,prefix=sha-

      - name: Docker metadata (nginx image)
        id: meta_nginx
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.ECR_REGISTRY }}/tickethub-nginx
          flavor: |
            latest=false
          tags: |
            type=sha,format=short,prefix=sha-

      - name: Build app image
        uses: docker/build-push-action@v6
        with:
          context: .             # the checked-out workspace, not the action's default Git context
          load: true             # into the runner's Docker, so we can run and scan it first
          tags: ${{ steps.meta_app.outputs.tags }}
          labels: ${{ steps.meta_app.outputs.labels }}
          build-args: |
            APP_VERSION=${{ github.sha }}
          cache-from: type=gha,scope=app
          cache-to: type=gha,scope=app,mode=max

      - name: Build nginx image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/nginx/Dockerfile
          load: true
          tags: ${{ steps.meta_nginx.outputs.tags }}
          labels: ${{ steps.meta_nginx.outputs.labels }}
          cache-from: type=gha,scope=nginx
          cache-to: type=gha,scope=nginx,mode=max

      - name: Smoke test app image
        run: |
          IMAGE="$ECR_REGISTRY/tickethub-api:${{ steps.meta_app.outputs.version }}"
          docker run --rm "$IMAGE" php artisan --version
          MODULES=$(docker run --rm "$IMAGE" php -m)
          for ext in mbstring intl gd bcmath pdo_mysql redis pcntl; do
            echo "$MODULES" | grep -qix "$ext" \
              || { echo "::error::image is missing PHP extension: $ext"; exit 1; }
          done
          echo "All required extensions present."

      - name: Scan app image (block on CRITICAL)
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: ${{ env.ECR_REGISTRY }}/tickethub-api:${{ steps.meta_app.outputs.version }}
          severity: CRITICAL
          exit-code: '1'
          ignore-unfixed: true

      - name: Configure AWS credentials (OIDC)
        if: github.ref == 'refs/heads/main'
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/tickethub-github-deploy
          aws-region: ap-southeast-1

      - name: Log in to Amazon ECR
        if: github.ref == 'refs/heads/main'
        uses: aws-actions/amazon-ecr-login@v2

      - name: Push app image
        if: github.ref == 'refs/heads/main'
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta_app.outputs.tags }}
          labels: ${{ steps.meta_app.outputs.labels }}
          build-args: |
            APP_VERSION=${{ github.sha }}
          cache-from: type=gha,scope=app
          provenance: false      # plain single-manifest images until Module 12's supply-chain lecture

      - name: Push nginx image
        if: github.ref == 'refs/heads/main'
        uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/nginx/Dockerfile
          push: true
          tags: ${{ steps.meta_nginx.outputs.tags }}
          labels: ${{ steps.meta_nginx.outputs.labels }}
          cache-from: type=gha,scope=nginx
          provenance: false
```

Read the `build` job's shape once more as a story: metadata computes names; two builds load images into the runner; the smoke test and scan interrogate them; only then — and only on `main`, per the `if:` from 7.1's own foreshadowing — does the job authenticate and push. The push steps *rebuild*, which sounds wasteful and isn't: identical context and args against the just-written cache resolve in ~20 seconds, and the pattern stays simple. On PRs the last four steps skip entirely — no credentials are even requested, and the trust policy would refuse them anyway. Defense in depth: the workflow doesn't try, and AWS wouldn't allow it.

**Step 4 — ship it and read the run.** Push the branch, merge the PR (note the PR run: both build steps execute, the push steps show *Skipped*), then watch the `main` run:

```text
✓ ci · main · 17308821406
JOBS
✓ tests in 4m05s   ✓ quality in 2m28s   ✓ build in 7m52s     (first run: cold cache)

Run aws-actions/configure-aws-credentials@v4
Assuming role with OIDC
Authenticated as assumedRoleId AROA5EXAMPLE:GitHubActions

#4 importing cache manifest from gha:...
 => CACHED [base 3/8] RUN docker-php-ext-install pdo_mysql bcmath pcntl ...
 => [production 9/11] COPY --chown=www-data . /var/www/html

Laravel Framework 12.21.0
All required extensions present.

tickethub-api:sha-9f2c1d7 (debian 12.8)
Total: 0 (CRITICAL: 0)

#21 pushing manifest for .../tickethub-api:sha-9f2c1d7@sha256:4c1f8e...
```

The next merge, with warm caches, brings `build` to under two minutes. Verify the artifact from your terminal — both the registry's view and the image's own stamp:

```console
$ aws ecr describe-images --repository-name tickethub-api \
    --query 'sort_by(imageDetails,&imagePushedAt)[-1].{tags:imageTags,scan:imageScanStatus.status}'
{ "tags": ["sha-9f2c1d7"], "scan": "COMPLETE" }
$ ECR=111122223333.dkr.ecr.ap-southeast-1.amazonaws.com
$ docker pull -q $ECR/tickethub-api:sha-9f2c1d7 && docker inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    $ECR/tickethub-api:sha-9f2c1d7
9f2c1d7e5b8c41d2a90f37e6c2a41b7d8e19c3f4
```

**Step 5 — leave the door Module 9 walks through.** Create `.github/workflows/deploy.yml` as a stub — it claims the `v*` tag event and the manual trigger now, so the release convention from Module 4 has a landing site:

```yaml
name: deploy

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Placeholder
        run: echo "Deployment pipeline is completed in Module 9."
```

And with that, the promotion model this course has been assembling since Module 4 closes its loop: **a PR** runs `tests`, `quality`, and a push-less `build` — the ruleset merges nothing unverified. **A merge to `main`** produces `sha-<short-sha>` in ECR — immutable, scanned, stamped, deployable. **A tag `v*`** fires `deploy.yml` — which today prints one honest line, and in Module 9 promotes an image that already exists to the environment that earned it.

## Real-world best practices

- **No long-lived cloud keys in CI, ever — OIDC or bust.** Every stored key is rotation debt plus leak surface; the 2025 action-compromise incidents harvested exactly those secrets. If a workflow holds an `AWS_SECRET_ACCESS_KEY` today, migrating it to OIDC is the highest-leverage hour of security work available to you.
- **Build once, promote by digest.** The image staging validated is the image production runs — rebuilding "the same thing" for each environment is a parallel-universe deploy. Immutable `sha-` tags plus re-tag promotion make the guarantee structural instead of aspirational.
- **Scope the trust policy like you mean it.** `aud` pinned, `sub` pinned to repo *and* ref, one role per purpose, permissions limited to named resource ARNs. The question to ask of every line: "if a hostile workflow satisfied this policy, what's the worst it could do?" — the answer here is "push an image to two repositories", and keeping the answer that boring is the job.
- **Order the Dockerfile for the cache, and version-stamp at the bottom.** Layers that change every commit (`COPY . .`, `ARG APP_VERSION`) go late; layers that change rarely (system packages, extension builds) go early. This single habit is most of the difference between the 90-second build and the 7-minute one.
- **Gate on CRITICAL, monitor the rest.** A pipeline that blocks on every LOW finding gets bypassed within a month, and a bypassed gate protects nothing (7.2's coverage lesson, again). Block the indefensible, let ECR's continuous scanning track the long tail, and ratchet the gate as your base-image hygiene improves.

## Common pitfalls

1. **Pasting IAM user keys into GitHub secrets.** It's the first search result and it works in ten minutes — then it sits there, unrotated, readable by every workflow with secret access, until an incident makes it famous. Correct approach: section 3's OIDC setup, which is barely slower to build and has nothing to steal.
2. **Forgetting `permissions: id-token: write` on the build job.** `configure-aws-credentials` fails with *"Credentials could not be loaded... Could not load credentials from any providers"* — an error that says nothing about permissions. People then debug the trust policy for an hour. Correct approach: the job-level permissions block first; remember the workflow's read-only default (7.1) means no job gets OIDC tokens implicitly.
3. **A trust policy `sub` that doesn't match the token's actual subject.** One wrong segment — `repo:tickethub/tickethub-api:main` instead of `...:ref:refs/heads/main` — and STS returns a bare `AccessDenied` on `AssumeRoleWithWebIdentity`. Correct approach: build the subject from the documented format, and when in doubt print the real claims (exercise 1) instead of guessing.
4. **Layer caching without `mode=max`.** The default `min` mode exports only final-stage layers, so a multi-stage build's expensive middle — Composer install, asset compile — rebuilds cold every run while you stare at a "working" cache config. Correct approach: `mode=max` on `cache-to`, distinct `scope` per image, and section 6's numbers as your sanity check.
5. **Pushing first, verifying after.** scanOnPush results arrive asynchronously *after* the artifact is already a deployment candidate — with Module 9 wired, staging may be running it before the scan lands. Correct approach: smoke test and Trivy gate before the push steps; registry-side scanning as the ongoing monitor, not the gate.
6. **Rebuilding images for release tags.** A tag-triggered rebuild produces a *different* image than the one staging validated (bases move, dependencies re-resolve) — and ECR's immutable tags will reject its duplicate `sha-` tag as a bonus failure. Correct approach: releases promote the existing digest; the `v*` event belongs to `deploy.yml`, completed in Module 9.

## Exercises

1. **Read your own identity token.** On a branch, add a temporary job with `id-token: write` that requests the JWT (`curl` the `$ACTIONS_ID_TOKEN_REQUEST_URL` with the runtime token, audience `sts.amazonaws.com`) and decodes its payload with `base64 -d` and `jq`. Compare `sub` on a branch run against section 3's trust policy and explain, from the two strings alone, why AWS refuses it. Delete the job.
2. **Close the nginx gap.** The pipeline smoke-tests and scans only the app image. Add a Trivy step for `tickethub-nginx` and a minimal smoke test (`nginx -t` inside the image). Decide: same CRITICAL-blocking policy, or stricter, given the nginx image changes rarely?
3. **Prove immutability.** Build any trivial image locally, tag it as `tickethub-api:sha-9f2c1d7` (a tag that exists), authenticate, and try to push it. Collect the `ImageTagAlreadyExistsException`, then write two sentences on how this error protects Module 9's rollback story.
4. **Upgrade the cache tier.** Create a *mutable* ECR repo `tickethub-build-cache`, switch the app image's `cache-to`/`cache-from` to `type=registry` with `mode=max,image-manifest=true,oci-mediatypes=true`, and extend the IAM permissions policy to cover it. Measure cold and warm builds against section 6's `gha` numbers and write down which tier this repo actually needs today.
5. **Stretch — one build job to rule them both.** Refactor the two image builds into a single job with `strategy.matrix` across `{name: app, ...}` and `{name: nginx, ...}` entries (image repo, Dockerfile path, build args per entry). Observe what happens to the reported check names — `build (app)`, `build (nginx)` — and write the note you'd leave for whoever adds `build` to the required checks in the ruleset, applying Lecture 7.3's naming lesson.

## What's next

Module 7 is complete: one workflow now tests every change against production's engines, holds the quality line, and turns every merge into a scanned, stamped, immutable artifact — with not a single stored credential. But those images are sitting in a registry with nowhere to run: TicketHub's production is still Module 3's hand-fed VPS. [Module 8 — AWS Cloud Fundamentals](../module-08-aws-fundamentals/) builds the destination properly — the account and IAM discipline your OIDC role got a preview of, the VPC, managed MySQL and Redis, S3 — and ends with a deliberately manual EC2 deployment of these very images, so that when Module 9 automates deployment away, you know exactly what pain it is sparing you.
