# Testing and verification report

Everything in this report was executed on the development workstation: v2 on 2026-11-12 and
2026-11-13, v3 on 2026-11-16 and 2026-11-17. Where something was not executed, it says so.
Results describe a single-host laboratory with synthetic data; they are not evidence of
production behaviour.

## Second round: planning, sourcing, e-mail, video, twin, search, alerting, PITR, load (2026-11-18)

Meridian's packs were restored to the seeded state first, at the user's request: manufacturing
re-activated and public-services deactivated. Nothing was deleted.

| Check | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | pass |
| Node unit tests | `npm run test:unit:docker` | 197 passed (21 files). New: planning rules, sourcing and budget rules, SMTP client against a local test server, clamd INSTREAM client against a fake daemon, PDF and XLSX encoders. One expectation of mine was wrong (a date off by one day) and was corrected; the code was right |
| Python unit tests | data-pipeline image `--target unit-test` | 18 passed (after the pipeline changes below) |
| Planning and sourcing end to end | `tests/integration/planning-sourcing.test.ts` | 9 passed. The first run found a real defect, described below |
| Full-text search, geospatial backfill, report PDF and Excel, camera update, test stream | `tests/integration/features-round2.test.ts` | 5 passed. The first run found lost SQL placeholders, described below |
| E-mail to the local catcher | Test A (`government-approval.test.ts`) | 16 passed; the approval e-mail arrived in Mailpit (checked through the Mailpit API) |
| Full integration + security + contract | `npm run test:integration` | Last full run: 346 tests, **343 passed**, 3 failed, 0 cancelled. The 3 were then fixed and their files re-run: facilities 16/16 three times in a row; industry-packs + analytics 50/50 |
| Browser tests | `npm run test:e2e` | **33 passed** (full suite). An earlier run failed 1 test: during login the gateway's circuit breaker for analytics was briefly open after heavy test runs, and the test allows no 5xx at all. It passed when re-run on a settled stack; the strict check was kept |
| Point-in-time recovery | `npm run dr:pitr-drill` | **passed** (report `pitr-20261118T071239Z`): 6.1 GB base backup in 55.6 s; the recovery instance reached the target in 7.2 s and stopped before the first commit after it; T1 present, T2 absent. The first run failed because recovery refuses `max_connections` lower than the primary's (300); the drill was corrected |
| Alert routing | synthetic alert posted to Alertmanager | delivered to the local receiver (`webhook-sink`) after the 10 s critical group wait; Prometheus lists Alertmanager as active |
| Live video | `curl` and the browser test | the local test server serves HLS playlists for both synthetic streams; the camera page player fetches the playlist. Chromium in the test container cannot decode H.264, so actual frame playback was checked only by the playlist request, not by pixels |
| Load test | `node tests/performance/load.mjs` | Gateway per-user limit raised to 100000/min for the run only, then restored to 600. Served 451 / 601 / 730 req/s at 10 / 25 / 50 virtual users; p95 35 / 64 / 96 ms; p99 51 / 80 / 114 ms; 0 server errors. With the normal limit, 16 demo users are capped at about 160 req/s (most requests answered 429), as designed. One workstation, synthetic data: **not** a capacity statement |
| Helm chart | `helm lint`, `kubeconform -strict` | 0 failures; 115 resources valid |
| OpenAPI | `npm run openapi:export` | 20 services; maintenance gained planning and settings operations and the parts field; procurement gained sourcing |

**Defects found in this round and fixed**

1. *Two event consumers under one durable name* (procurement-service). Both shared one JetStream
   consumer, so each handler received, and acknowledged, part of the other's events: purchase
   approvals and parts bookings were silently lost. The registrations were merged, and
   `EventConsumers.register` now refuses a second registration under the same name.
2. *Lost `$` in SQL placeholders* (document-service search, written by an edit script). One of
   them would have turned the list's row limit into a literal row count. Fixed, and the code was
   scanned for the same pattern.
3. *Work order history order.* Entries written in one transaction shared `now()` and were ordered
   by a random id. Migration `0003_event_order.sql` makes the default `clock_timestamp()`.
4. *Pipeline memory.* With about 1.9 million bronze events, runs exhausted the 768 MiB limit and the
   container restarted 16 times, leaving 17 runs recorded as "running". The batch size is now
   configurable (lab: 50 000; peak memory then 189 MiB), the limit was raised to 1536 MiB, and runs
   interrupted by a restart are recorded as failed at start-up.
5. *Fragile test.* The duplicate-publish check counted every message on the shared stream, and
   other traffic arrived in the same window. It now counts the test's own subject.
6. *PITR settings.* See the PITR row above.

**Not done in this round, and why**

