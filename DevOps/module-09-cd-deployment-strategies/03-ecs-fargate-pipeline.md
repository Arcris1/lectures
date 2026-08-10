# Lecture 9.3 — Containerized CD: ECS Fargate

> **Module 9 — Continuous Delivery & Deployment Strategies** · Lecture 3 of 4 · Estimated time: ~120 min

Everything converges here. [Lecture 8.4](../module-08-aws-fundamentals/04-classic-deployment-ec2-alb.md)'s pain audit is the requirements document; [Module 7](../module-07-ci-github-actions/04-building-images-in-ci.md)'s `sha-` images are the artifact; [9.1](01-cd-concepts-environments.md)'s environments are the policy; [9.2](02-zero-downtime-laravel-deploys.md)'s ordering rules are the correctness spec. This lecture assembles them into a machine: TicketHub on **ECS Fargate**, deployed automatically on every merge to `main`, with migrations as a gated one-off task, health-checked rolling updates, automatic rollback on failure, and a version-asserting smoke test. At the end, the stopped EC2 pair — the last hand-built servers in this course — gets terminated for real.

## Learning objectives

- Justify ECS Fargate against both EC2 and Kubernetes for TicketHub today, using the pain audit as the scorecard
- Define the ECS object model — cluster, task definition, task, service — and compute real Fargate costs for staging
- Write a complete two-container task definition: awsvpc networking, execution vs task roles, secrets from SSM/Secrets Manager, awslogs, drain-aligned stop timeouts
- Create the three services — api, horizon, scheduler — with rolling deployment config and the circuit breaker
- Operationalize 9.2's rules: migrations as a run-task singleton gating the rollout, workers restarted by task replacement
- Complete `deploy.yml`: staging on CI success, production on approved `v*` tags, with a version-asserting smoke test

## 1. Why Fargate, why now

**Versus EC2:** run the pain audit as a checklist. *Item 1, unknowable drift* — gone structurally: the image **is** the machine; there is no package that installs at boot, no PPA that moved, nothing to drift. Every task started from `sha-9f2c1d7` is byte-identical, and `docker inspect` proves it. *Item 2, deploys are manual repetition* — the service performs the rolling replacement; your job shrinks to "declare the new task definition." *Item 3, no rollback* — the previous task definition revision points at the previous image; rollback is one `update-service` (and the circuit breaker does it automatically on failed health checks). *Item 4, scale-out in coffee breaks* — a Fargate task pulls an image and passes health checks in roughly 60–90 seconds, versus 5–10 minutes of apt and Composer; an on-sale spike becomes survivable.

**Versus EKS/Kubernetes:** ECS gives you the 20% of orchestration TicketHub needs today — desired count, health-checked rollouts, LB wiring, secrets injection — with **nothing to operate**: no control plane bill, no version upgrades, no node management (Fargate removes even that), IAM instead of RBAC, and the ALB you already own. Kubernetes buys enormous flexibility at real operational cost, and this course *will* collect that trade in [Module 11](../module-11-kubernetes/) — both for your skills (the industry standardized on it) and because growth eventually justifies it. Choosing the boring, sufficient tool now and the powerful one when warranted is not indecision; it's the professional default.

## 2. The ECS object model, precisely

Four nouns, strictly layered:

- A **task definition** is a versioned *specification*: which containers, which images, CPU/memory, networking, secrets, logging. Registering one creates an immutable **revision** (`tickethub-api:12`, `:13`, …) — the ECS analog of 9.2's release directory. Task definitions run nothing; they describe.
- A **task** is a running instantiation of one revision — the analog of "a server," except disposable and identical by construction. On **Fargate**, AWS conjures the compute invisibly; you never see an instance.
- A **service** is a *reconciler* (the concept Kubernetes will generalize in Module 11): it holds a desired state — "N tasks of revision R, registered in this target group" — and continuously corrects reality toward it. A task dies; the service replaces it. You register a new revision; the service performs a rolling **deployment** from old to new, respecting health checks and capacity rules.
- A **cluster** is the namespace grouping services and tasks: `tickethub-staging` now, `tickethub-prod` in Module 10.

**Fargate pricing** is per-task, per-second: in `ap-southeast-1`, ~$0.0506 per vCPU-hour and ~$0.0055 per GB-hour. Staging's real math, which we'll size in section 3:

| Service | Size | Count | $/hr | ~$/mo (730 h) |
|---|---|---|---|---|
| `tickethub-api` | 0.5 vCPU / 1 GB | 2 | $0.0616 | $45 |
| `tickethub-horizon` | 0.25 vCPU / 1 GB | 1 | $0.0182 | $13 |
| `tickethub-scheduler` | 0.25 vCPU / 0.5 GB | 1 | $0.0154 | $11 |
| **Total** | | | | **≈ $69** |

Hold that against the EC2 pair it replaces ($35/mo including EBS) — the honest comparison closes this lecture.

## 3. The task definition, built up

We assemble `tickethub-api`'s task definition decision by decision, then print it complete.

**`networkMode: awsvpc`.** Each task gets its own **ENI** in the private-app subnets, wearing `sg-app` — the task is a first-class network citizen, and 8.2's security-group chain survives *unchanged*: internet → `sg-alb` → `sg-app` (now task ENIs, not instance NICs) → `sg-mysql`/`sg-redis`. Within a task, all containers share one network namespace — they talk over **localhost**, exactly like Module 6's manual `docker run` pair, minus the user-defined bridge.

**Two containers, unchanged pattern.** Module 6 split TicketHub into `tickethub-nginx` (serves statics, proxies PHP) and `tickethub-api` (FPM on 9000); the task definition lands that pair as written — nginx is the LB-facing container on 80, app listens on 9000, both `essential: true` (either dying kills the task, and the service replaces it whole). One honest wrinkle: Module 6's nginx config says `fastcgi_pass app:9000` — Docker DNS that doesn't exist in awsvpc's shared namespace. The fix is the nginx image's built-in template mechanism, making the FPM address config instead of code (hands-on step 1): `fastcgi_pass ${FPM_HOST}:9000` — Compose sets `FPM_HOST=app`, the task definition sets `127.0.0.1`.

