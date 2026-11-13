import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import { type EventEnvelope, type EventPayload, Roles } from '@titan/contracts';
import { type Logger, newContext, runWithContext } from '@titan/observability';
import { Db, DomainError, EventConsumers, LOGGER, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { clearThresholdIsConsistent, evaluate, OPERATOR_SYMBOL, type Operator } from './rules.js';

const RuleBase = z.object({
  name: z.string().min(2).max(200),
  sensor_kind: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  device_id: z.uuid().nullable().default(null),
  operator: z.enum(['gt', 'gte', 'lt', 'lte']),
  threshold: z.number(),
  clear_threshold: z.number().nullable().default(null),
  severity: z.enum(['info', 'warning', 'critical']),
  create_incident: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

export const CreateRule = RuleBase.refine(clearThresholdIsConsistent, {
  message: 'clear_threshold must be on the safe side of threshold',
  path: ['clear_threshold'],
});

// Declared explicitly (not derived with .partial()) so that an omitted field
// means "leave unchanged" and never picks up a creation default.
export const UpdateRule = z.object({
  name: z.string().min(2).max(200).optional(),
  operator: z.enum(['gt', 'gte', 'lt', 'lte']).optional(),
  threshold: z.number().optional(),
  clear_threshold: z.number().nullable().optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  create_incident: z.boolean().optional(),
  enabled: z.boolean().optional(),
  expected_version: z.number().int().positive(),
});

export const ListAlerts = z.object({
  status: z.enum(['active', 'acknowledged', 'cleared', 'open']).optional(),
  device_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export interface RuleRow {
  id: string;
  tenant_id: string;
  name: string;
  sensor_kind: string;
  device_id: string | null;
  operator: Operator;
  threshold: number;
  clear_threshold: number | null;
  severity: 'info' | 'warning' | 'critical';
  create_incident: boolean;
  enabled: boolean;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface AlertRow {
  id: string;
  tenant_id: string;
  kind: 'threshold' | 'device_offline';
  rule_id: string | null;
  rule_name: string;
  device_id: string;
  device_name: string | null;
  sensor_kind: string | null;
  severity: 'info' | 'warning' | 'critical';
  status: 'active' | 'acknowledged' | 'cleared';
  operator: string | null;
  threshold: number | null;
  trigger_value: number | null;
  last_value: number | null;
  occurrences: number;
  first_triggered_at: Date;
  last_triggered_at: Date;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  escalated_at: Date | null;
  cleared_at: Date | null;
}

const RULE_COLUMNS = `id, tenant_id, name, sensor_kind, device_id, operator, threshold, clear_threshold, severity, create_incident, enabled,
  version, created_by, created_at, updated_at`;
const ALERT_COLUMNS = `id, tenant_id, kind, rule_id, rule_name, device_id, device_name, sensor_kind, severity, status, operator, threshold,
  trigger_value, last_value, occurrences, first_triggered_at, last_triggered_at, acknowledged_by, acknowledged_at, escalated_at, cleared_at`;

const ESCALATION_SECONDS = Number(process.env.ALERT_ESCALATION_SECONDS ?? 300);
const ESCALATION_SWEEP_MS = Number(process.env.ALERT_ESCALATION_SWEEP_MS ?? 15_000);
const OFFLINE_CREATES_INCIDENT = ['1', 'true', 'yes'].includes((process.env.OFFLINE_ALERT_CREATES_INCIDENT ?? 'false').toLowerCase());

@Injectable()
export class AlertService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({
      subjects: ['telemetry.measurement.accepted.v1', 'device.registered.v1', 'device.status_changed.v1'],
      handler: (event, q) => this.onEvent(event, q),
    });
    this.timer = setInterval(() => void this.sweepEscalations(), ESCALATION_SWEEP_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  listRules(user: Principal) {
    return this.db.tx(user.tenantId, (q) => q.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM alert_rules ORDER BY name`));
  }

  createRule(user: Principal, input: z.infer<typeof CreateRule>) {
    return this.db.tx(user.tenantId, (q) =>
      q.one<RuleRow>(
        `INSERT INTO alert_rules (tenant_id, name, sensor_kind, device_id, operator, threshold, clear_threshold, severity, create_incident, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${RULE_COLUMNS}`,
        [
          user.tenantId,
          input.name,
          input.sensor_kind,
          input.device_id,
          input.operator,
          input.threshold,
          input.clear_threshold,
          input.severity,
          input.create_incident,
          input.enabled,
          user.username,
        ],
      ),
    );
  }

  updateRule(user: Principal, id: string, input: z.infer<typeof UpdateRule>) {
    return this.db.tx(user.tenantId, async (q) => {
      const current = await q.maybeOne<RuleRow>(`SELECT ${RULE_COLUMNS} FROM alert_rules WHERE id = $1 FOR UPDATE`, [id]);
      if (!current) throw DomainError.notFound('alert rule');
      if (current.version !== input.expected_version) throw DomainError.conflict('stale_version', 'the rule was changed elsewhere; reload and retry');
      const next = {
        name: input.name ?? current.name,
        operator: input.operator ?? current.operator,
        threshold: input.threshold ?? current.threshold,
        clear_threshold: input.clear_threshold === undefined ? current.clear_threshold : input.clear_threshold,
        severity: input.severity ?? current.severity,
        create_incident: input.create_incident ?? current.create_incident,
        enabled: input.enabled ?? current.enabled,
      };
      if (!clearThresholdIsConsistent(next)) throw DomainError.invalid('clear_threshold must be on the safe side of threshold');
      return q.one<RuleRow>(
        `UPDATE alert_rules
            SET name = $2, operator = $3, threshold = $4, clear_threshold = $5, severity = $6, create_incident = $7, enabled = $8,
                version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING ${RULE_COLUMNS}`,
        [id, next.name, next.operator, next.threshold, next.clear_threshold, next.severity, next.create_incident, next.enabled],
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Alerts
  // ---------------------------------------------------------------------------

  listAlerts(user: Principal, query: z.infer<typeof ListAlerts>) {
    return this.db.tx(user.tenantId, (q) => {
      const statuses = query.status === 'open' ? ['active', 'acknowledged'] : query.status ? [query.status] : null;
      return q.query<AlertRow>(
        `SELECT ${ALERT_COLUMNS} FROM alerts
          WHERE ($1::text[] IS NULL OR status = ANY($1)) AND ($2::uuid IS NULL OR device_id = $2)
          ORDER BY last_triggered_at DESC
          LIMIT $3`,
        [statuses, query.device_id ?? null, query.limit],
      );
    });
  }

  getAlert(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const alert = await q.maybeOne<AlertRow>(`SELECT ${ALERT_COLUMNS} FROM alerts WHERE id = $1`, [id]);
      if (!alert) throw DomainError.notFound('alert');
      return alert;
    });
  }

  acknowledge(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const alert = await q.maybeOne<AlertRow>(`SELECT ${ALERT_COLUMNS} FROM alerts WHERE id = $1 FOR UPDATE`, [id]);
      if (!alert) throw DomainError.notFound('alert');
      if (alert.status !== 'active') throw DomainError.conflict('invalid_state', `the alert is already ${alert.status}`);
      const now = new Date();
      const updated = await q.one<AlertRow>(
        `UPDATE alerts SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3 WHERE id = $1 RETURNING ${ALERT_COLUMNS}`,
        [id, user.username, now],
      );
      await this.outbox.emit(q, {
        type: 'alert.acknowledged.v1',
        aggregateType: 'alert',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: { alert_id: id, acknowledged_by: user.userId, acknowledged_at: now.toISOString() },
      });
      return updated;
    });
  }

  summary(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const open = await q.query(`SELECT severity, status, count(*)::int AS count FROM alerts WHERE status IN ('active', 'acknowledged') GROUP BY severity, status ORDER BY 1, 2`);
      const last24h = await q.one(`SELECT count(*)::int AS raised FROM alerts WHERE first_triggered_at >= now() - interval '24 hours'`);
      return { open, last_24_hours: last24h };
    });
  }

  // ---------------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------------

  private async onEvent(event: EventEnvelope, q: Q): Promise<void> {
    switch (event.event_type) {
      case 'telemetry.measurement.accepted.v1':
        return this.onMeasurement(event.tenant_id, event.payload as EventPayload<'telemetry.measurement.accepted.v1'>, q);
      case 'device.registered.v1': {
        const p = event.payload as EventPayload<'device.registered.v1'>;
        await q.exec('INSERT INTO device_names (device_id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (device_id) DO UPDATE SET name = EXCLUDED.name', [
          p.device_id,
          event.tenant_id,
          p.name,
        ]);
        return;
      }
      case 'device.status_changed.v1':
        return this.onDeviceStatus(event.tenant_id, event.payload as EventPayload<'device.status_changed.v1'>, q);
    }
  }

  private async onMeasurement(tenantId: string, m: EventPayload<'telemetry.measurement.accepted.v1'>, q: Q): Promise<void> {
    // Alarms are driven only by trustworthy readings: flagged data
    // (implausible, late or future-dated) is stored but never evaluated.
    if (m.quality !== 'ok') return;
    const rules = await q.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM alert_rules WHERE enabled AND sensor_kind = $1 AND (device_id IS NULL OR device_id = $2)`,
      [m.sensor_kind, m.device_id],
    );
    if (rules.length === 0) return;
    const observedAt = new Date(m.observed_at);

    for (const rule of rules) {
      const open = await q.maybeOne<AlertRow>(
        `SELECT ${ALERT_COLUMNS} FROM alerts
          WHERE device_id = $1 AND kind = 'threshold' AND rule_id = $2 AND status IN ('active', 'acknowledged')
          FOR UPDATE`,
        [m.device_id, rule.id],
      );
      // A reading older than the alarm's latest evidence is out of order; it
      // must not clear or re-trigger an alarm that newer data already decided.
      if (open && observedAt < open.last_triggered_at) continue;

      switch (evaluate(rule, m.value, open !== null)) {
        case 'raise':
          await this.raiseThresholdAlert(q, tenantId, rule, m, observedAt);
          break;
        case 'repeat':
          await q.exec('UPDATE alerts SET occurrences = occurrences + 1, last_triggered_at = $2, last_value = $3 WHERE id = $1', [open!.id, observedAt, m.value]);
          break;
        case 'clear':
          await this.clear(q, open!, m.value, observedAt);
          break;
        case 'none':
          break;
      }
    }
  }

  private async raiseThresholdAlert(q: Q, tenantId: string, rule: RuleRow, m: EventPayload<'telemetry.measurement.accepted.v1'>, observedAt: Date): Promise<void> {
    const device = await q.maybeOne<{ name: string }>('SELECT name FROM device_names WHERE device_id = $1', [m.device_id]);
    // ON CONFLICT against the partial unique index: if a concurrent
    // evaluation opened the alarm first, this insert does nothing.
    const alert = await q.maybeOne<AlertRow>(
      `INSERT INTO alerts (tenant_id, kind, rule_id, rule_name, device_id, device_name, sensor_kind, severity, operator, threshold,
                           trigger_value, last_value, first_triggered_at, last_triggered_at)
       VALUES ($1, 'threshold', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $11)
       ON CONFLICT DO NOTHING
       RETURNING ${ALERT_COLUMNS}`,
      [tenantId, rule.id, rule.name, m.device_id, device?.name ?? null, m.sensor_kind, rule.severity, rule.operator, rule.threshold, m.value, observedAt],
    );
    if (!alert) return;
    await this.outbox.emit(q, {
      type: 'alert.raised.v1',
      aggregateType: 'alert',
      aggregateId: alert.id,
      tenantId,
      payload: {
        alert_id: alert.id,
        kind: 'threshold',
        rule_id: rule.id,
        rule_name: rule.name,
        device_id: m.device_id,
        device_name: alert.device_name,
        sensor_kind: m.sensor_kind,
        severity: rule.severity,
        value: m.value,
        threshold: rule.threshold,
        operator: OPERATOR_SYMBOL[rule.operator],
        create_incident: rule.create_incident,
        triggered_at: observedAt.toISOString(),
      },
    });
  }

  private async clear(q: Q, alert: AlertRow, value: number | null, at: Date): Promise<void> {
    await q.exec(`UPDATE alerts SET status = 'cleared', cleared_at = $2, last_value = COALESCE($3, last_value) WHERE id = $1`, [alert.id, at, value]);
    await this.outbox.emit(q, {
      type: 'alert.cleared.v1',
      aggregateType: 'alert',
      aggregateId: alert.id,
      tenantId: alert.tenant_id,
      payload: { alert_id: alert.id, device_id: alert.device_id, value, cleared_at: at.toISOString() },
    });
  }

  /** Device health: an alarm while a device is silent, cleared when it reports again. */
  private async onDeviceStatus(tenantId: string, p: EventPayload<'device.status_changed.v1'>, q: Q): Promise<void> {
    const open = await q.maybeOne<AlertRow>(
      `SELECT ${ALERT_COLUMNS} FROM alerts WHERE device_id = $1 AND kind = 'device_offline' AND status IN ('active', 'acknowledged') FOR UPDATE`,
      [p.device_id],
    );
    if (p.to === 'offline' && !open) {
      const now = new Date();
      const alert = await q.maybeOne<AlertRow>(
        `INSERT INTO alerts (tenant_id, kind, rule_id, rule_name, device_id, device_name, severity, first_triggered_at, last_triggered_at)
         VALUES ($1, 'device_offline', NULL, 'Device offline', $2, $3, 'warning', $4, $4)
         ON CONFLICT DO NOTHING
         RETURNING ${ALERT_COLUMNS}`,
        [tenantId, p.device_id, p.name, now],
      );
      if (!alert) return;
      await this.outbox.emit(q, {
        type: 'alert.raised.v1',
        aggregateType: 'alert',
        aggregateId: alert.id,
        tenantId,
        payload: {
          alert_id: alert.id,
          kind: 'device_offline',
          rule_id: null,
          rule_name: 'Device offline',
          device_id: p.device_id,
          device_name: p.name,
          sensor_kind: null,
          severity: 'warning',
          value: null,
          threshold: null,
          operator: null,
          create_incident: OFFLINE_CREATES_INCIDENT,
          triggered_at: now.toISOString(),
        },
      });
    } else if ((p.to === 'online' || p.to === 'decommissioned') && open) {
      await this.clear(q, open, null, new Date());
    }
  }

  // ---------------------------------------------------------------------------
  // Escalation
  // ---------------------------------------------------------------------------

  /** An alarm nobody acknowledged in time is escalated once, to the incident commander. */
  async sweepEscalations(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let escalated = 0;
    try {
      const due = await this.db.tx(null, (q) =>
        q.query<{ alert_id: string; tenant_id: string }>('SELECT alert_id, tenant_id FROM alerts_unacknowledged($1, $2)', [ESCALATION_SECONDS, 100]),
      );
      for (const row of due) {
        const ctx = newContext({ actor: { id: 'alert-service', type: 'system' } });
        const done = await runWithContext(ctx, () =>
          this.db.tx(row.tenant_id, async (q) => {
            const alert = await q.maybeOne<AlertRow>(
              `UPDATE alerts SET escalated_at = now() WHERE id = $1 AND status = 'active' AND escalated_at IS NULL RETURNING ${ALERT_COLUMNS}`,
              [row.alert_id],
            );
            if (!alert) return false;
            await this.outbox.emit(q, {
              type: 'notification.requested.v1',
              aggregateType: 'alert',
              aggregateId: alert.id,
              tenantId: row.tenant_id,
              payload: {
                dedupe_key: `alert-escalated:${alert.id}`,
                channel: 'in_app',
                category: 'alert.escalated',
                external: false,
                recipient_user_id: null,
                recipient_role: Roles.IncidentCommander,
                recipient_address: null,
                subject: `Unacknowledged ${alert.severity} alarm: ${alert.rule_name}`,
                body: `${alert.device_name ?? 'A device'} has had an unacknowledged ${alert.severity} alarm for more than ${Math.round(ESCALATION_SECONDS / 60)} minutes.`,
                reference_type: 'alert',
                reference_id: alert.id,
              },
            });
            return true;
          }),
        );
        if (done) escalated += 1;
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'alert escalation sweep failed');
    } finally {
      this.sweeping = false;
    }
    return escalated;
  }
}