- Kubernetes deployment, CI execution, high availability, geographic recovery: no cluster or
  second site is available, and claiming any of them from one laptop would be false.
- Real mail relay, SMS, push, supplier connections, video management system: these need an outside
  system and your authorisation. Local stand-ins are in place (ADR-0016).
- ClamAV: the integration and the fail-closed path are unit-tested against a fake daemon. The real
  daemon (profile `scan`) was not started here, because it downloads signatures from the internet.
- Role provisioning from packs, per-site permissions, pack upload, enforced MFA: these are
  security-model decisions, not features to add quietly. Enforced MFA would also break the
  password-grant automation the tests use.
- PostGIS, OCR and PDF text extraction, a trace backend, unattended report runs, event-fed
  entitlements in the Python services (S13).

## Six further modules (document, geospatial, procurement, report, integration, video), 2026-11-18

The running v3 stack was extended in place (new databases created by `postgres-ensure`, realm
users added with `identity-sync.mjs`, seed re-run), not rebuilt from empty volumes.

| Check | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | pass |
| Node unit tests | `npm run test:unit:docker` | 179 passed (19 files; new: rules of the six services, webhook relay and download headers in the gateway) |
| Web build (type-check, static export) | `docker compose build web` | pass, 27 pages |
| Procurement end to end | `node --test tests/integration/procurement.test.ts` | 12 passed (second run; the first found a real defect, below) |
| Documents and zones | `tests/integration/documents-geo.test.ts` | 11 passed (second run; first run: test used a role that may not report incidents) |
| Integrations, reports, video | `tests/integration/integrations-reports-video.test.ts` | 16 passed (first run). Outbound webhooks went to the local `webhook-sink` container only; signatures verified by the test with the subscription secret |
| Database isolation of the six new databases | `tests/security/modules-isolation.test.ts` | 15 passed: RLS on every tenant table, no BYPASSRLS, cross-tenant read / update / delete / insert refused, append-only trails refuse UPDATE and DELETE |
| Full integration + security + contract | `npm run test:integration` | 322 tests: **300 passed, 7 failed, 15 cancelled** (242 s). See below |
| Browser tests | `npm run test:e2e` | 31 tests: 28 passed, 3 failed. New `modules.spec.ts` 5 of 5 passed (incl. WCAG 2 A/AA scan of the 6 new pages, after fixing one `dt` outside `dl`). Failures below |
| Restore drill (21 databases) | `npm run dr:restore-drill` | **passed**: 335.1 MB backed up in 151.9 s; restored and verified in 172 s; 21 archive checksums match; 47 key tables (incl. the new modules') within the recorded bounds; industry configuration with 8 packs restored (report `backup-restore-20261118T022015Z`) |
| Helm chart | `helm lint`, `kubeconform -strict` | 0 failures; 115 resources valid |
| Seed idempotency | `node scripts/seed.mjs` twice | first run 55 records, second run 0 |
| OpenAPI | `npm run openapi:export` | 20 services; the only change to an existing document is the new `document` subject type in workflow-service |

**Failures of the full suites, and why.** Between the v3 verification and this stage, the
Meridian tenant's packs were changed by someone signed in as `maya.admin` (pack history:
2026-11-17 08:54 manufacturing deactivated, 08:55 public-services activated). Neither the seed nor
any test makes that change. Every test that needs Meridian's manufacturing pack therefore fails or
is cancelled: `manufacturing.test.ts` (3 suites, 15 cancelled), 4 assertions in
`industry-packs.test.ts`, 2 in `ai-industry.test.ts`, and 2 browser tests of the industry
workspace. These were **not** re-run after the tenant state is resolved, so they are not counted as
passing. Two failures were caused by this stage and fixed: `pack-isolation.test.ts` asserted that
Riverbend had only case and incident processes (now documents and purchase requests use the
engine too; fixed and re-run, 16 passed), and the browser navigation test listed the old menu
(staff now also see Documents, Zones and map and Reports; fixed and re-run, passed).

**Defect found by the new tests.** Every stock decrease failed with `stock_levels_on_hand_check`:
PostgreSQL evaluates the CHECK constraint on the proposed `INSERT` row before `ON CONFLICT DO
UPDATE` applies, so an upsert of a negative quantity can never succeed. Decreases now update the
existing level only (`procurement.service.ts`, `move`).

**Not verified in this stage.** Failover and failback drills; Python unit tests (no Python code
changed); real e-mail, supplier, VMS or third-party delivery (deliberately none, ADR-0015); a
virus scanner (the upload check is a signature and EICAR hook only); behaviour under load.

## TITAN v3 (multi-industry), 2026-11-17

The v2 stack and its data were upgraded in place (migrations `0002_*`, the backfill of packs for
existing tenants, `identity-sync.mjs`, seed), not rebuilt from empty volumes.

