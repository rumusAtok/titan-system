# Testing and verification report

Everything in this report was executed on the development workstation on 2026-11-12 and
2026-11-13. Where something was not executed, it says so. Results describe a single-host
laboratory with synthetic data; they are not evidence of production behaviour.

## Environment

| Item | Value |
| --- | --- |
| Host | Windows 11 Pro, 20 logical CPUs, 32 GB RAM; Docker Desktop 29.9 (16 GB assigned), Compose v5 |
| Runtimes | Node.js 26.13 on the host; Node and Python 3 inside the service images |
| Stack under test | `docker compose` profiles `core iot analytics ai` (plus `observability`, `dr-lab` where stated), demo data loaded with `npm run seed` |
| Starting point | The final pass started from deleted data volumes and a fresh `.env` copied from `.env.example`; bring-up to healthy and seeded took about 90 s with images already built |

## Summary

| Check | Command | Result |
| --- | --- | --- |
| Build and type-check: 4 packages, 10 Node services, gateway | `npm run build` | pass |
| Web application build (type-check, static export) | image build of `apps/web` | pass |
| Node unit tests | `npm run test:unit:docker` | 101 passed, 0 failed (10 files) |
| Python unit tests, data-pipeline-service | image build `--target unit-test` | 13 passed |
| Python unit tests, ai-gateway-service | image build `--target unit-test` | 59 passed |
| Integration, security and contract tests | `npm run test:integration` | 123 passed, 0 failed, 0 skipped (third full run; see the run history) |
| Browser tests | `npm run test:e2e` | 21 passed, 0 failed (re-run after the map change) |
| Restore drill | `npm run dr:restore-drill` | passed |
| Failover drill | `npm run dr:failover-drill -- --confirm-failover` | passed |
| Failback | `npm run dr:failback -- --confirm-failback` | passed |
| Performance smoke | `node tests/performance/smoke.mjs` | completed, 0 unexpected errors |
| Dependency audit | `npm audit --omit=dev` (root workspace and `apps/web`) | 0 known vulnerabilities on 2026-11-13 |
| Helm chart | `helm lint`, `helm template` + `kubeconform -strict` | 0 lint failures; 80 resources valid (82 with ExternalSecrets and ServiceMonitor enabled) |
| Platform, DR and Argo CD manifests | `kubeconform -strict` with the operator CRD schemas | 12 resources valid |
| OpenTofu module | `tofu fmt -check`, `tofu validate` | valid |
| Observability profile | Prometheus, Grafana and Loki queried | 16 targets up, 0 down; 7 alert rules loaded; dashboard provisioned; logs of 18 services queryable |

analytics-service has no unit tests of its own; it is covered by 17 integration tests.

## The mandatory tests

| Test | What it proves | Where | Tests | Result |
| --- | --- | --- | --- | --- |
| A | Government approval end to end: submit, four stages, unauthorised decisions denied, notifications only after the decision, audit trail, return and resubmission, rejection, cancellation, parallel stage, conditional routing, delegation | `tests/integration/government-approval.test.ts` | 16 | pass |
| B | IoT incident end to end: MQTT reading stored, threshold alarm, exactly one incident despite repeated readings, response workflow, authorised acknowledgment, resolution and closure; quality flags, rejected payloads, unknown devices, offline detection | `tests/integration/iot-incident.test.ts` | 14 | pass |
| C | Tenant isolation through the API and directly against PostgreSQL as each runtime role (row-level security, cross-database access, partitions) | `tests/security/tenant-isolation.test.ts` | 17 | pass |
| D | Event recovery: a consumer interrupted while events are published, a business duplicate under a new event id, a malformed event moved to the dead-letter queue, the broker stopped while writes continue and buffered events published afterwards | `tests/integration/event-recovery.test.ts` | 7 | pass |
| E | AI safety: no cross-tenant or unauthorised data, no fabricated answers, injection attempts, proposals need human approval, platform works with AI off | `tests/integration/ai-safety.test.ts` | 22 | pass in deterministic mode and with a local model (`llama3.2:1b`) |
| F | Disaster recovery: backup and verified restore; failover with fencing and operator confirmation; failback | `scripts/dr/*.mjs` | 3 drills | pass (figures below) |
| G | Service failure: with notification and audit services stopped the platform reports degraded (not critical), a complete approval still runs, other operations are unaffected and calls to the stopped services fail fast, and their records appear after restart | `tests/integration/service-failure.test.ts` | 4 | pass |
| H | Interface in a real browser: sign-in, role-based navigation, each area's main flow, error and unauthorised states, accessibility scan | `tests/e2e/specs/interface.spec.ts` | 21 | pass |

Also in the suite: authorization tests (21: unauthenticated access, privilege escalation,
duplicate and concurrent decisions, invalid state transitions, input handling), analytics and
pipeline tests (17: KPIs recalculated from stored data, isolation, exports and query templates,
idempotent re-runs), and event and API contract tests (5).

The circuit breaker and the calculation of SLA due dates are covered by unit tests. The
periodic SLA sweep that escalates overdue tasks has **no automated test**.

All integration, security, contract and browser tests run against the real containers: real
PostgreSQL, NATS, Keycloak tokens, MQTT and browser. None of them uses mocks.

### History of full-suite runs

Recorded as they happened, including the failures.

