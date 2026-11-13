# Known limitations and risk register

TITAN is a development release verified on one workstation with synthetic data. This document
lists what is not done, what is weaker than it should be for real use, and what was never tested.
It is meant to be read before anyone plans a deployment.

## What this release is not

- Not production-ready, not certified, not assessed against any legal or regulatory standard.
- Not highly available: every component runs as one container on one machine.
- Not geographically recoverable: the recovery lab runs both databases on the same host.
- Not load-tested: the performance figures are a smoke test on an idle workstation.
- Not deployed to Kubernetes: the chart and manifests are schema-validated only.
- Not connected to any real identity provider, e-mail system, device or government data source.

## Not implemented

| Item | State |
| --- | --- |
| document, maintenance, procurement, geospatial, video, integration and report services | Designed in the service map; no code |
| Kubernetes deployment, Argo CD synchronisation, CloudNativePG, Velero, External Secrets | Manifests supplied and validated; never applied to a cluster |
| CI pipeline (`.github/workflows/ci.yml`) | Written; never executed |
| Point-in-time recovery | WAL is archived by the primary; restoring to a chosen moment was not drilled |
| Distributed trace export | Trace ids are generated, propagated and logged; no spans are exported, no trace UI |
| E-mail, SMS or push delivery | Notifications are stored and shown in the application only; the e-mail channel is a logging stub and says so |
| Document management | Case attachments are small files stored inside the case database; there is no object storage, malware scanning, versioning or retention handling |
| Alert routing to people | Prometheus evaluates rules; no Alertmanager |
| Own map base layer | The GIS view loads its background from the public OpenStreetMap tile server (see S12); there is no self-hosted or licensed tile source, and no spatial queries |
| Multi-factor authentication | Available in Keycloak; not enforced by the realm |

## Risks

Likelihood and impact are for a deployment that used this release unchanged. L = low,
M = medium, H = high.

### Security

| # | Risk | L | I | Current mitigation | What a real deployment needs |
| --- | --- | --- | --- | --- | --- |
| S1 | Development secrets: every database role password derives from one value in `.env`; Keycloak and Grafana use lab admin passwords | H | H | `.env` is git-ignored; ports bound to 127.0.0.1 | Independent secrets per role from a secret manager; rotation |
| S2 | `titan-cli` client allows the password grant, and demo users share one password | H | H | Documented as test-only; used by seed and tests | Generate the realm without `titan-cli` and without demo users |
| S3 | No TLS anywhere in the lab (HTTP, PostgreSQL, NATS, MQTT) | H | H | Loopback only | TLS at the edge and between components; the chart assumes an ingress with certificates |
| S4 | MQTT uses one shared service account; a compromised device could publish as another device of any tenant | M | H | Topic carries tenant and device; telemetry-service checks the device exists for that tenant and is not retired | Per-device credentials or client certificates with topic ACLs |
| S5 | NATS has no authentication or per-service permissions | M | H | Not published beyond the compose network and loopback | Accounts and subject permissions per service |
| S6 | The web Content-Security-Policy allows `'unsafe-inline'` scripts (needed by the static export) | M | M | No user-supplied HTML is rendered; React escapes text | Hashes or nonces generated at build time |
| S7 | Tenant isolation depends on services always taking the tenant from the token | L | H | Row-level security as a second layer; 17 isolation tests including direct database attacks | Keep the tests in CI; review every new query path |
| S8 | Rate limiting is in memory per gateway instance | M | M | Works for one instance | Shared store when the gateway is scaled out |
| S9 | Prompt-injection screening is pattern-based and can be evaded | M | M | Safety does not depend on it: tools are read-only, run with the user's token, and writes need human approval | Keep that structure; treat the screen as defence in depth only |
| S10 | Audit records are append-only inside the database, not tamper-evident against a database administrator | L | M | The runtime role has no UPDATE, DELETE or TRUNCATE privilege, and triggers reject those statements | Hash chaining or export to write-once storage |
| S11 | No dependency or image scanning has been run in CI | M | M | `npm audit --omit=dev` reported 0 vulnerabilities on 2026-11-13 | Run the CI workflow; add image scanning |
| S12 | The GIS page makes each viewer's browser request map tiles from `tile.openstreetmap.org`: that third party sees the viewer's IP address and the area being looked at (no platform records are sent). The public server's usage policy also does not allow heavy or operational use | H | M | One setting (`MAP_TILE_URL` in `.env`) points it at another tile service or, with `none`, switches the background off so that nothing is requested from outside; the Content-Security-Policy allows only the configured origin. In the Helm chart the address is still fixed in the ConfigMap template | A self-hosted or contracted tile service inside the organisation's network |