**Execution role vs task role — learn the distinction cold, it's on every real-world exam.** The **execution role** (`tickethub-staging-execution`) is used by the *ECS agent, before your code runs*: pull the images from ECR, fetch the `secrets:` values, create log streams. Your application never touches these credentials. The **task role** (`tickethub-staging-app`) is what *your PHP code* gets from the SDK at runtime — S3 uploads, SES sends — the instance profile's successor, scoped per service instead of per machine. Least privilege gets finer-grained for free: Horizon's task could carry a different role than the API's the day their needs diverge. We reuse the app role from 8.4 — same permissions, one trust-policy addition so `ecs-tasks.amazonaws.com` may wear it (the app's identity survives the platform change; only who's allowed to assume it grows).

**`secrets:` — the platform enforces Module 5.** Every config value arrives as `valueFrom` an SSM parameter or Secrets Manager ARN, resolved by the execution role at task start and injected as environment variables. No `.env` in the image (Module 6's rule), no boot script rendering one (8.4's workaround) — the platform *is* the renderer now, and the JSON keys syntax (`...:username::`) plucks fields from the RDS managed secret directly.

**Logging.** `logConfiguration: awslogs` ships each container's stdout/stderr to CloudWatch Logs. This is the Module 5 factor XI payoff: `LOG_CHANNEL=stderr` meant Laravel has logged to the stream since staging existed, FPM and nginx already write there — so *zero* application changes buy centralized logs at `/ecs/tickethub-staging`. Reading them well (structure, correlation, aggregation) is [Module 12](../module-12-observability-security-sre/01-structured-logging-aggregation.md)'s opening act.

**Stop timeout and the drain math.** On task stop, ECS deregisters the task from the target group, the ALB drains in-flight requests (deregistration delay: **30s**, tuned in 8.4), then ECS sends **SIGTERM** — which reaches FPM as PID 1 thanks to Module 6's `exec` entrypoint discipline, triggering graceful worker shutdown — and after `stopTimeout` seconds, SIGKILL. We set `stopTimeout: 30`: drain (30s) + millisecond-scale API requests means SIGTERM arrives at an idle FPM; 30 more seconds is generous. The chain nginx→ALB→FPM you built by hand in Modules 3 and 8 is now three fields that agree with each other.

**FPM pool sizing — Module 3's arithmetic, container edition.** The task has 1024 MB total. Nginx idles near 20 MB; FPM master plus opcache overhead ~150 MB; leaving ~850 MB for workers at ~80 MB each → **`pm.max_children = 10`**. That's a repo change to `docker/php/pool.conf` (Module 6 explicitly deferred real sizing to this moment): `pm.max_children = 10`, `pm.start_servers = 4`, `pm.min_spare_servers = 2`, `pm.max_spare_servers = 6`. Two tasks × 10 workers = 20 concurrent PHP requests — half the EC2 pair's 40, on a quarter of the vCPUs. That's honest right-sizing for staging traffic, and section 8's request-count autoscaling is the mechanism that adds capacity when reality disagrees.

The complete `deploy/ecs/tickethub-api.json` (checked into the repo — the task definition is *code*, reviewed like code; `<SHA_TAG>` is what the pipeline substitutes):

```json
{
  "family": "tickethub-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "runtimePlatform": { "operatingSystemFamily": "LINUX", "cpuArchitecture": "X86_64" },
  "executionRoleArn": "arn:aws:iam::111122223333:role/tickethub-staging-execution",
  "taskRoleArn": "arn:aws:iam::111122223333:role/tickethub-staging-app",
  "containerDefinitions": [
    {
      "name": "nginx",
      "image": "111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-nginx:<SHA_TAG>",
      "essential": true,
      "portMappings": [{ "containerPort": 80, "protocol": "tcp" }],
      "environment": [{ "name": "FPM_HOST", "value": "127.0.0.1" }],
      "dependsOn": [{ "containerName": "app", "condition": "HEALTHY" }],
      "stopTimeout": 30,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/tickethub-staging",
          "awslogs-region": "ap-southeast-1",
          "awslogs-stream-prefix": "api-nginx"
        }
      }
    },
    {
      "name": "app",
      "image": "111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:<SHA_TAG>",
      "essential": true,
      "portMappings": [{ "containerPort": 9000, "protocol": "tcp" }],
      "stopTimeout": 30,
      "healthCheck": {
        "command": ["CMD-SHELL", "cgi-fcgi -bind -connect 127.0.0.1:9000 | grep -q pong || exit 1"],
        "interval": 15,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 20
      },
      "secrets": [
        { "name": "APP_NAME",       "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/APP_NAME" },
        { "name": "APP_ENV",        "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/APP_ENV" },
        { "name": "APP_DEBUG",      "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/APP_DEBUG" },
        { "name": "APP_URL",        "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/APP_URL" },
        { "name": "LOG_CHANNEL",    "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/LOG_CHANNEL" },
        { "name": "LOG_LEVEL",      "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/LOG_LEVEL" },
        { "name": "DB_CONNECTION",  "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/DB_CONNECTION" },
        { "name": "DB_HOST",        "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/DB_HOST" },
        { "name": "DB_PORT",        "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/DB_PORT" },
        { "name": "DB_DATABASE",    "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/DB_DATABASE" },
        { "name": "SESSION_DRIVER", "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/SESSION_DRIVER" },
        { "name": "CACHE_STORE",    "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/CACHE_STORE" },
        { "name": "QUEUE_CONNECTION", "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/QUEUE_CONNECTION" },
        { "name": "REDIS_CLIENT",   "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/REDIS_CLIENT" },
        { "name": "REDIS_HOST",     "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/REDIS_HOST" },
        { "name": "REDIS_PORT",     "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/REDIS_PORT" },
        { "name": "REDIS_SCHEME",   "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/REDIS_SCHEME" },
        { "name": "REDIS_QUEUE_RETRY_AFTER", "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/REDIS_QUEUE_RETRY_AFTER" },
        { "name": "FILESYSTEM_DISK", "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/FILESYSTEM_DISK" },
        { "name": "AWS_BUCKET",     "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/AWS_BUCKET" },
        { "name": "AWS_DEFAULT_REGION", "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/AWS_DEFAULT_REGION" },
        { "name": "MAIL_MAILER",    "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/MAIL_MAILER" },
        { "name": "MAIL_FROM_ADDRESS", "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/env/MAIL_FROM_ADDRESS" },
        { "name": "APP_KEY",        "valueFrom": "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:tickethub/staging/app-key-Qw7RtY" },
        { "name": "DB_USERNAME",    "valueFrom": "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:rds!db-3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9-AbCdEf:username::" },
        { "name": "DB_PASSWORD",    "valueFrom": "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:rds!db-3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9-AbCdEf:password::" },
        { "name": "REDIS_PASSWORD", "valueFrom": "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:tickethub/staging/redis-auth-Ab12Cd" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/tickethub-staging",
          "awslogs-region": "ap-southeast-1",
          "awslogs-stream-prefix": "api-app"
        }
      }
    }
  ]
}
```

