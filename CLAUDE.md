# TITAN platform — working rules for this repository

TITAN is a multi-tenant, industry-agnostic operations platform built as independently
deployable microservices. Since v3 it has three layers: a universal core, switchable business
capabilities (`case_management`, `iot`, `maintenance`, `procurement`, `reporting`,
`integrations`, `video`) and declarative industry packs
(`docs/architecture/industry-packs.md`). This file holds the durable rules; `PROGRESS.md` holds
current state.

**Status honesty:** this is a locally verified development release. Never describe it as
production-ready, certified, or highly available. Never record a build, test, backup, failover
or integration as passing unless it was actually executed; put the evidence in
`docs/testing/verification-report.md`.

## Layout

| Path | What |
| --- | --- |
| `packages/contracts` | Event envelope, event catalog (Zod payload schemas), role names, capabilities, workflow subject registry, pack manifest schema, field specs |
| `services/tenant-service/packs/<id>/<version>.json` | Industry pack manifests (immutable once released; add a new version file) |
| `packages/observability` | Logger, correlation/trace context, Prometheus metrics |
| `packages/authentication` | JWT verification, `Principal`, `AuthGuard`, `@RequireRoles`, `@CurrentUser` |
| `packages/platform` | Config, `Db` (tenant-bound transactions), migrations, outbox, consumers, resilience, bootstrap |
| `services/*-service` | One deployable per service; NestJS (TypeScript) or FastAPI (Python) |
| `apps/gateway` | API gateway (auth, rate limit, resilient proxy, SSE, aggregated health) |
| `apps/web` | Next.js command center (own `package.json`, not part of the root workspace) |
| `infrastructure/` | Docker, Helm/Kubernetes, monitoring, disaster-recovery tooling |
| `scripts/` | Seed, sensor simulator, setup/verification scripts |
| `tests/` | Integration, security, contract, e2e and DR tests (run against the real stack) |

## Architecture rules (do not break)

1. **Database per service.** A service reads and writes only its own database, with its own
   credentials. Never query another service's tables. Share data through events, API calls or a
   local projection (e.g. `device_projection` in telemetry-service).
2. **Shared packages are infrastructure only.** No business rules in `packages/*`.
3. **Tenant comes from the verified token, never from the request.** Use `principal.tenantId`.
   Every query runs inside `db.tx(tenantId, ...)`, which sets `app.tenant_id` for PostgreSQL RLS.
   Every tenant-scoped table has `tenant_id`, `ENABLE ROW LEVEL SECURITY` and a policy using
   `app_tenant_id()`.
4. **Cross-tenant background work** (sweeps) goes through a narrowly scoped `SECURITY DEFINER`
   SQL function that returns ids only, then each item is processed in its own tenant transaction.
   Do not grant `BYPASSRLS` to an application role.
5. **Events:** state change and `outbox.emit(q, ...)` happen in the same transaction. Consumers are
   registered with `EventConsumers.register` and must be idempotent (the inbox handles repeated
   event ids; add a unique constraint when a *business* duplicate is possible).
   New event types are added to `packages/contracts/src/events.ts`; changing a payload
   incompatibly requires a new `.vN` type.
6. **Authorization is enforced in the service** that owns the data (`@RequireRoles` + ownership
   checks). The gateway authenticates but is never trusted for authorization.
7. **Not found vs forbidden:** records of another tenant or another owner answer `404`.
8. **AI is optional.** No core workflow or alert rule may depend on the AI subsystem. Deterministic
   fallbacks must never be labelled as AI-generated.
9. **No safety-critical actuation.** Nothing in this repository may command physical equipment.
10. **Secrets** never go in Git. `.env` is ignored; `.env.example` holds development-only values.
11. **Capabilities are enforced by the owning service.** A controller of a switchable capability
    carries `@RequireCapability(Capabilities.X)`; Python services use `EntitlementsClient`. Menu
    visibility is never the control. Unknown entitlements mean no capability (fail closed).
12. **Packs are data, never code.** No expressions, SQL or scripts in a manifest; it may only name
    things that already exist (datasets, query templates, AI tools, icons) and the manifest
    contract test checks that. A released `<version>.json` is never edited: publish a new version
    with `lifecycle.upgrades_from`. Installing a template must be idempotent, must create a new
    version rather than change one in use, and must never change a record a person created.
    Deactivating a pack deletes nothing.
13. **New workflow subject types** are added to `SUBJECT_TYPES` in `@titan/contracts` AND by a
    forward-only migration of `workflow_subject_types`; the owner starts processes with
    `workflow.start.requested.v1`.
14. **Adding a field to an existing event payload** makes it optional (old events stay valid);
    anything else needs a new `.vN` type.
15. **Nothing leaves the machine by default.** Outbound webhooks go only to hosts in
    `WEBHOOK_ALLOWED_HOSTS` (default: the local `webhook-sink`); do not add a real destination,
    e-mail adapter or supplier connection without the user's authorisation. The public
    `/hooks/<id>` route is authenticated by HMAC signature only, never by trusting the caller.
