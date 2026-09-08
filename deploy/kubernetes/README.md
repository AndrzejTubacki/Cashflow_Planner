# Kubernetes Deployment Examples

These manifests are initial examples for running Cashflow on Kubernetes. They
are not a guarantee of production readiness. Each cluster still needs a review
of ingress, storage, security, and backup choices.

Cashflow remains portable: Kubernetes is optional. Bare-metal Node.js, Docker,
Docker Compose, and other process-manager deployments continue to use the same
application configuration model.

The repository tests do not validate these manifests against a real cluster.
They are starter packaging for staging tests with copied data before production
traffic is moved.

## Included Files

- `namespace.yaml`: staging namespace named `cashflow-staging`
- `configmap.yaml`: non-secret runtime configuration
- `secret.example.yaml`: secret shape with no real values; not included in
  `kustomization.yaml`
- `pvc.yaml`: 1Gi RWO data PVC
- `deployment.yaml`: single-replica `Recreate` Deployment
- `service.yaml`: ClusterIP service on port 3000
- `ingress.yaml`: placeholder host-based Ingress
- `kustomization.yaml`: optional convenience wrapper for `kubectl apply -k`

## Deployment Shape

- one replica only
- `strategy: Recreate`
- persistent data mounted at `/app/data`
- ephemeral `/app/logs` or stdout/stderr log collection
- no `/app/backups` mount by default
- `/readyz` for readiness and startup
- `/healthz` for process-only liveness
- RWO storage for SQLite

SQLite is single-writer storage, so Cashflow remains a single-replica
deployment. NFS/RWX storage adds locking and durability risk unless the operator
has explicitly designed for SQLite on that backend.

## Build And Push An Image

Build and push an image to a registry your cluster can pull from:

```sh
docker build -t registry.example.com/cashflow:0.3.0 .
docker push registry.example.com/cashflow:0.3.0
```

A retained, immutable image tag is recommended for every deployment. The image
in `deployment.yaml` is the value to change:

```yaml
image: registry.example.com/cashflow:0.3.0
```

The `latest` tag is a poor fit for upgrades that may need rollback.

## Configure Staging

The example namespace is `cashflow-staging`. The public placeholder hostname is
`cashflow-staging.example.com`. Replace the placeholder host only in your local
copy or deployment overlay.

`configmap.yaml` contains portable example settings:

- `DATA_DIR=/app/data`
- `LOGS_DIR=/app/logs`
- `CASHFLOW_MIRROR_LOGS_TO_STDOUT=1`
- `CASHFLOW_READYZ_CHECK_DEFAULT_BUDGET=0`
- bounded recovery retention defaults

`CASHFLOW_LOG_TIMEZONE=Europe/Warsaw` is only an example. Set the timezone that
matches the deployment's log-reading preference.

The example PVC uses:

```yaml
storageClassName: standard
resources:
  requests:
    storage: 1Gi
```

That storage class is user-specific. Other clusters can change it or omit it.
PVC expansion belongs at the storage-class level when future growth is expected.

## Create Secrets

`secret.example.yaml` intentionally contains no real secret values. Real
secrets belong in a private Secret, not in the repository.

For `none` mode behind external ingress protection, you may not need any
Cashflow secret yet. For internal or external auth, create a real Secret from a
private local env file:

```sh
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl -n cashflow-staging create secret generic cashflow-secrets \
  --from-env-file=/path/to/private/cashflow.secret.env \
  --dry-run=client -o yaml | kubectl apply -f -
```

The private file can contain keys such as:

```text
CASHFLOW_PASSWORD_PEPPER=
CASHFLOW_EXTERNAL_AUTH_SECRET=
CASHFLOW_GOOGLE_CLIENT_SECRET=
CASHFLOW_GITHUB_CLIENT_SECRET=
CASHFLOW_FACEBOOK_CLIENT_SECRET=
```

That private file belongs outside the repo and outside backups that should not
contain deployment secrets.

## Apply The Manifests

Apply files explicitly:

```sh
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f deploy/kubernetes/configmap.yaml
kubectl apply -f deploy/kubernetes/pvc.yaml
kubectl apply -f deploy/kubernetes/deployment.yaml
kubectl apply -f deploy/kubernetes/service.yaml
kubectl apply -f deploy/kubernetes/ingress.yaml
```

