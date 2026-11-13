import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import type { EventEnvelope, EventPayload } from '@titan/contracts';
import { counter, type Logger, newContext, runWithContext } from '@titan/observability';
import { Db, DomainError, EventConsumers, LOGGER, Outbox, type Q } from '@titan/platform';
import mqtt, { type MqttClient } from 'mqtt';
import { z } from 'zod';
import { classify, DEFAULT_QUALITY_OPTIONS, parseTopic, type SensorSpec, TELEMETRY_TOPIC_FILTER, TelemetryMessage } from './validation.js';

export const SeriesQuery = z.object({
  device_id: z.uuid(),
  sensor_kind: z.string().min(1).max(32),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  bucket_seconds: z.coerce.number().int().min(1).max(86_400).default(60),
});

export const MeasurementsQuery = z.object({
  device_id: z.uuid(),
  sensor_kind: z.string().min(1).max(32).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
});

const messagesIngested = counter('titan_telemetry_messages_total', 'MQTT telemetry messages by outcome', ['outcome']);
const readingsStored = counter('titan_telemetry_readings_total', 'Readings by result (stored|duplicate) and quality', ['result', 'quality']);

const HEARTBEAT_EVERY_MS = Number(process.env.HEARTBEAT_EVERY_MS ?? 10_000);
const RETENTION_MONTHS = Number(process.env.TELEMETRY_RETENTION_MONTHS ?? 24);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface IngestResult {
  outcome: 'accepted' | 'rejected';
  reason?: string;
  stored: number;
  duplicates: number;
}

