# Deployment guide

Two sections: **local deployment** (implemented and verified) and **Kubernetes** (chart and
manifests supplied and schema-validated; not deployed).

## Local deployment with Docker Compose

Prerequisites and first-time setup are in the [developer setup guide](developer-setup.md).

### Profiles

| Profile | Starts | Approx. memory |
| --- | --- | --- |
| *(always)* | PostgreSQL, NATS, Keycloak | 1.2 GB |
| `core` | web, gateway, tenant, case, workflow, notification, audit, asset, incident | + 0.9 GB |
| `iot` | Mosquitto, device, telemetry, alert, sensor simulator | + 0.4 GB |
| `analytics` | data-pipeline, analytics | + 0.4 GB |
| `ai` | ai-gateway (works without a model) | + 0.1 GB |
| `ai-model` | Ollama (optional local model, CPU) | + 2 GB while a model is loaded |
| `observability` | Prometheus, Grafana, Loki, Alloy | + 0.6 GB |
| `dr-lab` | standby database, restore target, backup tooling | + 0.3 GB |

Figures are observed container memory on the development machine, not guarantees. All profiles
can run together in roughly 6 GB; `core` alone is the lightweight default. `iot` depends on
`core` for the gateway and incident handling; `analytics` and `ai` are useful only with `core`.

### Commands

```powershell
./scripts/titan.ps1 setup                                   # once
./scripts/titan.ps1 up                                      # core + iot: build, start, wait, seed
./scripts/titan.ps1 up -Profiles core,iot,analytics,ai      # more profiles
./scripts/titan.ps1 status                                  # health of every service
./scripts/titan.ps1 seed                                    # reload demo data (idempotent)
./scripts/titan.ps1 test                                    # unit + integration tests
./scripts/titan.ps1 down                                    # stop, keep data
./scripts/titan.ps1 destroy                                 # stop and delete local data (asks first)
```

Equivalent plain commands (any shell):

```bash
cp .env.example .env && npm install
docker compose --profile core --profile iot up -d --build
npm run seed
node scripts/status.mjs
docker compose --profile core --profile iot down
```

### Addresses

| What | URL |
| --- | --- |
| Web command center | http://localhost:3000 |
| API gateway | http://localhost:8080 (API docs per service: `/api/<key>/docs`, token required) |
| Keycloak | http://localhost:8081 (admin console user and password in `.env`) |
| Grafana / Prometheus | http://localhost:3001 / http://localhost:9090 |

Ports are bound to 127.0.0.1 only. Services other than web, gateway and Keycloak are not
published on the host; PostgreSQL (5432), NATS (4222) and MQTT (1883) are published on
localhost for tests and tools.

### Database migrations

Each service applies its own migrations when it starts (`MIGRATE_ON_START=true`), using its
owner role, under an advisory lock. To run them as a separate step:

```bash
DATABASE_OWNER_URL=postgres://case_owner:<password>@localhost:5432/titan_case DB_APP_ROLE=case_app \
  node packages/platform/dist/migrate-cli.js services/case-service/migrations
```

Databases and roles are created once, when the PostgreSQL volume is first initialised
(`infrastructure/docker/postgres/init`). Adding a new service database to an existing volume
requires creating it by hand or re-initialising the volume.

### Configuration

All settings are in `.env` (copied from `.env.example`; development-only values).

| Setting | Meaning |
| --- | --- |
| `DB_DEV_PASSWORD` | Base of every database role password in the lab |
| `DEMO_USER_PASSWORD` | Password of all synthetic demo users |
| `KEYCLOAK_PUBLIC_URL`, `WEB_ORIGIN` | Public addresses (token issuer, CORS, redirect URIs) |
| `RATE_LIMIT_PER_MINUTE` | Gateway limit per user |
| `AI_ENABLED`, `OLLAMA_*` | AI feature flag and model server |
| `MAP_TILE_URL` | Background tiles of the map page. Empty: the public OpenStreetMap server, contacted by each viewer's browser. A raster tile template of your own, or `none` for a map with no external requests |
| `*_HOST_PORT` | Host ports |