Or use the optional kustomization:

```sh
kubectl apply -k deploy/kubernetes
```

The example Secret should not be committed with real values.

## Restore Existing Data Into The PVC

For staging, copy production-like data first and validate it before moving the
production hostname.

Writes on the source system should be stopped before making a raw data archive.
Copying live SQLite files without their WAL files can lose data.

The Kubernetes Deployment should be scaled down before replacing data in the
PVC:

```sh
kubectl -n cashflow-staging scale deployment/cashflow --replicas=0
```

Create a temporary copy pod that mounts the same PVC:

```sh
kubectl -n cashflow-staging apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: cashflow-data-copy
spec:
  restartPolicy: Never
  containers:
    - name: copy
      image: busybox:1.36
      command: ["sleep", "3600"]
      volumeMounts:
        - name: cashflow-data
          mountPath: /app/data
  volumes:
    - name: cashflow-data
      persistentVolumeClaim:
        claimName: cashflow-data
YAML
kubectl -n cashflow-staging wait --for=condition=Ready pod/cashflow-data-copy --timeout=60s
```

Copy the prepared data archive into the mounted path and remove the temporary
pod:

```sh
kubectl -n cashflow-staging cp ./cashflow-data.tgz cashflow-data-copy:/tmp/cashflow-data.tgz
kubectl -n cashflow-staging exec cashflow-data-copy -- sh -c \
  'find /app/data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -C /app/data -xzf /tmp/cashflow-data.tgz'
kubectl -n cashflow-staging delete pod cashflow-data-copy
```

Start staging again:

```sh
kubectl -n cashflow-staging scale deployment/cashflow --replicas=1
kubectl -n cashflow-staging rollout status deployment/cashflow
```

## Health And Readiness Checks

Port-forward for direct checks:

```sh
kubectl -n cashflow-staging port-forward svc/cashflow 3000:3000
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/readyz
curl http://127.0.0.1:3000/api/system
```

`/healthz` confirms the process is alive. `/readyz` confirms cheap application
readiness: app initialization, writable `DATA_DIR`, and readable global schema
metadata. It does not scan every budget, run SQLite `integrity_check`, or call
external APIs.

## Validate Migrated Legacy Data

Before switching production traffic, validate staging with copied data:

1. Open the staging hostname.
2. Confirm existing budgets are visible.
3. If legacy profile directories were imported, confirm `legacy-admin` exists
   and is the only automatic `system_admin`.
4. Create a staging-only account and confirm it does not accidentally receive
   `system_admin`.
5. Open representative budgets and verify settings, pending rows, confirmed
   ledger rows, balances, FX settings, and data portability exports.
6. The rollout check passes against staging after the route is protected as
   intended:

```sh
CASHFLOW_BASE_URL=https://cashflow-staging.example.com npm run rollout:check
```

## Ingress And Auth

The generic Ingress uses a placeholder host. The ingress class, TLS issuer, and
authentication are cluster-specific.

Cashflow in auth mode `none` requires strong external access control such as
VPN, management allowlist, Basic Auth, or SSO. HTTPS alone is not access
control.

Traefik example annotations, using placeholder middleware names:

```yaml
metadata:
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.middlewares: namespace-auth@kubernetescrd
```

Middleware names are cluster-local. Placeholder names need to match resources
that exist in the target cluster.

## Optional Node Placement

The generic manifests do not set node affinity. Placement belongs in a local
deployment overlay.

Generic pattern to prefer one node while avoiding another:

```yaml
spec:
  template:
    spec:
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: In
                    values: ["preferred-node"]
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: NotIn
                    values: ["avoid-node"]
```

## Backups And Rollback

A complete `DATA_DIR` backup is recommended before every upgrade. Longhorn
replication or any other storage replication is not a backup; off-cluster
backups are still needed for real recovery.

If database migrations ran, the safest rollback is restoring the matching
`DATA_DIR` backup and then starting the previous application image tag. An older
image may not understand a newer schema.

App-level backups remain useful for bare-metal, Docker, and Compose users. For a
small Kubernetes PVC, avoid storing large long-term backup archives on the same
volume. Prefer external/off-cluster backups for real recovery.

## Release Note

Kubernetes manifests are provided as initial examples. They are not a guarantee
of production readiness. Users should test with copied data first.
