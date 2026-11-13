import { describe, expect, it } from 'vitest';
import { buildEnvelope, EventCatalog, EventValidationError, schemaVersionOf, subjectFor, validateEvent, validatePayload } from './index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';

function alertRaised() {
  return buildEnvelope({
    type: 'alert.raised.v1',
    producer: 'alert-service',
    aggregateType: 'alert',
    aggregateId: ID,
    tenantId: TENANT,
    payload: {
      alert_id: ID,
      kind: 'threshold',
      rule_id: ID,
      rule_name: 'High water level',
      device_id: ID,
      device_name: 'Sensor',
      sensor_kind: 'water_level',
      severity: 'warning',
      value: 3.9,
      threshold: 3.5,
      operator: '>',
      create_incident: true,
      triggered_at: new Date().toISOString(),
    },
  });
}

describe('event envelope', () => {
  it('carries every required metadata field', () => {
    const e = alertRaised();
    for (const field of ['event_id', 'event_type', 'schema_version', 'producer', 'aggregate_id', 'tenant_id', 'occurred_at', 'correlation_id', 'causation_id']) {
      expect(e).toHaveProperty(field);
    }
    expect(e.schema_version).toBe(1);
    expect(e.causation_id).toBeNull();
  });

  it('derives the schema version and subject from the event type', () => {
    expect(schemaVersionOf('case.submitted.v1')).toBe(1);
    expect(schemaVersionOf('case.submitted.v12')).toBe(12);
    expect(() => schemaVersionOf('case.submitted')).toThrow();
    expect(subjectFor('case.submitted.v1')).toBe('titan.events.case.submitted.v1');
  });

  it('keeps correlation and causation ids supplied by the caller', () => {
    const e = buildEnvelope({ type: 'tenant.created.v1', producer: 'x', aggregateType: 'tenant', aggregateId: ID, tenantId: TENANT, payload: {}, correlationId: 'corr-1', causationId: 'cause-1' });
    expect(e.correlation_id).toBe('corr-1');
    expect(e.causation_id).toBe('cause-1');
  });
});

describe('event validation', () => {
  it('accepts a valid catalogued event', () => {
    expect(validateEvent(JSON.parse(JSON.stringify(alertRaised()))).event_type).toBe('alert.raised.v1');
  });

  it('rejects an envelope with a missing tenant', () => {
    const { tenant_id: _omitted, ...rest } = alertRaised();
    expect(() => validateEvent(rest)).toThrow(EventValidationError);
  });

  it('rejects an event type without a version suffix', () => {
    expect(() => validateEvent({ ...alertRaised(), event_type: 'alert.raised' })).toThrow(EventValidationError);
  });

  it('rejects a payload that violates the catalogued schema', () => {
    const e = alertRaised();
    expect(() => validateEvent({ ...e, payload: { ...e.payload, severity: 'catastrophic' } })).toThrow(/invalid payload/);
  });

  it('accepts unknown event types on envelope validity alone (forward compatibility for generic consumers)', () => {
    const e = { ...alertRaised(), event_type: 'future.thing.happened.v1', payload: { anything: true } };
    expect(validateEvent(e).event_type).toBe('future.thing.happened.v1');
  });

  it('tolerates additional payload fields (additive changes are backward compatible)', () => {
    const e = alertRaised();
    expect(() => validateEvent({ ...e, payload: { ...e.payload, new_optional_field: 1 } })).not.toThrow();
  });

  it('requires a notification to have a recipient', () => {
    const base = {
      dedupe_key: 'k',
      channel: 'in_app' as const,
      category: 'c',
      external: false,
      recipient_address: null,
      subject: 's',
      body: 'b',
      reference_type: null,
      reference_id: null,
    };
    expect(() => validatePayload('notification.requested.v1', { ...base, recipient_user_id: null, recipient_role: null })).toThrow();
    expect(() => validatePayload('notification.requested.v1', { ...base, recipient_user_id: null, recipient_role: 'duty_officer' })).not.toThrow();
  });

  it('names every catalogued event with a domain, an action and a version', () => {
    for (const type of Object.keys(EventCatalog)) expect(type).toMatch(/^[a-z_]+(\.[a-z_]+)+\.v\d+$/);
  });
});
