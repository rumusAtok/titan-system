import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import type { EventEnvelope, EventPayload } from '@titan/contracts';
import { type Logger, newContext, runWithContext } from '@titan/observability';
import { Db, DomainError, EventConsumers, LOGGER, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';

export const SensorInput = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    unit: z.string().min(1).max(16),
    min_valid: z.number().nullable().default(null),
    max_valid: z.number().nullable().default(null),
  })
  .refine((s) => s.min_valid === null || s.max_valid === null || s.min_valid < s.max_valid, { message: 'min_valid must be below max_valid' });

export const RegisterDevice = z
  .object({
    serial_no: z.string().min(3).max(64),
    name: z.string().min(2).max(200),
    device_type: z.string().min(2).max(64),
    asset_id: z.uuid().nullable().default(null),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
    expected_interval_seconds: z.number().int().min(1).max(86_400).default(30),
    config: z.record(z.string(), z.unknown()).default({}),
    sensors: z.array(SensorInput).min(1).max(32),
  })
  .refine((d) => (d.latitude === null) === (d.longitude === null), { message: 'latitude and longitude must be given together' })
  .refine((d) => new Set(d.sensors.map((s) => s.kind)).size === d.sensors.length, { message: 'sensor kinds must be distinct' });

export const UpdateConfig = z.object({
  config: z.record(z.string(), z.unknown()),
  expected_version: z.number().int().positive(),
});