(The `healthCheck` is Module 6's Dockerfile `HEALTHCHECK` re-declared — ECS ignores image-level healthchecks — and it powers `dependsOn: HEALTHY`: nginx doesn't start until FPM answers FastCGI, so a task is never briefly "up" while proxying to a dead pool. X86_64 matches what the CI runners build; ARM64 Fargate is ~20% cheaper and is exercise 4's multi-arch project.)

Two sibling files complete the set. `deploy/ecs/tickethub-horizon.json`: **app container only** (no nginx — nothing HTTP-facing), same secrets/logging (`awslogs-stream-prefix: horizon`), `"command": ["php", "artisan", "horizon"]`, cpu 256/memory 1024, and `"stopTimeout": 120` — **Fargate's hard cap**. Read that against Module 5's timeout chain: `GenerateTicketPdf` declares `$timeout = 120`, so a PDF in its final seconds when SIGTERM arrives is *exactly* at the wire — Horizon gets the TERM, tells workers to finish, and the platform's SIGKILL lands at 120s sharp. The honest configuration keeps the longest job's timeout *under* the platform cap with margin (drop `$timeout` to 110, or split the work); "our platform kills at 120, our jobs may run 120" is a coin you flip every deploy. `deploy/ecs/tickethub-scheduler.json`: app container only, `"command": ["php", "artisan", "schedule:work"]`, cpu 256/memory 512, `awslogs-stream-prefix: scheduler`.

## 4. Three services, and how a deploy actually rolls

**Why `schedule:work` and not EventBridge?** The scheduler needs a tick every minute. EventBridge Scheduler *can* `run-task` on a cron — genuinely serverless, pay-per-tick — but Fargate task launch latency (image pull, ENI attach: 30–90s, occasionally worse) makes "every minute" arrive as "most minutes, eventually": `ExpireReservations` would drift and skip. For sub-minute-precision scheduling, a **tiny always-on service** wins: `schedule:work` is Laravel's built-in foreground loop that fires `schedule:run` every minute from one warm process. `desiredCount: 1`, and the `onOneServer()` locks from 8.4 still guard the deploy window — during a rolling replacement two schedulers briefly coexist, both tick, one wins the Redis lock. Belt and braces, again. (EventBridge remains the right answer for coarse, infrequent jobs — file it, don't fight it.)

**The api service's deployment configuration** is where zero-downtime becomes declarative: `minimumHealthyPercent: 100` (never fewer than desired running and healthy), `maximumPercent: 200` (may double during a deploy). For `desiredCount: 2`:

```text
t=0     [old-1] [old-2]                     ← steady state, both in the TG
t+10s   [old-1] [old-2] [new-1] [new-2]     ← new revision launched (200%)
t+60s   [old-1] [old-2] [NEW-1] [NEW-2]     ← new tasks pass /up + container health,
                                              registered in the target group
t+65s   [old-1] [old-2] draining…           ← old tasks deregistered; ALB drains
                                              in-flight requests (≤30s)
t+95s   [NEW-1] [NEW-2]                     ← old tasks SIGTERM → gone. Done.
```

Capacity never dips below 2; users never see a connection reset; total wall time ≈ 2–3 minutes. This is 9.2's atomic flip, rebuilt from health checks and a reconciler — the "release directory" is an image, the "symlink" is target-group membership, and the opcache/worker-restart problems *cannot exist* because processes are never updated, only replaced.

**The deployment circuit breaker** (`enable: true, rollback: true`) is the safety net: if new tasks repeatedly fail to reach healthy (bad migration interaction, missing secret, crash loop), ECS stops launching, marks the deployment failed, and **rolls the service back to the last working revision automatically** — no human awake required. `healthCheckGracePeriodSeconds: 60` keeps the ALB from judging a task during its cold start.

**One honest migration step: the target group.** 8.4's `tickethub-staging-tg` has `target-type: instance` — it registers EC2 instance IDs, and awsvpc tasks register **ENI IPs**. Target type is immutable, so we create `tickethub-staging-tg-ip` (same health-check policy, `target-type: ip`) and swap the ALB listener's default action to it. In a live system you'd stand up the new TG, attach the service, verify through a test listener, then swap — a small blue/green maneuver (9.4 formalizes it). Our staging has conveniently been *parked* since 8.4's teardown (instances stopped, nothing healthy to disturb), so the swap is consequence-free today.

## 5. Migrations: the release-phase singleton, operationalized

9.2's principle — exactly once per release, before traffic — becomes `aws ecs run-task`: launch a one-off task from the *new* revision (the app-only horizon family — no nginx container to keep a migration task alive past its work) with a command override of `["php","artisan","migrate","--force"]`, **wait for it to stop, and check its exit code**. Zero is the gate opening; anything else aborts the deploy with the service still running the old revision untouched — a failed migration is a *blocked release*, never a down service (Module 6 made this exact argument against entrypoint migrations). The pipeline encodes it as three steps: register → run+wait → assert.

## 6. `deploy.yml`: the design, then the file

