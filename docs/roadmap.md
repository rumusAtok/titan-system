# Future development roadmap

Ordered by what reduces the most risk first. Nothing here is implemented; the
[risk register](risk-register.md) explains why each item matters (references in brackets).

## 1. Make the existing release trustworthy outside one workstation

| Item | Outcome |
| --- | --- |
| Commit to version control and run the CI workflow [P9, S11] | Build, unit tests and manifest validation run on every change; add the integration suite on a runner with Docker, plus dependency and image scanning |
| Deploy to a staging Kubernetes cluster [P7] | The Helm chart, CloudNativePG cluster, NATS and Keycloak actually run; fix what the first deployment finds; run the integration suite against it |
| Secrets and TLS [S1, S3] | Per-role secrets from a secret manager; TLS at the ingress and to PostgreSQL, NATS and MQTT |
| Production realm [S2] | Realm without the password-grant client and demo users; MFA required for administrative and approval roles |
| Broker hardening [S4, S5, R3] | NATS accounts and subject permissions, three nodes, stream replicas of 3; per-device MQTT credentials with topic ACLs |

## 2. Recovery that is real

| Item | Outcome |
| --- | --- |
| Physical backups with WAL to object storage, and a point-in-time recovery drill [R5] | Restore to a chosen minute, measured |
| Backup age and replication lag alerts; PostgreSQL and NATS exporters | The gaps listed in the monitoring guide are closed |
| Two-cluster recovery rehearsal [R4] | Failover and failback in a real staging pair, with fencing that does not rely on the failed site, DNS switch and measured RTO and RPO |
| Synchronous replication decision per service [R2] | Documented choice, tested |
| Dead-letter replay tool [R8] | Replay with approval and audit |

## 3. Observability

| Item | Outcome |
| --- | --- |
| OTLP span export and a trace backend | Traces across HTTP and events, linked from logs |
| Alertmanager with routes and on-call ownership | Alerts reach people |
| Service-level objectives for the two core flows | Error budgets instead of raw thresholds |

## 4. The remaining services

In suggested order; each follows the same pattern (own database, RLS, outbox, role checks, tests).

| Service | First useful slice |
| --- | --- |
| document-service | Attachments on cases and incidents in object storage, virus-scan hook, retention classes |
| report-service | Scheduled PDF and spreadsheet reports from the analytical read models |
| maintenance-service | Work orders raised from alarms and inspections, linked to assets |
| geospatial-service | Spatial queries (PostGIS), catchments and zones, a configurable base map |
| integration-service | Inbound and outbound adapters with an anti-corruption layer; the real e-mail adapter belongs here and needs authorisation before it sends anything |
| procurement-service | Requisition to award on the workflow engine |
| video-service | Camera registry and event markers; no analytics until privacy rules are agreed |

## 5. Product depth

| Item | Outcome |
| --- | --- |
| Workflow designer in the administration area | Definitions edited and versioned in the interface instead of through the API |
| Localisation and manual accessibility testing [P4, P5] | Interface in the operating language; tested with assistive technology |
| Telemetry archiving [R10] | Old partitions exported to the lake before they are dropped |
| Self-hosted map tiles [S12] | No viewer request leaves the organisation's network |
| Data pipeline orchestration and backfill [R12] | Scheduled, retried, replayable runs; data-quality checks with alerts |
| Load and soak tests [P1] | Capacity figures for the gateway, ingestion and the workflow engine |
| Shared rate-limit store [S8] | Correct limits with several gateway instances |
| Tamper-evident audit [S10] | Hash chain or write-once export |

## 6. AI, only after evaluation

| Item | Outcome |
| --- | --- |
| Evaluation set of real questions with expected evidence [P3] | A measured basis for choosing a model |
| Multi-step tool use with the same safeguards | Questions that need two sources |
| Document retrieval over approved procedures | Grounded answers with citations, once document-service exists |

AI stays optional, read-only by default and subordinate to human approval at every step.

## Not planned

Autonomous control of physical equipment. Automatic cross-site failover without proven fencing
and quorum.
