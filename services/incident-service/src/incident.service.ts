import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import { type EventEnvelope, type EventPayload, Roles } from '@titan/contracts';
import { Db, DomainError, EventConsumers, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';

export const CreateIncident = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(4000).default(''),
  severity: z.enum(['info', 'warning', 'critical']),
  device_id: z.uuid().nullable().default(null),
});

export const AssignIncident = z.object({
  assignee_id: z.string().min(1).max(100),
  assignee_username: z.string().min(1).max(255),
});

export const AddNote = z.object({ message: z.string().trim().min(1).max(4000) });

export const ListIncidents = z.object({
  status: z.enum(['open', 'acknowledged', 'resolved', 'closed', 'active']).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface IncidentRow {
  id: string;
  tenant_id: string;
  reference_no: string;
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved' | 'closed';
  source_type: 'alert' | 'manual';
  source_id: string | null;
  device_id: string | null;
  assignee_id: string | null;
  assignee_username: string | null;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, tenant_id, reference_no, title, description, severity, status, source_type, source_id, device_id, assignee_id,
  assignee_username, acknowledged_by, acknowledged_at, resolved_by, resolved_at, closed_at, version, created_at, updated_at`;

interface Actor {
  id: string | null;
  username: string | null;
}

/**
 * Incident lifecycle: open -> acknowledged -> resolved -> closed.
 *
 * Acknowledgment and resolution are not commands of this service. They are
 * the outcome of the incident-response workflow (workflow-service), which
 * decides who is authorised to perform them; this service applies the result
 * when the corresponding workflow stage completes.
 */
@Injectable()
export class IncidentService implements OnApplicationBootstrap {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({
      subjects: ['alert.raised.v1', 'alert.cleared.v1', 'workflow.task.assigned.v1', 'workflow.stage.completed.v1'],
      handler: (event, q) => this.onEvent(event, q),
    });
  }

  private timeline(q: Q, incident: Pick<IncidentRow, 'id' | 'tenant_id'>, type: string, message: string, actor: Actor = { id: null, username: null }) {
    return q.exec('INSERT INTO incident_timeline (tenant_id, incident_id, entry_type, message, actor_id, actor_username) VALUES ($1, $2, $3, $4, $5, $6)', [
      incident.tenant_id,
      incident.id,
      type,
      message,
      actor.id,
      actor.username,
    ]);
  }

  /**
   * Creates an incident and announces it. With a `source` the insert is
   * idempotent: a second attempt for the same alarm returns null and has no effect.
   */
  private async open(
    q: Q,
    tenantId: string,
    input: { title: string; description: string; severity: IncidentRow['severity']; deviceId: string | null; source: { type: 'alert' | 'manual'; id: string | null } },
    actor: Actor,
  ): Promise<IncidentRow | null> {
    if (input.source.id) {
      const existing = await q.maybeOne('SELECT 1 FROM incidents WHERE source_type = $1 AND source_id = $2', [input.source.type, input.source.id]);
      if (existing) return null;
    }
    const year = new Date().getUTCFullYear();
    const { last_no } = await q.one<{ last_no: number }>(
      `INSERT INTO incident_counters (tenant_id, year, last_no) VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, year) DO UPDATE SET last_no = incident_counters.last_no + 1
       RETURNING last_no`,
      [tenantId, year],
    );
    const reference = `INC-${year}-${String(last_no).padStart(6, '0')}`;
    const incident = await q.maybeOne<IncidentRow>(
      `INSERT INTO incidents (tenant_id, reference_no, title, description, severity, source_type, source_id, device_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [tenantId, reference, input.title, input.description, input.severity, input.source.type, input.source.id, input.deviceId],
    );
    if (!incident) return null;

    await this.timeline(q, incident, 'created', input.source.type === 'alert' ? 'Incident raised automatically from an alarm' : 'Incident reported manually', actor);
    await this.outbox.emit(q, {
      type: 'incident.created.v1',
      aggregateType: 'incident',
      aggregateId: incident.id,
      tenantId,
      payload: {
        incident_id: incident.id,
        reference_no: incident.reference_no,
        title: incident.title,
        severity: incident.severity,
        source_type: incident.source_type,
        source_id: incident.source_id,
        device_id: incident.device_id,
        created_at: incident.created_at.toISOString(),
      },
    });
    return incident;
  }

  // --- commands --------------------------------------------------------------

  create(user: Principal, input: z.infer<typeof CreateIncident>) {
    return this.db.tx(user.tenantId, async (q) => {
      const incident = await this.open(
        q,
        user.tenantId,
        { title: input.title, description: input.description, severity: input.severity, deviceId: input.device_id, source: { type: 'manual', id: null } },
        { id: user.userId, username: user.username },
      );
      return incident!;
    });
  }

  private async load(q: Q, id: string, lock = false): Promise<IncidentRow> {
    const row = await q.maybeOne<IncidentRow>(`SELECT ${COLUMNS} FROM incidents WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!row) throw DomainError.notFound('incident');
    return row;
  }

  assign(user: Principal, id: string, input: z.infer<typeof AssignIncident>) {
    return this.db.tx(user.tenantId, async (q) => {
      const incident = await this.load(q, id, true);
      if (incident.status === 'closed') throw DomainError.conflict('invalid_state', 'a closed incident cannot be assigned');
      const updated = await q.one<IncidentRow>(
        `UPDATE incidents SET assignee_id = $2, assignee_username = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, input.assignee_id, input.assignee_username],
      );
      await this.timeline(q, incident, 'assigned', `Assigned to ${input.assignee_username}`, { id: user.userId, username: user.username });
      await this.outbox.emit(q, {
        type: 'incident.assigned.v1',
        aggregateType: 'incident',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: { incident_id: id, assignee_id: input.assignee_id, assigned_by: user.userId },
      });
      await this.outbox.emit(q, {
        type: 'notification.requested.v1',
        aggregateType: 'incident',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: {
          dedupe_key: `incident-assigned:${id}:${updated.version}`,
          channel: 'in_app',
          category: 'incident.assigned',
          external: false,
          recipient_user_id: input.assignee_id,
          recipient_role: null,
          recipient_address: null,
          subject: `Incident ${incident.reference_no} assigned to you`,
          body: incident.title,
          reference_type: 'incident',
          reference_id: id,
        },
      });
      return updated;
    });
  }

  addNote(user: Principal, id: string, input: z.infer<typeof AddNote>) {
    return this.db.tx(user.tenantId, async (q) => {
      const incident = await this.load(q, id);
      await this.timeline(q, incident, 'note', input.message, { id: user.userId, username: user.username });
      return { incident_id: id, added: true };
    });
  }

  close(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const incident = await this.load(q, id, true);
      if (incident.status !== 'resolved') throw DomainError.conflict('invalid_state', `only a resolved incident can be closed (it is ${incident.status})`);
      const updated = await q.one<IncidentRow>(
        `UPDATE incidents SET status = 'closed', closed_at = now(), version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
        [id],
      );
      await this.timeline(q, incident, 'closed', 'Incident closed', { id: user.userId, username: user.username });
      return updated;
    });
  }

  // --- queries ---------------------------------------------------------------

  list(user: Principal, query: z.infer<typeof ListIncidents>) {
    return this.db.tx(user.tenantId, (q) => {
      const statuses = query.status === 'active' ? ['open', 'acknowledged'] : query.status ? [query.status] : null;
      return q.query<IncidentRow>(
        `SELECT ${COLUMNS} FROM incidents
          WHERE ($1::text[] IS NULL OR status = ANY($1)) AND ($2::text IS NULL OR severity = $2)
          ORDER BY created_at DESC
          LIMIT $3 OFFSET $4`,
        [statuses, query.severity ?? null, query.limit, query.offset],
      );
    });
  }

  get(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const incident = await this.load(q, id);
      const timeline = await q.query('SELECT id, entry_type, message, actor_username, occurred_at FROM incident_timeline WHERE incident_id = $1 ORDER BY occurred_at, id', [id]);
      return { ...incident, timeline };
    });
  }

  summary(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const bySeverity = await q.query('SELECT severity, count(*)::int AS count FROM incidents GROUP BY severity ORDER BY severity');
      const byStatus = await q.query('SELECT status, count(*)::int AS count FROM incidents GROUP BY status ORDER BY status');
      const active = await q.query(`SELECT severity, count(*)::int AS count FROM incidents WHERE status IN ('open', 'acknowledged') GROUP BY severity ORDER BY severity`);
      const response = await q.one(
        `SELECT round(avg(extract(epoch FROM acknowledged_at - created_at))::numeric, 1) AS avg_seconds_to_acknowledge,
                count(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acknowledged
           FROM incidents`,
      );
      return { by_severity: bySeverity, by_status: byStatus, active_by_severity: active, response };
    });
  }

  // --- event handlers --------------------------------------------------------

  private async onEvent(event: EventEnvelope, q: Q): Promise<void> {
    switch (event.event_type) {
      case 'alert.raised.v1': {
        const p = event.payload as EventPayload<'alert.raised.v1'>;
        if (!p.create_incident) return;
        const where = p.device_name ?? 'a device';
        const title =
          p.kind === 'threshold'
            ? `${p.rule_name} at ${where}`
            : `${where} is offline`;
        const description =
          p.kind === 'threshold'
            ? `${p.sensor_kind} reading ${p.value} ${p.operator} threshold ${p.threshold} (observed ${p.triggered_at}).`
            : `No telemetry received from ${where} within the expected interval.`;
        const incident = await this.open(
          q,
          event.tenant_id,
          { title, description, severity: p.severity, deviceId: p.device_id, source: { type: 'alert', id: p.alert_id } },
          { id: null, username: null },
        );
        if (!incident) return;
        await this.outbox.emit(q, {
          type: 'notification.requested.v1',
          aggregateType: 'incident',
          aggregateId: incident.id,
          tenantId: event.tenant_id,
          payload: {
            dedupe_key: `incident-created:${incident.id}`,
            channel: 'in_app',
            category: 'incident.created',
            external: false,
            recipient_user_id: null,
            recipient_role: Roles.DutyOfficer,
            recipient_address: null,
            subject: `${incident.severity.toUpperCase()} incident ${incident.reference_no}`,
            body: incident.title,
            reference_type: 'incident',
            reference_id: incident.id,
          },
        });
        return;
      }
      case 'alert.cleared.v1': {
        const p = event.payload as EventPayload<'alert.cleared.v1'>;
        const incident = await q.maybeOne<IncidentRow>(`SELECT ${COLUMNS} FROM incidents WHERE source_type = 'alert' AND source_id = $1`, [p.alert_id]);
        // The alarm condition ending does not end the incident: a person still decides that.
        if (incident && incident.status !== 'closed') {
          await this.timeline(q, incident, 'alert_cleared', `The originating alarm cleared${p.value === null ? '' : ` (reading ${p.value})`}`);
        }
        return;
      }
      case 'workflow.task.assigned.v1': {
        const p = event.payload as EventPayload<'workflow.task.assigned.v1'>;
        if (p.subject_type !== 'incident') return;
        const incident = await q.maybeOne<IncidentRow>(`SELECT ${COLUMNS} FROM incidents WHERE id = $1`, [p.subject_id]);
        if (incident) await this.timeline(q, incident, 'workflow', `Response step "${p.stage_name}" assigned to role ${p.role}`);
        return;
      }
      case 'workflow.stage.completed.v1': {
        const p = event.payload as EventPayload<'workflow.stage.completed.v1'>;
        if (p.subject_type !== 'incident') return;
        const incident = await q.maybeOne<IncidentRow>(`SELECT ${COLUMNS} FROM incidents WHERE id = $1 FOR UPDATE`, [p.subject_id]);
        if (!incident) return;
        const actor = { id: p.completed_by, username: p.completed_by_username };
        if (p.stage_key === 'acknowledge' && incident.status === 'open') {
          await q.exec(
            `UPDATE incidents SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3, version = version + 1, updated_at = now() WHERE id = $1`,
            [incident.id, p.completed_by_username, p.completed_at],
          );
          await this.timeline(q, incident, 'acknowledged', 'Incident acknowledged', actor);
          await this.outbox.emit(q, {
            type: 'incident.acknowledged.v1',
            aggregateType: 'incident',
            aggregateId: incident.id,
            tenantId: event.tenant_id,
            payload: {
              incident_id: incident.id,
              reference_no: incident.reference_no,
              acknowledged_by: p.completed_by,
              acknowledged_at: p.completed_at,
              created_at: incident.created_at.toISOString(),
            },
          });
        } else if (p.stage_key === 'resolve' && (incident.status === 'open' || incident.status === 'acknowledged')) {
          await q.exec(`UPDATE incidents SET status = 'resolved', resolved_by = $2, resolved_at = $3, version = version + 1, updated_at = now() WHERE id = $1`, [
            incident.id,
            p.completed_by_username,
            p.completed_at,
          ]);
          await this.timeline(q, incident, 'resolved', 'Incident resolved', actor);
          await this.outbox.emit(q, {
            type: 'incident.resolved.v1',
            aggregateType: 'incident',
            aggregateId: incident.id,
            tenantId: event.tenant_id,
            payload: {
              incident_id: incident.id,
              reference_no: incident.reference_no,
              resolved_by: p.completed_by,
              resolved_at: p.completed_at,
              created_at: incident.created_at.toISOString(),
            },
          });
        }
        return;
      }
    }
  }
}