16. **A service acting for a user calls other services with that user's token** (report-service
    reading analytics), never with stored credentials of its own. Unattended work needs an
    explicit, audited service identity and is a design decision, not a shortcut.
17. **Video is metadata only.** No video is stored, relayed or analysed; a stream URL is revealed
    only inside a viewing session with a stated purpose, which is logged.

## Conventions

- Node services: NestJS 12 (ESM), TypeScript 6.0.x, explicit `@Inject(Token)` on every constructor
  parameter (the code does not rely on `emitDecoratorMetadata`), Zod for request validation
  (`@ZBody`, `@ZQuery`), plain SQL through `Q` (`pg`), relative imports end in `.js`.
- TypeScript is pinned to 6.0.x because `@nestjs/swagger` 12 does not accept TypeScript 7 (ADR-0003).
- Exported classes need exported row types (the build emits declarations).
- Migrations: `services/<svc>/migrations/NNNN_name.sql`, never edited after being applied (the
  runner checks checksums). `{{APP_ROLE}}` is replaced with the service's runtime role.
- IDs are UUIDs; timestamps are `timestamptz` in UTC; optimistic concurrency uses `version` +
  `expected_version`.
- Errors: throw `DomainError`; responses are `{ "error": { status, code, message, correlation_id } }`.
- Python services: FastAPI, `psycopg` 3, shared helpers in `packages/pykit`.

## Commands

```powershell
# one-time
Copy-Item .env.example .env ; npm install

# build (type-check) all Node services
npm run build

# start / stop the stack (profiles: core iot analytics ai observability dr-lab scan)
# core also starts the local helpers: mailpit (e-mail inbox :8025), webhook-sink (:8099), video-lab (HLS :8888)
docker compose --profile core --profile iot up -d --build
docker compose --profile core --profile iot down          # keeps data volumes
node scripts/identity-sync.mjs                            # add demo users/roles missing from an existing Keycloak
npm run seed                                              # synthetic reference data via the API (activates packs)

# or the wrapper: setup | up [-Profiles core,iot,analytics,ai] | status | seed | test | down | destroy
./scripts/titan.ps1 up

# tests
npm run test:unit:docker                                  # Node unit tests (vitest, in the image's unit-test stage)
docker build -f infrastructure/docker/python-service.Dockerfile --build-arg SERVICE_PATH=services/ai-gateway-service --target unit-test .   # pytest, per Python service
npm run test:integration                                  # integration + security + contract; needs core,iot,analytics,ai running and seeded
npm run test:a                                            # one mandatory test: test:a b c d e g, test:analytics
npm run test:e2e                                          # Playwright, in a container on the compose network
node tests/performance/smoke.mjs                          # lab-only latency smoke
node tests/performance/load.mjs                           # lab-only stepped load test (writes load-result.json)

# after changing a service: rebuild that container, then run the affected test
docker compose --profile core up -d --build case-service

# recovery lab (dr-lab profile); each writes a report under infrastructure/disaster-recovery/reports
npm run dr:restore-drill ; npm run dr:failover-drill ; npm run dr:failback ; npm run dr:pitr-drill

# generated artefacts
npm run openapi:export                                    # docs/api/*.openapi.json from the running services
node infrastructure/docker/keycloak/generate-realm.mjs    # realm JSON (applies only to an empty Keycloak database)
```

Unit tests use vitest. On this Windows machine an Application Control policy blocks vitest's
native bundler binary, so unit tests are run in the Linux container stage above. Integration
tests use Node's built-in runner (`node --test`) so they need no native binaries and can drive
`docker compose` (ADR-0006).

Integration tests run against real containers and assert on eventually consistent state: read
state that follows an event with the waiting helpers in `tests/helpers/stack.ts` (`waitFor`,
`caseStatus`, `pendingTask`), never with an immediate assertion. The suite runs with
`--test-concurrency=1` because Tests D and G stop and start containers.

`tests/contract/pack-manifests.test.ts` needs no stack but reads compiled output: run
`npm run build` first. After adding a demo user or role to
`infrastructure/docker/keycloak/identity-data.mjs`, regenerate the realm and run
`node scripts/identity-sync.mjs` (Keycloak imports the realm file only into an empty database).

Shell scripts that build values containing `{`/`}` (tile URL templates) must not put them inside
`${VAR:=default}`: the shell ends the expansion at the first `}`.

Migrations run automatically at service start (`MIGRATE_ON_START=true`), or explicitly with
`node packages/platform/dist/migrate-cli.js <migrations dir>`.

## Before calling work done

- `npm run build` passes.
- Unit tests and the affected integration tests pass; new behaviour has a test.
- A new endpoint has role checks, a capability check if it belongs to a switchable capability,
  and a tenant-isolation consideration; a new table has RLS.
- A new or changed endpoint: `npm run openapi:export` and review the diff (the API contract test
  fails otherwise).
- `PROGRESS.md` and the relevant document under `docs/` are updated to match the code.
