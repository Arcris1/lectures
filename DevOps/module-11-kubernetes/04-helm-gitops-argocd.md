# Lecture 11.4 — Helm & GitOps with Argo CD

> **Module 11 — Kubernetes** · Lecture 4 of 4 · Estimated time: ~75 min

You ended Lecture 11.2 with roughly ten YAML files and a `kubectl apply -f k8s/` habit, and Lecture 11.3 with a production EKS cluster waiting for them. Two problems remain. Staging and production need *different* YAML — replicas, resources, hostnames, image tags — and copy-pasting per-environment directories is the mistake Module 10 taught you to avoid. And *something* still has to run `kubectl apply` — right now that something is you, holding cluster credentials at a laptop. This lecture fixes both: Helm turns the manifests into one parameterized package, and Argo CD turns deployment itself into the reconciliation loop from Lecture 11.1 — pointed at a Git repo.

## Learning objectives

- Package TicketHub's manifests as a Helm chart with small per-environment values files.
- Use the core Helm workflow — `template`, `lint`, `upgrade --install`, `history`, `rollback` — and explain Helm's revision model.
- Guarantee migrations-before-rollout ordering with Helm hooks, replacing Lecture 11.2's manual Job sequencing.
- Contrast push-based CD (Module 9) with pull-based GitOps, and explain how an in-cluster agent extends the reconciliation loop to deployment itself.
- Deploy TicketHub with Argo CD: automated sync for staging, manual sync for production, rollback via `git revert`.
- Trace the end-to-end image-update flow from `git push` to pods rolling, naming which module built each step.

## 1. The YAML-sprawl problem

Count what Lecture 11.2 produced for the `tickethub` namespace: the two-container `tickethub-web` Deployment, `tickethub-horizon`, the `tickethub-scheduler` CronJob, a migration Job, `tickethub-config`, a Service, an Ingress, an HPA. Call it ten files, ~600 lines. Now deploy it to both staging and `tickethub-prod-eks`. The differences are small but real:

| Setting | Staging | Production |
|---|---|---|
| `tickethub-web` replicas | 2 | 3 |
| App container resources | 250m / 384Mi | 500m / 512Mi |
| Ingress host | `api.staging.tickethub.example` | `api.tickethub.example` |
| Ingress class | `nginx` (kind) / `alb` | `alb` + ACM cert |
| Image tag | latest merged SHA | promoted SHA |

Copy the directory and those ten files exist twice; every future change — a probe threshold, a label — must be made twice, correctly, forever. You watched this movie in Module 10: the answer there was *one module, many `tfvars`*. The Kubernetes answer has the same shape: **one chart, many values files**.

## 2. Helm: one chart, many values

Helm is a package manager and template engine for Kubernetes. A **chart** is a directory of templated manifests plus metadata; **values** are its parameters; a **release** is one installed instance of a chart, with a numbered revision history. You've already consumed charts — ingress-nginx, metrics-server, the AWS Load Balancer Controller, and External Secrets Operator all arrived via `helm install` in Lectures 11.2 and 11.3. Now you author one, in the app repo at `helm/tickethub/`:

```text
helm/tickethub/
├── Chart.yaml              # name, chart version, appVersion
├── values.yaml             # the chart's public API: every knob, with defaults
├── values-staging.yaml     # small per-env override (image tag, host)
├── values-production.yaml  # small per-env override (replicas, resources, host)
└── templates/
    ├── _helpers.tpl        # named template snippets (labels, names)
    ├── NOTES.txt           # printed after install
    ├── configmap.yaml
    ├── deployment-web.yaml
    ├── deployment-horizon.yaml
    ├── cronjob-scheduler.yaml
    ├── job-migrate.yaml    # becomes a hook in §4
    ├── service.yaml
    ├── ingress.yaml
    └── hpa.yaml
```

Two deliberate absences: **no `secret.yaml`** — `tickethub-secrets` is owned by External Secrets Operator on EKS (Lecture 11.3) and by your hand-made placeholder on kind, so the chart never touches it — and no environment-named template files. Environments differ only in values.

**`values.yaml` is the chart's API.** Everything an operator may legitimately vary goes here; everything else stays hardcoded in templates. Staging-ish defaults:

