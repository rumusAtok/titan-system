# Event catalog

Source of truth: [`packages/contracts/src/events.ts`](../../packages/contracts/src/events.ts)
(Zod schemas). The contract test `tests/contract/contracts.test.ts` validates the events found in
the live stream against these schemas.

## Envelope

Every event has this envelope (`packages/contracts/src/envelope.ts`):

| Field | Meaning |
| --- | --- |
| `event_id` | UUID, unique per event; also the JetStream message id (broker-side deduplication) and the inbox key |
| `event_type` | `<domain>.<entity>.<action>.v<N>` |
| `schema_version` | The `N` of the type |
| `producer` | Service that emitted it |
| `aggregate_type`, `aggregate_id` | The business record it is about |
| `tenant_id` | Owning tenant (platform tenant id for platform-level events) |
| `occurred_at` | ISO-8601 UTC |
| `correlation_id` | Follows one business operation across services |
| `causation_id` | `event_id` of the event (or null for a request) that directly caused this one |
| `actor` | `{id, username?, type: user\|service\|system\|device}` |
| `payload` | Type-specific body |

Subject: `titan.events.<event_type>` in stream `TITAN_EVENTS` (file storage, 7 days in the lab).
Dead letters: `titan.dlq.<consumer>` in stream `TITAN_DLQ`.

## Delivery guarantees

```mermaid
sequenceDiagram
  participant S as Service A
  participant DB as A's database
  participant R as Outbox relay
  participant J as JetStream
  participant C as Service B consumer
  participant DB2 as B's database
  S->>DB: BEGIN; change state; INSERT outbox; COMMIT
  R->>DB: SELECT unpublished FOR UPDATE SKIP LOCKED
  R->>J: publish (Nats-Msg-Id = event_id)
  J-->>R: ack
  R->>DB: mark published
  J->>C: deliver (at least once)
  C->>DB2: BEGIN; INSERT inbox ON CONFLICT DO NOTHING
  alt first time
    C->>DB2: apply business effect (+ own outbox rows); COMMIT
  else duplicate
    C->>DB2: COMMIT (nothing to do)
  end
  C-->>J: ack
```

- **At-least-once**, never assumed exactly-once. Three layers absorb repeats: the broker's
  duplicate window (same message id), the consumer's inbox (same event id), and unique
  constraints for business duplicates (e.g. one incident per alarm).
- **Bounded retries.** A failing handler is retried with backoff (1 s, 3 s, 10 s, 30 s, 60 s) up to
  `EVENT_MAX_DELIVER` (5); then the event is written to `dead_letters`, published to the DLQ
  stream and terminated. Malformed events go to the DLQ immediately.
- **Schema validation** on both sides: the producer validates the payload before writing the
  outbox row; the consumer validates the envelope and payload before handling.
- **Ordering** is per consumer, in stream order; a retried event can be overtaken, so handlers
  check current state rather than assume order.
- **Observability:** `titan_events_published_total`, `titan_events_consumed_total{outcome}`,
  `titan_outbox_pending`.

Verified by Test D and the failover drill (see the verification report).

## Events

### Tenant
| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `tenant.created.v1` | A tenant is created | `tenant_id`, `name`, `slug` |
| `tenant.department.created.v1` | A department is added | `department_id`, `code`, `name` |
| `tenant.config.updated.v1` | Tenant configuration saved | `keys` |

### Case
| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `case.submitted.v1` | A draft is submitted | `case_id`, `reference_no`, `form_key`, `workflow_key`, `applicant_id`, `title`, `data`, `submitted_at` |
| `case.resubmitted.v1` | A returned case is resubmitted | `case_id`, `data`, `resubmitted_at` |
| `case.cancelled.v1` | A submitted case is cancelled | `case_id`, `cancelled_by` |

### Workflow
| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `workflow.instance.started.v1` | A process starts for a case or incident | `instance_id`, `subject_type`, `subject_id`, `definition_key`, `definition_version` |
| `workflow.task.assigned.v1` | A task is created for a role | `task_id`, `subject_*`, `stage_key`, `stage_name`, `role`, `due_at` |
| `workflow.task.closed.v1` | A task is completed or cancelled | `task_id`, `status`, `decision`, `assigned_at`, `closed_at` |
| `workflow.decision.approved.v1` / `rejected.v1` / `returned.v1` | A decision is recorded | `decision_id`, `task_id`, `stage_key`, `decided_by`, `on_behalf_of`, `comment` |
| `workflow.stage.completed.v1` | All tasks of a stage are approved | `stage_key`, `completed_by`, `completed_at` |
| `workflow.case.returned.v1` | A case is sent back to the applicant | `case_id`, `stage_key`, `comment` |
| `workflow.case.completed.v1` | A case process ends | `case_id`, `outcome`, `started_at`, `completed_at` |
| `workflow.instance.completed.v1` | A non-case process ends | `subject_*`, `outcome` |
| `workflow.task.escalated.v1` | A task passes its SLA | `task_id`, `role`, `escalate_to_role`, `due_at` |

### Assets and devices
| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `asset.created.v1` | An asset is registered | `asset_id`, `code`, `category`, `status`, `condition`, location |
| `asset.status_changed.v1` | Lifecycle transition | `from`, `to` |
| `asset.maintenance.updated.v1` | Maintenance recorded | `condition`, `last_maintained_at`, `next_maintenance_due` |
| `device.registered.v1` | A device is registered | `device_id`, `serial_no`, `sensors[]`, `expected_interval_seconds` |
| `device.status_changed.v1` | Online / offline / decommissioned | `from`, `to`, `last_seen_at`, `reason` |

### Telemetry, alarms, incidents
| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `telemetry.measurement.accepted.v1` | A reading is stored (once per reading) | `device_id`, `sensor_kind`, `value`, `quality`, `observed_at`, `received_at`, `processed_at` |
| `telemetry.device.heartbeat.v1` | A device reported (throttled) | `device_id`, `last_received_at` |
| `alert.raised.v1` | A rule is breached with no open alarm, or a device goes offline | `alert_id`, `kind`, `rule_name`, `severity`, `value`, `threshold`, `create_incident` |
| `alert.acknowledged.v1` / `alert.cleared.v1` | Acknowledged / condition ended | `alert_id` |
| `incident.created.v1` | An incident is opened | `incident_id`, `reference_no`, `severity`, `source_type`, `source_id` |
| `incident.acknowledged.v1` / `incident.resolved.v1` | Response step completed | `incident_id`, actor, timestamps |
| `incident.assigned.v1` | An assignee is set | `assignee_id` |

### Notifications, security, platform
| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `notification.requested.v1` | A service wants someone told | `dedupe_key`, `channel`, `external`, recipient, `subject`, `body` |
| `notification.delivered.v1` / `failed.v1` | E-mail delivery outcome | `notification_id`, `attempts` |
| `security.access_denied.v1` | A request was refused for lack of role or rule | `username`, `method`, `path`, `reason` |
| `pipeline.run.completed.v1` | A pipeline run ends (Python, envelope-validated) | `run_id`, `status`, `events_read` |
| `ai.tool.executed.v1` | The assistant used a tool (Python, envelope-validated) | `tool`, `status`, `use_case`, `username` |

## Changing an event

- Adding an optional field: allowed (consumers ignore unknown fields).
- Removing, renaming or changing the meaning of a field: publish a new type with the next
  version suffix and keep emitting the old one until every consumer has moved.