**Trigger design, stated honestly.** Staging must deploy the image that CI just pushed for a `main` commit. Two wiring options: append a deploy job to `ci.yml` via `needs: build` (simple, but tangles CI and CD concerns, and PR runs carry dead deploy weight), or a separate workflow triggered by **`workflow_run`** — fires when `ci` completes on `main`; we filter for success. We choose `workflow_run`: `ci.yml` stays exactly what Module 7 shipped, and `deploy.yml` owns deployment wholly. The trigger hands us `workflow_run.head_sha` — the deployed SHA is *pinned to the event*, not to whatever `main` points at by the time the job runs (two quick merges must produce two deploys of two distinct SHAs, in order — the `concurrency` group serializes them). One race remains worth guarding: we re-verify the exact `sha-` tags exist in ECR with a bounded retry loop before touching ECS — cheap insurance that also covers manual `workflow_dispatch` runs against not-yet-built commits.

**Production** deploys from the same file on `v*` tags, behind the `production` environment gate from 9.1 — same steps, `tickethub-prod` names from environment variables. Honest scoping: **the production cluster doesn't exist until Module 10 builds it with Terraform**, so the job ships complete but disabled with a comment. Writing it now means Module 10 enables a reviewed, finished pipeline by deleting one line.

The complete `.github/workflows/deploy.yml`, replacing Module 7's stub:

```yaml
name: deploy

on:
  workflow_run:
    workflows: [ci]
    types: [completed]
    branches: [main]
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      sha:
        description: 'Full commit SHA to deploy to staging'
        required: true

permissions:
  contents: read

concurrency:
  group: deploy-${{ startsWith(github.ref, 'refs/tags/') && 'production' || 'staging' }}
  cancel-in-progress: false   # deploys queue; a deploy is never killed mid-flight

jobs:
  deploy-staging:
    if: >-
      (github.event_name == 'workflow_run' &&
       github.event.workflow_run.conclusion == 'success') ||
      github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: staging
    permissions:
      contents: read
      id-token: write
    env:
      ECR_REGISTRY: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com
    steps:
      - name: Resolve the SHA being deployed
        id: sha
        run: |
          SHA='${{ github.event.workflow_run.head_sha || inputs.sha }}'
          echo "full=$SHA"            >> "$GITHUB_OUTPUT"
          echo "tag=sha-${SHA:0:7}"   >> "$GITHUB_OUTPUT"

      - uses: actions/checkout@v4
        with:
          ref: ${{ steps.sha.outputs.full }}   # task-def JSON from the deployed commit

      - name: Configure AWS credentials (OIDC, environment-scoped sub)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/tickethub-github-deploy
          aws-region: ${{ vars.AWS_REGION }}

      - name: Await images in ECR (race guard)
        run: |
          for repo in tickethub-api tickethub-nginx; do
            for i in $(seq 1 30); do
              if aws ecr describe-images --repository-name "$repo" \
                   --image-ids imageTag='${{ steps.sha.outputs.tag }}' >/dev/null 2>&1; then
                echo "$repo:${{ steps.sha.outputs.tag }} present"; continue 2
              fi
              echo "waiting for $repo:${{ steps.sha.outputs.tag }} ($i/30)"; sleep 10
            done
            echo "::error::$repo:${{ steps.sha.outputs.tag }} never appeared in ECR"
            exit 1
          done

      # ---- Render: pin this commit's sha- images into the task definitions
      - name: Render tickethub-api (app container)
        id: render_api_app
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: deploy/ecs/tickethub-api.json
          container-name: app
          image: ${{ env.ECR_REGISTRY }}/tickethub-api:${{ steps.sha.outputs.tag }}

      - name: Render tickethub-api (nginx container)
        id: render_api
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: ${{ steps.render_api_app.outputs.task-definition }}
          container-name: nginx
          image: ${{ env.ECR_REGISTRY }}/tickethub-nginx:${{ steps.sha.outputs.tag }}

      - name: Render tickethub-horizon
        id: render_horizon
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: deploy/ecs/tickethub-horizon.json
          container-name: app
          image: ${{ env.ECR_REGISTRY }}/tickethub-api:${{ steps.sha.outputs.tag }}

      - name: Render tickethub-scheduler
        id: render_scheduler
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: deploy/ecs/tickethub-scheduler.json
          container-name: app
          image: ${{ env.ECR_REGISTRY }}/tickethub-api:${{ steps.sha.outputs.tag }}

      # ---- Migrations: run EXACTLY ONCE, gate everything behind the result
      - name: Register migration task definition
        id: migration_td
        run: |
          ARN=$(aws ecs register-task-definition \
            --cli-input-json file://'${{ steps.render_horizon.outputs.task-definition }}' \
            --query 'taskDefinition.taskDefinitionArn' --output text)
          echo "arn=$ARN" >> "$GITHUB_OUTPUT"

      - name: Run migrations (release-phase singleton)
        run: |
          TASK_ARN=$(aws ecs run-task \
            --cluster '${{ vars.ECS_CLUSTER }}' \
            --task-definition '${{ steps.migration_td.outputs.arn }}' \
            --launch-type FARGATE \
            --network-configuration 'awsvpcConfiguration={subnets=[${{ vars.PRIVATE_APP_SUBNETS }}],securityGroups=[${{ vars.APP_SECURITY_GROUP }}],assignPublicIp=DISABLED}' \
            --overrides '{"containerOverrides":[{"name":"app","command":["php","artisan","migrate","--force"]}]}' \
            --started-by 'deploy-${{ steps.sha.outputs.tag }}' \
            --query 'tasks[0].taskArn' --output text)
          echo "Migration task: $TASK_ARN"
          aws ecs wait tasks-stopped --cluster '${{ vars.ECS_CLUSTER }}' --tasks "$TASK_ARN"
          EXIT_CODE=$(aws ecs describe-tasks --cluster '${{ vars.ECS_CLUSTER }}' \
            --tasks "$TASK_ARN" \
            --query 'tasks[0].containers[?name==`app`]|[0].exitCode' --output text)
          if [ "$EXIT_CODE" != "0" ]; then
            echo "::error::migrations exited with $EXIT_CODE — aborting before any service update"
            aws logs tail /ecs/tickethub-staging --since 10m --format short || true
            exit 1
          fi

      # ---- Rolling deploys, migration-first ordering per Lecture 9.2
      - name: Deploy tickethub-api
        uses: aws-actions/amazon-ecs-deploy-task-definition@v1
        with:
          task-definition: ${{ steps.render_api.outputs.task-definition }}
          service: tickethub-api
          cluster: ${{ vars.ECS_CLUSTER }}
          wait-for-service-stability: true

      - name: Deploy tickethub-horizon
        uses: aws-actions/amazon-ecs-deploy-task-definition@v1
        with:
          task-definition: ${{ steps.render_horizon.outputs.task-definition }}
          service: tickethub-horizon
          cluster: ${{ vars.ECS_CLUSTER }}
          wait-for-service-stability: true

      - name: Deploy tickethub-scheduler
        uses: aws-actions/amazon-ecs-deploy-task-definition@v1
        with:
          task-definition: ${{ steps.render_scheduler.outputs.task-definition }}
          service: tickethub-scheduler
          cluster: ${{ vars.ECS_CLUSTER }}
          wait-for-service-stability: true

      # ---- Close the loop: Module 7's APP_VERSION stamp, asserted live
      - name: Smoke test — assert the deployed version
        run: |
          for i in $(seq 1 10); do
            LIVE=$(curl -fsS '${{ vars.BASE_URL }}/up' | jq -r .version)
            if [ "$LIVE" = '${{ steps.sha.outputs.full }}' ]; then
              echo "staging is serving ${LIVE:0:7} — deploy verified"; exit 0
            fi
            echo "staging reports ${LIVE:0:7}, expecting ${{ steps.sha.outputs.tag }} ($i/10)"
            sleep 15
          done
          echo "::error::deployed version never matched — investigate; circuit breaker handles service-level rollback"
          exit 1

  deploy-production:
    # ⛔ DISABLED until Module 10 provisions tickethub-prod (cluster, services,
    # RDS, ALB) via Terraform. To enable: replace the line below with
    #   if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
    if: false
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: production          # required reviewers + v* tag policy (9.1)
    permissions:
      contents: read
      id-token: write
    env:
      ECR_REGISTRY: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com
    steps:
      - name: Resolve the SHA being promoted
        id: sha
        run: |
          echo "full=${{ github.sha }}"            >> "$GITHUB_OUTPUT"
          echo "tag=sha-$(echo '${{ github.sha }}' | cut -c1-7)" >> "$GITHUB_OUTPUT"

      - uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC, environment:production sub)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/tickethub-github-deploy
          aws-region: ${{ vars.AWS_REGION }}

      - name: Assert the promoted image exists (never rebuild for production)
        run: |
          aws ecr describe-images --repository-name tickethub-api \
            --image-ids imageTag='${{ steps.sha.outputs.tag }}' \
            --query 'imageDetails[0].imagePushedAt'

      # …identical render → migrate (against tickethub-prod) → deploy → smoke
      # steps as deploy-staging, reading ${{ vars.* }} from the production
      # environment: ECS_CLUSTER=tickethub-prod, BASE_URL=https://api.tickethub.example

      - name: Announce the deployment
        run: |
          {
            echo "## 🚀 Production deploy: ${GITHUB_REF_NAME}"
            echo "Commit: ${{ steps.sha.outputs.full }}"
            echo "Release notes: https://github.com/${{ github.repository }}/releases/tag/${GITHUB_REF_NAME}"
          } >> "$GITHUB_STEP_SUMMARY"
          # Real teams post this to Slack/Teams via a webhook secret here —
          # the changelog exists because Module 4's conventional commits generate it.
```

