import { z } from 'zod';
import { EventEnvelopeSchema, type EventEnvelope } from './envelope.js';

const uuid = z.uuid();
const ts = z.iso.datetime({ offset: true });
const nullableTs = ts.nullable();

export const SeveritySchema = z.enum(['info', 'warning', 'critical']);
export const QualitySchema = z.enum(['ok', 'out_of_range', 'late', 'future_timestamp']);
export const SubjectTypeSchema = z.enum(['case', 'incident']);
export const DecisionSchema = z.enum(['approve', 'reject', 'return']);

/**
 * Event catalog: event type -> payload schema.
 * Adding a field is backwards compatible; removing/renaming requires a new
 * version suffix (e.g. `.v2`) published alongside the old one.
 */
export const EventCatalog = {
  // --- tenant-service ---
  'tenant.created.v1': z.object({ tenant_id: uuid, name: z.string(), slug: z.string() }),
  'tenant.department.created.v1': z.object({ department_id: uuid, code: z.string(), name: z.string() }),
  'tenant.config.updated.v1': z.object({ tenant_id: uuid, keys: z.array(z.string()) }),

  // --- case-service ---
  'case.submitted.v1': z.object({
    case_id: uuid,
    reference_no: z.string(),
    form_key: z.string(),
    workflow_key: z.string(),
    applicant_id: z.string(),
    applicant_username: z.string(),
    applicant_email: z.string().nullable(),
    title: z.string(),
    data: z.record(z.string(), z.unknown()),
    submitted_at: ts,
  }),
  'case.resubmitted.v1': z.object({
    case_id: uuid,
    reference_no: z.string(),
    applicant_id: z.string(),
    data: z.record(z.string(), z.unknown()),
    resubmitted_at: ts,
  }),
  'case.cancelled.v1': z.object({ case_id: uuid, reference_no: z.string(), cancelled_by: z.string() }),

  // --- workflow-service ---
  'workflow.instance.started.v1': z.object({
    instance_id: uuid,
    subject_type: SubjectTypeSchema,
    subject_id: uuid,
    definition_key: z.string(),
    definition_version: z.number().int(),
  }),
  'workflow.task.assigned.v1': z.object({
    task_id: uuid,
    instance_id: uuid,
    subject_type: SubjectTypeSchema,
    subject_id: uuid,
    reference: z.string(),
    stage_key: z.string(),
    stage_name: z.string(),
    role: z.string(),
    due_at: nullableTs,
  }),
  'workflow.task.closed.v1': z.object({
    task_id: uuid,
    instance_id: uuid,
    subject_type: SubjectTypeSchema,
    subject_id: uuid,
    stage_key: z.string(),
    role: z.string(),
    status: z.enum(['completed', 'cancelled', 'skipped']),
    decision: DecisionSchema.nullable(),
    decided_by: z.string().nullable(),
    assigned_at: ts,
    closed_at: ts,
  }),
  'workflow.decision.approved.v1': z.object({
    decision_id: uuid,
    task_id: uuid,
    instance_id: uuid,
    subject_type: SubjectTypeSchema,
    subject_id: uuid,
    stage_key: z.string(),
    decided_by: z.string(),
    decided_by_username: z.string(),
    on_behalf_of: z.string().nullable(),
    comment: z.string().nullable(),
  }),
  'workflow.decision.rejected.v1': z.object({
    decision_id: uuid,
    task_id: uuid,
    instance_id: uuid,
    subject_type: SubjectTypeSchema,
    subject_id: uuid,
    stage_key: z.string(),
    decided_by: z.string(),
    decided_by_username: z.string(),
    on_behalf_of: z.string().nullable(),
    comment: z.string().nullable(),
  }),
  'workflow.decision.returned.v1': z.object({
    decision_id: uuid,
    task_id: uuid,
    instance_id: uuid,
    subject_type: SubjectTypeSchema,
    subject_id: uuid,
    stage_key: z.string(),
    decided_by: z.string(),
    decided_by_username: z.string(),
    on_behalf_of: z.string().nullable(),
    comment: z.string().nullable(),
  }),
  'workflow.stage.completed.v1': z.object({
    instance_id: uuid,
    subject_type: SubjectTypeSchema,
    subject_id: uuid,
    stage_key: z.string(),
    stage_name: z.string(),
    completed_by: z.string(),
    completed_by_username: z.string(),
    completed_at: ts,
  }),
  'workflow.case.returned.v1': z.object({
    instance_id: uuid,
    case_id: uuid,
    stage_key: z.string(),
    returned_by: z.string(),
    comment: z.string().nullable(),
  }),
  'workflow.case.completed.v1': z.object({
    instance_id: uuid,
    case_id: uuid,
    outcome: z.enum(['approved', 'rejected', 'cancelled']),
    decided_by: z.string().nullable(),
    started_at: ts,
    completed_at: ts,
  }),
  'workflow.instance.completed.v1': z.object({
    instance_id: uuid,
    subject_type: SubjectTypeSchema,
    subject_id: uuid,
    outcome: z.enum(['approved', 'rejected', 'cancelled']),
    started_at: ts,
    completed_at: ts,
  }),
  'workflow.task.escalated.v1': z.object({
    task_id: uuid,
    instance_id: uuid,
    subject_type: SubjectTypeSchema,
    subject_id: uuid,
    stage_key: z.string(),
    role: z.string(),
    escalate_to_role: z.string().nullable(),
    due_at: ts,
    escalated_at: ts,
  }),

  // --- asset-service ---
  'asset.created.v1': z.object({
    asset_id: uuid,
    code: z.string(),
    name: z.string(),
    category: z.string(),
    status: z.string(),
    condition: z.string(),
    parent_id: uuid.nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    next_maintenance_due: nullableTs,
  }),
  'asset.status_changed.v1': z.object({
    asset_id: uuid,
    code: z.string(),
    from: z.string(),
    to: z.string(),
    changed_by: z.string(),
  }),
  'asset.maintenance.updated.v1': z.object({
    asset_id: uuid,
    code: z.string(),
    condition: z.string(),
    last_maintained_at: nullableTs,
    next_maintenance_due: nullableTs,
  }),

  // --- device-service ---
  'device.registered.v1': z.object({
    device_id: uuid,
    serial_no: z.string(),
    name: z.string(),
    device_type: z.string(),
    asset_id: uuid.nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    expected_interval_seconds: z.number().int().positive(),
    sensors: z.array(
      z.object({
        kind: z.string(),
        unit: z.string(),
        min_valid: z.number().nullable(),
        max_valid: z.number().nullable(),
      }),
    ),
  }),
  'device.status_changed.v1': z.object({
    device_id: uuid,
    serial_no: z.string(),
    name: z.string(),
    from: z.string(),
    to: z.string(),
    last_seen_at: nullableTs,
    reason: z.string(),
  }),

  // --- telemetry-service ---
  'telemetry.device.heartbeat.v1': z.object({
    device_id: uuid,
    last_observed_at: ts,
    last_received_at: ts,
  }),
  'telemetry.measurement.accepted.v1': z.object({
    device_id: uuid,
    sensor_kind: z.string(),
    value: z.number(),
    unit: z.string(),
    quality: QualitySchema,
    message_id: z.string(),
    observed_at: ts,
    received_at: ts,
    processed_at: ts,
  }),

  // --- alert-service ---
  'alert.raised.v1': z.object({
    alert_id: uuid,
    kind: z.enum(['threshold', 'device_offline']),
    rule_id: uuid.nullable(),
    rule_name: z.string(),
    device_id: uuid,
    device_name: z.string().nullable(),
    sensor_kind: z.string().nullable(),
    severity: SeveritySchema,
    value: z.number().nullable(),
    threshold: z.number().nullable(),
    operator: z.string().nullable(),
    create_incident: z.boolean(),
    triggered_at: ts,
  }),
  'alert.acknowledged.v1': z.object({ alert_id: uuid, acknowledged_by: z.string(), acknowledged_at: ts }),
  'alert.cleared.v1': z.object({ alert_id: uuid, device_id: uuid, value: z.number().nullable(), cleared_at: ts }),

  // --- incident-service ---
  'incident.created.v1': z.object({
    incident_id: uuid,
    reference_no: z.string(),
    title: z.string(),
    severity: SeveritySchema,
    source_type: z.enum(['alert', 'manual']),
    source_id: z.string().nullable(),
    device_id: uuid.nullable(),
    created_at: ts,
  }),
  'incident.acknowledged.v1': z.object({
    incident_id: uuid,
    reference_no: z.string(),
    acknowledged_by: z.string(),
    acknowledged_at: ts,
    created_at: ts,
  }),
  'incident.assigned.v1': z.object({ incident_id: uuid, assignee_id: z.string(), assigned_by: z.string() }),
  'incident.resolved.v1': z.object({
    incident_id: uuid,
    reference_no: z.string(),
    resolved_by: z.string(),
    resolved_at: ts,
    created_at: ts,
  }),

  // --- notification-service ---
  'notification.requested.v1': z
    .object({
      dedupe_key: z.string().min(1),
      channel: z.enum(['in_app', 'email']),
      category: z.string(),
      /** true when the recipient is outside the organisation (e.g. an applicant). */
      external: z.boolean(),
      recipient_user_id: z.string().nullable(),
      recipient_role: z.string().nullable(),
      recipient_address: z.string().nullable(),
      subject: z.string(),
      body: z.string(),
      reference_type: z.string().nullable(),
      reference_id: z.string().nullable(),
    })
    .refine((v) => v.recipient_user_id !== null || v.recipient_role !== null, {
      message: 'a notification needs a recipient user or role',
    }),
  'notification.delivered.v1': z.object({
    notification_id: uuid,
    channel: z.string(),
    category: z.string(),
    attempts: z.number().int(),
  }),
  'notification.failed.v1': z.object({
    notification_id: uuid,
    channel: z.string(),
    category: z.string(),
    attempts: z.number().int(),
    error: z.string(),
  }),

  // --- cross-cutting ---
  'security.access_denied.v1': z.object({
    user_id: z.string(),
    username: z.string(),
    method: z.string(),
    path: z.string(),
    required_roles: z.array(z.string()),
    reason: z.string(),
  }),
} as const;

export type EventType = keyof typeof EventCatalog;
export type EventPayload<T extends EventType> = z.infer<(typeof EventCatalog)[T]>;

export function isKnownEventType(t: string): t is EventType {
  return Object.prototype.hasOwnProperty.call(EventCatalog, t);
}

export class EventValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: unknown,
  ) {
    super(message);
    this.name = 'EventValidationError';
  }
}

/** Validates the envelope and, when the type is catalogued, its payload. */
export function validateEvent(raw: unknown): EventEnvelope {
  const env = EventEnvelopeSchema.safeParse(raw);
  if (!env.success) throw new EventValidationError('invalid event envelope', env.error.issues);
  const e = env.data;
  if (isKnownEventType(e.event_type)) {
    const p = EventCatalog[e.event_type].safeParse(e.payload);
    if (!p.success) throw new EventValidationError(`invalid payload for ${e.event_type}`, p.error.issues);
  }
  return e;
}

export function validatePayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  const p = EventCatalog[type].safeParse(payload);
  if (!p.success) throw new EventValidationError(`invalid payload for ${type}`, p.error.issues);
  return p.data as EventPayload<T>;
}