| Run | Result | What failed and why |
| --- | --- | --- |
| 1 (fresh stack) | 121 of 123 passed | Two test assumptions that only hold on a stack with history: the contract test expected business events to exist already; the trend cross-check expected a completed five-minute bucket. Fixed in the tests (the contract test now creates its own activity; the trend check uses the pipeline's `computed_at` and skips with an explanation on a too-young stack). Re-run of both files: 5 of 5 and 17 of 17, none skipped |
| 2 | 122 of 123 passed | One Test A assertion read a case's status immediately, although that status follows a workflow event asynchronously. The file runs directly after Test D, which stops the broker, and case-service was still catching up. The service behaved as designed; the test now waits (bounded) like the other tests |
| 3 | 123 of 123 passed, 0 skipped (116 s) | — |

## Disaster recovery results

Reports: `infrastructure/disaster-recovery/reports/` (`.md` and `.json` per drill). Both
databases are containers on one machine, so these figures show that the procedure works and
what the software does during it. They are not regional recovery times.

| Drill | Report | Observed |
| --- | --- | --- |
| Backup and restore | `backup-restore-20261113T073624Z` | 14 databases, 1.1 MB, backed up in 18.5 s; restored into an isolated empty instance and verified in 13.8 s; recovery point 18.5 s before the simulated disaster; the one transaction written after the backup was lost, as expected for backup-only recovery |
| Failover | `failover-20261113T073716Z` | Primary killed and fenced; standby promoted after confirmation (timeline 2); 17 services re-pointed; RTO 47.8 s; RPO 0 s; 0 of 12 acknowledged writes lost; no duplicate records after event replay; a new application approved end to end on the recovery database |
| Failback | `failback-20261113T073812Z` | Planned outage 57.6 s; no data loss; original primary restored as primary, recovery database streaming again |

An earlier pass on a larger data set (110 MB) gave: restore and verify 38.5 s, failover RTO
49.7 s, failback outage 79.6 s. The reports of that pass are in the same directory.

Limits of these drills: asynchronous replication on an idle machine makes "0 lost" unsurprising;
fencing is a stopped container; the confirmation was given by a script flag; DNS, detection time
and human decision time are not measured. Point-in-time recovery was not drilled.

## Performance smoke

`tests/performance/last-result.json`, run on an otherwise idle workstation. Not a load test.

| Measurement | Result |
| --- | --- |
| Five read endpoints through the gateway, 100 requests each at concurrency 5 | p50 8–10 ms, p95 13–16 ms, 0 errors |
| Overload: 400 requests from one user at once | 76 served, 248 rejected by the rate limit (429 with `Retry-After`), 76 shed by the bulkhead (503), 0 other statuses; another user was served normally meanwhile |
| MQTT publish → reading visible through the API (30 samples) | p50 46 ms, p95 54 ms |
| Threshold reading → open incident, across three services (5 samples) | p50 255 ms, p95 380 ms |

## Browser checks

21 Playwright tests in Chromium, covering role-based navigation, the main flow of each area,
the error, empty, unauthorised and degraded states, a phone-sized viewport and keyboard
operation. They include an automated accessibility scan (axe, WCAG 2 A and
AA rules) of nine pages with no critical or serious findings; the map canvas is excluded from
the scan. No manual assistive-technology testing was done.

## Defects found by verification and fixed

| # | Found by | Defect | Fix |
| --- | --- | --- | --- |
| 1 | Security test | Any signed-in user could read a service's `/metrics` and `/health` through the gateway | The gateway does not route those paths; test added |
| 2 | Test G | With a service stopped, slow DNS lookups exhausted Node's four lookup threads in the gateway and healthy services were briefly reported unreachable | Lookup pool raised to 32 in the service image; residual risk R7 |
| 3 | Seeded data review | The simulator's normal water level grew with the number of devices and produced about 210 spurious incidents | Baseline bounded per device |
| 4 | AI unit tests | Regular expressions in the injection screen were corrupted by a tool escaping error (word boundaries became backspace characters) | Repaired; 59 unit tests cover the screen |
| 5 | AI tests | A note's text was taken from the wrong position; procedural questions were routed to a data tool | Parsing and routing corrected |
| 6 | Browser test | The AI workspace crashed in the browser because an effect returned a promise | Fixed |
| 7 | Accessibility scan | Chart label overwritten by the chart library; invalid definition-list structure; scrollable regions not reachable by keyboard | Fixed |
| 8 | Browser test | The web server answered unknown paths with the home page and status 200 | Now 404 |
| 9 | Restore drill | The restore target ran out of memory on a memory-backed volume; the recovery point was measured from the end of the backup instead of its start | Disposable disk volume; measured from the start |
| 10 | Performance smoke | The first version of the smoke test mistook rate limiting and load shedding for errors | The test now measures both deliberately |
| 11 | Documentation review | The web container's start script truncated the map tile address (shell brace handling), so the background map never loaded; markers were drawn on the plain fallback | Script fixed; the address is now a documented setting that can also be switched off; verified in all three modes |
| 12 | Full-suite runs | Three test assumptions (see the run history) | Tests corrected; no assertion was removed or weakened to always pass |

## Not verified

- Any Kubernetes deployment: Helm chart, CloudNativePG, NATS, Keycloak operator, Argo CD,
  Velero, External Secrets, OpenTofu `apply`.
- The CI workflow (`.github/workflows/ci.yml`) has never run.
- Point-in-time recovery; recovery between two machines or regions; real fencing.
- Load, soak and capacity behaviour; behaviour with several replicas of any service.
- TLS, per-device MQTT credentials, NATS authentication, enforced MFA: none is configured.
- E-mail or any other external delivery: only the logging adapter exists.
- Distributed trace export.
- The SLA escalation sweep (overdue tasks) has no automated test.
- Larger models: only `llama3.2:1b` was used, on CPU.
- Manual accessibility testing; browsers other than Chromium; real phones (one test checks the
  layout at a phone-sized viewport in Chromium).
- Loading of background map tiles in the browser tests: they assert that the map and its
  records render, not that tiles arrive.
