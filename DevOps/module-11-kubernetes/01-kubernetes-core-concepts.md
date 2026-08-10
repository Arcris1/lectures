# Lecture 11.1 — Why Kubernetes & Core Concepts

> **Module 11 — Kubernetes** · Lecture 1 of 4 · Estimated time: ~75 min

## Learning objectives

- Explain when Kubernetes earns its complexity — and when ECS or a PaaS is the better call.
- Describe the control plane and node components, and what each one actually does.
- Teach back the reconciliation loop: desired state, watch → diff → act, and why the cluster self-heals.
- Read and write the four fields every manifest shares, and use labels and selectors as the glue between objects.
- Deploy TicketHub's web tier to a local kind cluster and reach `/up` through a Service.
- Debug pods with the core `kubectl` verbs: `get`, `describe`, `logs`, `exec`, `explain`.

## 1. Why Kubernetes — and why not

Let's be honest before we type a single command: **TicketHub does not need Kubernetes.** At the end of Module 10 you have a genuinely good setup — ECS Fargate services deployed automatically from GitHub Actions, every AWS resource born from a Terraform PR, blue/green and canary in your toolbox, feature flags for kill switches. Plenty of successful companies run exactly that architecture for years. If you stopped the course here, you would not be wrong.

So why does the industry — and this course — keep going?

**Kubernetes earns its complexity when:**

