import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import {
  DEFAULT_INCIDENT_CATEGORY,
  DEFAULT_INCIDENT_WORKFLOW,
  type EventEnvelope,
  type EventPayload,
  type IncidentSourceType,
  PackIncidentCategory,
  Roles,
} from '@titan/contracts';
import { Db, DomainError, EventConsumers, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { describeOrigin, responseOverdue } from './rules.js';

export const CreateIncident = z
  .object({
    title: z.string().min(3).max(200),
    description: z.string().max(4000).default(''),
    severity: z.enum(['info', 'warning', 'critical']),
    device_id: z.uuid().nullable().default(null),
    /** Category configured for the tenant (by an industry pack); `general` always exists. */
    category: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/).default(DEFAULT_INCIDENT_CATEGORY),
    /** Asset the incident concerns, when there is one. */
    asset_id: z.uuid().nullable().default(null),
    site_id: z.uuid().nullable().default(null),
    /** Where the report comes from. Alarms raise incidents themselves and cannot be claimed here. */
    source_type: z.enum(['manual', 'inspection', 'work_order', 'service_request', 'external']).default('manual'),
    /** Identifier of the originating record; required for every origin except `manual`. One incident per origin. */
    source_id: z.string().min(1).max(200).nullable().default(null),
  })
  .refine((i) => i.source_type === 'manual' || i.source_id !== null, { message: 'source_id is required unless source_type is manual', path: ['source_id'] });

export const AssignIncident = z.object({
  assignee_id: z.string().min(1).max(100),
  assignee_username: z.string().min(1).max(255),
});

export const AddNote = z.object({ message: z.string().trim().min(1).max(4000) });