```yaml
# helm/tickethub/values.yaml
image:
  app:
    repository: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api
  nginx:
    repository: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-nginx
  tag: sha-0000000   # always overridden per environment; never 'latest'

web:
  replicas: 2
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilizationPercentage: 60
  resources:
    nginx:
      requests: { cpu: 100m, memory: 128Mi }
      limits: { memory: 256Mi }
    app:
      requests: { cpu: 250m, memory: 384Mi }
      limits: { memory: 512Mi }

horizon:
  replicas: 1
  terminationGracePeriodSeconds: 60

scheduler:
  schedule: "* * * * *"
  suspend: false

ingress:
  className: nginx
  host: api.staging.tickethub.example
  certificateArn: ""      # set for ALB in production

serviceAccountName: tickethub-app

config:                    # rendered into tickethub-config
  APP_ENV: staging
  LOG_CHANNEL: stderr
  SESSION_DRIVER: redis
  QUEUE_CONNECTION: redis
  FILESYSTEM_DISK: s3
```

An excerpt from `templates/deployment-web.yaml` shows the pattern — you don't need all ten files once you can read one:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tickethub-web
  labels:
    {{- include "tickethub.labels" . | nindent 4 }}
spec:
  {{- if not .Values.web.autoscaling.enabled }}
  replicas: {{ .Values.web.replicas }}
  {{- end }}
  selector:
    matchLabels:
      app: tickethub-web
  template:
    metadata:
      labels:
        app: tickethub-web
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    spec:
      serviceAccountName: {{ .Values.serviceAccountName }}
      containers:
        - name: nginx
          image: "{{ .Values.image.nginx.repository }}:{{ .Values.image.tag }}"
          resources:
            {{- toYaml .Values.web.resources.nginx | nindent 12 }}
        - name: app
          image: "{{ .Values.image.app.repository }}:{{ .Values.image.tag }}"
          resources:
            {{- toYaml .Values.web.resources.app | nindent 12 }}
        # probes, lifecycle, envFrom — unchanged from Lecture 11.2
```

Three details are load-bearing:

- **One `image.tag` drives both containers.** Module 6's two-image pattern means one commit builds `tickethub-api` and `tickethub-nginx` with the same SHA tag (Module 7), so one values change rolls both in lockstep — nginx's baked-in static assets can never drift from the PHP code they belong to.
- **The `checksum/config` annotation** hashes the rendered ConfigMap into the pod template. Kubernetes only restarts pods when the *pod template* changes — editing a ConfigMap alone changes nothing running. With the checksum, any config change triggers a normal rolling update. Standard practice in real charts, not a curiosity.
- **`replicas` disappears when autoscaling is on.** If both the chart and the HPA own the replica count, every sync resets what the autoscaler decided. Render one owner, never both.

The per-environment files are tiny. `values-staging.yaml` carries what CI changes, plus the host:

```yaml
# helm/tickethub/values-staging.yaml
image:
  tag: sha-a1b2c3d       # bumped by CI — see §7
ingress:
  host: api.staging.tickethub.example
```

`values-production.yaml` is the entire staging-vs-production diff — about twenty lines, exactly like Module 10's `production.tfvars` against the shared modules. Same lesson, new ecosystem: an environment is *data*, not a copy of the code:

```yaml
# helm/tickethub/values-production.yaml
image:
  tag: sha-a1b2c3d       # promoted deliberately — see §7
web:
  replicas: 3
  autoscaling:
    minReplicas: 3
    maxReplicas: 20
  resources:
    app:
      requests: { cpu: 500m, memory: 512Mi }
      limits: { memory: 1Gi }
ingress:
  className: alb
  host: api.tickethub.example
  certificateArn: arn:aws:acm:ap-southeast-1:111122223333:certificate/abcd-1234
config:
  APP_ENV: production
