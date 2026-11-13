import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Tenant id used for platform-level events that do not belong to a single tenant. */
export const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export const EVENT_STREAM = 'TITAN_EVENTS';
export const EVENT_SUBJECT_PREFIX = 'titan.events.';
export const DLQ_STREAM = 'TITAN_DLQ';
export const DLQ_SUBJECT_PREFIX = 'titan.dlq.';

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v\d+$/;

export const ActorSchema = z.object({
  id: z.string().min(1),
  username: z.string().optional(),
  type: z.enum(['user', 'service', 'system', 'device']),
});
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Canonical event envelope. Every durable business event published to
 * JetStream must satisfy this schema (see docs/architecture/event-catalog.md).
 */
export const EventEnvelopeSchema = z.object({
  event_id: z.uuid(),
  event_type: z.string().regex(EVENT_TYPE_PATTERN),
  schema_version: z.number().int().positive(),
  producer: z.string().min(1),
  aggregate_type: z.string().min(1),
  aggregate_id: z.string().min(1),
  tenant_id: z.uuid(),
  occurred_at: z.iso.datetime({ offset: true }),
  correlation_id: z.string().min(1),
  causation_id: z.string().nullable(),
  actor: ActorSchema.nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope<P = Record<string, unknown>> = Omit<z.infer<typeof EventEnvelopeSchema>, 'payload'> & {
  payload: P;
};

export function subjectFor(eventType: string): string {
  return EVENT_SUBJECT_PREFIX + eventType;
}

export function schemaVersionOf(eventType: string): number {
  const m = /\.v(\d+)$/.exec(eventType);
  if (!m) throw new Error(`event type '${eventType}' has no version suffix`);
  return Number(m[1]);
}

export interface NewEvent {
  type: string;
  producer: string;
  aggregateType: string;
  aggregateId: string;
  tenantId: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  causationId?: string | null;
  actor?: Actor | null;
  occurredAt?: Date;
}

export function buildEnvelope(e: NewEvent): EventEnvelope {
  return {
    event_id: randomUUID(),
    event_type: e.type,
    schema_version: schemaVersionOf(e.type),
    producer: e.producer,
    aggregate_type: e.aggregateType,
    aggregate_id: e.aggregateId,
    tenant_id: e.tenantId,
    occurred_at: (e.occurredAt ?? new Date()).toISOString(),
    correlation_id: e.correlationId ?? randomUUID(),
    causation_id: e.causationId ?? null,
    actor: e.actor ?? null,
    payload: e.payload,
  };
}