Read the failure modes before admiring the happy path. **Migration fails** → exit before any `update-service`; old revision serves untouched; the workflow is red and says why. **New tasks fail health checks** → the circuit breaker is already rolling the service back while `wait-for-service-stability` times the action out — the workflow fails *loudly* against an environment that healed itself. **Smoke test mismatch** → services are stable but something's off (cached DNS, wrong image wiring) — red workflow, humans investigate, traffic unharmed. Every failure leaves staging serving *something known-good*, which is the entire point.

## 7. Debugging: ECS Exec, and the tinker ritual

No SSH, no SSM agent to manage — but you still sometimes need a shell where production-shaped things are happening. **ECS Exec** is Session Manager's machinery pointed at containers: enable `--enable-execute-command` on the service (done at creation, hands-on), grant the task role the four `ssmmessages:*` channel permissions, and then:

```console
$ aws ecs execute-command --cluster tickethub-staging \
    --task 4f2a9c81d3e64b0f8a17c5d2e9b31a06 --container app \
    --interactive --command "/bin/sh"
Starting session with SessionId: ecs-execute-command-0a1b2c3d4e5f6a7b8
/var/www/html $ php artisan horizon:status
Horizon is running.
```

Audited in CloudTrail like every SSM session, IAM-controlled, no inbound anything. The **tinker caution ritual** carries over from every module before: `php artisan tinker` inside a staging task is a loaded tool — it holds real credentials to real (staging) data. Read-only by default, announce before writes, and remember the container is ephemeral: nothing you "fix" in a shell survives the next deploy, *which is a feature* — the pipeline remains the only path that persists (9.1's doctrine, structurally enforced).

## 8. Autoscaling: reactive for surprises, scheduled for on-sales

Target tracking wires two signals to `desiredCount`, and the pairing matters. **CPU at 60%** catches compute-bound load. But FPM saturates *before* CPU does: 10 workers busy waiting on MySQL row locks is a full queue at 15% CPU — Module 3's queueing lesson (requests queue when workers, not cores, run out) says the better signal is concurrency. **`ALBRequestCountPerTarget` ≈ 800/min** tracks exactly that: at ~10 workers × ~80 ms/request, one task clears ~7,500 req/min at theoretical max; targeting ~800 keeps utilization near 10% of ceiling with headroom for lock contention and slow endpoints. Two policies, and ECS scales on whichever demands more.

And the ticketing move: **scheduled scaling**. An on-sale at noon Saturday is *known in advance* — reactive scaling reacts after the spike lands (60–90s of task launch during the worst minute of the month), while a scheduled action has capacity warm *before* the doors open: min 6 at T−15 min, back to normal an hour later. Cooldowns (300s scale-in, 60s scale-out) stop flapping. This is the cheapest reliability TicketHub can buy, and it's a calendar entry.

## Hands-on with TicketHub

⚠️ **Cost check — created here:** the Fargate services (~$69/mo while all three run — see the closing table), one CloudWatch log group (pennies at staging volume). **Terminated here, permanently: the two stopped EC2 instances** (−$4/mo EBS). Everything else — ALB, RDS, ElastiCache, VPC, Route 53 — is Module 8's, kept and reused. Fargate bills per second: `aws ecs update-service --desired-count 0` on all three services pauses compute spend between study sessions.

### 1. Repo changes: nginx template, pool sizing, task definitions

The nginx image learns configurable upstreams (official-image templates: anything in `/etc/nginx/templates/*.template` gets `envsubst`ed to `conf.d/` at start). Rename `docker/nginx/default.conf` → `default.conf.template`, change one line, teach both consumers:

```nginx
        fastcgi_pass ${FPM_HOST}:9000;
```

```dockerfile
# docker/nginx/Dockerfile — was: COPY default.conf /etc/nginx/conf.d/default.conf
COPY default.conf.template /etc/nginx/templates/default.conf.template
```

```yaml
# compose.yaml (nginx service) — local dev keeps container-DNS wiring
    environment:
      FPM_HOST: app
```

Commit that, the `pm.max_children = 10` pool sizing from section 3, the three `deploy/ecs/*.json` files, and the new `deploy.yml`. One PR — it's a release like any other, and CI builds the images the first deploy will ship.

### 2. IAM: execution role, task-role trust, deploy-role powers

```console
$ aws iam create-role --role-name tickethub-staging-execution \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
      "Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
$ aws iam attach-role-policy --role-name tickethub-staging-execution \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
$ aws iam put-role-policy --role-name tickethub-staging-execution \
    --policy-name tickethub-staging-config-read --policy-document '{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ReadEnvParameters", "Effect": "Allow", "Action": "ssm:GetParameters",
      "Resource": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/tickethub/staging/*" },
    { "Sid": "ReadSecrets", "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:rds!db-3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9-AbCdEf",
        "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:tickethub/staging/redis-auth-*",
        "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:tickethub/staging/app-key-*"
      ] }
  ]
}'
```

The task role is 8.4's app role with a widened trust (both services may wear it) plus ECS Exec channels:

```console
$ aws iam update-assume-role-policy --role-name tickethub-staging-app \
    --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
      "Principal":{"Service":["ec2.amazonaws.com","ecs-tasks.amazonaws.com"]},
      "Action":"sts:AssumeRole"}]}'
$ aws iam put-role-policy --role-name tickethub-staging-app \
    --policy-name tickethub-ecs-exec --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{ "Sid": "EcsExecChannels", "Effect": "Allow",
    "Action": ["ssmmessages:CreateControlChannel","ssmmessages:CreateDataChannel",
               "ssmmessages:OpenControlChannel","ssmmessages:OpenDataChannel"],
    "Resource": "*" }]
}'
```

And `tickethub-github-deploy` graduates from image-pusher to deployer — new inline policy `ecs-deploy-tickethub` (alongside Module 7's ECR policy):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "DescribeEcr", "Effect": "Allow",
      "Action": "ecr:DescribeImages",
      "Resource": "arn:aws:ecr:ap-southeast-1:111122223333:repository/tickethub-*" },
    { "Sid": "DeployEcs", "Effect": "Allow",
      "Action": ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition",
                 "ecs:DescribeServices", "ecs:UpdateService",
                 "ecs:RunTask", "ecs:DescribeTasks", "ecs:TagResource"],
      "Resource": "*" },
    { "Sid": "ReadDeployLogs", "Effect": "Allow",
      "Action": ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:DescribeLogStreams"],
      "Resource": "arn:aws:logs:ap-southeast-1:111122223333:log-group:/ecs/tickethub-*:*" },
    { "Sid": "PassTaskRoles", "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::111122223333:role/tickethub-staging-execution",
        "arn:aws:iam::111122223333:role/tickethub-staging-app"
      ],
      "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }
    }
  ]
}
```

(`iam:PassRole` is the sleeper: registering a task definition that names roles requires permission to *hand those roles to ECS* — scoped to exactly two roles, passable only to `ecs-tasks`. Without the condition, a hijacked workflow could attach any passable role to a task it controls. ECS actions on `Resource: "*"` is a pragmatic start; Module 10 tightens with resource ARNs and tags.)

### 3. Cluster, logs, target group, listener swap

```console
$ aws ecs create-cluster --cluster-name tickethub-staging \
    --settings name=containerInsights,value=enabled \
    --tags key=Name,value=tickethub-staging
