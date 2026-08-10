# Lecture 11.2 — TicketHub on Kubernetes

> **Module 11 — Kubernetes** · Lecture 2 of 4 · Estimated time: ~75 min

In [Lecture 11.1](01-kubernetes-core-concepts.md) you stood up a kind cluster and ran a minimal `tickethub-web` Deployment. Now we do the real translation: every piece of the ECS Fargate setup from Module 9 — web service, Horizon, scheduler, migrations as a release phase, config and secrets — becomes a complete, production-shaped manifest in the `tickethub` namespace. By the end, all of TicketHub runs on your laptop cluster, an order flows end-to-end through an Ingress, and you'll have deliberately killed pods mid-flow to watch reconciliation hold the line.

## Learning objectives

- Translate each ECS concept from Module 9 (task definition, service, run-task, EventBridge schedule) into its Kubernetes equivalent and explain the mapping.
- Size container resource requests and limits deliberately, including deriving PHP-FPM's `pm.max_children` from the container memory limit.
- Configure liveness, readiness, and startup probes that gate traffic and restart containers without turning a dependency blip into an outage.
- Choreograph graceful shutdown (preStop, SIGTERM, termination grace) so deploys and scale-downs drop zero requests and zero queue jobs.
- Run database migrations as a Kubernetes Job before rolling out new code, preserving Module 9's release-phase discipline.
- Deploy the full TicketHub stack — web, Horizon, scheduler, config, Ingress, HPA — to kind and verify an order end-to-end.

## 1. The shape of the translation

In Module 9 you described TicketHub to ECS as task definitions (containers, CPU/memory, env) plus services (desired count, load balancer wiring, circuit breaker). Kubernetes splits the same information across smaller, composable objects:

| You told ECS… | You tell Kubernetes… |
|---|---|
| Task definition (containers, resources, env) | Pod template inside a Deployment |
| Service (desired count, rolling deploy) | Deployment (replicas, update strategy) |
| Target group + listener rule | Service + Ingress |
| `run-task` for migrations | Job |
| EventBridge scheduled task | CronJob |
| SSM/Secrets Manager valueFrom | ConfigMap + Secret via `envFrom` |

Nothing here is conceptually new — what's new is that each behavior is a first-class API object you can `kubectl get`, `describe`, and diff. We'll build them in dependency order: config → migrations → workloads → traffic → autoscaling.

## 2. tickethub-web: the two-container pod, sized properly

Module 6's two-image pattern maps 1:1 onto a pod: the `tickethub-nginx` container serves static files and proxies PHP to the `tickethub-api` (PHP-FPM) container over `127.0.0.1:9000` — the same localhost wiring as the ECS task, because containers in a pod share a network namespace.

Here is the full Deployment. Read the resources and probes sections after it; every number is argued for.

```yaml
# k8s/web-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tickethub-web
  namespace: tickethub
  labels:
    app.kubernetes.io/name: tickethub
    app.kubernetes.io/component: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: tickethub
      app.kubernetes.io/component: web
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app.kubernetes.io/name: tickethub
        app.kubernetes.io/component: web
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: nginx
          image: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-nginx:sha-a1b2c3d
          ports:
            - name: http
              containerPort: 80
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              memory: 256Mi
          readinessProbe:
            httpGet:
              path: /up
              port: http
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            tcpSocket:
              port: http
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "5"]
        - name: app
          image: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
          ports:
            - name: fpm
              containerPort: 9000
          envFrom:
            - configMapRef:
                name: tickethub-config
            - secretRef:
                name: tickethub-secrets
          resources:
            requests:
              cpu: 250m
              memory: 384Mi
            limits:
              memory: 512Mi
          startupProbe:
            tcpSocket:
              port: fpm
            periodSeconds: 5
            failureThreshold: 12
          livenessProbe:
            tcpSocket:
              port: fpm
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "5"]
```

### Requests vs limits — two different jobs