| Check | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | pass |
| Node unit tests | `npm run test:unit:docker` | 128 passed (13 files) |
| Python unit tests | image `--target unit-test` | data-pipeline 18, analytics 8, ai-gateway 70 passed |
| Web build (type-check, static export) | `docker compose build web` | pass |
| Integration + security + contract | `npm run test:integration` | 243 passed, 0 failed, 0 skipped (fourth run, includes `ai-industry.test.ts`; history below) |
| AI and analytics industry isolation | `tests/integration/ai-industry.test.ts` | 8 passed (part of the 243) |
| Browser tests | `npm run test:e2e` | 26 passed (second run; the first run had 2 failures, both test-side: a capitalisation in an expectation and a menu read without waiting). Includes an automated WCAG 2 A/AA scan and a phone-width overflow check of 8 new pages |
| Restore drill incl. industry configuration | `npm run dr:restore-drill` | passed: 15 databases (236 MB) backed up in 102 s, restored and verified in 85.8 s; industry configuration and a maintenance request with its work order present (report backup-restore-20261117T074538Z) |
| Helm chart | `helm lint`, `kubeconform -strict` | 0 failures; 85 resources valid (80 in v2) |

### The twelve required v3 tests

| # | Requirement | Where | Result |
| --- | --- | --- | --- |
| 1 | Government and flood workflows keep working | Test A (16), Test B (14), all other v2 tests | pass |
| 2 | Manufacturing pack activates and exposes its modules | `industry-packs.test.ts`, `manufacturing.test.ts` | pass |
| 3 | Facilities pack activates without IoT | `facilities.test.ts` (asserts the tenant has no `iot` capability and the pack needs none) | pass |
| 4 | Different tenants, different packs | `industry-packs.test.ts` › Different tenants, different packs | pass |
| 5 | One tenant, several packs, records kept apart | `manufacturing.test.ts` › one tenant, two industries | pass |
| 6 | Disabled modules refuse direct API calls | `industry-packs.test.ts` › A module that is not active ... (case, maintenance, device, telemetry, alert APIs; refusal audited) | pass |
| 7 | Workflow subject extension keeps cases and incidents working | Tests A, B; `pack-isolation.test.ts` (registry protections, only registered types) | pass |
| 8 | Manufacturing sensors create incidents and work orders | `manufacturing.test.ts` › alarm to equipment incident to maintenance request | pass |
| 9 | Pack upgrade keeps running processes on their version | `industry-packs.test.ts` › Pack lifecycle (in-flight request finishes on 1.0.0 definition; new requests use 1.1.0) | pass |
| 10 | RLS and authorization still effective | Test C (17), authorization (21), `pack-isolation.test.ts` (16, incl. direct database attacks as the new roles) | pass |
| 11 | AI tools cannot reach other industries or tenants | `ai-industry.test.ts` (8) | pass |
| 12 | Backups and recovery include industry configuration | restore drill step "Verify industry-pack configuration and industry records in the restore" | passed: 15 databases (236 MB) backed up in 102 s, restored and verified in 85.8 s; industry configuration and a maintenance request with its work order present (report backup-restore-20261117T074538Z) |

### v3 run history

| Run | Result | What failed and why |
| --- | --- | --- |
| Baseline (before any change) | 122 passed, 1 skipped | Skip: analytics trend check needs a completed 5-minute bucket |
| 1 (v3 backend, v2 tests + facilities) | 168 of 171 | (a) API contract: OpenAPI not yet regenerated, expected. (b) AI bottleneck explanation once returned an unexpected status; passed on immediate re-run and in every later run; not reproduced. (c) Analytics: a service identity now gets 403 from the case API instead of an empty list (a deliberate, stricter behaviour from capability enforcement); test updated |
| 2 (all v3 backend tests) | 233 of 235 | (a) API contract, as above. (b) Event contract: `pack_id` had been added as a **required** field to existing maintenance events, so older events in the stream failed validation. A real contract defect; fixed by making it optional |
| 3 | 235 of 235 | — |
| 4 (with `ai-industry.test.ts`) | 243 of 243, 0 skipped, 204 s | — |

Tests written in this stage were reviewed before being relied on. Four assertions that could
never fail were found and replaced: a browser test that called an API without a token and
accepted 401; a widget test comparing with a placeholder; an AI label check that compared a
value with itself; a dataset check that only asserted a sum was not negative.

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

- **v3:** the failover and failback drills were not re-run with maintenance-service and the
  v3 consumers in the stack (the restore drill was). The CI workflow, including its new steps,
  has still never run. The v3 stack was upgraded in place, not started from empty volumes.
- **v3:** no load test of pack activation, entitlement propagation or dashboard queries; no
  test with more than four tenants.

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