export const ListDevices = z.object({
  status: z.enum(['registered', 'online', 'offline', 'decommissioned']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export interface DeviceRow {
  id: string;
  tenant_id: string;
  serial_no: string;
  name: string;
  device_type: string;
  asset_id: string | null;
  latitude: number | null;
  longitude: number | null;
  status: 'registered' | 'online' | 'offline' | 'decommissioned';
  expected_interval_seconds: number;
  config: Record<string, unknown>;
  last_seen_at: Date | null;
  version: number;
  registered_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, tenant_id, serial_no, name, device_type, asset_id, latitude, longitude, status, expected_interval_seconds,
  config, last_seen_at, version, registered_at, updated_at`;

const OFFLINE_SWEEP_MS = Number(process.env.OFFLINE_SWEEP_MS ?? 10_000);
const MIN_SILENCE_SECONDS = Number(process.env.OFFLINE_MIN_SILENCE_SECONDS ?? 20);

@Injectable()
export class DeviceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({ subjects: ['telemetry.device.heartbeat.v1'], handler: (event, q) => this.onHeartbeat(event, q) });
    this.timer = setInterval(() => void this.sweepOffline(), OFFLINE_SWEEP_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  register(user: Principal, input: z.infer<typeof RegisterDevice>) {
    return this.db.tx(user.tenantId, async (q) => {
      const device = await q.one<DeviceRow>(
        `INSERT INTO devices (tenant_id, serial_no, name, device_type, asset_id, latitude, longitude, expected_interval_seconds, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
        [
          user.tenantId,
          input.serial_no,
          input.name,
          input.device_type,
          input.asset_id,
          input.latitude,
          input.longitude,
          input.expected_interval_seconds,
          JSON.stringify(input.config),
        ],
      );
      for (const s of input.sensors) {
        await q.exec('INSERT INTO sensors (tenant_id, device_id, kind, unit, min_valid, max_valid) VALUES ($1, $2, $3, $4, $5, $6)', [
          user.tenantId,
          device.id,
          s.kind,
          s.unit,
          s.min_valid,
          s.max_valid,
        ]);
      }
      await q.exec(`INSERT INTO device_status_history (tenant_id, device_id, from_status, to_status, reason) VALUES ($1, $2, NULL, 'registered', $3)`, [
        user.tenantId,
        device.id,
        `registered by ${user.username}`,
      ]);
      // Other services (telemetry, alerting) build their local projection of the device from this event.
      await this.outbox.emit(q, {
        type: 'device.registered.v1',
        aggregateType: 'device',
        aggregateId: device.id,
        tenantId: user.tenantId,
        payload: {
          device_id: device.id,
          serial_no: device.serial_no,
          name: device.name,
          device_type: device.device_type,
          asset_id: device.asset_id,
          latitude: device.latitude,
          longitude: device.longitude,
          expected_interval_seconds: device.expected_interval_seconds,
          sensors: input.sensors,
        },
      });
      return { ...device, sensors: input.sensors };
    });
  }

  list(user: Principal, query: z.infer<typeof ListDevices>) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT ${COLUMNS},
                (SELECT COALESCE(json_agg(json_build_object('kind', s.kind, 'unit', s.unit, 'min_valid', s.min_valid, 'max_valid', s.max_valid) ORDER BY s.kind), '[]'::json)
                   FROM sensors s WHERE s.device_id = devices.id) AS sensors
           FROM devices
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY name
          LIMIT $2`,
        [query.status ?? null, query.limit],
      ),
    );
  }

  get(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const device = await q.maybeOne<DeviceRow>(`SELECT ${COLUMNS} FROM devices WHERE id = $1`, [id]);
      if (!device) throw DomainError.notFound('device');
      const sensors = await q.query('SELECT kind, unit, min_valid, max_valid FROM sensors WHERE device_id = $1 ORDER BY kind', [id]);
      const history = await q.query('SELECT from_status, to_status, reason, changed_at FROM device_status_history WHERE device_id = $1 ORDER BY changed_at DESC LIMIT 50', [id]);
      return { ...device, sensors, history };
    });
  }

  updateConfig(user: Principal, id: string, input: z.infer<typeof UpdateConfig>) {
    return this.db.tx(user.tenantId, async (q) => {
      const updated = await q.maybeOne<DeviceRow>(
        `UPDATE devices SET config = $2, version = version + 1, updated_at = now() WHERE id = $1 AND version = $3 RETURNING ${COLUMNS}`,
        [id, JSON.stringify(input.config), input.expected_version],
      );
      if (updated) return updated;
      if (!(await q.maybeOne('SELECT 1 FROM devices WHERE id = $1', [id]))) throw DomainError.notFound('device');
      throw DomainError.conflict('stale_version', 'the device was changed elsewhere; reload and retry');
    });
  }

  decommission(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const device = await q.maybeOne<DeviceRow>(`SELECT ${COLUMNS} FROM devices WHERE id = $1 FOR UPDATE`, [id]);
      if (!device) throw DomainError.notFound('device');
      if (device.status === 'decommissioned') return device;
      return this.setStatus(q, device, 'decommissioned', `decommissioned by ${user.username}`);
    });
  }

  summary(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const byStatus = await q.query<{ status: string; count: number }>('SELECT status, count(*)::int AS count FROM devices GROUP BY status ORDER BY status');
      const count = (s: string) => byStatus.find((r) => r.status === s)?.count ?? 0;
      const inService = count('online') + count('offline');
      return {
        by_status: byStatus,
        in_service: inService,
        online: count('online'),
        // Share of in-service devices currently reporting; null until a device has reported.
        availability_pct: inService ? Math.round((count('online') / inService) * 1000) / 10 : null,
      };
    });
  }

  private async setStatus(q: Q, device: DeviceRow, to: DeviceRow['status'], reason: string): Promise<DeviceRow> {
    const updated = await q.one<DeviceRow>(`UPDATE devices SET status = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [
      device.id,
      to,
    ]);
    await q.exec('INSERT INTO device_status_history (tenant_id, device_id, from_status, to_status, reason) VALUES ($1, $2, $3, $4, $5)', [
      device.tenant_id,
      device.id,
      device.status,
      to,
      reason,
    ]);
    await this.emitStatusChanged(q, updated, device.status, reason);
    return updated;
  }

  private emitStatusChanged(q: Q, device: Pick<DeviceRow, 'id' | 'tenant_id' | 'serial_no' | 'name' | 'status' | 'last_seen_at'>, from: string, reason: string) {
    return this.outbox.emit(q, {
      type: 'device.status_changed.v1',
      aggregateType: 'device',
      aggregateId: device.id,
      tenantId: device.tenant_id,
      payload: {
        device_id: device.id,
        serial_no: device.serial_no,
        name: device.name,
        from,
        to: device.status,
        last_seen_at: device.last_seen_at ? device.last_seen_at.toISOString() : null,
        reason,
      },
    });
  }

  /** Telemetry arrived for the device: remember when, and bring it (back) online. */
  private async onHeartbeat(event: EventEnvelope, q: Q): Promise<void> {
    const p = event.payload as EventPayload<'telemetry.device.heartbeat.v1'>;
    const device = await q.maybeOne<DeviceRow>(`SELECT ${COLUMNS} FROM devices WHERE id = $1 FOR UPDATE`, [p.device_id]);
    if (!device || device.status === 'decommissioned') return;
    // Heartbeats can arrive out of order; last_seen_at only moves forward.
    const seen = await q.one<DeviceRow>(`UPDATE devices SET last_seen_at = GREATEST(COALESCE(last_seen_at, $2), $2) WHERE id = $1 RETURNING ${COLUMNS}`, [
      device.id,
      p.last_received_at,
    ]);
    if (device.status === 'online') return;
    // A stale heartbeat (e.g. replayed after an outage) must not resurrect a device that is silent now.
    const silenceMs = Date.now() - (seen.last_seen_at?.getTime() ?? 0);
    if (silenceMs > Math.max(device.expected_interval_seconds * 3, MIN_SILENCE_SECONDS) * 1000) return;
    await this.setStatus(q, seen, 'online', 'telemetry received');
  }

  /** Marks devices offline when they stop reporting. */
  async sweepOffline(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const ctx = newContext({ actor: { id: 'device-service', type: 'system' } });
      return await runWithContext(ctx, () =>
        this.db.tx(null, async (q) => {
          const silent = await q.query<{ device_id: string; tenant_id: string; serial_no: string; name: string; last_seen_at: Date | null }>(
            'SELECT device_id, tenant_id, serial_no, name, last_seen_at FROM devices_mark_offline($1)',
            [MIN_SILENCE_SECONDS],
          );
          for (const d of silent) {
            // Same transaction as the status change made by the function (outbox has no tenant policy).
            await this.emitStatusChanged(
              q,
              { id: d.device_id, tenant_id: d.tenant_id, serial_no: d.serial_no, name: d.name, status: 'offline', last_seen_at: d.last_seen_at },
              'online',
              'no telemetry received within the expected interval',
            );
          }
          return silent.length;
        }),
      );
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'offline sweep failed');
      return 0;
    } finally {
      this.sweeping = false;
    }
  }
}