### Optional local model

```powershell
docker compose --profile ai-model up -d ollama
docker compose --profile ai-model exec ollama ollama pull llama3.2:1b
docker compose --profile ai-model exec ollama ollama pull nomic-embed-text
# in .env:  OLLAMA_BASE_URL=http://ollama:11434
docker compose --profile ai up -d ai-gateway-service
```

The AI workspace then shows "Model available". Without these steps it shows "No model
available" and gives deterministic answers. A GPU machine can serve Ollama instead: point
`OLLAMA_BASE_URL` at it.

### Upgrading and resetting

- Code change: `./scripts/titan.ps1 up` rebuilds and recreates what changed.
- Reset all local data: `./scripts/titan.ps1 destroy`, then `up`.

## Kubernetes (supplied, validated, not deployed)

**Status.** `helm lint` passes; the rendered chart (80 resources) and the platform manifests
pass `kubeconform -strict` including operator CRDs; the OpenTofu module passes `tofu validate`.
None of it has run on a cluster. Expect to adjust it during a first staging deployment.

### What is in the repository

| Path | Content |
| --- | --- |
| `infrastructure/helm/titan` | Chart for gateway, web and the 13 services: Deployments, Services, ServiceAccounts, PodDisruptionBudgets, HPA (gateway), NetworkPolicies, Ingress with TLS, lake PVC, optional ExternalSecrets and ServiceMonitor |
| `infrastructure/helm/titan/values-primary.yaml`, `values-dr-standby.yaml` | Per-region overrides |
| `infrastructure/kubernetes/platform` | CloudNativePG cluster, NATS chart values, Keycloak custom resource |
| `infrastructure/kubernetes/dr` | CloudNativePG replica cluster for the DR region, Velero schedules |
| `infrastructure/kubernetes/argocd` | AppProject and ApplicationSet (one application per region) |
| `infrastructure/opentofu` | Namespaces and Helm releases of the operators, broker, secrets, backup and GitOps controllers |

### Order of a first deployment (outline)

1. Provide a cluster (3 zones), an ingress controller, cert-manager, a storage class, object
   storage buckets and a secret manager. These are outside this repository.
2. `tofu apply` in `infrastructure/opentofu` with pinned chart versions (no defaults are given
   on purpose).
3. Build and push the images (`node-service.Dockerfile` with `SERVICE_PATH`, the Python and web
   Dockerfiles) to your registry; set `global.imageRegistry` and `imageTag`.
4. Apply the CloudNativePG cluster; create the service databases and roles (the logic of
   `01-init-databases.sh`, with independent secrets per role).
5. Install NATS with `nats-values.yaml`; deploy Keycloak and import the realm generated without
   the `titan-cli` client and demo users.
6. Create the secrets the chart expects (see `values.yaml` or the chart notes), ideally through
   External Secrets.
7. Register the Argo CD ApplicationSet; let it sync the chart.
8. Verify with the integration test suite pointed at the environment
   (`TITAN_GATEWAY_URL`, `TITAN_KEYCLOAK_URL`) using test tenants.

### Validate the manifests yourself

```bash
docker run --rm -v "$PWD/infrastructure/helm:/charts" alpine/helm:3.19.0 lint /charts/titan
docker run --rm -v "$PWD/infrastructure/helm:/charts" alpine/helm:3.19.0 template titan /charts/titan > rendered.yaml
docker run --rm -i ghcr.io/yannh/kubeconform:v0.7.0 -strict -summary -kubernetes-version 1.31.0 - < rendered.yaml
```

### Differences from the local stack to plan for

TLS everywhere; per-role database secrets; no `titan-cli` client; MFA enforced for privileged
roles; NATS authentication and stream replicas of 3; per-device MQTT credentials; object
storage for the lake; a real e-mail adapter (requires authorization); Alertmanager routing.
See the [risk register](../risk-register.md).
