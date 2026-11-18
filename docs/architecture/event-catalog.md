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
| `tenant.site.created.v1` | A site (plant, building, line, ...) is added | `site_id`, `code`, `kind`, `parent_id` |
| `tenant.pack.activated.v1` | A pack is activated, upgraded, reconfigured or re-synchronised | `pack_id`, `version`, `previous_version`, `reason`, `install` (templates per owning service, configuration resolved) |
| `tenant.pack.deactivated.v1` | A pack is deactivated (nothing is deleted) | `pack_id`, `version`, `deactivated_by` |
| `tenant.entitlements.changed.v1` | The capabilities or packs of a tenant change | `revision` (only grows), `capabilities`, `packs` |

### Case
| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `case.submitted.v1` | A draft is submitted | `case_id`, `reference_no`, `form_key`, `workflow_key`, `applicant_id`, `title`, `data`, `submitted_at` |
| `case.resubmitted.v1` | A returned case is resubmitted | `case_id`, `data`, `resubmitted_at` |
| `case.cancelled.v1` | A submitted case is cancelled | `case_id`, `cancelled_by` |

### Workflow
| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `workflow.start.requested.v1` | The owner of a subject asks for its process (any registered subject type) | `subject_type`, `subject_id`, `workflow_key`, `reference`, `title`, `requester_id`, `context` |
| `workflow.cancel.requested.v1` | The owner withdraws a subject | `subject_type`, `subject_id`, `cancelled_by` |
| `workflow.instance.started.v1` | A process starts for any registered subject | `instance_id`, `subject_type`, `subject_id`, `definition_key`, `definition_version` |
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
| `alert.raised.v1` | A rule is breached with no open alarm, or a device goes offline | `alert_id`, `kind`, `rule_name`, `severity`, `value`, `threshold`, `create_incident`; v3 adds optional `incident_category`, `asset_id` |
| `alert.acknowledged.v1` / `alert.cleared.v1` | Acknowledged / condition ended | `alert_id` |
| `incident.created.v1` | An incident is opened | `incident_id`, `reference_no`, `severity`, `source_type` (alert, manual, inspection, work_order, service_request, external), `source_id`; v3 adds optional `category`, `asset_id`, `workflow_key` |
| `incident.acknowledged.v1` / `incident.resolved.v1` | Response step completed | `incident_id`, actor, timestamps |
| `incident.assigned.v1` | An assignee is set | `assignee_id` |

### Maintenance (TITAN v3)
| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `maintenance.request.submitted.v1` | A maintenance or service request is raised (by a person or from an incident) | `request_id`, `reference_no`, `request_type`, `pack_id` (optional), `priority`, `origin_type`, `origin_id`, `asset_id` |
| `maintenance.request.decided.v1` | Its approval process ends, or it is withdrawn | `request_id`, `outcome`, `decided_at` |
| `maintenance.work_order.created.v1` | An approved request becomes a work order | `work_order_id`, `request_id`, `priority`, `asset_id`, `origin_*` |
| `maintenance.work_order.assigned.v1` / `started.v1` | Assigned to a technician / work started | `assignee_*` / `started_at` |
| `maintenance.work_order.completed.v1` | Work completed | `summary`, `labor_hours`, `condition_after`, `started_at`, `completed_at` |
| `maintenance.work_order.cancelled.v1` | Work order cancelled | `reason` |

The new fields of existing events are optional, so events written before v3 still validate
(this was found by the event contract test when `pack_id` was first added as required).

### Documents, zones, procurement, reports, integrations, video (after v3)
| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `document.created.v1` | A controlled document is created | `document_id`, `reference_no`, `document_type`, `classification`, `retention_class`, `links` |
| `document.version.added.v1` | A version is uploaded (and passed the scan) | `version_id`, `version`, `filename`, `size_bytes`, `sha256` |
| `document.version.published.v1` | A version is published, or its review rejected (`approved: false`) | `document_id`, `version_id`, `version`, `approved` |
| `document.legal_hold.changed.v1` / `document.disposed.v1` | Hold placed or released / content disposed of | `legal_hold`, `reason` / `versions_removed` |
| `geo.zone.created.v1` | A zone is drawn | `zone_id`, `code`, `zone_type`, `notify_role` |
| `geo.incident.in_zone.v1` | An incident is located (via its asset or device) inside a zone that watches incidents | `incident_id`, `zone_id`, `zone_code`, `latitude`, `longitude` |
| `procurement.purchase_request.submitted.v1` / `decided.v1` | A request is raised (person, low stock or work order) / its approval ends | `purchase_request_id`, `total_amount`, `currency`, `origin_type` / `outcome` |
| `procurement.purchase_order.issued.v1` | An approved request becomes a purchase order (internal record) | `purchase_order_id`, `supplier_id`, `total_amount` |
| `procurement.goods.received.v1` | A goods receipt is recorded | `lines[{item_id, sku, quantity}]`, `fully_received` |
| `procurement.stock.issued.v1` / `procurement.stock.low.v1` | Stock leaves a store / stock is at or below its reorder level | `sku`, `location`, `quantity` / `on_hand`, `reorder_level` |
| `report.generated.v1` | A report run completes | `report_run_id`, `definition_id`, `datasets`, `rows` |
| `integration.incident.reported.v1` | A **verified** inbound webhook reports an incident; incident-service creates it (source `external`, deduplicated by endpoint + external id) | `endpoint_id`, `external_id`, `title`, `severity`, `category` |
| `integration.delivery.failed.v1` | An outbound delivery gives up | `subscription_id`, `event_id`, `attempts`, `error` |
| `video.camera.registered.v1` / `status_changed.v1` | Camera registered / status changed | `camera_id`, `code`, coordinates / `from`, `to` |
| `video.session.started.v1` | Someone opened a camera's stream (audited) | `session_id`, `camera_id`, `viewer_id`, `purpose`, `incident_id` |
| `video.marker.created.v1` | A moment is marked, optionally for an incident (recorded on its timeline) | `marker_id`, `camera_id`, `recording_id`, `incident_id`, `at`, `label` |

Added in the second round (2026-11-18):

| Type | Emitted when | Key payload fields |
| --- | --- | --- |
| `maintenance.inspection.completed.v1` | An inspection round is recorded; each failed item has raised a finding request | `round_id`, `plan_code`, `asset_id`, `findings` |
| `maintenance.work_order.completed.v1` (new optional fields) | Parts used and labour cost | `parts[{sku, quantity, location}]`, `labor_cost`, `currency` |
| `procurement.stock.issued.v1` (new optional fields) | Cost of what was issued | `unit_cost`, `currency` |
| `procurement.stock.issue_failed.v1` | Parts named on a completed work order could not be booked out | `sku`, `quantity`, `location`, `reference_id`, `reason` |
| `procurement.rfq.awarded.v1` | A quotation was awarded and became a purchase request | `rfq_id`, `quotation_id`, `supplier_id`, `purchase_request_id`, `total_amount`, `lowest` |

The workflow subject type `document` was added (registry and migration 0003 of workflow-service);
`purchase_request` is now owned by procurement-service. Documents and purchase requests start
their processes with `workflow.start.requested.v1` and act on `workflow.instance.completed.v1`.

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
