import { describe, expect, it } from 'vitest';
import { classify, parseTopic, type SensorSpec, TelemetryMessage } from './validation.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const spec: SensorSpec = { kind: 'water_level', unit: 'm', min_valid: 0, max_valid: 15 };
const options = { lateAfterMs: 10 * 60_000, futureToleranceMs: 2 * 60_000 };
const received = new Date('2026-06-01T12:00:00Z');
const minutes = (n: number) => new Date(received.getTime() + n * 60_000);

describe('quality classification', () => {
  it('flags a plausible, timely reading as ok', () => {
    expect(classify(2.4, minutes(0), received, spec, options)).toBe('ok');
    expect(classify(2.4, minutes(-9), received, spec, options)).toBe('ok');
  });

  it('flags values outside the sensor range', () => {
    expect(classify(-0.1, minutes(0), received, spec, options)).toBe('out_of_range');
    expect(classify(15.01, minutes(0), received, spec, options)).toBe('out_of_range');
    expect(classify(15, minutes(0), received, spec, options)).toBe('ok');
  });

  it('flags delayed data as late', () => {
    expect(classify(2.4, minutes(-11), received, spec, options)).toBe('late');
  });

  it('flags timestamps too far in the future, tolerating small clock skew', () => {
    expect(classify(2.4, minutes(1), received, spec, options)).toBe('ok');
    expect(classify(2.4, minutes(3), received, spec, options)).toBe('future_timestamp');
  });

  it('prefers the more serious flag when several apply', () => {
    expect(classify(99, minutes(-30), received, spec, options)).toBe('out_of_range');
    expect(classify(99, minutes(30), received, spec, options)).toBe('future_timestamp');
  });

  it('accepts any value when the sensor declares no range', () => {
    expect(classify(1e6, minutes(0), received, { ...spec, min_valid: null, max_valid: null }, options)).toBe('ok');
  });
});

describe('topic parsing', () => {
  it('extracts tenant and device', () => {
    expect(parseTopic(`titan/${TENANT}/devices/${DEVICE}/telemetry`)).toEqual({ tenantId: TENANT, deviceId: DEVICE });
  });

  it('rejects topics that are not telemetry topics or carry malformed ids', () => {
    expect(parseTopic(`titan/${TENANT}/devices/${DEVICE}/commands`)).toBeNull();
    expect(parseTopic(`titan/not-a-uuid/devices/${DEVICE}/telemetry`)).toBeNull();
    expect(parseTopic(`titan/${TENANT}/devices/x' OR '1'='1/telemetry`)).toBeNull();
    expect(parseTopic(`other/${TENANT}/devices/${DEVICE}/telemetry`)).toBeNull();
  });
});

describe('message schema', () => {
  const base = { message_id: 'm-1', observed_at: '2026-06-01T12:00:00Z', readings: [{ sensor: 'water_level', value: 2.4 }] };

  it('accepts a well-formed message', () => {
    expect(TelemetryMessage.safeParse(base).success).toBe(true);
  });

  it('rejects a missing message id, a bad timestamp, empty readings and non-numeric values', () => {
    expect(TelemetryMessage.safeParse({ ...base, message_id: '' }).success).toBe(false);
    expect(TelemetryMessage.safeParse({ ...base, observed_at: 'yesterday' }).success).toBe(false);
    expect(TelemetryMessage.safeParse({ ...base, readings: [] }).success).toBe(false);
    expect(TelemetryMessage.safeParse({ ...base, readings: [{ sensor: 'water_level', value: '2.4' }] }).success).toBe(false);
    expect(TelemetryMessage.safeParse({ ...base, readings: [{ sensor: 'water_level', value: Number.NaN }] }).success).toBe(false);
  });
});