$ aws logs create-log-group --log-group-name /ecs/tickethub-staging
$ aws logs put-retention-policy --log-group-name /ecs/tickethub-staging --retention-in-days 30
$ aws elbv2 create-target-group --name tickethub-staging-tg-ip \
    --protocol HTTP --port 80 --vpc-id vpc-0a1b2c3d4e5f67890 \
    --target-type ip \
    --health-check-path /up --health-check-interval-seconds 15 \
    --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 --matcher HttpCode=200 \
    --query 'TargetGroups[0].TargetGroupArn'
"arn:aws:elasticloadbalancing:ap-southeast-1:111122223333:targetgroup/tickethub-staging-tg-ip/9a8b7c6d5e4f3210"
$ aws elbv2 modify-target-group-attributes \
    --target-group-arn arn:aws:elasticloadbalancing:...:targetgroup/tickethub-staging-tg-ip/9a8b7c6d5e4f3210 \
    --attributes Key=deregistration_delay.timeout_seconds,Value=30
$ aws elbv2 modify-listener \
    --listener-arn arn:aws:elasticloadbalancing:...:listener/app/tickethub-staging-alb/50dc6c495c0c9188/f00dabcd1234ef56 \
    --default-actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:...:targetgroup/tickethub-staging-tg-ip/9a8b7c6d5e4f3210
```

Same `/up` policy, same 30s drain, new membership type. The old `tickethub-staging-tg` can be deleted after the first successful deploy.

### 4. Create the services (first revision by hand — the pipeline owns every one after)

Register initial task definitions with a known image (the latest `sha-` tag in ECR), by substituting `<SHA_TAG>` locally:

```console
$ TAG=$(aws ecr describe-images --repository-name tickethub-api \
    --query 'sort_by(imageDetails,&imagePushedAt)[-1].imageTags[0]' --output text)
