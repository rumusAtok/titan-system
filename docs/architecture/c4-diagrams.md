# C4 architecture diagrams

Diagrams describe the implemented system unless a box is marked *planned*.

## Level 1 — system context

```mermaid
C4Context
  title TITAN - system context
  Person(applicant, "Applicant", "Member of the public submitting and tracking applications")
  Person(staff, "Staff", "Reviewers, duty officers, asset managers, analysts, administrators")
  Person(operator, "Platform operator", "Runs the platform and recovery procedures")
  System(titan, "TITAN platform", "Case management, operations, IoT monitoring, analytics, optional AI")
  System_Ext(sensors, "Field sensors", "Flood monitoring stations (simulated in this release)")
  System_Ext(mail, "E-mail service", "Outbound notifications (log adapter only in this release)")
  System_Ext(model, "Local model runtime", "Ollama (optional)")
  Rel(applicant, titan, "Submits and tracks applications", "HTTPS")
  Rel(staff, titan, "Reviews, responds, administers", "HTTPS")
  Rel(operator, titan, "Operates, backs up, recovers", "CLI")
  Rel(sensors, titan, "Publishes measurements", "MQTT")
  Rel(titan, mail, "Sends notifications", "adapter")
  Rel(titan, model, "Generates text from authorised records", "HTTP")
```

## Level 2 — containers

```mermaid
flowchart TB
  subgraph edge[Edge]
    web["Web command center<br/><i>Next.js static export on nginx</i>"]
    gw["API gateway<br/><i>NestJS</i><br/>auth, rate limit, breaker, SSE"]
  end

  subgraph identity[Identity]
    kc["Keycloak<br/><i>realm titan</i>"]
  end

  subgraph foundation[Enterprise foundation]
    tenant[tenant-service]
    case[case-service]
    wf[workflow-service]
    notif[notification-service]
    audit[audit-service]
  end

  subgraph operations[Enterprise operations]
    asset[asset-service]
    incident[incident-service]
  end

  subgraph iot[Intelligent infrastructure]
    device[device-service]
    telem[telemetry-service]
    alert[alert-service]
    mqtt["Mosquitto<br/><i>MQTT broker</i>"]
  end

  subgraph intel[Data and intelligence]
    pipe["data-pipeline-service<br/><i>FastAPI, Polars, DuckDB</i>"]
    analytics["analytics-service<br/><i>FastAPI</i>"]
    ai["ai-gateway-service<br/><i>FastAPI</i>"]
  end

  nats[("NATS JetStream<br/>TITAN_EVENTS, TITAN_DLQ")]
  pg[("PostgreSQL 17<br/>13 service databases + keycloak")]
  lake[("Analytical lake<br/>Parquet volume")]
  ollama["Ollama<br/><i>optional</i>"]

  web -->|REST + SSE| gw
  web -.OIDC PKCE.-> kc
  gw -->|REST, user token| foundation & operations & iot & intel
  gw -.verify token keys.-> kc
  mqtt --> telem
  foundation & operations & iot -->|outbox publish / consume| nats
  nats --> pipe
  nats --> gw
  foundation & operations & iot & intel --- pg
  kc --- pg
  pipe -->|writes| lake
  lake -->|reads| analytics
  pipe -->|service token| analytics
  ai -->|user token| analytics & incident & telem
  ai -.-> ollama
```

## Level 3 — components of a Node service

Every NestJS service has the same internal structure; only the domain differs.

```mermaid
flowchart LR
  subgraph svc[one service, e.g. workflow-service]
    ctrl["Controller<br/>routes, Zod validation,<br/>role requirements"]
    guard["AuthGuard<br/>verifies JWT, builds Principal"]
    domain["Domain service<br/>business rules"]
    pure["Pure rules module<br/>(engine.ts, rules.ts, forms.ts)"]
    db["Db.tx(tenant)<br/>sets app.tenant_id"]
    outbox["Outbox.emit<br/>same transaction"]
    relay["OutboxRelay<br/>publish, then mark"]
    consumers["EventConsumers<br/>inbox, retry, DLQ"]
    sweep["Background sweep<br/>(SLA, offline, delivery)"]
  end
  req([HTTP request]) --> guard --> ctrl --> domain
  domain --> pure
  domain --> db
  domain --> outbox
  outbox --> pgdb[(service database)]
  db --> pgdb
  relay --> pgdb
  relay --> bus[(JetStream)]
  bus --> consumers --> domain
  sweep --> domain
```

Shared code (`packages/platform`, `authentication`, `observability`, `contracts`) provides the
grey plumbing only: guard, transaction helper, outbox, relay, consumers, health, metrics.

## Level 3 — components of the AI gateway

```mermaid
flowchart LR
  q([Question]) --> screen["Injection screen<br/>+ write-intent check"]
  screen --> plan{"Model available<br/>and input clean?"}
  plan -- yes --> mplan["Model selects a tool<br/>(strict JSON, allow-list)"]
  plan -- no --> rules["Rule-based router"]
  mplan -- invalid plan --> rules
  mplan --> exec
  rules --> exec["Tool execution<br/>schema-validated arguments,<br/>USER token, audit record"]
  exec --> svc["Owning service API<br/>(authorisation happens here)"]
  exec --> empty{"Records found?"}
  empty -- no --> none["insufficient evidence"]
  empty -- yes --> gen{"Model available<br/>and records clean?"}
  gen -- yes --> model["Model writes the answer<br/>from delimited records"]
  gen -- no --> det["Deterministic rendering"]
  model --> out([Answer + sources + label])
  det --> out
```

## Deployment — local development (implemented)

```mermaid
flowchart TB
  subgraph host[One workstation - Docker Desktop]
    subgraph net[network titan]
      c1[web] --- c2[gateway] --- c3[13 services]
      c4[(postgres)] --- c5[(nats)] --- c6[keycloak] --- c7[mosquitto]
    end
    subgraph drnet[network titan-dr]
      d1[(postgres-dr standby)] --- d2[dr-tools] --- d3[(postgres-restore)]
    end
    c4 -. streaming replication .-> d1
  end
  browser([Browser]) --> c1
  browser --> c2
  browser --> c6
```

## Deployment — production target (planned, not deployed)

```mermaid
flowchart LR
  dns{{Global DNS / load balancer}}
  subgraph primary[Primary region - 3 zones]
    ing1[Ingress + TLS] --> gw1[gateway x3] --> s1[services x2+]
    s1 --- pg1[(CloudNativePG<br/>3 instances, 1 sync)]
    s1 --- n1[(NATS x3<br/>R3 streams)]
    kc1[Keycloak x2] --- pg1
  end
  subgraph dr[DR region - warm standby]
    ing2[Ingress] --> gw2[gateway x0] --> s2[services x0]
    s2 --- pg2[(CloudNativePG<br/>replica cluster)]
    s2 --- n2[(NATS x3<br/>mirror)]
  end
  obj[(Object storage<br/>WAL + backups, versioned)]
  dns --> ing1
  dns -. after failover .-> ing2
  pg1 -- WAL archive --> obj --> pg2
  n1 -. stream mirror .-> n2
  git[(Git)] --> argo[Argo CD] --> primary & dr
```

Details: [high availability](high-availability.md) and
[disaster recovery](../disaster-recovery/dr-architecture.md).
