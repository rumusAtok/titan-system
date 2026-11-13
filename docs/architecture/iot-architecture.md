# IoT architecture (flood monitoring)

Implemented in device-service, telemetry-service, alert-service and incident-service.
Verified by Test B (`tests/integration/iot-incident.test.ts`).

**All sensor data in this repository is synthetic**, produced by `scripts/sensor-simulator.mjs`.
No real measurements and no external weather feed are used. Screens that show readings carry a
"Simulated data" label.

## Flow

```mermaid
sequenceDiagram
  participant S as Sensor (simulated)
  participant M as Mosquitto
  participant T as telemetry-service
  participant A as alert-service
  participant I as incident-service
  participant W as workflow-service
  participant U as Duty officer
  S->>M: PUBLISH titan/{tenant}/devices/{device}/telemetry (QoS 1)
  M->>T: deliver
  T->>T: validate, classify quality, INSERT (dedupe), outbox
  T-->>M: PUBACK (only after the row is stored)
  T-)A: telemetry.measurement.accepted.v1
  A->>A: evaluate rules; open alarm if none is open
  A-)I: alert.raised.v1
  I->>I: create incident (unique per alarm)
  I-)W: incident.created.v1
  W->>W: start incident-response; task for duty_officer
  U->>W: decide task (acknowledge)
  W-)I: workflow.stage.completed.v1
  I->>I: status acknowledged
  Note over T,I: every hop is a durable event; the gateway also streams them to dashboards (SSE)
```

Measured in the lab: about 50 ms from publish to stored reading, about 0.3 s from a
threshold-crossing reading to an open incident (`tests/performance/last-result.json`).

## Devices

- Registered through `POST /api/device/devices` with their sensors (`kind`, `unit`, valid range)
  and an expected reporting interval.
- `device.registered.v1` builds local projections in telemetry-service and alert-service, so
  ingestion never calls device-service.
- **Health:** telemetry emits a throttled heartbeat; device-service marks a device `online`, and a
  sweep marks it `offline` after three missed intervals (at least 20 s). Going offline raises a
  device-health alarm that clears when the device reports again.

## Message contract

Topic: `titan/<tenant_id>/devices/<device_id>/telemetry`

```json
{ "message_id": "RB-WL-001-1731400000-42",
  "observed_at": "2026-11-12T06:06:48.341Z",
  "readings": [ { "sensor": "water_level", "value": 2.31 }, { "sensor": "rainfall", "value": 4.0 } ] }
```

## Timestamps

| Column | Meaning |
| --- | --- |
| `observed_at` | When the sensor took the reading (device clock) |
| `received_at` | When the platform received the message |
| `processed_at` | When the row was validated and stored |

## Quality flags

Every accepted reading is stored with a flag. Only `ok` readings are evaluated by alert rules
and used in trends.

| Flag | Condition |
| --- | --- |
| `ok` | Plausible and timely |
| `out_of_range` | Outside the sensor's valid range |
| `late` | Observed more than 10 minutes before it was received |
| `future_timestamp` | Observed more than 2 minutes after it was received |

Rejected (recorded in `rejected_messages`, visible in ingest statistics): invalid JSON or schema,
unknown sensor. Ignored: unregistered or decommissioned device, or a device id published under
another tenant's topic.

## Duplicates, delays, retries, disconnection

| Situation | Handling |
| --- | --- |
| Broker redelivers a message (QoS 1) | Primary key `(device, sensor, observed_at, message_id)`; the second insert does nothing |
| Database unavailable during ingestion | The message is not acknowledged; the service reconnects and the broker redelivers |
| telemetry-service down | Persistent MQTT session: the broker queues QoS 1 messages and delivers them on return |
| Delayed data | Stored and flagged `late`; does not overwrite the "latest" value; does not trigger or clear alarms |
| Reading older than an alarm's latest evidence | Ignored for that alarm (out-of-order protection) |
| Device stops reporting | Offline detection and a device-health alarm |

## Storage

`measurements` is partitioned by month with a default partition; partitions are created ahead
and dropped by retention (see [database design](../database/README.md#time-series-partitioning-and-retention)).
`latest_measurements` keeps one row per device and sensor for live tiles.

## Alert rules

A rule has a sensor kind, optional device, operator, threshold, optional **clear threshold**
(hysteresis), severity and whether it opens an incident.

- **Raise** on the first breaching reading when no alarm is open for that rule and device.
- **Fold** further breaching readings into the open alarm (`occurrences`, `last_value`).
- **Clear** when the value is back past the clear threshold.
- **Deduplication** is guaranteed by a partial unique index (one open alarm per rule and device)
  and, for incidents, one incident per alarm.
- **Escalation:** an alarm unacknowledged for `ALERT_ESCALATION_SECONDS` (300) notifies the
  incident commander once.

Seeded rules: high water level (> 3.5 m, clear 3.2, warning), critical water level (> 4.5 m,
clear 4.2, critical), heavy rainfall, low battery.

## Incident response

Acknowledgment and resolution are steps of the `incident-response` workflow
(acknowledge: `duty_officer`, 15-minute SLA escalating to `incident_commander`; resolve:
`incident_commander`). incident-service applies the result when the stage completes; closing a
resolved incident is its own command. See ADR-0005.

## Simulator

```powershell
npm run simulate                                     # normal conditions, until stopped
npm run simulate -- --scenario flood --duration 120  # one sensor rises past both thresholds, then recedes
npm run simulate -- --silent RB-WL-003               # one sensor says nothing (offline detection)
```

The `iot` profile also runs a simulator container in `normal` mode so dashboards have data.

## Safety boundary

The platform observes and notifies. **It does not operate pumps, gates or any other equipment**,
and contains no code path that could. Actuation of physical equipment requires independently
validated engineering controls and explicit authorization, and is out of scope.

## Limitations

- One shared MQTT credential for all simulated devices; production needs per-device credentials
  or certificates and TLS, with the broker ACL restricting each device to its own topic.
- telemetry-service runs as a single replica (one persistent MQTT session). Scaling out needs
  shared subscriptions (roadmap).
- No public weather API is integrated; when one is, its provenance, last update time and
  availability must be shown with the data (integration-service is not started).
- Alarms that hover around a clear threshold create a new alarm, and therefore a new incident,
  each time they re-trigger; there is no incident cool-down.
