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