A **request** is a scheduling claim: the scheduler places a pod only on a node with that much *unreserved* capacity. A **limit** is a runtime ceiling enforced by the kernel. They fail differently:

- **CPU is compressible.** Exceed a CPU limit and the kernel *throttles* you — the process runs slower. Nothing dies, but p99 latency quietly climbs.
- **Memory is not.** Exceed a memory limit and the kernel **OOM-kills** the container. It restarts, mid-request, no appeal.

That asymmetry drives this course's opinionated stance: **always set requests; always set memory limits; leave CPU limits off for the web tier.** The honest debate: CPU limits protect neighbors on a shared node from a runaway pod, but in practice they throttle exactly when you least want it — a traffic spike during an on-sale — and requests already give the scheduler what it needs to spread load. If a compliance regime forces CPU limits on you, set them high and monitor throttling (Module 12 gives you the metric).

### The FPM math — Module 3, container edition

In Module 3 you sized `pm.max_children` to the *server's* RAM. The container limit is now the server. The app container gets a 512Mi limit; a TicketHub FPM worker peaks around 45 MB (opcache is shared in the master), and master + opcache + overhead cost roughly 100 MB:

```
(512 − 100) / 45 ≈ 9  →  pm.max_children = 8 (leave headroom)
```

Set `pm.max_children = 8` in `docker/php/` and rebuild. If you set it to 25 "to be safe", eight concurrent slow requests won't hurt you — but twelve will OOM-kill the container. The limit and the FPM config must agree, or the kernel becomes your process manager.

One paragraph on **QoS classes**: pods where every container's requests equal its limits are *Guaranteed*; ours (requests < limits, some limits absent) are *Burstable*; pods with nothing set are *BestEffort* and are first against the wall under node memory pressure. Burstable is the right trade for web workloads — you get scheduling guarantees plus burst room.

## 3. Probes — the #1 source of self-inflicted incidents

Kubernetes offers three probes, and confusing them causes real outages.

**Liveness** answers "is this process wedged beyond recovery?" — failure means *restart the container*. It must be **dependency-free**. Walk the cascade if you probe the database from a liveness check: MySQL blips for 20 seconds → every web pod's liveness fails → kubelet restarts all of them *simultaneously* → cold opcache, connection stampede on a recovering database → more failures → restart storm. You converted a blip into an outage. Our liveness probes are `tcpSocket` — "is nginx accepting connections", "is the FPM master alive" — nothing more.

**Readiness** answers "should this pod receive traffic *right now*?" — failure removes the pod from Service endpoints but does **not** restart it. Ours hits `/up` through nginx, which proves the full request path: nginx → FastCGI → FPM → Laravel booted. Here's the Kubernetes twist on Module 3's shallow-vs-deep health check debate: if readiness checked the database and MySQL flapped, *every* pod would go unready at once — Kubernetes would calmly remove all endpoints and serve nobody. A dependency being down is not a reason to stop serving 503s from your own error handler, and it's certainly not improved by adding "no pods at all". **Keep readiness app-local; alert on dependencies instead** (Module 12's job). Laravel 12's `/up` route is exactly this: it boots the framework and returns 200 without touching MySQL or Redis.

**Startup** answers "has this container finished booting?" and suspends the other probes until it succeeds. FPM usually boots in seconds, but a cold node pulling the image and running `config:cache` can take longer; without a startup probe you'd tune liveness's `initialDelaySeconds` for the worst case and pay it forever. Ours allows 12 × 5s = 60 seconds of boot budget, then hands off to a tight liveness probe.

The thresholds, argued: readiness `periodSeconds: 5, failureThreshold: 3` means a genuinely broken pod stops receiving traffic within ~15 seconds — fast, but three consecutive failures filter out one slow scrape. Liveness `periodSeconds: 10, failureThreshold: 3` means we tolerate 30 seconds of weirdness before the drastic remedy of a restart — restarts should be rare and deserved.

## 4. Graceful shutdown — killing the deploy-time 502

Every rollout terminates pods, so termination *is* the steady state of deployment. The sequence when Kubernetes deletes a pod:

1. Pod is marked Terminating; endpoint controllers *start* removing it from Services.
2. **Simultaneously**, the `preStop` hook runs, then SIGTERM goes to each container.
3. After `terminationGracePeriodSeconds`, anything still running gets SIGKILL.

Step 1 and step 2 race. kube-proxy on every node must observe the endpoint removal and rewrite rules; for a second or two, *new* connections still arrive at a pod that has already been told to die. If nginx exits immediately on SIGTERM, those connections get 502s — the classic "we only see errors during deploys" signature. The `preStop: sleep 5` is load-bearing: it holds the container fully alive while endpoint removal propagates, so by the time SIGTERM lands, no new traffic is coming. Then FPM finishes in-flight requests (our images set `STOPSIGNAL SIGQUIT` for graceful FPM drain — Module 6) inside the 30-second grace period.

You have danced this dance before: it's exactly ALB deregistration delay + connection draining from Modules 8 and 9, reimplemented at pod granularity. Same race, same fix, different layer.

## 5. tickethub-horizon and tickethub-scheduler

Horizon is a Deployment with no Service — nothing routes *to* a queue worker:

```yaml
# k8s/horizon-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tickethub-horizon
  namespace: tickethub
  labels:
    app.kubernetes.io/name: tickethub
    app.kubernetes.io/component: horizon
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: tickethub
      app.kubernetes.io/component: horizon
  template:
    metadata:
      labels:
        app.kubernetes.io/name: tickethub
        app.kubernetes.io/component: horizon
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: horizon
          image: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
          command: ["php", "artisan", "horizon"]
          envFrom:
            - configMapRef:
                name: tickethub-config
            - secretRef:
                name: tickethub-secrets
          resources:
            requests:
              cpu: 250m
              memory: 384Mi
            limits:
              memory: 512Mi
```