```

## 3. The Helm workflow

Four commands cover daily life. **Render and inspect** — `helm template` runs the template engine locally and prints pure YAML; pipe it to `kubectl diff -f -` to see what would change before touching anything (Terraform `plan`'s cousin). **Lint** — `helm lint helm/tickethub` catches template and chart-structure mistakes; it belongs in CI next to `tflint` (Module 10). **Install/upgrade** — `helm upgrade --install tickethub helm/tickethub -n tickethub -f helm/tickethub/values-staging.yaml` is idempotent: first run installs, later runs upgrade. **History and rollback** — every upgrade stores a numbered revision (the rendered manifests, in a Secret in the release namespace); `helm history` lists them, `helm rollback tickethub 3 -n tickethub` re-applies revision 3. `helm uninstall` removes the release and everything it created. You'll use these hands-on below — and then, with Argo CD, mostly stop running them yourself.

## 4. Hooks: migrations before rollout, guaranteed

Lecture 11.2 ordered migrations manually: apply the Job, wait, then apply the Deployments. That ordering lived in your shell history. Helm **hooks** turn it into machinery. Annotate the migration Job template:

```yaml
# helm/tickethub/templates/job-migrate.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: tickethub-migrate
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": "0"
    "helm.sh/hook-delete-policy": before-hook-creation
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: {{ .Values.serviceAccountName }}
      containers:
        - name: migrate
          image: "{{ .Values.image.app.repository }}:{{ .Values.image.tag }}"
          command: ["php", "artisan", "migrate", "--force"]
          envFrom:
            - configMapRef: { name: tickethub-config }
            - secretRef: { name: tickethub-secrets }
```

`pre-install,pre-upgrade` means: on every release, Helm creates this Job *first*, waits for completion, and only then applies the rest of the chart. A failed Job fails the release — **no migration, no rollout** — Module 9's release-phase principle as an annotation instead of a pipeline step. `hook-weight` orders multiple hooks (lower first — room for a future `config:cache` warmer). `hook-delete-policy: before-hook-creation` deletes the previous run's Job just before creating the new one — necessary because Job specs are immutable (re-applying over an old Job by the same name errors), and useful because the last run's logs stay around for debugging until the next deploy. Module 9's contract still governs: migrations stay backward-compatible with the previous code version, because old pods serve traffic while the migration runs.

## 5. When not Helm: Kustomize, briefly and fairly

Kustomize solves the same environment-variance problem without a template language: a `base/` of plain, valid YAML plus per-environment *overlays* that patch it. It is built into kubectl (`kubectl apply -k`), and its manifests stay readable YAML rather than Go-template soup — genuine advantages, and plenty of good teams choose it. Helm wins for TicketHub on three counts: values files are a cleaner *parameter* interface than patches when the differences are scalar knobs; hooks give us migration ordering natively; and the ecosystem speaks Helm — every add-on you installed this module shipped as a chart, and Argo CD supports both anyway. Pick one per repo and stay consistent.

## 6. GitOps: from push to pull

Module 9's deployment model has served you well: CI builds an image, then *pushes* the change to the environment — it holds AWS credentials, calls the ECS APIs, and hopes. Two structural weaknesses. First, CI holds production credentials, and every workflow in the repo is one misconfiguration away from using them. Second, CI deploys and walks away: if someone `kubectl edit`s a Deployment on Tuesday, nothing notices until the next deploy silently reverts it. There is no ongoing relationship between "what we declared" and "what is running".

**GitOps** inverts the direction. A Git repo *is* the desired state of the cluster. An agent running *inside* the cluster pulls from that repo and continuously reconciles: watch Git, watch the cluster, diff, act, forever. You already know this loop — it is Lecture 11.1's controller pattern, the deepest idea in this module, now applied to deployment itself. A Deployment reconciles pods toward its spec; Argo CD reconciles the *cluster* toward the repo. Terraform gave you declarative-on-demand (Module 10); Kubernetes controllers made it continuous; GitOps makes the declaration live in Git.

The concrete benefits, without evangelism:

- **Audit** — "who changed prod and when" is `git log`, with PR review attached (Module 4's machinery, reused).
- **Rollback** — `git revert` the offending commit; the agent converges backward. No special tooling.
- **Drift correction** — hand edits are detected and (if you enable it) reverted automatically.
- **Credentials** — the agent pulls with read-only Git access; cluster-admin credentials never leave the cluster. CI shrinks to building images and editing YAML in a repo.
- **Disaster recovery** — point a fresh cluster at the repo and wait. The repo *is* the runbook.

The honest costs: one more stateful thing to run and upgrade in-cluster, and a mental-model shift — "deploy" stops being a command and becomes a commit that *causes* a deploy, which takes a week to stop feeling strange.

## 7. Argo CD: the Application resource and the image-update flow

Argo CD is the most widely deployed GitOps agent (Flux is the credible alternative; the concepts transfer). It extends the Kubernetes API with an `Application` CRD — an object declaring "this Git path, rendered this way, belongs in that cluster and namespace."

`Application` definitions live in **`tickethub-infra`** — platform wiring, not app code — under `apps/staging.yaml` and `apps/production.yaml`, while the chart they point at lives in the app repo:

```yaml
# tickethub-infra/apps/staging.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: tickethub-staging
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/tickethub/tickethub-api.git
    targetRevision: main
    path: helm/tickethub
    helm:
      valueFiles:
        - values-staging.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: tickethub
  syncPolicy:
    automated:
      prune: true      # delete cluster resources removed from the chart
      selfHeal: true   # revert hand edits automatically
    syncOptions:
      - CreateNamespace=true