$ for f in tickethub-api tickethub-horizon tickethub-scheduler; do
    sed "s/<SHA_TAG>/$TAG/" deploy/ecs/$f.json > /tmp/$f.json
    aws ecs register-task-definition --cli-input-json file:///tmp/$f.json \
      --query 'taskDefinition.{family:family,revision:revision}'
  done
{ "family": "tickethub-api", "revision": 1 }
{ "family": "tickethub-horizon", "revision": 1 }
{ "family": "tickethub-scheduler", "revision": 1 }
$ SUBNETS=subnet-0e4d9f306c1ba5003,subnet-0f5e0a417d2cb6004   # private-app, both AZs
$ SG=sg-0e2d8b0c1f3a40002                                      # sg-app — the 8.2 chain, unchanged
$ aws ecs create-service --cluster tickethub-staging --service-name tickethub-api \
    --task-definition tickethub-api --desired-count 2 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:...:targetgroup/tickethub-staging-tg-ip/9a8b7c6d5e4f3210,containerName=nginx,containerPort=80" \
    --health-check-grace-period-seconds 60 \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100,deploymentCircuitBreaker={enable=true,rollback=true}" \
    --enable-execute-command
$ aws ecs create-service --cluster tickethub-staging --service-name tickethub-horizon \
    --task-definition tickethub-horizon --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=0,deploymentCircuitBreaker={enable=true,rollback=true}" \
    --enable-execute-command
$ aws ecs create-service --cluster tickethub-staging --service-name tickethub-scheduler \
    --task-definition tickethub-scheduler --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
    --deployment-configuration "maximumPercent=200,minimumHealthyPercent=0,deploymentCircuitBreaker={enable=true,rollback=true}" \
    --enable-execute-command
```

(Horizon and scheduler run `minimumHealthyPercent: 0` with desired 1 — a moment of zero workers during a deploy is fine; jobs wait in Redis, and `onOneServer()` already tolerates scheduler overlap the other direction. Image pulls and secret fetches ride 8.2's NAT; the S3 gateway endpoint already carries ECR's layer downloads free — interface endpoints for `ecr.api`, `ecr.dkr`, `logs`, and Secrets Manager are the NAT-retirement move Module 10 codifies.) Watch `aws ecs describe-services --cluster tickethub-staging --services tickethub-api --query 'services[0].{running:runningCount,desired:desiredCount}'` reach 2/2, then prove the whole path: `curl -s https://api.staging.tickethub.example/up | jq .` — the VPC, ALB, and data tier from Module 8 serving containers from Module 6 built by Module 7's CI.

Feed the last two variables the workflow reads:

```console
$ gh variable set PRIVATE_APP_SUBNETS --env staging --body "$SUBNETS"
$ gh variable set APP_SECURITY_GROUP  --env staging --body "$SG"
```

### 5. First pipeline deploy, and the funeral

Merge the PR from step 1. Watch `ci` go green, `deploy` fire on its completion, and read the run like a story: SHA resolved → images confirmed → rendered → migration task exits 0 → three rolling deploys → smoke test asserts the SHA. Then the moment this module owes Module 8:

```console
$ aws ec2 terminate-instances --instance-ids i-0aa11bb22cc33dd44 i-0ee55ff66aa77bb88 \
    --query 'TerminatingInstances[].{Id:InstanceId,State:CurrentState.Name}'
[ { "Id": "i-0aa11bb22cc33dd44", "State": "shutting-down" },
  { "Id": "i-0ee55ff66aa77bb88", "State": "shutting-down" } ]
```

The last hand-built servers in this course are gone. Nobody will ever SSH-and-edit them, because they no longer exist — the doctrine from 9.1, made of facts now.

### 6. Autoscaling and the on-sale calendar

```console
$ aws application-autoscaling register-scalable-target --service-namespace ecs \
    --scalable-dimension ecs:service:DesiredCount \
    --resource-id service/tickethub-staging/tickethub-api \
    --min-capacity 2 --max-capacity 6
$ aws application-autoscaling put-scaling-policy --service-namespace ecs \
    --scalable-dimension ecs:service:DesiredCount \
    --resource-id service/tickethub-staging/tickethub-api \
    --policy-name tickethub-api-cpu --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration '{
      "TargetValue": 60.0,
      "PredefinedMetricSpecification": {"PredefinedMetricType": "ECSServiceAverageCPUUtilization"},
      "ScaleOutCooldown": 60, "ScaleInCooldown": 300 }'
$ aws application-autoscaling put-scaling-policy --service-namespace ecs \
    --scalable-dimension ecs:service:DesiredCount \
    --resource-id service/tickethub-staging/tickethub-api \
    --policy-name tickethub-api-requests --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration '{
      "TargetValue": 800.0,
      "PredefinedMetricSpecification": {
        "PredefinedMetricType": "ALBRequestCountPerTarget",
        "ResourceLabel": "app/tickethub-staging-alb/50dc6c495c0c9188/targetgroup/tickethub-staging-tg-ip/9a8b7c6d5e4f3210" },
      "ScaleOutCooldown": 60, "ScaleInCooldown": 300 }'
$ aws application-autoscaling put-scheduled-action --service-namespace ecs \
    --scalable-dimension ecs:service:DesiredCount \
    --resource-id service/tickethub-staging/tickethub-api \
    --scheduled-action-name onsale-warmup-demo \
    --schedule 'at(2026-08-15T11:45:00)' --timezone 'Asia/Singapore' \
    --scalable-target-action MinCapacity=6,MaxCapacity=8
```