@Injectable()
export class TelemetryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private client?: MqttClient;
  private maintenanceTimer?: NodeJS.Timeout;
  private readonly lastHeartbeat = new Map<string, number>();
  private mqttConnected = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({
      subjects: ['device.registered.v1', 'device.status_changed.v1'],
      handler: (event, q) => this.onDeviceEvent(event, q),
    });
    this.connectMqtt();
    void this.maintainPartitions();
    this.maintenanceTimer = setInterval(() => void this.maintainPartitions(), DAY_MS);
    this.maintenanceTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.maintenanceTimer);
    await this.client?.endAsync().catch(() => undefined);
  }

  get brokerConnected(): boolean {
    return this.mqttConnected;
  }

  // ---------------------------------------------------------------------------
  // MQTT
  // ---------------------------------------------------------------------------

  private connectMqtt(): void {
    const url = process.env.MQTT_URL;
    if (!url) {
      this.logger.warn('MQTT_URL not set; MQTT ingestion disabled');
      return;
    }
    const client = mqtt.connect(url, {
      // A fixed client id with a persistent session: the broker queues QoS 1
      // messages while this service is down and delivers them on reconnect.
      clientId: process.env.MQTT_CLIENT_ID ?? 'telemetry-service',
      clean: false,
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
      reconnectPeriod: 2_000,
      connectTimeout: 10_000,
    });
    this.client = client;

    // Acknowledge (PUBACK) a message only after it has been handled, so a
    // crash or database outage mid-message leads to redelivery, not loss.
    client.handleMessage = (packet, done) => {
      const received = new Date();
      this.ingest(packet.topic, packet.payload as Buffer, received).then(
        () => done(),
        (err: Error) => {
          this.logger.error({ error: err.message, topic: packet.topic }, 'telemetry message could not be stored; forcing redelivery');
          messagesIngested.inc({ outcome: 'error' });
          // Not acknowledged. Dropping the connection makes the broker
          // redeliver unacknowledged messages when the session resumes.
          setTimeout(() => client.reconnect(), 1_000);
        },
      );
    };

    client.on('connect', () => {
      this.mqttConnected = true;
      client.subscribe(TELEMETRY_TOPIC_FILTER, { qos: 1 }, (err) => {
        if (err) this.logger.error({ error: err.message }, 'MQTT subscribe failed');
        else this.logger.info({ filter: TELEMETRY_TOPIC_FILTER }, 'subscribed to telemetry topics');
      });
    });
    client.on('close', () => {
      this.mqttConnected = false;
    });
    client.on('error', (err) => this.logger.warn({ error: err.message }, 'MQTT error'));
  }

  // ---------------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------------

  /**
   * Validates and stores one telemetry message.
   * Throws only for infrastructure failures (so the message is redelivered);
   * invalid messages are recorded as rejected and resolve normally.
   */
  async ingest(topic: string, raw: Buffer, receivedAt: Date): Promise<IngestResult> {
    const address = parseTopic(topic);
    if (!address) {
      messagesIngested.inc({ outcome: 'rejected' });
      this.logger.warn({ topic }, 'telemetry on a malformed topic ignored');
      return { outcome: 'rejected', reason: 'malformed_topic', stored: 0, duplicates: 0 };
    }
    const text = raw.toString('utf8');
    let message: TelemetryMessage | undefined;
    let parseError: string | undefined;
    try {
      const parsed = TelemetryMessage.safeParse(JSON.parse(text));
      if (parsed.success) message = parsed.data;
      else parseError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } catch {
      parseError = 'payload is not valid JSON';
    }

    const ctx = newContext({ actor: { id: address.deviceId, type: 'device' } });
    const result = await runWithContext(ctx, () =>
      // The tenant comes from the topic, but is only trusted if the device is
      // registered under that tenant: the lookup below runs under that
      // tenant's row-level security.
      this.db.tx(address.tenantId, async (q): Promise<IngestResult> => {
        const device = await q.maybeOne<{ active: boolean; sensors: SensorSpec[] }>('SELECT active, sensors FROM device_projection WHERE device_id = $1', [address.deviceId]);
        if (!device || !device.active) {
          // No tenant can be confirmed for an unknown device, so nothing is written under the claimed tenant.
          return { outcome: 'rejected', reason: 'unknown_device', stored: 0, duplicates: 0 };
        }
        if (!message) {
          await this.reject(q, address, topic, 'invalid_payload', parseError ?? null, text);
          return { outcome: 'rejected', reason: 'invalid_payload', stored: 0, duplicates: 0 };
        }

        const observedAt = new Date(message.observed_at);
        const specs = new Map(device.sensors.map((s) => [s.kind, s]));
        let stored = 0;
        let duplicates = 0;
        const unknown: string[] = [];

        for (const reading of message.readings) {
          const spec = specs.get(reading.sensor);
          if (!spec) {
            unknown.push(reading.sensor);
            continue;
          }
          const quality = classify(reading.value, observedAt, receivedAt, spec, DEFAULT_QUALITY_OPTIONS);
          const inserted = await q.maybeOne<{ processed_at: Date }>(
            `INSERT INTO measurements (tenant_id, device_id, sensor_kind, value, unit, quality, message_id, observed_at, received_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT DO NOTHING
             RETURNING processed_at`,
            [address.tenantId, address.deviceId, spec.kind, reading.value, spec.unit, quality, message.message_id, observedAt, receivedAt],
          );
          if (!inserted) {
            // Same device, sensor, timestamp and message id: a redelivery.
            duplicates += 1;
            readingsStored.inc({ result: 'duplicate', quality });
            continue;
          }
          stored += 1;
          readingsStored.inc({ result: 'stored', quality });
          // Delayed data must not overwrite a newer "latest" value.
          await q.exec(
            `INSERT INTO latest_measurements (device_id, sensor_kind, tenant_id, value, unit, quality, observed_at, received_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (device_id, sensor_kind) DO UPDATE
               SET value = EXCLUDED.value, unit = EXCLUDED.unit, quality = EXCLUDED.quality,
                   observed_at = EXCLUDED.observed_at, received_at = EXCLUDED.received_at
             WHERE latest_measurements.observed_at < EXCLUDED.observed_at`,
            [address.deviceId, spec.kind, address.tenantId, reading.value, spec.unit, quality, observedAt, receivedAt],
          );
          await this.outbox.emit(q, {
            type: 'telemetry.measurement.accepted.v1',
            aggregateType: 'device',
            aggregateId: address.deviceId,
            tenantId: address.tenantId,
            occurredAt: receivedAt,
            payload: {
              device_id: address.deviceId,
              sensor_kind: spec.kind,
              value: reading.value,
              unit: spec.unit,
              quality,
              message_id: message.message_id,
              observed_at: observedAt.toISOString(),
              received_at: receivedAt.toISOString(),
              processed_at: inserted.processed_at.toISOString(),
            },
          });
        }

        if (unknown.length) await this.reject(q, address, topic, 'unknown_sensor', unknown.join(', '), text);

        // Tell device-service the device is alive, at most once per interval.
        const last = this.lastHeartbeat.get(address.deviceId) ?? 0;
        if (stored > 0 && receivedAt.getTime() - last >= HEARTBEAT_EVERY_MS) {
          await this.outbox.emit(q, {
            type: 'telemetry.device.heartbeat.v1',
            aggregateType: 'device',
            aggregateId: address.deviceId,
            tenantId: address.tenantId,
            occurredAt: receivedAt,
            payload: { device_id: address.deviceId, last_observed_at: observedAt.toISOString(), last_received_at: receivedAt.toISOString() },
          });
          this.lastHeartbeat.set(address.deviceId, receivedAt.getTime());
        }
        return { outcome: 'accepted', stored, duplicates };
      }),
    );

    messagesIngested.inc({ outcome: result.outcome === 'accepted' ? (result.stored === 0 && result.duplicates > 0 ? 'duplicate' : 'accepted') : 'rejected' });
    if (result.reason === 'unknown_device') this.logger.warn({ topic }, 'telemetry from an unregistered or inactive device ignored');
    return result;
  }

  private reject(q: Q, address: { tenantId: string; deviceId: string }, topic: string, reason: string, detail: string | null, payload: string) {
    return q.exec('INSERT INTO rejected_messages (tenant_id, device_id, topic, reason, detail, payload) VALUES ($1, $2, $3, $4, $5, $6)', [
      address.tenantId,
      address.deviceId,
      topic,
      reason,
      detail,
      payload.slice(0, 8_000),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Device projection
  // ---------------------------------------------------------------------------

  private async onDeviceEvent(event: EventEnvelope, q: Q): Promise<void> {
    if (event.event_type === 'device.registered.v1') {
      const p = event.payload as EventPayload<'device.registered.v1'>;
      await q.exec(
        `INSERT INTO device_projection (device_id, tenant_id, serial_no, name, sensors)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (device_id) DO UPDATE SET serial_no = EXCLUDED.serial_no, name = EXCLUDED.name, sensors = EXCLUDED.sensors, updated_at = now()`,
        [p.device_id, event.tenant_id, p.serial_no, p.name, JSON.stringify(p.sensors)],
      );
    } else if (event.event_type === 'device.status_changed.v1') {
      const p = event.payload as EventPayload<'device.status_changed.v1'>;
      if (p.to === 'decommissioned') await q.exec('UPDATE device_projection SET active = false, updated_at = now() WHERE device_id = $1', [p.device_id]);
    }
  }

  // ---------------------------------------------------------------------------
  // Partition maintenance and retention
  // ---------------------------------------------------------------------------

  async maintainPartitions(): Promise<void> {
    try {
      await this.db.tx(null, async (q) => {
        const { created } = await q.one<{ created: number }>('SELECT ensure_measurement_partitions(1, 2) AS created');
        const { dropped } = await q.one<{ dropped: number }>('SELECT drop_expired_measurement_partitions($1) AS dropped', [RETENTION_MONTHS]);
        if (created || dropped) this.logger.info({ created, dropped, retention_months: RETENTION_MONTHS }, 'measurement partitions maintained');
      });
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'partition maintenance failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  latest(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT l.device_id, d.name AS device_name, d.serial_no, l.sensor_kind, l.value, l.unit, l.quality, l.observed_at, l.received_at
           FROM latest_measurements l JOIN device_projection d ON d.device_id = l.device_id
          ORDER BY d.name, l.sensor_kind`,
      ),
    );
  }

  measurements(user: Principal, query: z.infer<typeof MeasurementsQuery>) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT device_id, sensor_kind, value, unit, quality, message_id, observed_at, received_at, processed_at
           FROM measurements
          WHERE device_id = $1
            AND ($2::text IS NULL OR sensor_kind = $2)
            AND observed_at >= COALESCE($3::timestamptz, now() - interval '1 hour')
            AND observed_at < COALESCE($4::timestamptz, now() + interval '1 day')
          ORDER BY observed_at DESC
          LIMIT $5`,
        [query.device_id, query.sensor_kind ?? null, query.from ?? null, query.to ?? null, query.limit],
      ),
    );
  }

  /** Down-sampled series for charts: avg/min/max per time bucket, `ok` readings only. */
  series(user: Principal, query: z.infer<typeof SeriesQuery>) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 60 * 60_000);
    if (from >= to) throw DomainError.invalid('from must be before to');
    if ((to.getTime() - from.getTime()) / 1000 / query.bucket_seconds > 5_000) {
      throw DomainError.invalid('the range would produce more than 5000 points; use a larger bucket_seconds');
    }
    return this.db.tx(user.tenantId, async (q) => {
      const points = await q.query(
        `SELECT date_bin(make_interval(secs => $5), observed_at, $3::timestamptz) AS bucket,
                round(avg(value)::numeric, 4) AS avg, min(value) AS min, max(value) AS max, count(*)::int AS samples
           FROM measurements
          WHERE device_id = $1 AND sensor_kind = $2 AND observed_at >= $3 AND observed_at < $4 AND quality = 'ok'
          GROUP BY bucket
          ORDER BY bucket`,
        [query.device_id, query.sensor_kind, from, to, query.bucket_seconds],
      );
      return { device_id: query.device_id, sensor_kind: query.sensor_kind, from, to, bucket_seconds: query.bucket_seconds, points };
    });
  }

  ingestStats(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const byQuality = await q.query(
        `SELECT quality, count(*)::int AS count FROM measurements WHERE received_at >= now() - interval '1 hour' GROUP BY quality ORDER BY quality`,
      );
      const lag = await q.one(
        `SELECT round((avg(extract(epoch FROM received_at - observed_at)) * 1000)::numeric, 0) AS avg_transport_ms,
                round((avg(extract(epoch FROM processed_at - received_at)) * 1000)::numeric, 0) AS avg_processing_ms
           FROM measurements WHERE received_at >= now() - interval '1 hour' AND quality = 'ok'`,
      );
      const rejected = await q.query(
        `SELECT reason, count(*)::int AS count FROM rejected_messages WHERE received_at >= now() - interval '1 hour' GROUP BY reason ORDER BY reason`,
      );
      return { window: 'last_hour', mqtt_connected: this.mqttConnected, readings_by_quality: byQuality, latency: lag, rejected };
    });
  }
}