export const ListIncidents = z.object({
  status: z.enum(['open', 'acknowledged', 'resolved', 'closed', 'active']).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  category: z.string().max(64).optional(),
  asset_id: z.uuid().optional(),
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
  source_type: IncidentSourceType;
  source_id: string | null;
  device_id: string | null;
  category: string;
  asset_id: string | null;
  site_id: string | null;
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

export interface CategoryRow {
  key: string;
  name: string;
  description: string;
  workflow_key: string;
  notify_role: string;
  response_targets: Record<string, number>;
  pack_id: string | null;
}

const COLUMNS = `id, tenant_id, reference_no, title, description, severity, status, source_type, source_id, device_id, category, asset_id, site_id,
  assignee_id, assignee_username, acknowledged_by, acknowledged_at, resolved_by, resolved_at, closed_at, version, created_at, updated_at`;

/** Used when a tenant has no row for `general` (no pack has installed one yet). */
const GENERAL: CategoryRow = {
  key: DEFAULT_INCIDENT_CATEGORY,
  name: 'General',
  description: '',
  workflow_key: DEFAULT_INCIDENT_WORKFLOW,
  notify_role: Roles.DutyOfficer,
  response_targets: {},
  pack_id: null,
};

interface Actor {
  id: string | null;
  username: string | null;
}

interface OpenInput {
  title: string;
  description: string;
  severity: IncidentRow['severity'];
  deviceId: string | null;
  assetId: string | null;
  siteId: string | null;
  category: CategoryRow;
  source: { type: IncidentSourceType; id: string | null };
}

/**
 * Incident lifecycle: open -> acknowledged -> resolved -> closed.
 *
 * Acknowledgment and resolution are not commands of this service. They are
 * the outcome of the incident's response workflow (workflow-service), which
 * decides who is authorised to perform them; this service applies the result
 * when the corresponding workflow stage completes. Which workflow that is,
 * and who is told about a new incident, comes from the incident's category.
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
      subjects: [
        'alert.raised.v1',
        'alert.cleared.v1',
        'workflow.task.assigned.v1',
        'workflow.stage.completed.v1',
        'tenant.pack.activated.v1',
        'maintenance.request.submitted.v1',
        'maintenance.work_order.created.v1',
        'maintenance.work_order.completed.v1',
      ],
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

  // --- categories -------------------------------------------------------------

  private async category(q: Q, key: string): Promise<CategoryRow | null> {
    const row = await q.maybeOne<CategoryRow>('SELECT key, name, description, workflow_key, notify_role, response_targets, pack_id FROM incident_categories WHERE key = $1', [key]);
    return row ?? (key === DEFAULT_INCIDENT_CATEGORY ? GENERAL : null);
  }

  listCategories(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const rows = await q.query<CategoryRow>('SELECT key, name, description, workflow_key, notify_role, response_targets, pack_id FROM incident_categories ORDER BY key');
      return rows.some((r) => r.key === DEFAULT_INCIDENT_CATEGORY) ? rows : [GENERAL, ...rows];
    });
  }

  /**
   * Creates an incident and announces it. With a `source.id` the insert is
   * idempotent: a second attempt for the same origin returns null and has no effect.
   */
  private async open(q: Q, tenantId: string, input: OpenInput, actor: Actor): Promise<IncidentRow | null> {
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
      `INSERT INTO incidents (tenant_id, reference_no, title, description, severity, source_type, source_id, device_id, category, asset_id, site_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [tenantId, reference, input.title, input.description, input.severity, input.source.type, input.source.id, input.deviceId, input.category.key, input.assetId, input.siteId],
    );
    if (!incident) return null;

    await this.timeline(q, incident, 'created', describeOrigin(input.source.type), actor);
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
        category: incident.category,
        asset_id: incident.asset_id,
        workflow_key: input.category.workflow_key,
      },
    });
    return incident;
  }

  private notifyCreated(q: Q, incident: IncidentRow, role: string) {
    return this.outbox.emit(q, {
      type: 'notification.requested.v1',
      aggregateType: 'incident',
      aggregateId: incident.id,
      tenantId: incident.tenant_id,
      payload: {
        dedupe_key: `incident-created:${incident.id}`,
        channel: 'in_app',
        category: 'incident.created',
        external: false,
        recipient_user_id: null,
        recipient_role: role,
        recipient_address: null,
        subject: `${incident.severity.toUpperCase()} incident ${incident.reference_no}`,
        body: incident.title,
        reference_type: 'incident',
        reference_id: incident.id,
      },
    });
  }

  // --- commands --------------------------------------------------------------

  create(user: Principal, input: z.infer<typeof CreateIncident>) {
    return this.db.tx(user.tenantId, async (q) => {
      const category = await this.category(q, input.category);
      if (!category) throw DomainError.invalid(`unknown incident category '${input.category}'`);
      const incident = await this.open(
        q,
        user.tenantId,
        {
          title: input.title,
          description: input.description,
          severity: input.severity,
          deviceId: input.device_id,
          assetId: input.asset_id,
          siteId: input.site_id,
          category,
          source: { type: input.source_type, id: input.source_id },
        },
        { id: user.userId, username: user.username },
      );
      if (!incident) throw DomainError.conflict('duplicate_origin', 'an incident already exists for this origin');
      // A report in a pack-defined category goes to the role responsible for it, unless the reporter holds
      // that role. Reports in the default category are not announced, exactly as before categories existed.
      if (category.key !== DEFAULT_INCIDENT_CATEGORY && !user.roles.includes(category.notify_role)) {
        await this.notifyCreated(q, incident, category.notify_role);
      }
      return incident;
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
    return this.db.tx(user.tenantId, async (q) => {
      const statuses = query.status === 'active' ? ['open', 'acknowledged'] : query.status ? [query.status] : null;
      const rows = await q.query<IncidentRow>(
        `SELECT ${COLUMNS} FROM incidents
          WHERE ($1::text[] IS NULL OR status = ANY($1)) AND ($2::text IS NULL OR severity = $2)
            AND ($3::text IS NULL OR category = $3) AND ($4::uuid IS NULL OR asset_id = $4)
          ORDER BY created_at DESC
          LIMIT $5 OFFSET $6`,
        [statuses, query.severity ?? null, query.category ?? null, query.asset_id ?? null, query.limit, query.offset],
      );
      const targets = new Map((await q.query<{ key: string; response_targets: Record<string, number> }>('SELECT key, response_targets FROM incident_categories')).map((c) => [c.key, c.response_targets]));
      const now = new Date();
      return rows.map((r) => ({ ...r, response_overdue: responseOverdue(r, targets.get(r.category) ?? {}, now) }));
    });
  }

  get(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const incident = await this.load(q, id);
      const timeline = await q.query('SELECT id, entry_type, message, actor_username, occurred_at FROM incident_timeline WHERE incident_id = $1 ORDER BY occurred_at, id', [id]);
      const category = await this.category(q, incident.category);
      return { ...incident, response_overdue: responseOverdue(incident, category?.response_targets ?? {}, new Date()), category_name: category?.name ?? incident.category, timeline };
    });
  }

  summary(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const bySeverity = await q.query('SELECT severity, count(*)::int AS count FROM incidents GROUP BY severity ORDER BY severity');
      const byStatus = await q.query('SELECT status, count(*)::int AS count FROM incidents GROUP BY status ORDER BY status');
      const active = await q.query(`SELECT severity, count(*)::int AS count FROM incidents WHERE status IN ('open', 'acknowledged') GROUP BY severity ORDER BY severity`);
      const byCategory = await q.query(
        `SELECT category, count(*)::int AS count, count(*) FILTER (WHERE status IN ('open', 'acknowledged'))::int AS active FROM incidents GROUP BY category ORDER BY category`,
      );
      const response = await q.one(
        `SELECT round(avg(extract(epoch FROM acknowledged_at - created_at))::numeric, 1) AS avg_seconds_to_acknowledge,
                count(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acknowledged
           FROM incidents`,
      );
      return { by_severity: bySeverity, by_status: byStatus, active_by_severity: active, by_category: byCategory, response };
    });
  }

  // --- event handlers --------------------------------------------------------

  private async onEvent(event: EventEnvelope, q: Q): Promise<void> {
    switch (event.event_type) {
      case 'alert.raised.v1': {
        const p = event.payload as EventPayload<'alert.raised.v1'>;
        if (!p.create_incident) return;
        const where = p.device_name ?? 'a device';
        const title = p.kind === 'threshold' ? `${p.rule_name} at ${where}` : `${where} is offline`;
        const description =
          p.kind === 'threshold'
            ? `${p.sensor_kind} reading ${p.value} ${p.operator} threshold ${p.threshold} (observed ${p.triggered_at}).`
            : `No telemetry received from ${where} within the expected interval.`;
        // An alarm must never be lost to configuration: an unknown category falls back to `general`.
        const category = (p.incident_category ? await this.category(q, p.incident_category) : null) ?? (await this.category(q, DEFAULT_INCIDENT_CATEGORY)) ?? GENERAL;
        const incident = await this.open(
          q,
          event.tenant_id,
          { title, description, severity: p.severity, deviceId: p.device_id, assetId: p.asset_id ?? null, siteId: null, category, source: { type: 'alert', id: p.alert_id } },
          { id: null, username: null },
        );
        if (!incident) return;
        if (p.incident_category && category.key !== p.incident_category) {
          await this.timeline(q, incident, 'note', `The alarm named the category '${p.incident_category}', which is not configured; the incident was filed as ${category.key}.`);
        }
        await this.notifyCreated(q, incident, category.notify_role);
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
      case 'tenant.pack.activated.v1': {
        const p = event.payload as EventPayload<'tenant.pack.activated.v1'>;
        for (const raw of p.install.incident_categories) {
          const c = PackIncidentCategory.parse(raw);
          await q.exec(
            `INSERT INTO incident_categories (tenant_id, key, name, description, workflow_key, notify_role, response_targets, pack_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (tenant_id, key) DO UPDATE
               SET name = EXCLUDED.name, description = EXCLUDED.description, workflow_key = EXCLUDED.workflow_key, notify_role = EXCLUDED.notify_role,
                   response_targets = EXCLUDED.response_targets, pack_id = EXCLUDED.pack_id, updated_at = now()`,
            [event.tenant_id, c.key, c.name, c.description, c.workflow_key, c.notify_role, JSON.stringify(c.response_targets), p.pack_id],
          );
        }
        return;
      }
      // Maintenance raised because of an incident is recorded on that incident's timeline.
      case 'maintenance.request.submitted.v1': {
        const p = event.payload as EventPayload<'maintenance.request.submitted.v1'>;
        await this.maintenanceNote(q, p.origin_type, p.origin_id, `Maintenance request ${p.reference_no} raised (${p.priority} priority)`);
        return;
      }
      case 'maintenance.work_order.created.v1': {
        const p = event.payload as EventPayload<'maintenance.work_order.created.v1'>;
        await this.maintenanceNote(q, p.origin_type, p.origin_id, `Work order ${p.reference_no} created after approval of the maintenance request`);
        return;
      }
      case 'maintenance.work_order.completed.v1': {
        const p = event.payload as EventPayload<'maintenance.work_order.completed.v1'>;
        // The work being finished does not resolve the incident: the responsible role confirms that in its response process.
        await this.maintenanceNote(q, p.origin_type, p.origin_id, `Work order ${p.reference_no} completed by ${p.completed_by_username}: ${p.summary}`);
        return;
      }
    }
  }

  private async maintenanceNote(q: Q, originType: string, originId: string | null, message: string): Promise<void> {
    if (originType !== 'incident' || !originId || !/^[0-9a-f-]{36}$/i.test(originId)) return;
    const incident = await q.maybeOne<IncidentRow>(`SELECT ${COLUMNS} FROM incidents WHERE id = $1`, [originId]);
    if (incident) await this.timeline(q, incident, 'maintenance', message);
  }
}
