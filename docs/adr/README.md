# Architecture decision records

Each record states the context, the decision and its consequences. Status is *accepted* unless noted.

| # | Decision |
| --- | --- |
| [0001](#adr-0001-independent-services-one-database-each-one-postgresql-instance-locally) | Independent services, one database each, one PostgreSQL instance locally |
| [0002](#adr-0002-nats-jetstream-with-transactional-outbox-and-inbox) | NATS JetStream with transactional outbox and inbox |
| [0003](#adr-0003-nestjs-12-typescript-60-explicit-injection-zod-plain-sql) | NestJS 12, TypeScript 6.0, explicit injection, Zod, plain SQL |
| [0004](#adr-0004-tenant-isolation-by-token-and-row-level-security) | Tenant isolation by token and row-level security |
| [0005](#adr-0005-incident-acknowledgment-is-a-workflow-step) | Incident acknowledgment is a workflow step |
| [0006](#adr-0006-test-tooling) | Test tooling |
| [0007](#adr-0007-python-data-services-lake-as-contract-events-without-outbox) | Python data services, lake as contract, events without outbox |
| [0008](#adr-0008-ai-as-an-optional-read-only-subsystem) | AI as an optional, read-only subsystem |
| [0009](#adr-0009-static-web-application-with-run-time-configuration) | Static web application with run-time configuration |
| [0010](#adr-0010-active-passive-recovery-with-operator-confirmed-failover) | Active-passive recovery with operator-confirmed failover |
| [0011](#adr-0011-industry-packs-are-declarative-manifests-installed-by-the-owning-services) | Industry packs are declarative manifests installed by the owning services |
| [0012](#adr-0012-capability-entitlements-enforced-by-every-service-from-a-local-projection) | Capability entitlements enforced by every service from a local projection |
| [0013](#adr-0013-a-controlled-registry-of-workflow-subject-types) | A controlled registry of workflow subject types |
| [0014](#adr-0014-one-maintenance-service-shared-by-industries) | One maintenance service shared by industries |

---

## ADR-0001: Independent services, one database each, one PostgreSQL instance locally

**Context.** The platform must be independently deployable microservices without becoming a
distributed monolith, yet run on one 32 GB workstation.

**Decision.** Every service owns a separate database with its own owner and runtime roles. In
development all databases share one PostgreSQL instance. Services never read each other's
tables; they use events, public APIs or local projections. Shared packages contain
infrastructure code only.

**Consequences.** Isolation is enforced by database privileges (a runtime role cannot connect
to another service's database) and tested. Moving a service to its own instance changes one
connection string. Cross-service queries are impossible, so read needs are met by projections
(more code) or by the analytical layer. One instance is a single point of failure locally.

## ADR-0002: NATS JetStream with transactional outbox and inbox

**Context.** Business processes span services (case → workflow → notification; telemetry → alert
→ incident → workflow). Dual writes to a database and a broker lose or invent events on failure.

**Decision.** A service writes its state change and an outbox row in one transaction; a relay
publishes to JetStream and marks the row afterwards. Consumers are durable, acknowledge
explicitly, and record each event id in an inbox inside the handling transaction. Retries are
bounded with backoff; exhausted or malformed events go to a dead-letter table and stream.
Sagas are choreographed by events with compensating states (returned, rejected, cancelled).

**Consequences.** At-least-once delivery with idempotent handling; services keep working while
the broker is down. Cost: eventual consistency between services (typically well under a second
locally) and the need for every handler to check current state. gRPC was not introduced: no
call path showed a benefit over REST and events.

## ADR-0003: NestJS 12, TypeScript 6.0, explicit injection, Zod, plain SQL

**Context.** The preferred stack was NestJS, TypeScript and Drizzle or another well-supported
data layer. At build time the current releases were NestJS 12 (ESM only) and TypeScript 7.

**Decision.**
- TypeScript is pinned to 6.0.x: `@nestjs/swagger` 12 declares `typescript ^5.5 || ^6` and npm
  refuses TypeScript 7 alongside it.
- Constructor dependencies use explicit `@Inject(Token)`; the code does not rely on
  `emitDecoratorMetadata`, so it runs unchanged under `tsc`, tsx and vitest.
- Request validation uses Zod schemas (`@ZBody`, `@ZQuery`), which also generate the OpenAPI
  request schemas.
- Data access uses `pg` with plain SQL and versioned SQL migrations, not an ORM. Row-level
  security needs a transaction-local setting on every transaction, and the security-relevant
  SQL (policies, `SECURITY DEFINER` functions, partitioning) is clearest when written directly.
- The `nats` package is deprecated; `@nats-io/transport-node` and `@nats-io/jetstream` are used.

**Consequences.** No ORM conveniences (hand-written row types); in exchange, every query is
visible and the migration files are the schema. Revisit the TypeScript pin when
`@nestjs/swagger` accepts TypeScript 7.

## ADR-0004: Tenant isolation by token and row-level security

**Context.** Tenants must never see each other's records, and that must not depend on every
query remembering a filter or on trusting client input.

**Decision.** The tenant id comes only from the verified token. Every transaction sets
`app.tenant_id`; every tenant table has a row-level security policy on it, enforced for the
runtime role (not owner, not superuser, no `BYPASSRLS`). Unset means no rows. Cross-tenant
background work uses narrow `SECURITY DEFINER` functions returning ids only. Records outside the
caller's tenant answer 404.

**Consequences.** Two independent layers, both tested (including direct attacks as the runtime
role). A service that deliberately set another tenant id would bypass the database layer, so the
rule "tenant from the principal only" is a code-review rule. Platform administrators use a
distinguished platform tenant id that the tenant registry policy recognises.

## ADR-0005: Incident acknowledgment is a workflow step

**Context.** Incident handling must integrate with an authorised workflow. Two designs were
possible: commands on incident-service mirrored into a workflow, or the workflow as the single
authority.

**Decision.** `incident.created` starts an `incident-response` process (acknowledge by the duty
officer with a 15-minute SLA, resolve by the incident commander). incident-service applies
acknowledgment and resolution when the corresponding stage completes. Closing remains a
command on incident-service.

**Consequences.** One engine decides who may act on cases and incidents, with the same
delegation, SLA, escalation, duplicate protection and audit. Trade-off: incidents cannot be
acknowledged while workflow-service is down (they are still created and visible). A tenant
without an `incident-response` definition gets incidents with no response process (logged).

## ADR-0006: Test tooling

**Context.** Vitest was preferred. The development machine's Application Control policy blocks
unsigned native Node add-ons, which vitest's bundler needs. Integration tests must also stop and
start containers.

**Decision.**
- Unit tests: vitest (Node) and pytest (Python), run inside the service images
  (`--target unit-test`), identically on any machine and in CI.
- Integration, security and contract tests: Node's built-in test runner (`node --test`) with
  native TypeScript type stripping. No native dependency, runs on the host, can call
  `docker compose`. They use the real stack: no mocks.
- Browser tests: Playwright in the official container on the compose network, with TCP
  forwarders so the browser uses the same `localhost` URLs as a person.

**Consequences.** Two runners instead of one. The host policy was respected, not bypassed.

## ADR-0007: Python data services, lake as contract, events without outbox

**Context.** Data engineering and AI call for Python (Polars, DuckDB). The pipeline and the
analytics service must stay separately owned.

**Decision.** The pipeline's only input is the event stream (bronze). Silver and gold are
Parquet files in a lake volume; **the gold layer is the contract** between pipeline (writer) and
analytics (reader, mounted read-only). The pipeline asks analytics to refresh with a
client-credentials token; analytics also polls. Python services publish their two announcement
events directly, without an outbox, because each announces a record already stored durably
(run history, tool log): a lost publish loses the announcement, not the record.

**Consequences.** Analytics never queries operational databases. The lake is a shared volume
locally (object storage in production). `pipeline.run.completed` and `ai.tool.executed` are
best-effort; consumers needing completeness read the APIs.

## ADR-0008: AI as an optional, read-only subsystem

**Context.** AI must not be a core dependency, must not bypass authorization, must not
fabricate, and must not write without human approval.

**Decision.** A separate, feature-flagged service. The model can only select among read-only
tools; each tool calls the owning service with the **user's** token; arguments are
schema-validated; analytical access is through approved query templates on a read-only role.
With no model, the same tools run and answers are deterministic renderings, labelled as such.
Empty results produce "insufficient evidence" without consulting the model. Writes exist only as
proposals approved by a person and executed with the approver's permissions. LangGraph is not
used: every use case is one tool call followed by one generation, which a plain function
expresses more simply.

**Consequences.** Safety does not depend on prompt wording. Capability is deliberately limited
(one tool per question). Verified with no model and with a small local model.

## ADR-0009: Static web application with run-time configuration

**Context.** The command center needs no server-side rendering; fewer moving parts at the edge
is safer.

**Decision.** Next.js static export served by unprivileged nginx. All data comes from the
gateway with the user's token (kept in memory). Gateway and identity addresses are read from
`/config.js`, written at container start (or a ConfigMap), so one image serves every
environment. Live updates use Server-Sent Events read with `fetch`, so the token travels in a
header.

**Consequences.** No Node server to patch at the edge; no dynamic route segments (record ids are
query parameters); the Content-Security-Policy needs `'unsafe-inline'` for the export's
bootstrap scripts (recorded as a risk).

## ADR-0010: Active-passive recovery with operator-confirmed failover

**Context.** Recovery must be a built capability, but automatic cross-site failover without
proven fencing and quorum risks split brain.

**Decision.** One active site and a warm standby. Failover is a scripted procedure that
detects, confirms scope, fences, inspects replication, and then **stops for an explicit operator
confirmation** before promoting; declining aborts safely. Failback is a planned operation with
no data loss. The lab runs both databases on one host and labels itself accordingly; regional
manifests are provided as a plan. Replication and backup are treated as different protections
and both are used.

**Consequences.** Recovery time includes a human decision. The procedure and the software's
behaviour under failover are tested; geographic separation, real fencing and regional timings
are not.

## ADR-0011: Industry packs are declarative manifests installed by the owning services

**Context.** TITAN v3 must serve many industries without becoming a set of per-industry copies,
and without running code supplied by tenants.

**Decision.** An industry pack is a versioned JSON manifest shipped with tenant-service and
validated against a schema in `@titan/contracts`. It names capabilities and carries templates:
workflows, forms, asset categories with attribute schemas, sensor profiles, alert rules, incident
categories, request types, dashboards, and the names of reviewed query templates and AI tools.
tenant-service records activation and announces the templates in `tenant.pack.activated.v1`;
each owning service installs its part idempotently in its own database. Published versions are
immutable (the catalogue table refuses updates). Upgrades follow declared paths; deactivation
deletes nothing. Uploading packs is not supported.

**Consequences.** A new industry needs no new service when its behaviour is expressible with the
existing capabilities; behaviour that is not (a real procurement process) needs a new service, as
the directive requires. Installation is eventually consistent: a few hundred milliseconds after
activation locally. Templates installed by a deactivated pack remain, which keeps running
processes valid but means a re-activation does not start from a clean slate.

## ADR-0012: Capability entitlements enforced by every service from a local projection

**Context.** Hiding a menu is not a control. Each service must refuse a module its tenant has not
activated, without calling tenant-service on every request (availability, latency) and without
reading its database (ADR-0001).

**Decision.** tenant-service announces a tenant's complete entitlement state with a monotonically
increasing revision. Every Node service keeps a `tenant_entitlements` projection (platform
migration) under row-level security, updated by its own durable consumer; `@RequireCapability`
and a global guard refuse other tenants with `403 capability_disabled` and record the refusal.
Python services ask tenant-service with the caller's own token and cache briefly. Unknown means
no capability (fail closed); a known answer survives a tenant-service outage.

**Consequences.** Enforcement keeps working when tenant-service is down. A newly activated pack
becomes usable after the event is consumed (seconds at most; the seed and tests wait for it). The
Python cache means up to 5 seconds of lag after a change. Service identities belong to no tenant
and therefore hold no capability: the case API now refuses them instead of returning an empty
list (one analytics test was updated for this).

## ADR-0013: A controlled registry of workflow subject types

**Context.** The workflow engine accepted only `case` and `incident`, enforced by CHECK
constraints and hard-coded event handling.

**Decision.** A `workflow_subject_types` table (mirroring `SUBJECT_TYPES` in `@titan/contracts`)
is referenced by definitions and instances. New types are added only by migration; the runtime
role cannot change the table. Services that own other subjects start and cancel processes with
`workflow.start.requested.v1` and `workflow.cancel.requested.v1`; cases and incidents keep their
original triggers. Returning for changes remains limited to subject types that support it.

**Consequences.** Five types are registered for future services (work order, inspection,
purchase request, quality deviation, contract) with no owner yet: definitions can be prepared, but
no process runs until an owning service emits the start event.

## ADR-0014: One maintenance service shared by industries

**Context.** Manufacturing and facilities both need requests, approval and work orders. Two
copies would diverge; one service with industry branches would accumulate industry rules.

**Decision.** maintenance-service implements the generic slice: request types (from packs),
requests, approval outcome (decided by workflow-service), work orders and their lifecycle.
Industry differences are configuration: request types, approval workflows, detail fields, and
automatic creation from an incident category. Records carry the pack they belong to, so one
tenant's industries stay separable in lists, datasets and dashboards.

**Consequences.** Preventive schedules, spare parts, labour costing and inspection plans are not
implemented. Effects on other services are by event only: asset-service sets an asset under
maintenance and back, and records the condition; incident-service writes the work to the incident
timeline but never resolves an incident on its own.
