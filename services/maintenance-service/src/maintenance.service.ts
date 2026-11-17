import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { hasAnyRole, type Principal } from '@titan/authentication';
import { Capabilities, type EventEnvelope, type EventPayload, type FieldSpec, PackRequestType, Roles, STAFF_ROLES, validateFieldValues } from '@titan/contracts';
import type { Logger } from '@titan/observability';
import { Db, DomainError, Entitlements, EventConsumers, LOGGER, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { canPerform, hoursBetween, mayExecute, type Priority, priorityFromSeverity, type WorkOrderStatus } from './rules.js';

const priority = z.enum(['low', 'normal', 'high', 'urgent']);

export const CreateRequest = z.object({
  request_type: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  title: z.string().trim().min(3).max(200),
  description: z.string().max(4000).default(''),
  /** The request type's default when omitted. */
  priority: priority.optional(),
  asset_id: z.uuid().nullable().default(null),
  /** Values for the request type's detail fields. */
  details: z.record(z.string(), z.unknown()).default({}),
});

export const ListRequests = z.object({
  status: z.enum(['submitted', 'approved', 'rejected', 'cancelled']).optional(),
  pack: z.string().max(64).optional(),
  asset_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const ListWorkOrders = z.object({
  status: z.enum(['open', 'assigned', 'in_progress', 'completed', 'cancelled', 'active']).optional(),
  pack: z.string().max(64).optional(),
  asset_id: z.uuid().optional(),
  /** Only work orders assigned to the caller. */
  mine: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const AssignWorkOrder = z.object({
  assignee_id: z.string().min(1).max(100),
  assignee_username: z.string().min(1).max(255),
});

export const CompleteWorkOrder = z.object({
  summary: z.string().trim().min(3).max(4000),
  labor_hours: z.number().min(0).max(10_000).nullable().default(null),
  /** Condition of the asset after the work; applied to the asset by asset-service. */
  condition_after: z.enum(['good', 'fair', 'poor', 'critical']).nullable().default(null),
});

export const CancelWorkOrder = z.object({ reason: z.string().trim().min(3).max(1000) });

/** Roles that plan work: assign, re-assign and cancel work orders. */
export const PLANNING_ROLES: readonly string[] = [Roles.MaintenancePlanner, Roles.FacilityManager, Roles.TenantAdmin];

export interface RequestTypeRow {
  key: string;
  name: string;
  description: string;
  subject_type: 'maintenance_request' | 'service_request';
  workflow_key: string;
  default_priority: Priority;
  requester_roles: string[];
  auto_from_incident_category: string | null;
  detail_fields: FieldSpec[];
  pack_id: string;
}

export interface RequestRow {
  id: string;
  tenant_id: string;
  reference_no: string;
  request_type: string;
  pack_id: string;
  subject_type: 'maintenance_request' | 'service_request';
  workflow_key: string;
  title: string;
  description: string;
  priority: Priority;
  status: 'submitted' | 'approved' | 'rejected' | 'cancelled';
  origin_type: 'manual' | 'incident';
  origin_id: string | null;
  asset_id: string | null;
  details: Record<string, unknown>;
  requested_by: string | null;
  requested_by_username: string | null;
  submitted_at: Date;
  decided_at: Date | null;
  version: number;
}

export interface WorkOrderRow {
  id: string;
  tenant_id: string;
  reference_no: string;
  request_id: string;
  request_type: string;
  pack_id: string;
  title: string;
  description: string;
  priority: Priority;
  status: WorkOrderStatus;
  asset_id: string | null;
  origin_type: string;
  origin_id: string | null;
  assignee_id: string | null;
  assignee_username: string | null;
  assigned_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  completion_summary: string | null;
  labor_hours: number | null;
  condition_after: 'good' | 'fair' | 'poor' | 'critical' | null;
  cancelled_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const TYPE = 'key, name, description, subject_type, workflow_key, default_priority, requester_roles, auto_from_incident_category, detail_fields, pack_id';
const REQUEST = `id, tenant_id, reference_no, request_type, pack_id, subject_type, workflow_key, title, description, priority, status, origin_type, origin_id,
  asset_id, details, requested_by, requested_by_username, submitted_at, decided_at, version`;
const WORK_ORDER = `id, tenant_id, reference_no, request_id, request_type, pack_id, title, description, priority, status, asset_id, origin_type, origin_id,
  assignee_id, assignee_username, assigned_at, started_at, completed_at, completion_summary, labor_hours, condition_after, cancelled_reason, version, created_at, updated_at`;

interface NewRequest {
  type: RequestTypeRow;
  title: string;
  description: string;
  priority: Priority;
  assetId: string | null;
  details: Record<string, unknown>;
  origin: { type: 'manual' | 'incident'; id: string | null };
  requester: { id: string; username: string } | null;
}

/**
 * Maintenance and service requests, their approval outcome, and work orders.
 *
 *   request (submitted) --approval workflow--> approved --> work order
 *   work order: open -> assigned -> in_progress -> completed
 *
 * Approval is not decided here: the request type names a workflow, and
 * workflow-service decides who may approve. This service applies the outcome.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(Entitlements) private readonly entitlements: Entitlements,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({
      subjects: ['tenant.pack.activated.v1', 'incident.created.v1', 'workflow.instance.completed.v1', 'asset.created.v1', 'asset.status_changed.v1'],
      handler: (event, q) => this.onEvent(event, q),
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async nextReference(q: Q, tenantId: string, series: 'MR' | 'WO'): Promise<string> {
    const year = new Date().getUTCFullYear();
    const { last_no } = await q.one<{ last_no: number }>(
      `INSERT INTO maintenance_counters (tenant_id, series, year, last_no) VALUES ($1, $2, $3, 1)
       ON CONFLICT (tenant_id, series, year) DO UPDATE SET last_no = maintenance_counters.last_no + 1
       RETURNING last_no`,
      [tenantId, series, year],
    );
    return `${series}-${year}-${String(last_no).padStart(6, '0')}`;
  }

  private log(q: Q, order: Pick<WorkOrderRow, 'id' | 'tenant_id'>, type: string, message: string, actor: string | null) {
    return q.exec('INSERT INTO work_order_events (tenant_id, work_order_id, entry_type, message, actor_username) VALUES ($1, $2, $3, $4, $5)', [
      order.tenant_id,
      order.id,
      type,
      message,
      actor,
    ]);
  }

  private notify(q: Q, tenantId: string, aggregate: { type: string; id: string }, to: { userId?: string; role?: string }, dedupe: string, category: string, subject: string, body: string) {
    return this.outbox.emit(q, {
      type: 'notification.requested.v1',
      aggregateType: aggregate.type,
      aggregateId: aggregate.id,
      tenantId,
      payload: {
        dedupe_key: dedupe,
        channel: 'in_app',
        category,
        external: false,
        recipient_user_id: to.userId ?? null,
        recipient_role: to.role ?? null,
        recipient_address: null,
        subject,
        body,
        reference_type: aggregate.type,
        reference_id: aggregate.id,
      },
    });
  }

  private isStaff(user: Principal): boolean {
    return hasAnyRole(user, STAFF_ROLES);
  }

  // ---------------------------------------------------------------------------
  // Request types
  // ---------------------------------------------------------------------------

  listRequestTypes(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const rows = await q.query<RequestTypeRow>(`SELECT ${TYPE} FROM request_types ORDER BY name`);
      return rows.map((t) => ({ ...t, can_raise: hasAnyRole(user, t.requester_roles) }));
    });
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  /** Stores the request and, in the same transaction, announces it and asks for its approval process. */
  private async submit(q: Q, tenantId: string, input: NewRequest): Promise<RequestRow | null> {
    const reference = await this.nextReference(q, tenantId, 'MR');
    const request = await q.maybeOne<RequestRow>(
      `INSERT INTO maintenance_requests (tenant_id, reference_no, request_type, pack_id, subject_type, workflow_key, title, description, priority,
                                         origin_type, origin_id, asset_id, details, requested_by, requested_by_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT DO NOTHING
       RETURNING ${REQUEST}`,
      [
        tenantId,
        reference,
        input.type.key,
        input.type.pack_id,
        input.type.subject_type,
        input.type.workflow_key,
        input.title,
        input.description,
        input.priority,
        input.origin.type,
        input.origin.id,
        input.assetId,
        JSON.stringify(input.details),
        input.requester?.id ?? null,
        input.requester?.username ?? null,
      ],
    );
    // A request already exists for this origin: the event is a repeat.
    if (!request) return null;

    await this.outbox.emit(q, {
      type: 'maintenance.request.submitted.v1',
      aggregateType: 'maintenance_request',
      aggregateId: request.id,
      tenantId,
      payload: {
        request_id: request.id,
        reference_no: request.reference_no,
        request_type: request.request_type,
        pack_id: request.pack_id,
        subject_type: request.subject_type,
        title: request.title,
        priority: request.priority,
        origin_type: request.origin_type,
        origin_id: request.origin_id,
        asset_id: request.asset_id,
        requested_by: request.requested_by,
        submitted_at: request.submitted_at.toISOString(),
      },
    });
    await this.outbox.emit(q, {
      type: 'workflow.start.requested.v1',
      aggregateType: 'maintenance_request',
      aggregateId: request.id,
      tenantId,
      payload: {
        subject_type: request.subject_type,
        subject_id: request.id,
        workflow_key: request.workflow_key,
        reference: request.reference_no,
        title: request.title,
        // The requester can never approve their own request (enforced by workflow-service).
        requester_id: request.requested_by,
        // What workflow conditions can route on.
        context: { ...request.details, priority: request.priority, request_type: request.request_type, origin_type: request.origin_type },
      },
    });
    return request;
  }

  createRequest(user: Principal, input: z.infer<typeof CreateRequest>) {
    return this.db.tx(user.tenantId, async (q) => {
      const type = await q.maybeOne<RequestTypeRow>(`SELECT ${TYPE} FROM request_types WHERE key = $1`, [input.request_type]);
      if (!type) throw DomainError.invalid(`unknown request type '${input.request_type}'`);
      if (!hasAnyRole(user, type.requester_roles)) throw DomainError.forbidden(`your roles may not raise a '${type.name}' request`);
      const issues = validateFieldValues(type.detail_fields, input.details);
      if (issues.length) throw DomainError.invalid('request details are invalid', issues);
      if (input.asset_id) {
        const asset = await q.maybeOne<{ status: string }>('SELECT status FROM asset_projection WHERE asset_id = $1', [input.asset_id]);
        if (!asset) throw DomainError.invalid('asset not found');
        if (asset.status === 'retired') throw DomainError.conflict('invalid_state', 'a retired asset cannot be maintained');
      }
      const request = await this.submit(q, user.tenantId, {
        type,
        title: input.title,
        description: input.description,
        priority: input.priority ?? type.default_priority,
        assetId: input.asset_id,
        details: input.details,
        origin: { type: 'manual', id: null },
        requester: { id: user.userId, username: user.username },
      });
      return request!;
    });
  }

  listRequests(user: Principal, query: z.infer<typeof ListRequests>) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT r.id, r.reference_no, r.request_type, r.pack_id, r.subject_type, r.title, r.priority, r.status, r.origin_type, r.origin_id, r.asset_id,
                a.code AS asset_code, a.name AS asset_name, r.requested_by_username, r.submitted_at, r.decided_at,
                w.id AS work_order_id, w.reference_no AS work_order_reference, w.status AS work_order_status
           FROM maintenance_requests r
           LEFT JOIN asset_projection a ON a.asset_id = r.asset_id
           LEFT JOIN work_orders w ON w.request_id = r.id
          WHERE ($1::text IS NULL OR r.status = $1) AND ($2::text IS NULL OR r.pack_id = $2) AND ($3::uuid IS NULL OR r.asset_id = $3)
            -- Staff see every request of the tenant; anyone else only their own.
            AND ($4::boolean OR r.requested_by = $5)
          ORDER BY r.submitted_at DESC
          LIMIT $6`,
        [query.status ?? null, query.pack ?? null, query.asset_id ?? null, this.isStaff(user), user.userId, query.limit],
      ),
    );
  }

  private async loadRequest(q: Q, user: Principal, id: string, lock = false): Promise<RequestRow> {
    const row = await q.maybeOne<RequestRow>(`SELECT ${REQUEST} FROM maintenance_requests WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    // Someone else's request answers like a missing one, so its existence is not disclosed.
    if (!row || (!this.isStaff(user) && row.requested_by !== user.userId)) throw DomainError.notFound('request');
    return row;
  }

  getRequest(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const request = await this.loadRequest(q, user, id);
      const asset = request.asset_id ? await q.maybeOne('SELECT asset_id AS id, code, name, category, status FROM asset_projection WHERE asset_id = $1', [request.asset_id]) : null;
      const workOrder = await q.maybeOne(
        'SELECT id, reference_no, status, assignee_username, started_at, completed_at, completion_summary FROM work_orders WHERE request_id = $1',
        [id],
      );
      return { ...request, asset, work_order: workOrder };
    });
  }

  cancelRequest(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const request = await this.loadRequest(q, user, id, true);
      if (request.requested_by !== user.userId && !hasAnyRole(user, PLANNING_ROLES)) throw DomainError.forbidden('only the requester or a planner may cancel a request');
      if (request.status !== 'submitted') throw DomainError.conflict('invalid_state', `a request that is ${request.status} cannot be cancelled`);
      const updated = await this.decide(q, request, 'cancelled', new Date());
      await this.outbox.emit(q, {
        type: 'workflow.cancel.requested.v1',
        aggregateType: 'maintenance_request',
        aggregateId: request.id,
        tenantId: request.tenant_id,
        payload: { subject_type: request.subject_type, subject_id: request.id, cancelled_by: user.userId },
      });
      return updated;
    });
  }

  private async decide(q: Q, request: RequestRow, outcome: 'approved' | 'rejected' | 'cancelled', at: Date): Promise<RequestRow> {
    const updated = await q.one<RequestRow>(
      `UPDATE maintenance_requests SET status = $2, decided_at = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${REQUEST}`,
      [request.id, outcome, at],
    );
    await this.outbox.emit(q, {
      type: 'maintenance.request.decided.v1',
      aggregateType: 'maintenance_request',
      aggregateId: request.id,
      tenantId: request.tenant_id,
      payload: {
        request_id: request.id,
        reference_no: request.reference_no,
        request_type: request.request_type,
        pack_id: request.pack_id,
        outcome,
        submitted_at: request.submitted_at.toISOString(),
        decided_at: at.toISOString(),
      },
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Work orders
  // ---------------------------------------------------------------------------

  private async openWorkOrder(q: Q, request: RequestRow): Promise<void> {
    const reference = await this.nextReference(q, request.tenant_id, 'WO');
    const order = await q.maybeOne<WorkOrderRow>(
      `INSERT INTO work_orders (tenant_id, reference_no, request_id, request_type, pack_id, title, description, priority, asset_id, origin_type, origin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING ${WORK_ORDER}`,
      [request.tenant_id, reference, request.id, request.request_type, request.pack_id, request.title, request.description, request.priority, request.asset_id, request.origin_type, request.origin_id],
    );
    if (!order) return;
    await this.log(q, order, 'created', `Created from approved request ${request.reference_no}`, null);
    await this.outbox.emit(q, {
      type: 'maintenance.work_order.created.v1',
      aggregateType: 'work_order',
      aggregateId: order.id,
      tenantId: order.tenant_id,
      payload: {
        work_order_id: order.id,
        reference_no: order.reference_no,
        request_id: request.id,
        request_type: order.request_type,
        pack_id: order.pack_id,
        title: order.title,
        priority: order.priority,
        asset_id: order.asset_id,
        origin_type: order.origin_type,
        origin_id: order.origin_id,
        created_at: order.created_at.toISOString(),
      },
    });
    // Tell the roles that plan work that an order is waiting to be assigned.
    for (const role of [Roles.MaintenancePlanner, Roles.FacilityManager]) {
      await this.notify(q, order.tenant_id, { type: 'work_order', id: order.id }, { role }, `work-order-created:${order.id}:${role}`, 'maintenance.work_order_created', `Work order ${order.reference_no} needs assigning`, order.title);
    }
  }

  listWorkOrders(user: Principal, query: z.infer<typeof ListWorkOrders>) {
    const statuses = query.status === 'active' ? ['open', 'assigned', 'in_progress'] : query.status ? [query.status] : null;
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT w.id, w.reference_no, w.request_id, r.reference_no AS request_reference, w.request_type, w.pack_id, w.title, w.priority, w.status, w.asset_id,
                a.code AS asset_code, a.name AS asset_name, w.origin_type, w.origin_id, w.assignee_id, w.assignee_username,
                w.assigned_at, w.started_at, w.completed_at, w.labor_hours, w.condition_after, w.created_at
           FROM work_orders w
           JOIN maintenance_requests r ON r.id = w.request_id
           LEFT JOIN asset_projection a ON a.asset_id = w.asset_id
          WHERE ($1::text[] IS NULL OR w.status = ANY($1)) AND ($2::text IS NULL OR w.pack_id = $2) AND ($3::uuid IS NULL OR w.asset_id = $3)
            AND ($4::boolean IS FALSE OR w.assignee_id = $5)
          ORDER BY array_position(ARRAY['urgent', 'high', 'normal', 'low'], w.priority), w.created_at DESC
          LIMIT $6`,
        [statuses, query.pack ?? null, query.asset_id ?? null, query.mine === 'true', user.userId, query.limit],
      ),
    );
  }

  private async loadWorkOrder(q: Q, id: string, lock = false): Promise<WorkOrderRow> {
    const row = await q.maybeOne<WorkOrderRow>(`SELECT ${WORK_ORDER} FROM work_orders WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!row) throw DomainError.notFound('work order');
    return row;
  }

  getWorkOrder(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const order = await this.loadWorkOrder(q, id);
      const request = await q.one('SELECT id, reference_no, request_type, details, requested_by_username, submitted_at, decided_at FROM maintenance_requests WHERE id = $1', [order.request_id]);
      const asset = order.asset_id ? await q.maybeOne('SELECT asset_id AS id, code, name, category, status FROM asset_projection WHERE asset_id = $1', [order.asset_id]) : null;
      const events = await q.query('SELECT entry_type, message, actor_username, occurred_at FROM work_order_events WHERE work_order_id = $1 ORDER BY occurred_at, id', [id]);
      return { ...order, repair_hours: hoursBetween(order.started_at, order.completed_at), request, asset, events };
    });
  }

  assign(user: Principal, id: string, input: z.infer<typeof AssignWorkOrder>) {
    return this.db.tx(user.tenantId, async (q) => {
      const order = await this.loadWorkOrder(q, id, true);
      if (!canPerform('assign', order.status)) throw DomainError.conflict('invalid_state', `a work order that is ${order.status} cannot be assigned`);
      const updated = await q.one<WorkOrderRow>(
        `UPDATE work_orders SET status = 'assigned', assignee_id = $2, assignee_username = $3, assigned_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING ${WORK_ORDER}`,
        [id, input.assignee_id, input.assignee_username],
      );
      await this.log(q, order, 'assigned', `Assigned to ${input.assignee_username}`, user.username);
      await this.outbox.emit(q, {
        type: 'maintenance.work_order.assigned.v1',
        aggregateType: 'work_order',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: { work_order_id: id, reference_no: order.reference_no, assignee_id: input.assignee_id, assignee_username: input.assignee_username, assigned_by: user.userId },
      });
      await this.notify(q, user.tenantId, { type: 'work_order', id }, { userId: input.assignee_id }, `work-order-assigned:${id}:${updated.version}`, 'maintenance.work_order_assigned', `Work order ${order.reference_no} assigned to you`, order.title);
      return updated;
    });
  }

  start(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const order = await this.loadWorkOrder(q, id, true);
      if (!mayExecute(user, order.assignee_id, PLANNING_ROLES)) throw DomainError.forbidden('only the assigned technician or a planner may start this work order');
      if (!canPerform('start', order.status)) throw DomainError.conflict('invalid_state', `a work order that is ${order.status} cannot be started`);
      const updated = await q.one<WorkOrderRow>(
        `UPDATE work_orders SET status = 'in_progress', started_at = now(), version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${WORK_ORDER}`,
        [id],
      );
      await this.log(q, order, 'started', 'Work started', user.username);
      await this.outbox.emit(q, {
        type: 'maintenance.work_order.started.v1',
        aggregateType: 'work_order',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: { work_order_id: id, reference_no: order.reference_no, asset_id: order.asset_id, started_by: user.userId, started_at: updated.started_at!.toISOString() },
      });
      return updated;
    });
  }

  complete(user: Principal, id: string, input: z.infer<typeof CompleteWorkOrder>) {
    return this.db.tx(user.tenantId, async (q) => {
      const order = await this.loadWorkOrder(q, id, true);
      if (!mayExecute(user, order.assignee_id, PLANNING_ROLES)) throw DomainError.forbidden('only the assigned technician or a planner may complete this work order');
      if (!canPerform('complete', order.status)) throw DomainError.conflict('invalid_state', `a work order that is ${order.status} cannot be completed`);
      if (input.condition_after && !order.asset_id) throw DomainError.invalid('condition_after applies only to work on an asset');
      const updated = await q.one<WorkOrderRow>(
        `UPDATE work_orders
            SET status = 'completed', completed_at = now(), completion_summary = $2, labor_hours = $3, condition_after = $4, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING ${WORK_ORDER}`,
        [id, input.summary, input.labor_hours, input.condition_after],
      );
      await this.log(q, order, 'completed', input.summary, user.username);
      await this.outbox.emit(q, {
        type: 'maintenance.work_order.completed.v1',
        aggregateType: 'work_order',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: {
          work_order_id: id,
          reference_no: order.reference_no,
          request_id: order.request_id,
          request_type: order.request_type,
          pack_id: order.pack_id,
          asset_id: order.asset_id,
          origin_type: order.origin_type,
          origin_id: order.origin_id,
          condition_after: updated.condition_after,
          labor_hours: updated.labor_hours,
          summary: input.summary,
          completed_by: user.userId,
          completed_by_username: user.username,
          created_at: order.created_at.toISOString(),
          started_at: updated.started_at ? updated.started_at.toISOString() : null,
          completed_at: updated.completed_at!.toISOString(),
        },
      });
      // Tell whoever raised the request that the work is done.
      const request = await q.one<{ requested_by: string | null; reference_no: string }>('SELECT requested_by, reference_no FROM maintenance_requests WHERE id = $1', [order.request_id]);
      if (request.requested_by && request.requested_by !== user.userId) {
        await this.notify(q, user.tenantId, { type: 'work_order', id }, { userId: request.requested_by }, `work-order-completed:${id}`, 'maintenance.work_order_completed', `Work for ${request.reference_no} is complete`, input.summary.slice(0, 500));
      }
      return updated;
    });
  }

  cancelWorkOrder(user: Principal, id: string, input: z.infer<typeof CancelWorkOrder>) {
    return this.db.tx(user.tenantId, async (q) => {
      const order = await this.loadWorkOrder(q, id, true);
      if (!canPerform('cancel', order.status)) throw DomainError.conflict('invalid_state', `a work order that is ${order.status} cannot be cancelled`);
      const updated = await q.one<WorkOrderRow>(
        `UPDATE work_orders SET status = 'cancelled', cancelled_reason = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${WORK_ORDER}`,
        [id, input.reason],
      );
      await this.log(q, order, 'cancelled', input.reason, user.username);
      await this.outbox.emit(q, {
        type: 'maintenance.work_order.cancelled.v1',
        aggregateType: 'work_order',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: { work_order_id: id, reference_no: order.reference_no, asset_id: order.asset_id, cancelled_by: user.userId, reason: input.reason },
      });
      return updated;
    });
  }

  summary(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const requests = await q.query('SELECT pack_id, status, count(*)::int AS count FROM maintenance_requests GROUP BY pack_id, status ORDER BY 1, 2');
      const workOrders = await q.query('SELECT pack_id, status, count(*)::int AS count FROM work_orders GROUP BY pack_id, status ORDER BY 1, 2');
      const turnaround = await q.query(
        `SELECT w.pack_id, count(*)::int AS completed,
                round((avg(extract(epoch FROM w.completed_at - r.submitted_at)) / 3600)::numeric, 2) AS avg_request_to_completion_hours,
                round((avg(extract(epoch FROM w.completed_at - w.started_at)) / 3600)::numeric, 2) AS avg_repair_hours
           FROM work_orders w JOIN maintenance_requests r ON r.id = w.request_id
          WHERE w.status = 'completed' GROUP BY w.pack_id ORDER BY 1`,
      );
      return { requests, work_orders: workOrders, turnaround };
    });
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private async onEvent(event: EventEnvelope, q: Q): Promise<void> {
    switch (event.event_type) {
      case 'tenant.pack.activated.v1': {
        const p = event.payload as EventPayload<'tenant.pack.activated.v1'>;
        for (const raw of p.install.request_types) {
          const t = PackRequestType.parse(raw);
          await q.exec(
            `INSERT INTO request_types (tenant_id, key, name, description, subject_type, workflow_key, default_priority, requester_roles, auto_from_incident_category, detail_fields, pack_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (tenant_id, key) DO UPDATE
               SET name = EXCLUDED.name, description = EXCLUDED.description, subject_type = EXCLUDED.subject_type, workflow_key = EXCLUDED.workflow_key,
                   default_priority = EXCLUDED.default_priority, requester_roles = EXCLUDED.requester_roles,
                   auto_from_incident_category = EXCLUDED.auto_from_incident_category, detail_fields = EXCLUDED.detail_fields, updated_at = now()
             WHERE request_types.pack_id = EXCLUDED.pack_id`,
            [event.tenant_id, t.key, t.name, t.description, t.subject_type, t.workflow_key, t.default_priority, t.requester_roles, t.auto_from_incident_category ?? null, JSON.stringify(t.detail_fields), p.pack_id],
          );
        }
        return;
      }
      case 'incident.created.v1': {
        const p = event.payload as EventPayload<'incident.created.v1'>;
        if (!p.category) return;
        const type = await q.maybeOne<RequestTypeRow>(`SELECT ${TYPE} FROM request_types WHERE auto_from_incident_category = $1 ORDER BY key LIMIT 1`, [p.category]);
        if (!type) return;
        // Automation belongs to the capability: a tenant that deactivated it gets no new requests.
        if (!(await this.entitlements.has(event.tenant_id, Capabilities.Maintenance))) {
          this.logger.info({ tenant_id: event.tenant_id, incident_id: p.incident_id }, 'maintenance capability not active; no request raised for the incident');
          return;
        }
        const assetId = p.asset_id && (await q.maybeOne('SELECT 1 FROM asset_projection WHERE asset_id = $1', [p.asset_id])) ? p.asset_id : null;
        await this.submit(q, event.tenant_id, {
          type,
          title: p.title,
          description: `Raised automatically from incident ${p.reference_no} (${p.severity}).`,
          priority: priorityFromSeverity(p.severity, type.default_priority),
          assetId,
          details: {},
          origin: { type: 'incident', id: p.incident_id },
          requester: null,
        });
        return;
      }
      case 'workflow.instance.completed.v1': {
        const p = event.payload as EventPayload<'workflow.instance.completed.v1'>;
        if (p.subject_type !== 'maintenance_request' && p.subject_type !== 'service_request') return;
        const request = await q.maybeOne<RequestRow>(`SELECT ${REQUEST} FROM maintenance_requests WHERE id = $1 FOR UPDATE`, [p.subject_id]);
        // Already decided (e.g. cancelled by the requester before the process ended): nothing to apply.
        if (!request || request.status !== 'submitted') return;
        const decided = await this.decide(q, request, p.outcome, new Date(p.completed_at));
        if (p.outcome === 'approved') await this.openWorkOrder(q, decided);
        return;
      }
      case 'asset.created.v1': {
        const p = event.payload as EventPayload<'asset.created.v1'>;
        await q.exec(
          `INSERT INTO asset_projection (asset_id, tenant_id, code, name, category, status) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (asset_id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, category = EXCLUDED.category`,
          [p.asset_id, event.tenant_id, p.code, p.name, p.category, p.status],
        );
        return;
      }
      case 'asset.status_changed.v1': {
        const p = event.payload as EventPayload<'asset.status_changed.v1'>;
        await q.exec('UPDATE asset_projection SET status = $2 WHERE asset_id = $1', [p.asset_id, p.to]);
        return;
      }
    }
  }
}