### Reliability and data

| # | Risk | L | I | Current mitigation | What a real deployment needs |
| --- | --- | --- | --- | --- | --- |
| R1 | Single PostgreSQL instance holds every service database | H | H | Streaming standby and backups in the lab | Operator-managed clusters with synchronous replicas; possibly separate instances for busy services |
| R2 | Asynchronous replication can lose acknowledged transactions on failover | M | H | The failover drill measures and reports the loss (0 of 12 in the last run, which proves little) | Decide per service whether synchronous commit is required |
| R3 | Single NATS node with one stream replica: losing its volume loses undelivered events | M | H | Outbox rows remain until published, so producers re-send after a restart; an already-published, unconsumed event would be lost | Three-node JetStream, replicas of 3 |
| R4 | Fencing in the lab is "stop a container" | H | H | The runbook says not to promote if the old primary cannot be fenced | A fencing method that does not depend on the failed site |
| R5 | Backups are logical dumps taken by a script, stored on the same machine | H | H | Restore drill verifies each backup it takes | Scheduled physical backups with WAL to off-site object storage; alert on backup age |
| R6 | Failback re-clones both nodes with `pg_basebackup` | M | M | Fine at lab size (about 1 MB) | `pg_rewind` or operator-managed switchover for real sizes |
| R7 | The gateway resolves service names per request; slow DNS for stopped services once starved the lookup pool | L | M | Thread pool raised to 32; found and covered by the service-failure test | Kubernetes Services have stable addresses; keep the test |
| R8 | Dead-lettered events need manual replay | M | M | Dead-letter table, stream, metric and alert rule exist | A replay tool with an approval step |
| R9 | The analytical lake is a local volume shared by two containers | M | M | Mounted read-only into analytics | Object storage with versioning |
| R10 | Telemetry older than the retention window is dropped by partition, without being archived first; the maintenance job runs inside telemetry-service once a day | M | M | Monthly partitions; a default partition catches out-of-range timestamps | Agree the retention period; export partitions to the lake before dropping; alert if maintenance fails |
| R11 | Incidents cannot be acknowledged while workflow-service is down (ADR-0005) | L | M | Incidents are still created, visible and notified | Run workflow-service with replicas |
| R12 | The data pipeline runs on a timer inside one container; no orchestrator, no backfill tooling | M | L | Runs are idempotent and recorded; watermark is stored | A scheduler with retries and backfill |

### Product and process

| # | Risk | L | I | Current mitigation | What a real deployment needs |
| --- | --- | --- | --- | --- | --- |
| P1 | Local test results are mistaken for readiness | M | H | Every document states the scope of verification | Staging environment, load tests, security assessment |
| P2 | All data is synthetic; flood thresholds and sensor behaviour are invented | H | M | Labelled as synthetic in the simulator, seed and documentation | Calibration with the owning authority's real data |
| P3 | The small local model gives weak answers; only two model sizes were ever tried | H | L | AI is optional and labelled; deterministic mode is the default | Evaluate models on real questions before enabling |
| P4 | Accessibility was checked automatically on nine pages only | M | M | No critical or serious WCAG A/AA findings from the automated scan | Manual testing with assistive technology |
| P5 | The interface is English only | H | M | — | Localisation |
| P6 | TypeScript is pinned to 6.0.x because of one dependency (ADR-0003) | M | L | Recorded | Lift the pin when the dependency allows |
| P7 | Kubernetes artifacts have never run; a first deployment will find errors | H | M | Lint and strict schema validation pass | A staging cluster |
| P8 | Unit tests cannot run natively on the development machine (Application Control) | H | L | They run in the service image; same command in CI | — |
| P9 | Nothing is committed to version control yet | H | M | The working tree is complete on disk | Commit and push to a protected remote |

## No safety-critical control

The platform observes and records. It contains no code that commands pumps, gates, sirens or
any other physical equipment, and none should be added without a separate safety case.

## Legal and compliance

No claim of compliance with any data-protection, records-management, accessibility or security
standard is made. Requirements such as data residency, retention periods, lawful basis for
processing and procurement rules have not been assessed.
