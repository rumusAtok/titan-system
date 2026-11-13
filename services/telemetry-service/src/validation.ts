import { z } from 'zod';

/**
 * Wire format published by a device on
 *   titan/<tenant_id>/devices/<device_id>/telemetry
 */
export const TelemetryMessage = z.object({
  /** Unique per message per device; used to drop redelivered duplicates. */
  message_id: z.string().min(1).max(128),
  /** When the device took the readings (device clock, ISO-8601 with offset). */
  observed_at: z.iso.datetime({ offset: true }),
  readings: z
    .array(
      z.object({
        sensor: z.string().min(1).max(32),
        value: z.number().refine(Number.isFinite, 'value must be finite'),
      }),
    )
    .min(1)
    .max(32),
});
export type TelemetryMessage = z.infer<typeof TelemetryMessage>;

export interface SensorSpec {
  kind: string;
  unit: string;
  min_valid: number | null;
  max_valid: number | null;
}

export type Quality = 'ok' | 'out_of_range' | 'late' | 'future_timestamp';

export interface QualityOptions {
  /** A reading older than this when received is flagged `late`. */
  lateAfterMs: number;
  /** Tolerated device clock skew into the future. */
  futureToleranceMs: number;
}

export const DEFAULT_QUALITY_OPTIONS: QualityOptions = { lateAfterMs: 10 * 60_000, futureToleranceMs: 2 * 60_000 };

/**
 * Assigns the quality flag of one reading. Readings are always stored with
 * their flag; only `ok` readings are used for alerting.
 * Precedence: an implausible timestamp or value says more than lateness.
 */
export function classify(value: number, observedAt: Date, receivedAt: Date, spec: SensorSpec, options: QualityOptions = DEFAULT_QUALITY_OPTIONS): Quality {
  if (observedAt.getTime() - receivedAt.getTime() > options.futureToleranceMs) return 'future_timestamp';
  if ((spec.min_valid !== null && value < spec.min_valid) || (spec.max_valid !== null && value > spec.max_valid)) return 'out_of_range';
  if (receivedAt.getTime() - observedAt.getTime() > options.lateAfterMs) return 'late';
  return 'ok';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOPIC = /^titan\/([^/]+)\/devices\/([^/]+)\/telemetry$/;

export const TELEMETRY_TOPIC_FILTER = 'titan/+/devices/+/telemetry';

/** Extracts tenant and device from the topic; null when the topic is not a telemetry topic. */
export function parseTopic(topic: string): { tenantId: string; deviceId: string } | null {
  const m = TOPIC.exec(topic);
  if (!m) return null;
  const tenantId = m[1]!.toLowerCase();
  const deviceId = m[2]!.toLowerCase();
  if (!UUID.test(tenantId) || !UUID.test(deviceId)) return null;
  return { tenantId, deviceId };
}