Two deliberate choices. **Grace period 60s ≥ your longest job**: Horizon handles SIGTERM itself (equivalent to `horizon:terminate`) — it stops taking new jobs and drains in-flight ones; `GenerateTicketPdf` can take tens of seconds, so 30 would risk SIGKILL-ing a half-written PDF. **Replicas 1, and why not 2**: Horizon supervises its own worker pool across the `default`, `pdfs`, and `mail` queues; scale worker *processes* via Horizon's config first, and add pod replicas only when one pod's CPU/memory ceiling is truly the bottleneck. (Two Horizon pods is safe — Redis queues are multi-consumer — it's just usually the wrong first knob.)

The scheduler becomes a CronJob:

```yaml
# k8s/scheduler-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: tickethub-scheduler
  namespace: tickethub
spec:
  schedule: "* * * * *"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 30
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: scheduler
              image: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
              command: ["php", "artisan", "schedule:run"]
              envFrom:
                - configMapRef:
                    name: tickethub-config
                - secretRef:
                    name: tickethub-secrets
              resources:
                requests:
                  cpu: 100m
                  memory: 256Mi
                limits:
                  memory: 384Mi
```

On ECS you ran `schedule:work` as a tiny always-on service; here a fresh pod runs `schedule:run` every minute. The honest trade: the CronJob spawns 1,440 pods/day (churn, image must be cached), but there's no daemon to babysit, and a wedged run can't block the next one. `concurrencyPolicy: Forbid` skips a tick if the previous one is still running; `startingDeadlineSeconds: 30` says "if you couldn't start within 30s of the schedule, skip it" — better to miss a minute of `ExpireReservations` than fire a late double. And defense in depth still applies: your `onOneServer()` locks from Module 5 remain in the code, guarding against the day someone runs two schedulers by accident.

## 6. Config, secrets, and the migration Job

Module 5's config/code separation lands as two objects consumed via `envFrom`:

```yaml
# k8s/config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tickethub-config
  namespace: tickethub
data:
  APP_ENV: "staging"
  APP_URL: "https://api.tickethub.example"
  LOG_CHANNEL: "stderr"
  DB_HOST: "mysql.tickethub.svc"
  DB_DATABASE: "tickethub"
  REDIS_HOST: "redis.tickethub.svc"
  CACHE_STORE: "redis"
  QUEUE_CONNECTION: "redis"
  SESSION_DRIVER: "redis"
  FILESYSTEM_DISK: "s3"
---
apiVersion: v1
kind: Secret
metadata:
  name: tickethub-secrets
  namespace: tickethub
type: Opaque
stringData:                      # stringData: plain text in; API stores it base64
  APP_KEY: "base64:CHANGE-ME-lab-only"
  DB_USERNAME: "tickethub"
  DB_PASSWORD: "CHANGE-ME-lab-only"
  AWS_ACCESS_KEY_ID: "CHANGE-ME-lab-only"
  AWS_SECRET_ACCESS_KEY: "CHANGE-ME-lab-only"
```

Say it plainly: **base64 is encoding, not encryption.** Anyone with `kubectl get secret -o yaml` reads these in one pipe through `base64 -d`. Secrets exist as a *distinct object* so RBAC can restrict who reads them and so encryption-at-rest in etcd (a cluster-level setting, on by default in EKS) has something to target. These hand-typed values are honestly labeled lab placeholders — in [Lecture 11.3](03-eks-production.md), External Secrets Operator sources this same `tickethub-secrets` object from AWS Secrets Manager and you never type a password again.

Migrations keep Module 9's release-phase principle — schema changes run *before* new code rolls out, as a separate one-shot task:

```yaml
# k8s/migrate-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: tickethub-migrate-a1b2c3d   # unique per release: Jobs are immutable
  namespace: tickethub
spec:
  backoffLimit: 1
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
          command: ["php", "artisan", "migrate", "--force"]
          envFrom:
            - configMapRef:
                name: tickethub-config
            - secretRef:
                name: tickethub-secrets
```

`backoffLimit: 1` — a failed migration should page a human, not retry itself into a corrupted half-state. `restartPolicy: Never` keeps each attempt a fresh pod whose logs survive. `ttlSecondsAfterFinished` garbage-collects the Job an hour after completion. For now *you* enforce "migrate, then deploy" by running this Job first and waiting; [Lecture 11.4](04-helm-gitops-argocd.md) turns that ordering into machinery with Helm hooks. Module 9's backward-compatibility rule still governs: migrations must be safe alongside the *old* code that's still serving during the rollout.

## 7. Service, Ingress, and the HPA

```yaml
# k8s/web-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: tickethub-web
  namespace: tickethub
spec:
  selector:
    app.kubernetes.io/name: tickethub
    app.kubernetes.io/component: web
  ports:
    - name: http
      port: 80
      targetPort: http
---
# k8s/web-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tickethub-web
  namespace: tickethub
spec:
  ingressClassName: nginx
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
                  name: http
---
# k8s/web-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: tickethub-web
  namespace: tickethub
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: tickethub-web
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
```

The HPA compares actual CPU usage to *requests* (another reason requests must be honest): above 60% average, it adds pods; well below, it removes them, never breaching 2–10. CPU is a decent proxy for FPM saturation, but the metric TicketHub really wants to scale Horizon on is *queue depth* — custom metrics are Module 12 territory, once Prometheus exists. When the HPA owns replica count, remove `replicas: 2` from the Deployment manifest so an `apply` doesn't fight the autoscaler.

## Hands-on with TicketHub

Everything runs in kind — free, disposable, no AWS charges. The Ingress needs host ports, so recreate the cluster (clusters are cattle too) with port mappings, then install ingress-nginx and metrics-server:

```yaml
# kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
      - containerPort: 443
        hostPort: 443
```

```console
$ kind delete cluster --name tickethub && kind create cluster --name tickethub --config kind-config.yaml
$ kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
$ kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
$ kubectl patch -n kube-system deployment metrics-server --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
$ kind load docker-image tickethub-api:sha-a1b2c3d tickethub-nginx:sha-a1b2c3d --name tickethub
```

(In kind, reference the local image names in your manifests instead of the ECR URLs, and add `imagePullPolicy: IfNotPresent` — there's no ECR access from your laptop cluster.)

TicketHub needs MySQL, Redis, and S3-compatible storage in the lab. Apply `k8s/lab-deps.yaml` — four tiny single-replica Deployment+Service pairs (no PVCs; lab data is disposable). MySQL's pair shows the shape; Redis (`redis:7`) and MinIO follow it identically:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: {name: mysql, namespace: tickethub}
spec:
  replicas: 1
  selector: {matchLabels: {app: mysql}}
  template:
    metadata: {labels: {app: mysql}}
    spec:
      containers:
        - name: mysql
          image: mysql:8.0
          env:
            - {name: MYSQL_DATABASE, value: tickethub}
            - {name: MYSQL_USER, value: tickethub}
            - {name: MYSQL_PASSWORD, value: CHANGE-ME-lab-only}
            - {name: MYSQL_RANDOM_ROOT_PASSWORD, value: "1"}
---
apiVersion: v1
kind: Service
metadata: {name: mysql, namespace: tickethub}
spec:
  selector: {app: mysql}
  ports: [{port: 3306}]
```

Now the deploy sequence — namespace, config, migrate, workloads, traffic:

```console
$ kubectl create namespace tickethub
namespace/tickethub created
$ kubectl apply -f k8s/lab-deps.yaml -f k8s/config.yaml
deployment.apps/mysql created
service/mysql created
...
configmap/tickethub-config created
secret/tickethub-secrets created
$ kubectl apply -f k8s/migrate-job.yaml
job.batch/tickethub-migrate-a1b2c3d created
$ kubectl wait --for=condition=complete -n tickethub job/tickethub-migrate-a1b2c3d --timeout=120s
job.batch/tickethub-migrate-a1b2c3d condition met
$ kubectl logs -n tickethub job/tickethub-migrate-a1b2c3d | tail -3
  2026_02_10_000001_create_tickets_table ................ 41.22ms DONE
  2026_02_10_000002_create_cache_table .................. 12.90ms DONE
$ kubectl apply -f k8s/web-deployment.yaml -f k8s/horizon-deployment.yaml \
    -f k8s/scheduler-cronjob.yaml -f k8s/web-service.yaml -f k8s/web-ingress.yaml -f k8s/web-hpa.yaml
$ kubectl get pods -n tickethub
NAME                                READY   STATUS      RESTARTS   AGE
mysql-7d9f6c4b8-x2m4p               1/1     Running     0          3m
redis-6b8d55f9c-nq7ws               1/1     Running     0          3m
minio-59c7d8bd6-k8jl2               1/1     Running     0          3m
tickethub-horizon-6f7b9c5d4-w8xzt   1/1     Running     0          40s
tickethub-migrate-a1b2c3d-5tqk8     0/1     Completed   0          2m
tickethub-web-59c8d7f6b-4hm2k       2/2     Running     0          40s
tickethub-web-59c8d7f6b-tj9wp       2/2     Running     0          40s
```

`2/2` — both containers of each web pod ready. Place an order end-to-end through the Ingress (resolve the host to localhost):

```console
$ curl --resolve api.tickethub.example:80:127.0.0.1 \
    -X POST http://api.tickethub.example/api/orders \
    -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' \
    -d '{"ticket_type_id": 1, "quantity": 2}'
{"data":{"id":9001,"status":"paid","tickets":[{"id":417,"qr":"..."},{"id":418,"qr":"..."}]}}
$ kubectl logs -n tickethub deploy/tickethub-horizon -f
  2026-08-09 07:41:12 App\Jobs\GenerateTicketPdf ........ RUNNING
  2026-08-09 07:41:14 App\Jobs\GenerateTicketPdf ........ 1,912ms DONE
  2026-08-09 07:41:14 App\Mail\OrderConfirmed ........... 210ms DONE
$ kubectl exec -n tickethub deploy/tickethub-horizon -- \
    php artisan tinker --execute="print_r(Storage::disk('s3')->files('tickets'));"
Array
(
    [0] => tickets/417.pdf
    [1] => tickets/418.pdf
)
```

The full path works: Ingress → nginx → FPM → MySQL transaction → Redis queue → Horizon → PDF in (Min)S3. Watch the scheduler tick and verify reservations expire:

```console
$ kubectl get jobs -n tickethub --watch
NAME                            STATUS     COMPLETIONS   AGE
tickethub-scheduler-29471820    Complete   1/1           82s
tickethub-scheduler-29471821    Running    0/1           4s
```

Now break things on purpose. Kill a web pod mid-traffic and watch reconciliation hold:

```console
$ kubectl delete pod -n tickethub tickethub-web-59c8d7f6b-4hm2k &
$ for i in $(seq 1 20); do curl -so /dev/null -w "%{http_code}\n" \
    --resolve api.tickethub.example:80:127.0.0.1 http://api.tickethub.example/up; done
200
200
...20/20 — the Service routed around the dying pod; a replacement was already starting
$ kubectl get pods -n tickethub -l app.kubernetes.io/component=web
NAME                            READY   STATUS    RESTARTS   AGE
tickethub-web-59c8d7f6b-tj9wp   2/2     Running   0          9m
tickethub-web-59c8d7f6b-zc6rn   2/2     Running   0          31s
```

Scale drills — manual first, then let the HPA argue with you:

```console
$ kubectl scale deploy/tickethub-web -n tickethub --replicas=5
$ kubectl get pods -n tickethub -l app.kubernetes.io/component=web --watch
...three new pods Pending → ContainerCreating → 2/2 Running in ~15s
$ kubectl get hpa -n tickethub
NAME            REFERENCE                  TARGETS   MINPODS   MAXPODS   REPLICAS
tickethub-web   Deployment/tickethub-web   4%/60%    2         10        5
```

Within about five minutes the HPA scales back to 2 — its `minReplicas` — because 4% ≪ 60%. Your manual `kubectl scale` didn't stick: a controller owns the count now. Remember that feeling for Lecture 11.4, where Argo CD extends the same discipline to *every* field.

**The translation table** — pin this next to your Module 9 notes:

| ECS (Module 9) | Kubernetes |
|---|---|
| Task definition | Pod template (in the Deployment) |
| Service (desired count, rolling) | Deployment + ReplicaSet |
| Target group + health check | Service + Endpoints + readiness probe |
| `run-task` release phase | Job |
| EventBridge scheduled task | CronJob |
| Deployment circuit breaker | Rollout progress + probes (`rollout undo`) |
| SSM parameters / Secrets Manager refs | ConfigMap / Secret via `envFrom` |
| Service Auto Scaling | HorizontalPodAutoscaler |

## Real-world best practices

- **Requests always, CPU limits off (web), memory limits always.** Requests are the scheduler's only truth and the HPA's denominator; wrong requests mean wrong placement *and* wrong autoscaling. Memory limits turn a leak into one restarted container instead of a sick node.
- **Keep liveness probes brutally shallow and readiness app-local.** Every dependency you add to a probe is a new way to convert someone else's incident into yours. Alert on dependencies; don't restart or de-route over them.
- **Treat termination as a feature you test.** Deploy at peak traffic in staging while running a load test; zero 502s is the acceptance criterion. If you see errors, your preStop/grace-period/drain chain has a gap.
- **One release identity everywhere.** The same `sha-a1b2c3d` tag goes on the web images, the Horizon image, the migrate Job, and the CronJob in one change. Mixed SHAs across workloads is a subtle outage factory (old scheduler code dispatching jobs the new worker renamed).
- **Name Jobs per release, never reuse.** Jobs are immutable; `tickethub-migrate-<sha>` gives you an audit trail and lets `ttlSecondsAfterFinished` clean up behind you.
- **Keep the lab dependencies clearly fenced.** `lab-deps.yaml` never leaves your laptop; staging and production use RDS and ElastiCache from Module 10's Terraform. Running stateful databases in-cluster is a discipline this course deliberately avoids — the 12-factor payoff is that *no* TicketHub workload needs a volume.

## Common pitfalls

1. **Liveness probe checks a dependency.** People do it because "the pod isn't healthy if the DB is down" sounds reasonable. But liveness failure means *restart*, and restarting every pod because MySQL blipped is a restart storm that prolongs the incident. Correct: `tcpSocket`/process-local liveness; dependency health belongs in alerts.
2. **No preStop sleep, 502s on every deploy.** It "works fine" in dev where there's no traffic, so the endpoint-propagation race never bites. Correct: `preStop: sleep 5` on traffic-serving containers plus a grace period long enough to drain — and a load test during a staging deploy to prove it.
3. **`pm.max_children` ignores the container limit.** The Module 3 tuning was done against a 4 GB server and copied forward; the kernel now OOM-kills the container at 512Mi under load, which looks like "random crashes" in `kubectl describe` (`OOMKilled`, exit code 137). Correct: re-derive max_children from the limit, and treat the pair as one setting.
4. **Editing live objects instead of files.** `kubectl edit deploy` or `kubectl set image` fixes staging fast — and next `apply` from the repo silently reverts it, or worse, nobody can say what's running. Correct: change YAML in Git, `kubectl apply`, always. (Lecture 11.4 makes the cluster enforce this.)
5. **Two schedulers, no locks.** Someone scales the CronJob's Job history weirdness or runs `schedule:work` in a pod "temporarily", and nightly reports send twice. `concurrencyPolicy: Forbid` protects one CronJob against itself, not against a second scheduler. Correct: keep `onOneServer()` on every scheduled task — cheap insurance that has saved every team that's needed it.
6. **HPA fighting a hardcoded `replicas:`.** Apply sets 2, HPA sets 6, next apply sets 2 again mid-on-sale. Correct: once an HPA targets a Deployment, delete the `replicas` field from the manifest.

## Exercises

1. Run `kubectl describe pod` on a web pod and identify: its QoS class, both containers' probe configurations, and the events from its scheduling. Explain why the pod is Burstable.
2. Set `pm.max_children = 30` in the app image, load-test through the Ingress (`hey -z 60s -c 50 ...`), and capture the OOMKill in `kubectl describe pod` (exit code 137). Re-derive the correct value and verify the same load passes.
3. Break the readiness probe path (`/up` → `/upx`) in only one of the two web pods' worth of a new rollout by applying a bad image tag with `maxUnavailable: 0`. Observe that the rollout stalls, old pods keep serving, and `kubectl rollout undo` recovers — Module 9's circuit breaker, rebuilt from parts you now understand.
4. Deploy a config change (new `LOG_CHANNEL` value) and notice pods don't pick it up — `envFrom` is read at container start. Roll the pods with `kubectl rollout restart deploy/tickethub-web` and verify. Write down why this is annoying; Lecture 11.4's checksum-annotation trick fixes it.
5. **Stretch:** write `k8s/queue-drain-test.md` — a runbook proving Horizon's graceful drain. Dispatch 50 `GenerateTicketPdf` jobs, delete the Horizon pod mid-burst, and use Horizon's metrics plus the `tickets/` bucket listing to prove zero jobs were lost and none ran twice. Tune `terminationGracePeriodSeconds` down until jobs *do* get killed, and document the failure signature.

## What's next

TicketHub now runs entirely on Kubernetes — but Kubernetes runs entirely on your laptop, with hand-typed secrets and lab-grade MySQL. [Lecture 11.3](03-eks-production.md) moves the same manifests to EKS: a managed control plane born from a Terraform PR, IAM permissions per pod via IRSA, a real ALB provisioned by an in-cluster controller, DNS automation, and `tickethub-secrets` sourced from AWS Secrets Manager at last. The manifests you wrote today barely change — that portability is a large part of why Kubernetes won.