```

`source` says *what* (repo, branch, path, values files — Argo runs `helm template` itself and applies the output; Helm hooks like our migration Job are honored as pre-sync hooks). `destination` says *where*. `syncPolicy` says *how eagerly* — and here Module 9's promotion gates survive translation. Staging gets `automated` + `prune` + `selfHeal`: every merge to `main` converges staging within minutes, unattended. **Production's Application omits the `automated` block entirely** — Argo continuously *shows* the diff but applies nothing until a human clicks Sync or runs `argocd app sync tickethub-production`. Same merge-gates-deploy philosophy as Module 9's GitHub environment approvals, in GitOps form. (`syncWindows`, set on the Argo project, can additionally forbid syncs during on-sale hours — worth knowing exists.)

At scale, teams add an **app-of-apps**: one root `Application` whose source path contains other `Application` manifests, so registering a new app or add-on is itself a commit. A pattern to reach for when the app count grows past a handful; two Applications don't need it.

### The image-update flow, end to end

The question every team asks first: *CI builds `sha-9f8e7d6` — how does that reach the cluster?* In GitOps, CI never touches the cluster. It edits a file in Git:

```text
1. Developer merges PR to main                       (Module 4 review, Module 7 checks)
2. CI builds + pushes tickethub-api:sha-9f8e7d6
   and tickethub-nginx:sha-9f8e7d6 via OIDC          (Modules 6/7)
3. CI opens an automated PR: bump image.tag in
   helm/tickethub/values-staging.yaml, auto-merge    (this lecture)
4. Merge lands on main → Argo CD detects the diff
   → syncs → migration hook → pods roll on staging   (Lectures 11.2/11.4)
5. Promotion = a human PR copying the tag into
   values-production.yaml, gated by CODEOWNERS       (Module 4)
6. Merge → Argo shows prod OutOfSync → operator
   syncs → production rolls                          (manual gate preserved)
```

Step 3 is a dozen lines of workflow:

```yaml
# .github/workflows/deploy.yml (excerpt) — after the image build job
- name: Bump staging image tag
  run: |
    TAG="sha-${GITHUB_SHA::7}"
    git checkout -b "deploy/staging-${TAG}"
    yq -i ".image.tag = \"${TAG}\"" helm/tickethub/values-staging.yaml
    git commit -am "chore(deploy): staging → ${TAG}"
    git push -u origin HEAD
    gh pr create --fill --label deploy
    gh pr merge --auto --squash
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Exclude `helm/tickethub/values-*.yaml` from the image-build workflow's trigger paths, or the bump commit will rebuild the image it just deployed. The packaged alternative is **argocd-image-updater**, which watches ECR and writes tag bumps back to Git for you — less plumbing, but another controller to run, and its write-back commits bypass your PR checks; the explicit-PR flow keeps every deploy inside the same review machinery as everything else, which is why the course teaches it first.

Every Application reports two statuses: **sync** (does the cluster match Git? `Synced` / `OutOfSync`) and **health** (do the resources work? `Healthy` / `Progressing` / `Degraded` — for a Deployment, essentially `rollout status`). Green-green is steady state; anything else is your first place to look.