- **Many services and teams share one platform.** ECS is pleasant with three services. With thirty services owned by six teams, you want namespaces, resource quotas, RBAC, and a uniform deployment interface. Kubernetes was designed for exactly this multi-tenant platform shape.
- **You need the ecosystem.** The CNCF landscape — Prometheus, Argo CD, cert-manager, External Secrets, Karpenter, operators for databases and Kafka — is built against the Kubernetes API. On ECS you integrate each of these by hand or do without. On Kubernetes they install in minutes and speak a common language. Module 12's entire observability stack rides on this.
- **Portability pressure is real for you.** The same manifests run on EKS, GKE, AKS, on-prem, and your laptop. If multi-cloud, customer-hosted deployments, or vendor-exit leverage matter to your business, Kubernetes is the portable layer. (If they don't, this argument is weaker than conference talks suggest.)
- **The hiring market.** Kubernetes is the lingua franca of platform engineering. Engineers know it, tools target it, job postings assume it. Skills compound across employers in a way ECS knowledge doesn't.

**And the Kubernetes tax is real:**

- **Upgrades never stop.** Kubernetes ships three minor versions a year and old versions leave support. You will be upgrading clusters, forever.
- **Add-on lifecycle.** Ingress controller, DNS, secrets operator, autoscaler — each is software *you* now operate and version-match against the cluster.
- **YAML volume.** What was one ECS task definition becomes a Deployment, a Service, an Ingress, a ConfigMap, probes, and resource blocks. (Lecture 4 tames this with Helm — but the surface area is real.)

The course moves TicketHub to Kubernetes for two reasons, stated plainly: it **is** the industry's platform layer and you need it in your toolkit, and Module 12's observability and security stack assumes it. ECS remains a fine endpoint. This is education, not evangelism.

## 2. The architecture: control plane and nodes

A Kubernetes **cluster** is two kinds of machines: a **control plane** that decides what should run, and **nodes** that actually run it.

```
            CONTROL PLANE                              NODES
┌───────────────────────────────────┐   ┌────────────────────────────────┐
│  kube-apiserver ◄── every kubectl │   │  node 1                        │
│      │    ▲        command, every │   │  ┌──────────┐ ┌────────────┐   │
│      ▼    │        component call │   │  │ kubelet  │ │ kube-proxy │   │
│   etcd (cluster state)            │◄──┤  └────┬─────┘ └────────────┘   │
│                                   │   │       ▼                        │
│  kube-scheduler                   │   │  container runtime (containerd)│
│    (picks a node for new pods)    │   │   [pod] [pod] [pod]            │
│                                   │   ├────────────────────────────────┤
│  kube-controller-manager          │   │  node 2   ... same layout ...  │
│    (the reconciliation loops)     │   └────────────────────────────────┘
└───────────────────────────────────┘
```

- **kube-apiserver** — the front door. *Everything* in Kubernetes is an API call to this server: `kubectl`, the scheduler, the kubelets, your future GitOps agent. Nothing talks to the database directly; nothing bypasses the API. This single fact is why the ecosystem composes so well.
- **etcd** — the consistent key-value store holding the entire cluster state. Lose etcd, lose the cluster's memory.
- **kube-scheduler** — watches for pods that don't have a node yet and picks one, based on resource requests and constraints (much more on this in Lecture 2).
- **kube-controller-manager** — runs the controllers: the loops that make reality match intent. This is the heart of the system, and the next section is entirely about it.

On each node:

- **kubelet** — the node agent. Watches the API for pods assigned to its node, tells the container runtime to start them, reports status back.
- **kube-proxy** — programs the node's networking so Service IPs route to real pods.
- **container runtime** — containerd in most clusters. The same containerd that Docker uses under the hood (Module 6), so your images run unchanged.

On EKS (Lecture 3), AWS operates the entire left-hand box for you. On kind — today's tool — the whole diagram runs inside Docker containers on your laptop.

## 3. The one idea: declarative reconciliation

If you retain a single concept from this lecture, make it this one.

You never tell Kubernetes to *do* something. You tell it what you *want* — "two replicas of `tickethub-web`, this image, this port" — by writing an object to the API. Controllers then run an endless loop:

```
watch desired state  →  observe actual state  →  diff  →  act to converge  →  repeat forever
```

This should feel familiar. In Module 10, `terraform plan` diffed desired state (your HCL) against actual state (AWS), and `terraform apply` converged them. Kubernetes controllers run **the same loop shape — but continuously**. Terraform reconciles when you run it; Kubernetes reconciles every few seconds, forever, without being asked.

The consequences fall out immediately:

- **Self-healing is not a feature; it's the loop.** A pod dies at 3 a.m. → actual (1 replica) no longer matches desired (2) → the controller creates a replacement. Nobody "detects the failure and responds" — the diff simply stops being zero.
- **Hand-changes don't stick.** Delete a pod to "restart" it, fine — the controller replaces it. But hand-edit a running pod, or scale something the controller owns, and the loop calmly reverts your change. The system is doing its job; you fought the desired state instead of changing it. (Lecture 4 makes this the *entire deployment model*: Argo CD is just one more reconciler, whose desired state is a Git repo.)
- **Deploys are a state change, not a procedure.** You update the desired image tag; controllers choreograph the rollout. There is no deploy *script* to half-fail.

Every Kubernetes object you meet from now on — Deployment, Service, Ingress, HorizontalPodAutoscaler — is just a record of intent with a controller reconciling it. Learn the loop once and the whole system becomes predictable.

## 4. Objects and manifests: anatomy, labels, selectors

Every object you write shares four top-level fields:

```yaml
apiVersion: apps/v1        # which API group/version defines this kind
kind: Deployment           # what type of object this is
metadata:                  # identity: name, namespace, labels, annotations
  name: tickethub-web
  labels:
    app.kubernetes.io/name: tickethub-web
spec:                      # DESIRED state — you write this
  ...
```

There is a fifth section you never write: **`status`**. The system writes back what's actually true (`readyReplicas: 2`, conditions, IPs) into the same object. Desired state in `spec`, observed state in `status`, one API object — reconciliation made visible. `kubectl get deploy tickethub-web -o yaml` shows both.

Two kinds of metadata that beginners conflate:

- **Labels** are identifying key/values *meant for selection*: `app.kubernetes.io/name: tickethub-web`, `env: staging`. Queryable: `kubectl get pods -l app.kubernetes.io/name=tickethub-web`.
- **Annotations** are non-identifying attachments — descriptions, checksums, tool configuration (the AWS Load Balancer Controller in Lecture 3 is configured almost entirely through annotations). You cannot select by them.

**Selectors are the universal glue.** Kubernetes objects almost never reference each other by name. A Deployment doesn't own a list of pod names; it owns a *label selector*, and any pod matching it counts. A Service doesn't point at a Deployment; it selects pods by label. This loose coupling is what lets rolling updates, scaling, and service discovery compose without coordination.

## 5. The object tour

Six objects, one manifest each, building toward TicketHub.

### Pod

The smallest deployable unit: one or more containers that share a network namespace (one IP, `localhost` between them) and can share volumes. Remember Module 6's pattern — Nginx proxying to PHP-FPM over `127.0.0.1:9000` inside one Compose service? That maps 1:1 to a two-container pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: tickethub-web-demo
  labels:
    app.kubernetes.io/name: tickethub-web
spec:
  containers:
    - name: nginx
      image: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-nginx:sha-a1b2c3d
      ports:
        - containerPort: 80
    - name: app
      image: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
```

Nginx's `fastcgi_pass 127.0.0.1:9000` from Module 6 works unmodified, because both containers share the pod's network namespace.

Pods are **cattle, not pets** (the Module 8 vocabulary again): they get random-ish names, ephemeral IPs, and no resurrection — a dead pod is not restarted, it is *replaced*. Which is why **you never create bare pods** in practice; something must own their lifecycle.

### ReplicaSet

The controller that keeps N pod replicas alive from a template. You will see ReplicaSets constantly in `kubectl get` output, but you **never write one by hand** — because a ReplicaSet only knows "keep N of this template," not how to *change* the template safely. That's the next object's job.

### Deployment

The object you actually use for stateless workloads. A Deployment manages ReplicaSets, and a rolling update is ReplicaSet choreography: change the pod template (say, a new image tag) and the Deployment creates a *new* ReplicaSet, scaling it up while scaling the old one down, governed by:

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1          # how many extra pods may exist during the roll
    maxUnavailable: 0    # how many desired pods may be missing (0 = never dip below capacity)
```

That's the same surge-then-drain dance ECS performed in Module 9 — here it's declarative and inspectable:

```console
$ kubectl rollout status deployment/tickethub-web
$ kubectl rollout history deployment/tickethub-web
$ kubectl rollout undo deployment/tickethub-web    # rollback = re-activate the previous ReplicaSet
```

### Service

Pods are ephemeral: they die, get replaced, and every replacement has a new IP. A **Service** gives a stable virtual IP and DNS name in front of a label-selected, ever-changing set of pods:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: tickethub-web
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: tickethub-web
  ports:
    - name: http
      port: 80         # the Service's port
      targetPort: 80   # the pod's containerPort
```

How does traffic actually reach a pod? An endpoints controller continuously lists the pods matching the selector; `kube-proxy` on every node programs rules so connections to the Service IP are load-balanced across those pod IPs. Cluster DNS gives it a name: `tickethub-web.tickethub.svc.cluster.local` (`<service>.<namespace>.svc...`) — this is Module 3's service discovery problem, solved in-platform.

The three types, in terms of *who can reach it*: **ClusterIP** (default — inside the cluster only; right for almost everything), **NodePort** (opens a high port on every node — mostly a building block), **LoadBalancer** (asks the cloud for a real load balancer per Service — works, but one ALB per service gets expensive, which is why L7 routing moved to…)

### Ingress

L7 HTTP routing rules — host, path, TLS — as an object:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tickethub
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
                  number: 80
```

Critical gotcha: **an Ingress does nothing by itself.** It is pure intent; a separately installed **Ingress controller** (ingress-nginx locally, the AWS Load Balancer Controller on EKS in Lecture 3) watches Ingress objects and configures an actual proxy. `ingressClassName` picks which controller acts, since clusters can run several. Reconciliation again: rules are desired state, the controller converges a real load balancer to match. We install a controller and route real traffic in Lecture 2.

### Namespace

A named scope for objects — per-team, per-app, or per-environment isolation, and the attachment point for quotas and RBAC. From the next lecture onward, everything TicketHub lives in the `tickethub` namespace (per [TICKETHUB.md](../TICKETHUB.md)); today we'll stay in `default` to keep the moving parts minimal.

## 6. kubectl fluency

`kubectl` is a thin client for the API server, and a handful of verbs cover 95% of daily work. Drill these until they're reflex:

```console
$ kubectl apply -f deployment.yaml        # declare desired state (create OR update — idempotent)
$ kubectl get pods -o wide                # list, with node + pod IP
$ kubectl get deploy tickethub-web -o yaml  # full object incl. status writeback
$ kubectl describe pod tickethub-web-7d9f6c5b8-x2m4p   # human-readable detail + EVENTS
$ kubectl logs -f tickethub-web-7d9f6c5b8-x2m4p -c app   # follow logs; -c picks the container
$ kubectl logs tickethub-web-7d9f6c5b8-x2m4p -c app --previous  # the CRASHED container's logs
$ kubectl exec -it tickethub-web-7d9f6c5b8-x2m4p -c app -- sh   # shell into a container
$ kubectl delete -f deployment.yaml       # remove desired state (controller tears down pods)
$ kubectl explain deployment.spec.strategy   # built-in schema docs — no browser needed
$ kubectl config get-contexts             # which cluster/namespace am I pointed at?
```

Two habits worth naming now:

- **`describe` → Events is your first debugging stop.** Image pull failures, scheduling problems, crash loops — the Events section at the bottom of `describe` narrates what the controllers and kubelet did and why. Check it before you theorize.
- **`--previous` for crash loops.** A restarting container's current logs are empty milliseconds after restart; the evidence is in the *previous* container's logs.

## Hands-on with TicketHub

Time to run TicketHub's web tier on Kubernetes — locally, for free.

> 💰 **Cost: $0.** kind runs entirely on your machine. No AWS resources are created in this lecture; the paid cluster arrives in Lecture 3, clearly flagged.

### 1. Create a kind cluster

**kind** ("Kubernetes in Docker") runs a full conformant cluster inside Docker containers — the whole Section 2 diagram on your laptop. It's the standard local lab because it is fast (~1 minute), free, and disposable: `kind delete cluster` and it's gone. Install it (`brew install kind` or see kind.sigs.k8s.io), then:

```console
$ kind create cluster --name tickethub
Creating cluster "tickethub" ...
 ✓ Ensuring node image (kindest/node:v1.31.2) 🖼
 ✓ Preparing nodes 📦
 ✓ Writing configuration 📜
 ✓ Starting control-plane 🕹️
 ✓ Installing CNI 🔌
 ✓ Installing StorageClass 💾
Set kubectl context to "kind-tickethub"

$ kubectl get nodes
NAME                      STATUS   ROLES           AGE   VERSION
tickethub-control-plane   Ready    control-plane   61s   v1.31.2
```

Note the version: 1.31, matching what we'll run on EKS.

### 2. Load the Module 6 images

kind nodes can't see your local Docker image cache, and they can't pull from ECR without credentials. `kind load` copies images from your Docker daemon into the nodes. Build TicketHub's two images (Module 6) and load them:

```console
$ docker build --target production -t 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d .
$ docker build -f docker/nginx/Dockerfile -t 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-nginx:sha-a1b2c3d .

$ kind load docker-image --name tickethub \
    111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d \
    111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-nginx:sha-a1b2c3d
Image: "...tickethub-api:sha-a1b2c3d" with ID "sha256:9f2c..." loaded to node "tickethub-control-plane"
Image: "...tickethub-nginx:sha-a1b2c3d" with ID "sha256:41ab..." loaded to node "tickethub-control-plane"
```

(Because the tag isn't `:latest`, the default `imagePullPolicy: IfNotPresent` uses the loaded image instead of trying ECR.)

### 3. A minimal tickethub-web Deployment + Service

Create a directory `k8s/` in the app repo. First file, `k8s/web-deployment.yaml` — deliberately minimal; probes, resources, and real config are Lecture 2's whole subject:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tickethub-web
  labels:
    app.kubernetes.io/name: tickethub-web
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: tickethub-web
  template:
    metadata:
      labels:
        app.kubernetes.io/name: tickethub-web
    spec:
      containers:
        - name: nginx
          image: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-nginx:sha-a1b2c3d
          ports:
            - containerPort: 80
        - name: app
          image: 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/tickethub-api:sha-a1b2c3d
          env:
            - name: APP_ENV
              value: production
            - name: APP_KEY
              value: "base64:dGhpcy1pcy1hLWxvY2FsLW9ubHkta2V5LXJlcGxhY2U="  # local lab only — real secrets in Lecture 2/3
            - name: LOG_CHANNEL
              value: stderr
```

No database, no Redis — and that's fine for today, because Laravel 12's `/up` health endpoint is dependency-free (a point Module 3 made about shallow health checks, and which becomes load-bearing when we design probes in Lecture 2).

Second file, `k8s/web-service.yaml` — the ClusterIP Service shown in Section 5. Apply the whole directory:

```console
$ kubectl apply -f k8s/
deployment.apps/tickethub-web created
service/tickethub-web created

$ kubectl get pods -o wide
NAME                             READY   STATUS    RESTARTS   AGE   IP           NODE
tickethub-web-7d9f6c5b8-x2m4p    2/2     Running   0          18s   10.244.0.7   tickethub-control-plane
tickethub-web-7d9f6c5b8-zq81v    2/2     Running   0          18s   10.244.0.8   tickethub-control-plane
```

`READY 2/2` = both containers (nginx and app) in each pod. Now reach it — ClusterIP is cluster-internal, so tunnel in with `port-forward`:

```console
$ kubectl port-forward svc/tickethub-web 8080:80
Forwarding from 127.0.0.1:8080 -> 80
```

In another terminal:

```console
$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/up
200
```

**TicketHub is serving from Kubernetes.** The request path: your curl → port-forward tunnel → Service → a pod → nginx container → `127.0.0.1:9000` → php-fpm. Module 6's pattern, unchanged, one layer up.

### 4. The self-healing demo

Now *see* Section 3. Kill a pod:

```console
$ kubectl delete pod tickethub-web-7d9f6c5b8-x2m4p
pod "tickethub-web-7d9f6c5b8-x2m4p" deleted

$ kubectl get pods
NAME                             READY   STATUS    RESTARTS   AGE
tickethub-web-7d9f6c5b8-zq81v    2/2     Running   0          6m
tickethub-web-7d9f6c5b8-hn4wd    2/2     Running   0          4s    ← replacement, 4 seconds old
```

You expressed intent to delete; the ReplicaSet's diff went nonzero; it converged. Nobody paged. Scale up and watch the loop work live:

```console
$ kubectl scale deployment tickethub-web --replicas=5
$ kubectl get pods --watch
NAME                             READY   STATUS              RESTARTS   AGE
tickethub-web-7d9f6c5b8-8kfmw    0/2     ContainerCreating   0          2s
tickethub-web-7d9f6c5b8-8kfmw    2/2     Running             0          5s
...
```

And read the controllers narrating their own work:

```console
$ kubectl get events --sort-by=.lastTimestamp
LAST SEEN   TYPE     REASON             OBJECT                               MESSAGE
31s         Normal   SuccessfulCreate   replicaset/tickethub-web-7d9f6c5b8   Created pod: tickethub-web-7d9f6c5b8-8kfmw
30s         Normal   Scheduled          pod/tickethub-web-7d9f6c5b8-8kfmw    Successfully assigned default/tickethub-web-7d9f6c5b8-8kfmw to tickethub-control-plane
29s         Normal   Started            kubelet, Started container nginx
```

One caveat: that `kubectl scale` was an **imperative** command — the live object now says 5 but your YAML still says 2, and the next `kubectl apply -f k8s/` reverts it. Which brings us to the habit that matters most.

## Real-world best practices

- **Declarative always: edit YAML, `kubectl apply -f dir/`, commit to Git.** Imperative commands (`scale`, `set image`, `edit`) are for experiments and incidents only, because they create drift between the files you review and the cluster you run — Module 10's exact argument against console-clicking. This habit *is* the seed of GitOps: Lecture 4 merely adds a controller that runs the `apply` for you.
- **Use the standard label keys (`app.kubernetes.io/name`, `.../component`, `.../managed-by`) from day one.** Every dashboard, cost tool, and operator in the ecosystem understands them; ad-hoc labels mean rewriting selectors later — and selectors on Deployments are immutable.
- **Never create bare pods or hand-written ReplicaSets.** Deployments (and Jobs/CronJobs, next lecture) exist precisely to own pod lifecycle. A bare pod is a pet: when its node dies, it's simply gone.
- **`kubectl explain` before Google.** It documents the exact schema of *your* cluster's API version — faster and more accurate than a blog post written against 1.24.
- **Check your context before every destructive command** (`kubectl config get-contexts`). The classic career-limiting move is running `delete` against production while believing you're on kind. Tools like `kubectx` and a context-displaying shell prompt are cheap insurance.

## Common pitfalls

1. **Treating a pod like a server** — `exec` in, tweak a config, "fixed." People do it because it worked on the Module 3 VPS. But pods are replaced on every deploy, scale event, or node failure, and the fix silently evaporates. Correct: change the image or (from Lecture 2) the ConfigMap, and let the rollout converge.
2. **Fighting the reconciler and calling it a bug** — "I scaled to 5 and Kubernetes undid it!" It feels like the platform is broken; actually a controller is enforcing desired state that still says something else (your YAML — or, in Lecture 4, Argo CD's Git repo). Correct: find which object owns the state and change *that*.
3. **Expecting an Ingress to work with no controller installed** — you apply a valid Ingress, get no errors, and nothing happens. People assume Ingress is built-in because Service is. It's intent without an actor until a controller watches it. Correct: install an ingress controller and set `ingressClassName` (Lecture 2 for kind, Lecture 3 for EKS).
4. **Debugging from logs alone and skipping Events** — a pod stuck in `Pending` or `ImagePullBackOff` has no app logs *at all*, and people stare at `kubectl logs` errors. The scheduler and kubelet write their reasons to Events. Correct: `kubectl describe pod` first, read the bottom, then logs (with `--previous` for crash loops).
5. **Confusing Service `port` with `targetPort`** — traffic blackholes and people re-deploy the app repeatedly. `port` is the Service's own port; `targetPort` must match the pod's `containerPort`. Correct: check `kubectl get endpoints tickethub-web` — an empty endpoints list also instantly exposes the other classic cause, a selector/label typo.

## Exercises

1. **Break it, read Events.** Change the nginx image tag in `web-deployment.yaml` to `sha-doesnotexist` and apply. Use `kubectl get pods`, `describe`, and `get events` to narrate exactly what fails and why. Fix it, and confirm with `kubectl rollout status`.
2. **Rollout choreography.** Rebuild the nginx image under a new tag (`sha-b2c3d4e`), `kind load` it, update the Deployment, and watch `kubectl get replicasets --watch` during the apply. Explain the two ReplicaSets you see, then `kubectl rollout undo` and explain what happened to them.
3. **DNS between pods.** Run `kubectl run tmp --rm -it --image=busybox:1.36 -- sh`, then `wget -qO- http://tickethub-web.default.svc.cluster.local/up`. Explain each dot-separated segment of that name, and why the pod found the Service without any IP address.
4. **Selector surgery.** Remove the `app.kubernetes.io/name` label from one *running* pod with `kubectl label pod <name> app.kubernetes.io/name-`. Watch what the ReplicaSet does, check `kubectl get endpoints`, and explain both effects. Clean up the orphaned pod.
5. **Stretch: kubectl-only recon.** Without any browser docs, use only `kubectl explain` (drilling into subfields with dot-paths) to add a `RollingUpdate` strategy with `maxSurge: 1, maxUnavailable: 0` to the Deployment, and to answer: what does `progressDeadlineSeconds` default to, and what happens when it's exceeded?

## What's next

TicketHub's web tier runs on Kubernetes — but with hand-waved config, no probes, no resource limits, no Horizon, no scheduler, and no Ingress traffic. [Lecture 11.2 — TicketHub on Kubernetes](02-tickethub-on-kubernetes.md) is the full translation: every ECS concept from Module 9 lands as a complete, production-shaped manifest in the `tickethub` namespace — resources and the FPM math, the probes that cause (or prevent) most self-inflicted outages, graceful shutdown, Horizon, the scheduler CronJob, migrations as a Job, and an end-to-end order placed through Ingress.
