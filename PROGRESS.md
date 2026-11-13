# TITAN v2.0 — progress log

Single source of truth for what exists, what was verified, and what is still open.
"Verified" means the command was actually run in this repository and passed; the evidence is in
`docs/testing/verification-report.md`.

_Last updated: 2026-11-13 (stage 10 complete: handover state)_

**Status: locally verified development release. Not production-ready, not deployed to any
cluster, not highly available, all data synthetic.**

## Environment

| Item | Found |
| --- | --- |
| OS | Windows 11 Pro 10.0.26200, PowerShell 5.1, ~32 GB RAM, 20 logical CPUs |
| Node.js / npm | 26.13.1 / 11.20.0 |
| Docker | Desktop 29.9.2 (Linux containers, 16 GB assigned), Compose v5.6.1 |
| Kubernetes | `kubectl` client only; no cluster. Helm, kubeconform and OpenTofu were run from containers |
| Host restriction | Windows Application Control blocks unsigned native Node add-ons: vitest, `next dev` and Tailwind run in containers (ADR-0006) |

## Stage status

| Stage | Status | Notes |
| --- | --- | --- |
| 1 Foundation | Done, verified | Monorepo, shared packages, Compose profiles, PostgreSQL (database per service), Keycloak realm, NATS JetStream, gateway |
| 2 Core microservices | Done, verified | tenant, case, workflow, notification, audit |
| 3 Infrastructure operations | Done, verified | asset, device, telemetry, alert, incident; Mosquitto; sensor simulator |
| 4 Integrated business flows | Done, verified | Tests A and B |
| 5 Data and intelligence | Done, verified | data-pipeline (bronze/silver/gold), analytics, ai-gateway (deterministic and local-model modes) |
| 6 Resilience | Done, verified | Outbox/inbox, retries, dead-letter queue, breaker, bulkhead, rate limit; Tests D and G |
| 7 Disaster recovery | Done in the single-host lab | Backup, restore drill, failover drill, failback: all executed with reports. Not regional |
| 8 Kubernetes readiness | Artifacts written and schema-validated | Helm chart, CNPG, NATS, Keycloak, Argo CD, Velero, OpenTofu. **Never deployed** |
| 9 Verification | Done | Results below |
| 10 Finalization | Done | 24 documentation deliverables, README, CI workflow (**never executed**) |

## Services

Implemented (13): tenant, case, workflow, notification, audit, asset, device, telemetry, alert,
incident (NestJS); data-pipeline, analytics, ai-gateway (FastAPI). Plus `apps/gateway` and
`apps/web`.

Not started (7): document, maintenance, procurement, geospatial, video, integration, report.
They are described in `docs/architecture/service-map.md` and ordered in `docs/roadmap.md`.

## Verified results (final pass, 2026-11-13, from empty volumes)

| What | Command | Result |
| --- | --- | --- |
| Build of 4 packages, 10 services, gateway | `npm run build` | pass |
| Node unit tests | `npm run test:unit:docker` | 101 passed (10 files) |
| Python unit tests | image `--target unit-test` | pipeline 13 passed; ai-gateway 59 passed |
| Integration + security + contract | `npm run test:integration` | 123 passed, 0 failed, 0 skipped |
| Test E with a real local model | `npm run test:e` with `llama3.2:1b` | 22 passed |
| Browser tests | `npm run test:e2e` | 21 passed, including an automated WCAG A/AA scan of 9 pages |
| Restore drill | `npm run dr:restore-drill` | passed: 14 databases restored and verified in 13.8 s |
| Failover drill | `npm run dr:failover-drill -- --confirm-failover` | passed: RTO 47.8 s, RPO 0 s, 0 of 12 acknowledged writes lost |
| Failback | `npm run dr:failback -- --confirm-failback` | passed: planned outage 57.6 s, no data loss |
| Performance smoke | `node tests/performance/smoke.mjs` | reads p95 ≤ 16 ms; reading → incident p95 380 ms; 0 unexpected errors |
| Dependency audit | `npm audit --omit=dev` | 0 known vulnerabilities (root and web) |
| Kubernetes artifacts | helm lint, kubeconform -strict, tofu validate | valid (80 + 12 resources); not deployed |
| Observability | Prometheus / Grafana / Loki queried | 16 targets up, 7 alert rules, dashboard, logs of 18 services |

The integration suite needed three full runs to reach a clean result; each failure was a
test-timing or test-data assumption, recorded in the verification report.

## Defects found and fixed

Listed in `docs/testing/verification-report.md` ("Defects found by verification and fixed"),
12 entries. The most instructive:

1. Service `/metrics` and `/health` were reachable through the gateway by any signed-in user.
2. DNS lookup starvation in the gateway when a service is stopped (`UV_THREADPOOL_SIZE=32`).
3. The AI workspace page crashed in the browser (an effect returned a promise).
4. The web start script truncated the map tile address; the base map never loaded. The address
   is now the `MAP_TILE_URL` setting (`none` disables external tile requests).
5. Tests asserting immediately on state that follows an event: use the waiting helpers.

## Current local state (for whoever continues)

- Containers running: `core`, `iot`, `analytics`, `ai`, `observability`, `dr-lab`
  (`postgres` is primary, `postgres-dr` is a streaming standby). Ollama is stopped; its models
  (`llama3.2:1b`, `nomic-embed-text`) are kept in the `titan_ollama-data` volume.
- `.env` equals `.env.example` (AI in deterministic mode: `OLLAMA_BASE_URL` points at a host
  Ollama that is not installed).
- Git: repository initialised on `main`, **nothing committed**.
- `infrastructure/disaster-recovery/backups/` (git-ignored) and `reports/` contain artefacts of
  two drill passes: `*T0711*`–`*T0714*` from the first pass, `*T0736*`–`*T0738*` from the final
  pass that the documents cite. The first-pass files can be deleted.
- An empty file `ote` in the repository root existed before this work and was left untouched.

## Open items

Not done, in priority order (details in `docs/risk-register.md` and `docs/roadmap.md`):

1. Commit to version control; run the CI workflow for the first time.
2. Deploy the Helm chart and platform manifests to a staging cluster; fix what that finds.
3. Secrets per role, TLS, production realm without the password-grant client, MFA enforcement,
   NATS authentication, per-device MQTT credentials.
4. Physical backups with WAL to object storage; point-in-time recovery drill; two-cluster
   failover rehearsal with real fencing.
5. OTLP span export; Alertmanager; PostgreSQL and NATS exporters.
6. Automated test for the SLA escalation sweep.
7. Make the map tile address a Helm value (it is fixed in the chart's ConfigMap template).
8. The seven remaining services, starting with document-service.
