# Future development roadmap

Ordered by what reduces the most risk first. Items marked *(done 2026-11-18)* were implemented and verified locally (see the verification report); everything else is not implemented; the
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
| Physical backups with WAL to object storage, and a point-in-time recovery drill [R5] | *PITR drill done 2026-11-18 on one host.* Remaining: WAL and base backups in off-site object storage |
| Backup age and replication lag alerts; PostgreSQL and NATS exporters | The gaps listed in the monitoring guide are closed |
| Two-cluster recovery rehearsal [R4] | Failover and failback in a real staging pair, with fencing that does not rely on the failed site, DNS switch and measured RTO and RPO |
| Synchronous replication decision per service [R2] | Documented choice, tested |
| Dead-letter replay tool [R8] | Replay with approval and audit |

## 3. Observability

| Item | Outcome |
| --- | --- |
| OTLP span export and a trace backend | Traces across HTTP and events, linked from logs |
| Alertmanager with routes and on-call ownership | *Alertmanager and routes done 2026-11-18 (local receiver).* Remaining: real on-call receivers and ownership |
| Service-level objectives for the two core flows | Error budgets instead of raw thresholds |

## 4. The remaining services

Minimum slices of all of these now exist (ADR-0015). What would make each useful beyond the slice:

| Service | First useful slice |
| --- | --- |
| document-service (slice done) | *ClamAV hook and full-text search done 2026-11-18.* Remaining: object storage instead of database blobs; PDF text and OCR; case attachments moved here; retention periods set by the records policy |
| report-service (slice done) | *PDF and Excel output done 2026-11-18.* Remaining: unattended scheduled runs under an explicitly delegated, audited identity |
| maintenance-service | *Preventive plans, inspection plans and rounds, parts used and labour cost done 2026-11-18.* Remaining: plans from pack templates, parts reservation before the work starts, a planning calendar |
| geospatial-service (slice done) | *Backfill, zones on the GIS map and a digital twin of the asset hierarchy done 2026-11-18.* Remaining: PostGIS and spatial indexes; geometry and 3D models of real assets |
| integration-service (slice done) | *E-mail over SMTP to a local catcher done 2026-11-18.* Remaining: adapters for specific external systems (open data, CMMS, BMS); a real mail relay, which needs authorisation; key management for webhook secrets [S16] |
| procurement-service (slice done) | *Quotations and award, budgets and cost centres, parts booked for work orders done 2026-11-18.* Remaining: supplier portal or EDI, reservation before work starts |
| video-service (slice done) | *In-browser HLS playback against a local test stream done 2026-11-18.* Remaining: a real VMS with short-lived stream URLs and clip export [S18]; no analytics until privacy rules are agreed |

## 4b. Industry platform (after v3)

| Item | Outcome |
| --- | --- |
| Pack authoring and review | Packs proposed as data, reviewed and signed before entering the catalogue; still no code |
| Role provisioning and site-scoped authorization [P11] | Packs create Keycloak roles; permissions limited to plants, buildings or lines |
| Event-fed entitlements in the Python services [S13] | Same freshness as the Node services |
| Per-service installation status in the pack view [R13] | An administrator sees when every owner has installed a pack |
| More packs on the same capabilities | Utilities, healthcare facilities, logistics yards, education campuses: configuration, plus a new service only where behaviour demands it (inventory, procurement, inspection planning) |

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