## Hands-on with TicketHub

Everything here runs on your kind cluster from Lecture 11.2 — free, disposable. (Pointing Argo at `tickethub-prod-eks` is the same YAML with a different `destination`; the cluster bills ~$0.10/hr plus nodes while it exists — Lecture 11.3's teardown ritual applies.)

**1. Build the chart.** Create `helm/tickethub/` per §2: move the Lecture 11.2 manifests into `templates/`, parameterize them per the deployment excerpt, add `Chart.yaml`:

```yaml
# helm/tickethub/Chart.yaml
apiVersion: v2
name: tickethub
description: TicketHub event-ticketing API
type: application
version: 0.1.0        # chart version — bump on chart changes
appVersion: "sha-a1b2c3d"  # informational; the real tag lives in values
```

**2. Lint and render.**

```console
$ helm lint helm/tickethub
==> Linting helm/tickethub
1 chart(s) linted, 0 chart(s) failed

$ helm template tickethub helm/tickethub -f helm/tickethub/values-staging.yaml \
    | kubectl diff -f -
```

Read the rendered YAML until it matches what you applied by hand in Lecture 11.2 — same names, probes, resources. The chart is a repackaging, not a rewrite.

**3. First release by hand** (feel the revision model before automating it):

```console
$ helm upgrade --install tickethub helm/tickethub \
    -n tickethub -f helm/tickethub/values-staging.yaml --wait
Release "tickethub" does not exist. Installing it now.
NAME: tickethub
NAMESPACE: tickethub
STATUS: deployed
REVISION: 1

$ kubectl get jobs -n tickethub
NAME                STATUS     COMPLETIONS   AGE
tickethub-migrate   Complete   1/1           48s
```

The migration hook ran *before* the Deployments rolled — watch `kubectl get pods -w` during an upgrade to see the ordering live. Bump a config value, upgrade again, and check `helm history`:

```console
$ helm history tickethub -n tickethub
REVISION  STATUS      DESCRIPTION
1         superseded  Install complete
2         deployed    Upgrade complete
```

Now hand the wheel over: `helm uninstall tickethub -n tickethub`. (Argo applies rendered manifests directly rather than sharing Helm's release history, so let it own the objects from scratch. Your hand-made `tickethub-secrets` survives — it was never part of the release.)

**4. Install Argo CD** and log in:

```console
$ kubectl create namespace argocd
$ kubectl apply -n argocd \
    -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
$ kubectl -n argocd rollout status deploy/argocd-server
deployment "argocd-server" successfully rolled out
$ kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath='{.data.password}' | base64 -d; echo
kX9v2mPq7RwLnB4t
$ kubectl -n argocd port-forward svc/argocd-server 8080:443
```

Open `https://localhost:8080` (accept the self-signed cert), log in as `admin`: the UI is a live picture of every Application — resource tree, sync and health status. CLI equivalent: `argocd login localhost:8080`, then `argocd app list`.

**5. Register the staging Application.** Commit `apps/staging.yaml` from §7 to `tickethub-infra` (`repoURL` pointing at your fork), then apply it once by hand — the last manual `kubectl apply` of the course:

```console
$ kubectl apply -f apps/staging.yaml
application.argoproj.io/tickethub-staging created
$ argocd app get tickethub-staging
NAME            tickethub-staging
SYNC STATUS     Synced
HEALTH STATUS   Healthy
```

Within minutes, Argo cloned the repo, rendered the chart, ran the migration hook, and rolled out every workload — the same result as step 3, with nobody running Helm.

**6. The drift demo — the console-cowboy era formally ends.** Scale by hand and watch `selfHeal` respond:

```console
$ kubectl scale deploy tickethub-web -n tickethub --replicas=5
deployment.apps/tickethub-web scaled
$ kubectl get deploy tickethub-web -n tickethub -w
NAME            READY   UP-TO-DATE   AVAILABLE   AGE
tickethub-web   5/5     5            5           21m
tickethub-web   2/2     2            2           21m
```

Within seconds the count snaps back to the value in Git. Lecture 11.1 taught you that hand-changes to pods don't stick because a controller owns them; now hand-changes to *anything in the namespace* don't stick, because Git owns it. The only durable change is a commit.

**7. Deploy and roll back through Git.** Simulate CI's bump: edit `image.tag` in `values-staging.yaml` to a newer SHA (`kind load` it first, per Lecture 11.2), commit, push, watch the app go `OutOfSync → Syncing → Synced` as pods roll. Then the payoff:

```console
$ git revert --no-edit 4f7c2ab   # the bump commit
[main 8d1e9c0] Revert "chore(deploy): staging → sha-9f8e7d6"
$ git push
$ argocd app get tickethub-staging | grep -E 'SYNC|HEALTH'
SYNC STATUS     Synced
HEALTH STATUS   Healthy
```

Rollback is a revert. It flows through the same review, migration hook, and rollout choreography as any deploy — no snowflake procedure to remember at 2 a.m. (Module 9's schema caveat is eternal: reverting code does not revert an applied migration; backward-compatible migrations are what make the revert safe.)

**8. Secrets stayed out of Git the whole time.** The repo contains config values, resource numbers, image tags — and zero secrets. On EKS, External Secrets Operator (Lecture 11.3) materializes `tickethub-secrets` from AWS Secrets Manager, so the GitOps repo declares *that* secrets exist, never *what* they are, and Module 8's managed rotation keeps flowing untouched. The alternative, **sealed-secrets**, encrypts secrets so ciphertext can live in Git and only an in-cluster controller can decrypt — self-contained and cloud-agnostic, but rotation becomes re-encrypt-and-commit, and the sealing key becomes a cluster-lifecycle liability. With Secrets Manager already in the stack, ESO is the cleaner fit.

### The platform arc, closed

```text
 developer ──git push──▶ GitHub PR ── checks: Pest/Pint/Larastan (M7) ── review/CODEOWNERS (M4)
                            │ merge
                            ▼
                    CI builds images (M6/M7)
                    tickethub-api:sha-9f8e7d6 ──▶ ECR (OIDC, no keys)
                            │
                            ▼
                    CI PR: bump values-staging.yaml (M11) ──merge──▶ main
                                                                      │ pull
                          ┌───────────────────────────────────────────┘
                          ▼
        ┌─ EKS: tickethub-prod-eks (M11) ── born from Terraform PRs (M10) ─┐
        │   Argo CD ──sync──▶ helm/tickethub ──▶ migrate hook ──▶ rollout   │
        │   tickethub-web · tickethub-horizon · tickethub-scheduler        │
        │   12-factor container (M5/M6) · probes & drains (M11)            │
        └── on AWS: VPC/RDS/Redis/S3/SES (M8) ── secrets via ESO (M11) ────┘
```

| Stage | Built in |
|---|---|
| Code review, branch protection, CODEOWNERS promotion gate | Module 4 |
| Stateless 12-factor app; config from environment | Module 5 |
| Two-image container build (`tickethub-api` + `tickethub-nginx`) | Module 6 |
| CI: tests, quality gates, SHA-tagged images via OIDC | Module 7 |
| AWS foundations: VPC, RDS, Redis, S3, SES | Module 8 |
| Release discipline: migrations-first, zero-downtime, promotion | Module 9 |
| Everything above expressed as Terraform, applied by PR | Module 10 |
| EKS, Helm chart, Argo CD pulling it all together | Module 11 |

Every module's artifact is load-bearing in that picture. What it cannot yet tell you is *how it's going* — Module 12 adds the eyes.

## Real-world best practices

- **Treat `values.yaml` as a public API.** Comment every key, keep the structure flat, never make templates reach into undocumented values. Whoever edits `values-production.yaml` at 2 a.m. should not need to read templates to know what a knob does.
- **Keep environment overrides tiny.** If `values-production.yaml` grows past a screen, environment logic is leaking into it; push shared decisions into `values.yaml` defaults. Twenty lines of diff between environments is a feature — it is the whole review surface for a promotion.
- **Immutable tags only, in Git.** Argo diffs manifests — a re-pushed mutable tag changes nothing in YAML, so nothing deploys. SHA tags (Module 6's rule) are what make "Git is the source of truth" literally true.
- **Automated sync for staging, manual for production, and mean it.** The value of the production gate is that it's boring and always there; teams that flip prod to auto-sync "temporarily" have made an architecture decision by accident. Encode freeze periods as `syncWindows`, not tribal knowledge.
- **Once Argo owns a namespace, revoke human write access to it.** `selfHeal` reverts hand edits anyway; RBAC that makes `kubectl apply` impossible for humans in `tickethub` turns an anti-pattern into a non-event. Read access stays — debugging is `describe` and `logs`, not `edit`.

## Common pitfalls

1. **ConfigMap changed, pods didn't.** People assume updating config restarts consumers, because most PaaS platforms behave that way — but Kubernetes only rolls pods on pod-*template* changes, so the change silently applies only to future pods, giving you a mixed fleet. Hash the rendered ConfigMap into the pod template (§2) so config changes become ordinary rolling updates.
2. **`replicas` in Git fighting the HPA.** The chart says 2, the HPA scaled to 6 under load, `selfHeal` snaps it to 2, the HPA scales back up — sawtooth capacity during your busiest hour, because two owners are declared. Omit `replicas` when autoscaling is enabled (the `{{- if not ... }}` guard in §2), or set Argo's `ignoreDifferences` for the field.
3. **A failed migration Job blocks every subsequent release.** Job specs are immutable, so without a delete policy Helm cannot recreate `tickethub-migrate` over last release's corpse — every deploy errors with "field is immutable". People hit this because hooks work fine until the first failure. `hook-delete-policy: before-hook-creation` (§4) recreates cleanly *and* preserves the failed pod's logs until the next attempt.
4. **Fixing production in the Argo UI (or `kubectl edit`) during an incident.** Under pressure, editing live objects feels faster than a PR — and with `selfHeal` on, the fix evaporates on the next reconcile, mid-incident. The fast path is a small values PR with expedited review; for true emergencies, pause reconciliation *first* (`argocd app set --sync-policy none`), fix, then backfill the commit and re-enable.
5. **CI's tag-bump commit triggers another image build.** The bump merges, the image workflow fires, builds an identical image with a new SHA, bumps again — a slow infinite loop that looks like "CI is just busy". Scope the build workflow's `paths` to exclude `helm/tickethub/values-*.yaml`.
6. **Production's Application tracking `main` with auto-sync.** Usually born of copy-pasting the staging Application — and it makes every merge a production deploy, erasing Module 9's promotion model. Keep prod on manual sync with its own values file.

## Exercises

1. **Add a knob.** Use a values PR to set `scheduler.suspend: true` on staging. Verify with `kubectl get cronjob -n tickethub`, then revert.
2. **Break a migration on purpose.** Commit a migration that fails (a duplicate column will do), push, and watch: the hook Job fails, the release fails, the Deployments keep running the old version untouched. Read the failed pod's logs, fix forward, confirm the next sync heals everything. Write down the sequence — it's your incident rehearsal.
3. **Wire the real bump job.** Add the §7 `yq`/`gh pr create` step to your fork's deploy workflow (with the `paths` excludes from pitfall 5) and take one commit through the entire flow: push → image → auto-PR → merge → Argo sync → new pods. Time it end to end.
4. **Gate production properly.** Create `apps/production.yaml` with manual sync, add a `CODEOWNERS` rule on `helm/tickethub/values-production.yaml`, and run one full promotion: PR the staging tag into production values, merge, watch prod go `OutOfSync`, sync deliberately.
5. **Stretch — app-of-apps.** Build a root `Application` pointing at `tickethub-infra`'s `apps/` directory, so the Applications themselves sync from Git. Add a third one deploying a public chart (e.g. `kube-prometheus-stack`, arriving properly in Module 12) to see why platform teams manage *add-ons* this way too.

## What's next

TicketHub now runs on a platform where every layer — infrastructure, cluster, workloads, deployment itself — is declared in Git and reconciled by machinery, and a rollback is a revert. What the platform still lacks is sight: you can't yet see request latency spike during an on-sale, trace a slow checkout to its query, or get paged before customers notice. [Module 12](../module-12-observability-security-sre/) adds exactly that — structured logging, Prometheus and Grafana on this cluster, tracing, SLOs, and security scanning across the pipeline — and it deploys the way everything now deploys: through Git.
