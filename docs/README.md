# TITAN documentation

TITAN is a development release verified on a single workstation with synthetic data. Nothing in
these documents claims production readiness, certification or measured high availability.

Each document separates two things:

- **Implemented** — exists in this repository and was executed; evidence is in the
  [verification report](testing/verification-report.md).
- **Planned** — designed and, where possible, schema-validated, but not deployed or tested.

| # | Deliverable | Document |
| --- | --- | --- |
| 1 | System overview | [architecture/system-overview.md](architecture/system-overview.md) |
| 2 | C4 architecture diagrams | [architecture/c4-diagrams.md](architecture/c4-diagrams.md) |
| 3 | Microservices dependency map | [architecture/service-map.md](architecture/service-map.md#dependency-map) |
| 4 | Service responsibility matrix | [architecture/service-map.md](architecture/service-map.md#responsibility-matrix) |
| 5 | Database ownership matrix | [database/README.md](database/README.md#ownership-matrix) |
| 6 | ERDs | [database/README.md](database/README.md#entity-relationship-diagrams) |
| 7 | API specifications | [api/README.md](api/README.md) (generated from the running services) |
| 8 | Event catalog | [architecture/event-catalog.md](architecture/event-catalog.md) |
| 9 | Security architecture | [security/security-architecture.md](security/security-architecture.md) |
| 10 | Identity and authorization design | [security/identity-and-authorization.md](security/identity-and-authorization.md) |
| 11 | Data engineering architecture | [architecture/data-engineering.md](architecture/data-engineering.md) |
| 12 | AI architecture | [architecture/ai-architecture.md](architecture/ai-architecture.md) |
| 13 | IoT architecture | [architecture/iot-architecture.md](architecture/iot-architecture.md) |
| 14 | Deployment guide | [deployment/deployment-guide.md](deployment/deployment-guide.md) |
| 15 | High availability design | [architecture/high-availability.md](architecture/high-availability.md) |
| 16 | Disaster recovery architecture | [disaster-recovery/dr-architecture.md](disaster-recovery/dr-architecture.md) |
| 17 | Backup and restoration runbook | [runbooks/backup-and-restore.md](runbooks/backup-and-restore.md) |
| 18 | Failover and failback runbook | [runbooks/failover-and-failback.md](runbooks/failover-and-failback.md) |
| 19 | Monitoring and alerting guide | [runbooks/monitoring-and-alerting.md](runbooks/monitoring-and-alerting.md) |
| 20 | Developer setup guide | [deployment/developer-setup.md](deployment/developer-setup.md) |
| 21 | Testing and verification report | [testing/verification-report.md](testing/verification-report.md) |
| 22 | Architecture decision records | [adr/](adr/README.md) |
| 23 | Known limitations and risk register | [risk-register.md](risk-register.md) |
| 24 | Future development roadmap | [roadmap.md](roadmap.md) |

Generated evidence (not hand-written): OpenAPI documents in `api/`, recovery drill reports in
`../infrastructure/disaster-recovery/reports/`, performance smoke results in
`../tests/performance/last-result.json`.
