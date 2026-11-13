# Developer setup guide

Verified on Windows 11 with PowerShell 5.1, Docker Desktop (Linux containers) and Node.js 26.
Nothing else needs to be installed: Python, Helm, kubeconform, OpenTofu, Playwright and the
browsers all run in containers.

## Prerequisites

| Tool | Version used | Needed for |
| --- | --- | --- |
| Docker Desktop | 29.x, Compose v5 | Everything. Give it at least 8 GB of memory (16 GB to run all profiles) |
| Node.js | 22.12 or newer (26.13 used) | Building, seeding, the simulator, integration tests |
| Git | any recent | — |

## First start

```powershell
git clone <repository> titan-platform
cd titan-platform
./scripts/titan.ps1 setup      # checks tools, creates .env, npm install
./scripts/titan.ps1 up         # builds images, starts core + iot, waits, seeds demo data
```

The first build downloads base images and dependencies and takes several minutes; later starts
take about a minute and a half. Then open http://localhost:3000 and sign in.

| Sign in as | To see |
| --- | --- |
| `alice.applicant` | Submitting and tracking an application |
| `victor.validator` → `tara.technical` → `henry.head` → `fiona.final` | The four approval stages (Review inbox) |
| `derek.duty`, `irene.commander` | IoT operations, incident acknowledgment and resolution |
| `adam.admin` | Everything in the Riverbend tenant, administration, audit |
| `brian.admin` | The second tenant (Northfield): none of Riverbend's data |
| `pat.platform` | Disaster-recovery dashboard as a DR operator |

Password for all of them: `DEMO_USER_PASSWORD` in `.env`. These are synthetic, test-only identities.

## A five-minute tour

1. As `alice.applicant`: Applications → New application → Building permit → fill in → Submit.
2. As `victor.validator`: Review inbox → Decide → Approve. Repeat as `tara.technical`,
   `henry.head`, `fiona.final`. Alice's application becomes Approved; she has two notifications.
3. Trigger a flood: `npm run simulate -- --scenario flood --duration 90 --flood-device RB-WL-002`
4. As `derek.duty`: IoT operations. Watch the level cross the threshold line, an alarm and an
   incident appear; open the incident and acknowledge it. As `irene.commander`: resolve and close.
5. As `adam.admin`: Administration → Audit records shows every step with who did it.

## Repository layout

See `CLAUDE.md` for the layout, the architecture rules and conventions. In short:

```
apps/gateway, apps/web      edge
services/*-service          one deployable each (NestJS or FastAPI)
packages/*                  shared infrastructure code only
infrastructure/             docker, helm, kubernetes, opentofu, monitoring, disaster-recovery
scripts/                    titan.ps1, seed, simulator, DR drills
tests/                      integration, security, contract, e2e, performance
docs/                       this documentation
```

## Everyday commands

| Task | Command |
| --- | --- |
| Type-check and build all Node code | `npm run build` |
| Unit tests, Node services | `npm run test:unit:docker` (or `npm run test:unit` where native binaries are allowed) |
| Unit tests, Python services | `docker build -f infrastructure/docker/python-service.Dockerfile --build-arg SERVICE_PATH=services/<name> --target unit-test .` |
| Integration, security, contract tests | `npm run test:integration` (stack running with `core iot analytics ai`, seeded) |
| One mandatory test | `npm run test:a` … `test:g`, `test:e`, `test:analytics` |
| Browser tests | `npm run test:e2e` |
| Performance smoke | `node tests/performance/smoke.mjs` |
| DR drills | `npm run dr:restore-drill`, `npm run dr:failover-drill`, `npm run dr:failback` |
| Rebuild and restart one service | `docker compose --profile core up -d --build case-service` |
| Logs of one service | `docker compose logs -f case-service` |
| Regenerate API specifications | `npm run openapi:export` |
| Regenerate the Keycloak realm | `node infrastructure/docker/keycloak/generate-realm.mjs` (then recreate Keycloak on an empty database) |
| SQL in a service database | `docker compose exec postgres psql -U postgres -d titan_case` |

## Working on a Node service

- Entry point `src/main.ts`; routes in a controller; rules in a service class; pure rules in
  their own module with a `*.test.ts` beside it.
- Add a migration as the next `migrations/NNNN_name.sql`. Never edit an applied one.
- New table with tenant data: `tenant_id`, `ENABLE ROW LEVEL SECURITY`, a policy on
  `app_tenant_id()`. New endpoint: `@RequireRoles(...)` and an ownership or state check.
- State change plus event: both inside one `db.tx(...)`, using `outbox.emit(q, ...)`.
- New event type: add its schema to `packages/contracts/src/events.ts`.
- `docker compose --profile core up -d --build <service>` and run the relevant test.

## Working on a Python service

`app/main.py` builds the FastAPI app with `titan_pykit.create_app`; SQL through
`db.tx(tenant_id)`; tests in `tests/` run in the image (`--target unit-test`).

## Working on the web application

```powershell
docker compose --profile core up -d --build web
```

The web app is a static export; it reads the gateway and Keycloak addresses from `/config.js`
at run time. On machines where native Node add-ons may run, `cd apps/web; npm install; npm run dev`
gives hot reload on port 3000 (stop the `web` container first).

## Known machine-specific issue

On the development machine a Windows Application Control policy blocks unsigned native Node
add-ons. That affects vitest (its bundler) and would affect `next dev` and Tailwind. The
project therefore runs those tools in Linux containers, and the integration tests use Node's
built-in runner, which needs no native code (ADR-0006). On machines without that policy the
native commands work too.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `failed to connect to the docker API` | Docker Desktop is not running |
| A service stays `health: starting` | `docker compose logs <service>`; usually the database is still initialising on first start |
| Sign-in page does not load | Keycloak takes up to a minute on first start |
| `401` from the API with a fresh token | `.env` `KEYCLOAK_PUBLIC_URL` differs from the address the token was issued for |
| KPI cards say "Service unavailable" | The `analytics` profile is not running |
| AI workspace says "No model available" | Expected without Ollama; see the deployment guide |
| No sensor data | The `iot` profile (which includes the simulator) is not running, or the seed has not been run |
| Port already in use | Change the `*_HOST_PORT` values in `.env` |
| After a failover drill, services cannot reach the database | Run `npm run dr:failback`, or set `$env:DB_HOST = "postgres-dr"` |