(Pair every warm-up with a cool-down action restoring min 2 — an on-sale that ends at 13:00 shouldn't bill six tasks until someone remembers.)

### Cost recap: EC2 vs Fargate, honestly

| | EC2 pair (8.4) | Fargate (this lecture) |
|---|---|---|
| Compute | $31 + $4 EBS = **$35/mo** | api $45 + horizon $13 + scheduler $11 = **$69/mo** |
| Patching, AMI updates, drift | Yours, forever | None — the image is the machine |
| Deploy | Manual, downtime, no rollback | Automated, zero-downtime, auto-rollback |
| Scale-out | 5–10 min + manual registration | 60–90 s, automatic |
| Idle cost lever | Stop instances | `--desired-count 0` (per-second billing) |

Fargate costs about **2× for staging's always-on compute** — that's the honest number, and what it buys is listed beside it. Two levers close the gap when it matters: **Fargate Spot** (~70% discount, fine for staging's interruptible workloads) and **ARM64** (~20% cheaper, exercise 4). **Teardown/keep:** EC2 pair — terminated above, gone. Keep the cluster, services, ALB, RDS, ElastiCache, Route 53, and secrets: Modules 10–12 build on all of it. Pausing? Desired-count 0 on all three services drops Fargate spend to zero while every definition stays put.

## Real-world best practices

- **Task definitions live in the repo, rendered by the pipeline.** The alternative — describe-and-mutate whatever's currently deployed — means your deployment spec exists only as AWS state, unreviewable and driftable. JSON in Git + `render-task-definition` keeps the spec versioned with the code it deploys (and hands Module 10 a clean Terraform migration).
- **Gate the rollout on migrations, and let the circuit breaker own service-level rollback.** The two failure domains need different owners: schema problems must block *before* any task updates (pipeline's job); task-health problems must revert *without human latency* (platform's job). Wiring both and testing both is what "self-healing deploys" actually means.
- **Assert the deployed version, not the deploy's exit code.** `update-service` returning 0 means ECS accepted your request, not that users get new code. The `/up` version check closes the loop end to end — DNS, ALB, target group, task, container, framework — with one curl. Cheap, decisive, non-negotiable.
- **Give every service exactly the IAM it needs, and audit `iam:PassRole` like a firearm.** PassRole is how "can deploy tasks" quietly becomes "can run arbitrary code as any role" — pin the passable roles and the receiving service, always.
- **Size FPM to the container, then let request-count scaling do the breathing.** A fixed fleet sized for the on-sale wastes money 29 days a month; a fleet sized for the median falls over on day 30. Right-size the unit, scale the count — and pre-scale *scheduled* load, because you know when your own on-sales are.

## Common pitfalls

1. **Pointing an awsvpc service at the old instance-type target group.** `create-service` fails with a terse target-group incompatibility error, and the "fix" people reach for — recreating the TG with default settings — silently loses the 30s deregistration delay and `/up` tuning. Correct approach: create the `-ip` twin deliberately, copying every attribute, then swap the listener.
2. **Secrets in `environment:` instead of `secrets:`.** It works, so it ships — and now the DB password sits in plaintext in every `describe-task-definition` output, every revision, forever (task definitions are immutable *and* unredactable). Correct approach: `secrets:`/`valueFrom` for anything sensitive; `environment:` only for values you'd put on a slide.
3. **Forgetting `iam:PassRole` (or the execution role's secret grants).** The deploy fails with `is not authorized to perform: iam:PassRole`, or tasks die at `PROVISIONING` with `ResourceInitializationError: unable to pull secrets` — neither message names the actual fix, and people debug the app for an hour. Correct approach: section's IAM checklist — deploy role passes, execution role pulls and reads, task role acts; three roles, three jobs.
4. **`minimumHealthyPercent: 0` on the web service to "speed up deploys".** It does — by serving 0 tasks for a window on every deploy, which is a self-inflicted outage that health checks obligingly report after the fact. Correct approach: 100/200 for anything behind the ALB; 0 is a considered choice for worker singletons only.
5. **Treating `workflow_run` as "runs on every merge".** It fires when *CI completes* — a cancelled or failed CI run means no deploy, silently, and staging quietly falls behind `main` (9.1's drift pitfall, new mechanism). Correct approach: the `conclusion == 'success'` filter plus an alert on staging's `/up` SHA diverging from `main` for more than an hour (exercise 5 builds it).

## Exercises

1. Time a full deploy from merge to smoke-test-green using the run's timestamps, then break down where the minutes went (CI build vs migration task vs rolling replacement vs stability wait). Compare against your 8.4 exercise-5 manual number — that ratio is this module's report card.
2. Break a deploy on purpose: push a commit whose migration fails (`throw` in `up()`). Verify the workflow stops red at the migration gate, the api service still runs the old revision, and staging serves traffic throughout. Then fix forward and watch it heal. Write down the two other failure gates you didn't trigger and what each would have done.
3. Use ECS Exec to run `php artisan horizon:status` and `php artisan config:show database` (name one thing you must *never* do in that shell and why). Then find your session in CloudTrail — actor, task, timestamp — and compare the audit story to 8.4's SSM sessions.
4. **Go Graviton.** Add `--platform linux/arm64` multi-arch builds to `ci.yml` (Buildx makes this a matrix or a `platforms:` list), flip `runtimePlatform.cpuArchitecture` to `ARM64`, deploy, and re-run the cost math. Measure the CI-time cost of multi-arch builds and decide — in writing — whether 20% of $69 buys it for staging.
5. **Stretch — the drift sentinel.** Write a scheduled workflow (cron, every 30 min) that compares `main`'s HEAD SHA against staging's `/up` version and opens (or updates) a GitHub issue when they diverge for two consecutive checks — deploy failed, CI cancelled, or someone paused the pipeline. You've built your first piece of continuous *verification*; Module 12 gives the idea its full name.

## What's next

TicketHub now deploys itself: merge, and two minutes of machinery later staging is provably running your commit; tag, and production (come Module 10) is one approval away. [TICKETHUB.md](../TICKETHUB.md)'s roadmap line for Module 9 — "ECS Fargate, fully automated deploys from GitHub Actions, zero downtime" — is fact. But rolling deploys have a ceiling: they verify that new code is *healthy*, not that it's *right*, and a wrong-but-healthy release still reaches 100% of your users at rollout speed. [Lecture 9.4](04-progressive-delivery.md) climbs the rest of the ladder — blue/green, canary, and feature flags — so the blast radius of being wrong shrinks from "everyone" to "the few users you chose."
