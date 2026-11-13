# Monitoring and alerting guide

## Start the observability profile

```powershell
docker compose --profile observability up -d
```

| Tool | Address | Purpose |
| --- | --- | --- |
| Prometheus | http://localhost:9090 | Metrics, alert rules (Status → Rules, Alerts) |
| Grafana | http://localhost:3001 (user `admin`, password `GRAFANA_ADMIN_PASSWORD` in `.env`) | Dashboard "TITAN platform overview"; Explore for logs |
| Loki | via Grafana | Logs of every container, shipped by Alloy |

Verified: 16 scrape targets up, 7 alert rules loaded, dashboard provisioned, logs of all
containers queryable (see the verification report).

No Alertmanager is configured locally: alerts are evaluated and shown in Prometheus but are not
sent anywhere. Routing alerts to people is a deployment task.

## Health

| Endpoint | Meaning |
| --- | --- |
| `GET /health/live` | The process is running |
| `GET /health/ready` | It can serve: database reachable. `status` is `ok`, `degraded` (broker down, still serving) or `unavailable` (503) |
| `GET /api/platform/health` (gateway, staff roles) | Readiness of every service, probed at request time, with circuit state |
| `./scripts/titan.ps1 status` | The same, as a table; exit code 1 if a critical service is not ready |

Service health and metrics endpoints are not reachable through the public API.

## Metrics

| Metric | Type | Use |
| --- | --- | --- |
| `titan_http_request_duration_seconds` | histogram (`service`, `method`, `route`, `status`) | Rate, errors, latency (RED) |
| `titan_events_published_total` | counter (`event_type`) | Outbox relay throughput |
| `titan_events_consumed_total` | counter (`event_type`, `outcome`: processed, duplicate, retry, dead_letter, invalid) | Consumer health |
| `titan_outbox_pending` | gauge | Events waiting for the broker |
| `titan_upstream_requests_total` | counter (`upstream`, `outcome`) | Gateway calls: ok, error, timeout, circuit_open, rejected |
| `titan_circuit_breaker_open` | gauge (`upstream`) | 1 while the gateway refuses to call a service |
| `titan_telemetry_messages_total`, `titan_telemetry_readings_total` | counters | Ingestion by outcome and quality |
| `titan_gateway_sse_clients` | gauge | Connected live-stream clients |
| Process and runtime metrics | default collectors | Memory, CPU, event loop |

## Alert rules

Defined in `infrastructure/monitoring/prometheus/alerts.yml`.

| Alert | Fires when | First actions |
| --- | --- | --- |
| `TitanServiceDown` | A service has not answered its metrics endpoint for 1 minute | `docker compose ps`; `docker compose logs <service> --tail 100`. Check its database and whether a deployment is in progress. Critical services: restore first |
| `TitanHighErrorRate` | More than 5% of a service's responses are 5xx for 5 minutes | Find the correlation id in an error response or log; follow it in Loki across services |
| `TitanSlowRequests` | 95th percentile latency above 2 s for 10 minutes | Check database load (`log_min_duration_statement` logs slow queries) and the upstream panel |
| `TitanUpstreamCircuitOpen` | The gateway has stopped calling a service for 2 minutes | The service is failing or timing out; fix it. The circuit closes by itself after a successful trial call |
| `TitanOutboxBacklog` | More than 500 unpublished events for 5 minutes | Is NATS up (`/healthz` on 8222)? Is the service's relay logging publish failures? Nothing is lost while events wait |
| `TitanEventsDeadLettered` | Any event was dead-lettered in 15 minutes | Query `dead_letters` in that service's database for `reason` and `error`; fix the cause; re-publish from the `TITAN_DLQ` stream if the effect is still needed |
| `TitanTelemetryIngestionStalled` | No telemetry accepted for 10 minutes | Is Mosquitto healthy? Is telemetry-service connected (`mqtt_connected` in ingest stats)? Are devices or the simulator publishing? |

## Logs and tracing

Every log line is JSON with `service`, `level`, `message`, `correlation_id`, `trace_id`, `span_id`.

- `correlation_id` is created at the gateway (or accepted from `x-correlation-id`), returned in
  the response header and in every error body, copied into every event the request causes, and
  restored when a consumer handles that event. One id therefore covers the whole business
  operation across services and asynchronous hops.
- `causation_id` on events gives the chain of what caused what.
- W3C `traceparent` is accepted, generated and propagated over HTTP and on event headers.

Follow one operation in Grafana → Explore → Loki:

```logql
{service=~".+"} | json | correlation_id = "<id from the response or audit record>"
```

Errors and warnings across the platform:

```logql
{service=~".+"} |~ "\"level\": ?\"(error|warn|warning)\""
```

**Limitation:** spans are not exported to a tracing backend (no OpenTelemetry collector or
trace UI). Tracing today means correlated logs and the event causation chain. Exporting spans
over OTLP is on the roadmap.

## Business-level monitoring

| Question | Where |
| --- | --- |
| Are approvals getting stuck? | Executive dashboard (pending and overdue tasks); `GET /api/workflow/stats` |
| Are sensors reporting? | IoT operations (sensor health); `GET /api/device/devices/summary`; KPI `sensor_availability` |
| Is ingestion healthy? | `GET /api/telemetry/ingest/stats` (quality mix, latency, rejections, MQTT connection) |
| Is the analytical data fresh? | `freshness.computed_at` on every KPI; `GET /api/pipeline/status` (watermark, backlog, last run) |
| Is replication healthy? Are backups verified? | DR dashboard; `GET /api/platform/dr/status` |
| Who did what? | Administration → Audit records; `GET /api/audit/audit` |

## Not monitored yet

PostgreSQL internals (no exporter), NATS server metrics (no exporter), Mosquitto, disk usage of
volumes, certificate expiry, backup age alerts. These are listed in the roadmap.
