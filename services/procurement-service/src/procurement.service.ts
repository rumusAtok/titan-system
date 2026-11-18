import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { hasAnyRole, type Principal } from '@titan/authentication';
import { Capabilities, type EventEnvelope, type EventPayload, Roles } from '@titan/contracts';
import type { Logger } from '@titan/observability';
import { Db, DomainError, Entitlements, EventConsumers, LOGGER, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { budgetPosition, checkReceipt, isLow, replenishmentQuantity, requestTotal } from './rules.js';

export const APPROVAL_WORKFLOW = process.env.PURCHASE_APPROVAL_WORKFLOW ?? 'purchase-approval';

/** Roles that manage suppliers and the catalogue. */
export const BUYERS = [Roles.ProcurementOfficer, Roles.TenantAdmin];
/** Roles that receive, issue and count stock. */
export const STORES = [Roles.Storekeeper, Roles.ProcurementOfficer, Roles.TenantAdmin];
/** Roles that may raise a purchase request. */
export const REQUESTERS = [Roles.ProcurementOfficer, Roles.Storekeeper, Roles.MaintenancePlanner, Roles.FacilityManager, Roles.TenantAdmin];

const code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/);
const location = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/);

export const CreateSupplier = z.object({
  code,
  name: z.string().min(2).max(200),
  contact_email: z.email().max(254).nullable().default(null),
  phone: z.string().max(40).nullable().default(null),
});

export const CreateItem = z.object({
  sku: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,40}$/),
  name: z.string().min(2).max(200),
  category: z.string().min(2).max(60).default('general'),
  unit: z.string().min(1).max(20).default('each'),
  unit_cost: z.number().min(0).max(10_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  reorder_level: z.number().min(0).max(1_000_000).default(0),
  reorder_quantity: z.number().min(0).max(1_000_000).default(0),
  preferred_supplier_code: code.nullable().default(null),
});

export const CreatePurchaseRequest = z.object({
  title: z.string().trim().min(3).max(200),
  justification: z.string().max(4000).default(''),
  supplier_code: code,
  delivery_location: location,
  lines: z.array(z.object({ sku: z.string().min(2).max(41), quantity: z.number().positive().max(1_000_000), unit_cost: z.number().min(0).max(10_000_000).optional() })).min(1).max(50),
  /** Optional link to the work order the goods are for. */
  work_order_id: z.uuid().nullable().default(null),
  /** Cost centre the purchase is charged to (its budget is checked at submission). */
  cost_centre_code: code.nullable().default(null),
});

export const ReceiveGoods = z.object({
  lines: z.array(z.object({ line_no: z.number().int().positive(), quantity: z.number().positive() })).min(1).max(50),
  note: z.string().max(1000).default(''),
});

export const IssueStock = z.object({
  sku: z.string().min(2).max(41),
  location,
  quantity: z.number().positive().max(1_000_000),
  reference_type: z.enum(['work_order', 'maintenance_request', 'other']).default('other'),
  reference_id: z.string().max(100).nullable().default(null),
  note: z.string().max(500).default(''),
});

export const AdjustStock = z.object({
  sku: z.string().min(2).max(41),
  location,
  /** Counted quantity: the stock level is set to it and the difference recorded. */
  counted: z.number().min(0).max(1_000_000),
  note: z.string().trim().min(3).max(500),
});

export const ListRequests = z.object({
  status: z.enum(['submitted', 'approved', 'rejected', 'cancelled', 'ordered']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

interface ItemRow {
  id: string;
  tenant_id: string;
  sku: string;
  name: string;
  unit: string;
  unit_cost: number;
  currency: string;
  reorder_level: number;
  reorder_quantity: number;
  preferred_supplier_id: string | null;
}

export interface PurchaseRequestRow {
  id: string;
  tenant_id: string;
  reference_no: string;
  title: string;
  justification: string;
  supplier_id: string;
  delivery_location: string;
  total_amount: number;
  currency: string;
  status: 'submitted' | 'approved' | 'rejected' | 'cancelled' | 'ordered';
  origin_type: 'manual' | 'low_stock' | 'work_order' | 'rfq';
  origin_id: string | null;
  cost_centre_id: string | null;
  over_budget: boolean;
  requested_by: string | null;
  requested_by_username: string | null;
  submitted_at: Date;
  decided_at: Date | null;
}

const ITEM = 'id, tenant_id, sku, name, unit, unit_cost, currency, reorder_level, reorder_quantity, preferred_supplier_id';
const PR = `id, tenant_id, reference_no, title, justification, supplier_id, delivery_location, total_amount, currency, status, origin_type, origin_id,
  cost_centre_id, over_budget, requested_by, requested_by_username, submitted_at, decided_at`;

/**
 * Procurement and inventory.
 *
 *   purchase request --purchase-approval workflow--> approved --> purchase order (issued)
 *   purchase order --goods receipt(s)--> stock up;  stock issue --> stock down
 *   stock at or below its reorder level --> replenishment request (automatic, deduplicated)
 *
 * A purchase order is an internal record: nothing is sent to a supplier.
 */
@Injectable()
export class ProcurementService implements OnApplicationBootstrap {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(Entitlements) private readonly entitlements: Entitlements,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    // One registration per service: registrations share the service's durable consumer, so two would split its messages.
    this.consumers.register({
      subjects: ['workflow.instance.completed.v1', 'maintenance.work_order.completed.v1'],
      handler: (event, q) => (event.event_type === 'maintenance.work_order.completed.v1' ? this.onWorkOrderCompleted(event, q) : this.onApprovalCompleted(event, q)),
    });
  }

  private async nextReference(q: Q, tenantId: string, series: 'PR' | 'PO' | 'GR'): Promise<string> {
    const year = new Date().getUTCFullYear();
    const { last_no } = await q.one<{ last_no: number }>(
      `INSERT INTO procurement_counters (tenant_id, series, year, last_no) VALUES ($1, $2, $3, 1)
       ON CONFLICT (tenant_id, series, year) DO UPDATE SET last_no = procurement_counters.last_no + 1 RETURNING last_no`,
      [tenantId, series, year],
    );
    return `${series}-${year}-${String(last_no).padStart(6, '0')}`;
  }

  async itemBySku(q: Q, sku: string): Promise<ItemRow> {
    const item = await q.maybeOne<ItemRow>(`SELECT ${ITEM} FROM items WHERE sku = $1 AND active`, [sku]);
    if (!item) throw DomainError.invalid(`unknown item '${sku}'`);
    return item;
  }

  // --- master data -------------------------------------------------------------

  listSuppliers(user: Principal) {
    return this.db.tx(user.tenantId, (q) => q.query('SELECT id, code, name, contact_email, phone, active, created_at FROM suppliers ORDER BY code'));
  }

  createSupplier(user: Principal, input: z.infer<typeof CreateSupplier>) {
    return this.db.tx(user.tenantId, (q) =>
      q.one('INSERT INTO suppliers (tenant_id, code, name, contact_email, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id, code, name, contact_email, phone, active, created_at', [
        user.tenantId,
        input.code,
        input.name,
        input.contact_email,
        input.phone,
      ]),
    );
  }

  listItems(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT i.id, i.sku, i.name, i.category, i.unit, i.unit_cost, i.currency, i.reorder_level, i.reorder_quantity, s.code AS preferred_supplier,
                COALESCE((SELECT sum(on_hand) FROM stock_levels l WHERE l.item_id = i.id), 0) AS on_hand,
                COALESCE((SELECT json_agg(json_build_object('location', l.location, 'on_hand', l.on_hand) ORDER BY l.location) FROM stock_levels l WHERE l.item_id = i.id), '[]') AS locations
           FROM items i LEFT JOIN suppliers s ON s.id = i.preferred_supplier_id
          WHERE i.active ORDER BY i.sku`,
      ),
    );
  }

  createItem(user: Principal, input: z.infer<typeof CreateItem>) {
    return this.db.tx(user.tenantId, async (q) => {
      let supplierId: string | null = null;
      if (input.preferred_supplier_code) {
        const s = await q.maybeOne<{ id: string }>('SELECT id FROM suppliers WHERE code = $1', [input.preferred_supplier_code]);
        if (!s) throw DomainError.invalid(`unknown supplier '${input.preferred_supplier_code}'`);
        supplierId = s.id;
      }
      return q.one(
        `INSERT INTO items (tenant_id, sku, name, category, unit, unit_cost, currency, reorder_level, reorder_quantity, preferred_supplier_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${ITEM}, category`,
        [user.tenantId, input.sku, input.name, input.category, input.unit, input.unit_cost, input.currency, input.reorder_level, input.reorder_quantity, supplierId],
      );
    });
  }

  // --- purchase requests ---------------------------------------------------------

  /** Committed spend of a cost centre this year: requests not rejected or cancelled. */
  async budgetOf(q: Q, costCentreId: string): Promise<{ budget: number | null; committed: number; currency: string | null }> {
    const year = new Date().getUTCFullYear();
    const b = await q.maybeOne<{ amount: number; currency: string }>('SELECT amount, currency FROM budgets WHERE cost_centre_id = $1 AND year = $2', [costCentreId, year]);
    const c = await q.one<{ committed: number }>(
      `SELECT COALESCE(sum(total_amount), 0) AS committed FROM purchase_requests
        WHERE cost_centre_id = $1 AND status IN ('submitted', 'approved', 'ordered') AND extract(year FROM submitted_at) = $2`,
      [costCentreId, year],
    );
    return { budget: b ? Number(b.amount) : null, committed: Number(c.committed), currency: b?.currency ?? null };
  }

  /** Internal API (also used by sourcing). */
  async submit(
    q: Q,
    tenantId: string,
    input: {
      title: string;
      justification: string;
      supplierId: string;
      location: string;
      lines: { item: ItemRow; quantity: number; unit_cost: number }[];
      origin: { type: 'manual' | 'low_stock' | 'work_order' | 'rfq'; id: string | null };
      requester: { id: string; username: string } | null;
      costCentreId?: string | null;
    },
  ): Promise<PurchaseRequestRow | null> {
    const currencies = new Set(input.lines.map((l) => l.item.currency));
    if (currencies.size > 1) throw DomainError.invalid('all lines of a purchase request must have the same currency');
    const total = requestTotal(input.lines.map((l) => ({ quantity: l.quantity, unit_cost: l.unit_cost })));
    const costCentreId = input.costCentreId ?? null;
    const position = costCentreId ? await this.budgetOf(q, costCentreId).then((b) => budgetPosition(b.budget, b.committed, total)) : { available: null, over: false };
    const reference = await this.nextReference(q, tenantId, 'PR');
    const pr = await q.maybeOne<PurchaseRequestRow>(
      `INSERT INTO purchase_requests (tenant_id, reference_no, title, justification, supplier_id, delivery_location, total_amount, currency, origin_type, origin_id,
                                      requested_by, requested_by_username, cost_centre_id, over_budget)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT DO NOTHING RETURNING ${PR}`,
      [
        tenantId, reference, input.title, input.justification, input.supplierId, input.location, total, [...currencies][0], input.origin.type, input.origin.id,
        input.requester?.id ?? null, input.requester?.username ?? null, costCentreId, position.over,
      ],
    );
    if (!pr) return null; // an open replenishment request already exists for this item and location
    let n = 0;
    for (const l of input.lines) {
      n += 1;
      await q.exec('INSERT INTO purchase_request_lines (tenant_id, purchase_request_id, line_no, item_id, quantity, unit_cost) VALUES ($1, $2, $3, $4, $5, $6)', [
        tenantId,
        pr.id,
        n,
        l.item.id,
        l.quantity,
        l.unit_cost,
      ]);
    }
    await this.outbox.emit(q, {
      type: 'procurement.purchase_request.submitted.v1',
      aggregateType: 'purchase_request',
      aggregateId: pr.id,
      tenantId,
      payload: { purchase_request_id: pr.id, reference_no: pr.reference_no, total_amount: total, currency: pr.currency, lines: n, requested_by: pr.requested_by ?? 'system', origin_type: pr.origin_type, origin_id: pr.origin_id },
    });
    await this.outbox.emit(q, {
      type: 'workflow.start.requested.v1',
      aggregateType: 'purchase_request',
      aggregateId: pr.id,
      tenantId,
      payload: {
        subject_type: 'purchase_request',
        subject_id: pr.id,
        workflow_key: APPROVAL_WORKFLOW,
        reference: pr.reference_no,
        title: pr.title,
        requester_id: pr.requested_by,
        // What approval stages can route on (e.g. a second approval above an amount).
        context: { total_amount: total, currency: pr.currency, origin_type: pr.origin_type, lines: n, over_budget: position.over, budget_available: position.available },
      },
    });
    return pr;
  }

  createRequest(user: Principal, input: z.infer<typeof CreatePurchaseRequest>) {
    return this.db.tx(user.tenantId, async (q) => {
      const supplier = await q.maybeOne<{ id: string; active: boolean }>('SELECT id, active FROM suppliers WHERE code = $1', [input.supplier_code]);
      if (!supplier || !supplier.active) throw DomainError.invalid(`unknown or inactive supplier '${input.supplier_code}'`);
      const lines = [];
      for (const l of input.lines) {
        const item = await this.itemBySku(q, l.sku);
        lines.push({ item, quantity: l.quantity, unit_cost: l.unit_cost ?? Number(item.unit_cost) });
      }
      let costCentreId: string | null = null;
      if (input.cost_centre_code) {
        const cc = await q.maybeOne<{ id: string; active: boolean }>('SELECT id, active FROM cost_centres WHERE code = $1', [input.cost_centre_code]);
        if (!cc || !cc.active) throw DomainError.invalid(`unknown or inactive cost centre '${input.cost_centre_code}'`);
        costCentreId = cc.id;
      }
      const pr = await this.submit(q, user.tenantId, {
        costCentreId,
        title: input.title,
        justification: input.justification,
        supplierId: supplier.id,
        location: input.delivery_location,
        lines,
        origin: input.work_order_id ? { type: 'work_order', id: input.work_order_id } : { type: 'manual', id: null },
        requester: { id: user.userId, username: user.username },
      });
      return pr!;
    });
  }

  listRequests(user: Principal, query: z.infer<typeof ListRequests>) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT r.id, r.reference_no, r.title, r.total_amount, r.currency, r.status, r.origin_type, r.origin_id, r.requested_by_username, r.submitted_at, r.decided_at,
                r.over_budget, cc.code AS cost_centre_code,
                s.code AS supplier_code, s.name AS supplier_name, o.id AS purchase_order_id, o.reference_no AS purchase_order_reference, o.status AS purchase_order_status
           FROM purchase_requests r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN purchase_orders o ON o.purchase_request_id = r.id
           LEFT JOIN cost_centres cc ON cc.id = r.cost_centre_id
          WHERE ($1::text IS NULL OR r.status = $1)
          ORDER BY r.submitted_at DESC LIMIT $2`,
        [query.status ?? null, query.limit],
      ),
    );
  }

  getRequest(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const pr = await q.maybeOne<PurchaseRequestRow>(`SELECT ${PR} FROM purchase_requests WHERE id = $1`, [id]);
      if (!pr) throw DomainError.notFound('purchase request');
      const lines = await q.query(
        `SELECT l.line_no, i.sku, i.name, i.unit, l.quantity, l.unit_cost, round(l.quantity * l.unit_cost, 2) AS line_total
           FROM purchase_request_lines l JOIN items i ON i.id = l.item_id WHERE l.purchase_request_id = $1 ORDER BY l.line_no`,
        [id],
      );
      const supplier = await q.one('SELECT code, name FROM suppliers WHERE id = $1', [pr.supplier_id]);
      const order = await q.maybeOne('SELECT id, reference_no, status, issued_at FROM purchase_orders WHERE purchase_request_id = $1', [id]);
      const costCentre = pr.cost_centre_id ? await q.maybeOne('SELECT code, name FROM cost_centres WHERE id = $1', [pr.cost_centre_id]) : null;
      return { ...pr, supplier, lines, purchase_order: order, cost_centre: costCentre };
    });
  }

  cancelRequest(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const pr = await q.maybeOne<PurchaseRequestRow>(`SELECT ${PR} FROM purchase_requests WHERE id = $1 FOR UPDATE`, [id]);
      if (!pr) throw DomainError.notFound('purchase request');
      if (pr.requested_by !== user.userId && !hasAnyRole(user, BUYERS)) throw DomainError.forbidden('only the requester or a procurement officer may cancel a request');
      if (pr.status !== 'submitted') throw DomainError.conflict('invalid_state', `a request that is ${pr.status} cannot be cancelled`);
      await this.decide(q, pr, 'cancelled', new Date());
      await this.outbox.emit(q, {
        type: 'workflow.cancel.requested.v1',
        aggregateType: 'purchase_request',
        aggregateId: id,
        tenantId: pr.tenant_id,
        payload: { subject_type: 'purchase_request', subject_id: id, cancelled_by: user.userId },
      });
      return { id, status: 'cancelled' };
    });
  }

  private async decide(q: Q, pr: PurchaseRequestRow, outcome: 'approved' | 'rejected' | 'cancelled', at: Date): Promise<void> {
    await q.exec('UPDATE purchase_requests SET status = $2, decided_at = $3, version = version + 1 WHERE id = $1', [pr.id, outcome, at]);
    await this.outbox.emit(q, {
      type: 'procurement.purchase_request.decided.v1',
      aggregateType: 'purchase_request',
      aggregateId: pr.id,
      tenantId: pr.tenant_id,
      payload: { purchase_request_id: pr.id, reference_no: pr.reference_no, outcome, decided_at: at.toISOString() },
    });
  }

  // --- purchase orders and receipts ------------------------------------------------

  private async issueOrder(q: Q, pr: PurchaseRequestRow): Promise<void> {
    const reference = await this.nextReference(q, pr.tenant_id, 'PO');
    const order = await q.maybeOne<{ id: string; issued_at: Date }>(
      `INSERT INTO purchase_orders (tenant_id, reference_no, purchase_request_id, supplier_id, delivery_location, total_amount, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (purchase_request_id) DO NOTHING RETURNING id, issued_at`,
      [pr.tenant_id, reference, pr.id, pr.supplier_id, pr.delivery_location, pr.total_amount, pr.currency],
    );
    if (!order) return;
    await q.exec(
      `INSERT INTO purchase_order_lines (tenant_id, purchase_order_id, line_no, item_id, quantity_ordered, unit_cost)
       SELECT tenant_id, $2, line_no, item_id, quantity, unit_cost FROM purchase_request_lines WHERE purchase_request_id = $1`,
      [pr.id, order.id],
    );
    await q.exec(`UPDATE purchase_requests SET status = 'ordered', version = version + 1 WHERE id = $1`, [pr.id]);
    await this.outbox.emit(q, {
      type: 'procurement.purchase_order.issued.v1',
      aggregateType: 'purchase_order',
      aggregateId: order.id,
      tenantId: pr.tenant_id,
      payload: { purchase_order_id: order.id, reference_no: reference, purchase_request_id: pr.id, supplier_id: pr.supplier_id, total_amount: Number(pr.total_amount), currency: pr.currency, issued_at: order.issued_at.toISOString() },
    });
    for (const role of [Roles.Storekeeper, Roles.ProcurementOfficer]) {
      await this.outbox.emit(q, {
        type: 'notification.requested.v1',
        aggregateType: 'purchase_order',
        aggregateId: order.id,
        tenantId: pr.tenant_id,
        payload: {
          dedupe_key: `po-issued:${order.id}:${role}`,
          channel: 'in_app',
          category: 'procurement.order_issued',
          external: false,
          recipient_user_id: null,
          recipient_role: role,
          recipient_address: null,
          subject: `Purchase order ${reference} issued`,
          body: `${pr.title}: delivery to ${pr.delivery_location}.`,
          reference_type: 'purchase_order',
          reference_id: order.id,
        },
      });
    }
  }

  listOrders(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT o.id, o.reference_no, o.status, o.total_amount, o.currency, o.delivery_location, o.issued_at, o.closed_at, r.reference_no AS request_reference, r.title,
                s.code AS supplier_code, s.name AS supplier_name
           FROM purchase_orders o JOIN purchase_requests r ON r.id = o.purchase_request_id JOIN suppliers s ON s.id = o.supplier_id
          ORDER BY o.issued_at DESC LIMIT 200`,
      ),
    );
  }

  getOrder(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const order = await q.maybeOne(
        `SELECT o.id, o.reference_no, o.status, o.total_amount, o.currency, o.delivery_location, o.issued_at, o.closed_at, o.purchase_request_id,
                r.reference_no AS request_reference, r.title, s.code AS supplier_code, s.name AS supplier_name
           FROM purchase_orders o JOIN purchase_requests r ON r.id = o.purchase_request_id JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = $1`,
        [id],
      );
      if (!order) throw DomainError.notFound('purchase order');
      const lines = await q.query(
        `SELECT l.line_no, i.sku, i.name, i.unit, l.quantity_ordered, l.quantity_received, l.unit_cost
           FROM purchase_order_lines l JOIN items i ON i.id = l.item_id WHERE l.purchase_order_id = $1 ORDER BY l.line_no`,
        [id],
      );
      const receipts = await q.query('SELECT id, reference_no, lines, note, received_by, received_at FROM goods_receipts WHERE purchase_order_id = $1 ORDER BY received_at', [id]);
      return { ...order, lines, receipts };
    });
  }

  receive(user: Principal, id: string, input: z.infer<typeof ReceiveGoods>) {
    return this.db.tx(user.tenantId, async (q) => {
      const order = await q.maybeOne<{ id: string; reference_no: string; status: string; delivery_location: string }>(
        'SELECT id, reference_no, status, delivery_location FROM purchase_orders WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!order) throw DomainError.notFound('purchase order');
      if (order.status === 'received' || order.status === 'cancelled') throw DomainError.conflict('invalid_state', `the order is ${order.status}`);
      const lines = await q.query<{ line_no: number; item_id: string; sku: string; quantity_ordered: number; quantity_received: number }>(
        `SELECT l.line_no, l.item_id, i.sku, l.quantity_ordered, l.quantity_received FROM purchase_order_lines l JOIN items i ON i.id = l.item_id
          WHERE l.purchase_order_id = $1 ORDER BY l.line_no FOR UPDATE OF l`,
        [id],
      );
      const check = checkReceipt(lines, input.lines);
      if (!check.ok) throw DomainError.invalid(check.reason);
      const reference = await this.nextReference(q, user.tenantId, 'GR');
      const received: { item_id: string; sku: string; quantity: number }[] = [];
      for (const r of input.lines) {
        const line = lines.find((l) => l.line_no === r.line_no)!;
        await q.exec('UPDATE purchase_order_lines SET quantity_received = quantity_received + $3 WHERE purchase_order_id = $1 AND line_no = $2', [id, r.line_no, r.quantity]);
        await this.move(q, user.tenantId, line.item_id, order.delivery_location, r.quantity, 'receipt', { type: 'purchase_order', id }, `Receipt ${reference}`, user.username);
        received.push({ item_id: line.item_id, sku: line.sku, quantity: r.quantity });
      }
      const status = check.fully_received ? 'received' : 'partially_received';
      await q.exec(`UPDATE purchase_orders SET status = $2, closed_at = CASE WHEN $2 = 'received' THEN now() ELSE NULL END, version = version + 1 WHERE id = $1`, [id, status]);
      const receipt = await q.one<{ id: string; received_at: Date }>(
        'INSERT INTO goods_receipts (tenant_id, reference_no, purchase_order_id, lines, note, received_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, received_at',
        [user.tenantId, reference, id, JSON.stringify(received), input.note, user.username],
      );
      await this.outbox.emit(q, {
        type: 'procurement.goods.received.v1',
        aggregateType: 'purchase_order',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: { purchase_order_id: id, reference_no: order.reference_no, receipt_id: receipt.id, lines: received, fully_received: check.fully_received, received_by: user.userId, received_at: receipt.received_at.toISOString() },
      });
      return { purchase_order_id: id, receipt_reference: reference, status };
    });
  }

  // --- stock -----------------------------------------------------------------------

  /** Records a movement and applies it; the database refuses stock below zero. */
  private async move(q: Q, tenantId: string, itemId: string, location: string, quantity: number, kind: 'receipt' | 'issue' | 'adjustment', ref: { type: string | null; id: string | null }, note: string, by: string): Promise<number> {
    // An increase may create the level; a decrease only changes an existing one. (An INSERT of a negative
    // quantity would fail the CHECK before ON CONFLICT is considered.)
    const level =
      quantity >= 0
        ? await q.one<{ on_hand: number }>(
            `INSERT INTO stock_levels (tenant_id, item_id, location, on_hand) VALUES ($1, $2, $3, $4)
             ON CONFLICT (item_id, location) DO UPDATE SET on_hand = stock_levels.on_hand + EXCLUDED.on_hand, updated_at = now()
             RETURNING on_hand`,
            [tenantId, itemId, location, quantity],
          )
        : await q.maybeOne<{ on_hand: number }>('UPDATE stock_levels SET on_hand = on_hand + $3, updated_at = now() WHERE item_id = $1 AND location = $2 RETURNING on_hand', [
            itemId,
            location,
            quantity,
          ]);
    if (!level) throw DomainError.conflict('insufficient_stock', `no stock of this item at ${location}`);
    await q.exec('INSERT INTO stock_movements (tenant_id, item_id, location, quantity, kind, reference_type, reference_id, note, moved_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
      tenantId,
      itemId,
      location,
      quantity,
      kind,
      ref.type,
      ref.id,
      note,
      by,
    ]);
    return Number(level.on_hand);
  }

  /** Low stock: announce it, tell procurement, and raise one replenishment request (if procurement is active). */
  private async afterDecrease(q: Q, tenantId: string, item: ItemRow, location: string, onHand: number): Promise<string | null> {
    if (!isLow(onHand, Number(item.reorder_level))) return null;
    await this.outbox.emit(q, {
      type: 'procurement.stock.low.v1',
      aggregateType: 'item',
      aggregateId: item.id,
      tenantId,
      payload: { item_id: item.id, sku: item.sku, name: item.name, location, on_hand: onHand, reorder_level: Number(item.reorder_level) },
    });
    if (!item.preferred_supplier_id) return null;
    const quantity = replenishmentQuantity(onHand, Number(item.reorder_level), Number(item.reorder_quantity));
    const pr = await this.submit(q, tenantId, {
      title: `Replenish ${item.sku} at ${location}`,
      justification: `Stock fell to ${onHand} ${item.unit}, at or below the reorder level of ${item.reorder_level}.`,
      supplierId: item.preferred_supplier_id,
      location,
      lines: [{ item, quantity, unit_cost: Number(item.unit_cost) }],
      origin: { type: 'low_stock', id: `${item.id}:${location}` },
      requester: null,
    });
    if (pr) this.logger.info({ tenant_id: tenantId, sku: item.sku, location, reference: pr.reference_no }, 'replenishment request raised');
    return pr?.reference_no ?? null;
  }

  issue(user: Principal, input: z.infer<typeof IssueStock>) {
    return this.db.tx(user.tenantId, async (q) => {
      const item = await this.itemBySku(q, input.sku);
      const current = await q.maybeOne<{ on_hand: number }>('SELECT on_hand FROM stock_levels WHERE item_id = $1 AND location = $2 FOR UPDATE', [item.id, input.location]);
      if (!current || Number(current.on_hand) < input.quantity) {
        throw DomainError.conflict('insufficient_stock', `only ${current ? Number(current.on_hand) : 0} ${item.unit} of ${item.sku} at ${input.location}`);
      }
      const onHand = await this.move(q, user.tenantId, item.id, input.location, -input.quantity, 'issue', { type: input.reference_type, id: input.reference_id }, input.note, user.username);
      await this.outbox.emit(q, {
        type: 'procurement.stock.issued.v1',
        aggregateType: 'item',
        aggregateId: item.id,
        tenantId: user.tenantId,
        payload: {
          item_id: item.id,
          sku: item.sku,
          quantity: input.quantity,
          location: input.location,
          reference_type: input.reference_type,
          reference_id: input.reference_id,
          issued_by: user.userId,
          unit_cost: Number(item.unit_cost),
          currency: item.currency,
        },
      });
      const replenishment = await this.afterDecrease(q, user.tenantId, item, input.location, onHand);
      return { sku: item.sku, location: input.location, on_hand: onHand, replenishment_request: replenishment };
    });
  }

  adjust(user: Principal, input: z.infer<typeof AdjustStock>) {
    return this.db.tx(user.tenantId, async (q) => {
      const item = await this.itemBySku(q, input.sku);
      const current = await q.maybeOne<{ on_hand: number }>('SELECT on_hand FROM stock_levels WHERE item_id = $1 AND location = $2 FOR UPDATE', [item.id, input.location]);
      const difference = input.counted - Number(current?.on_hand ?? 0);
      if (difference === 0) return { sku: item.sku, location: input.location, on_hand: input.counted, replenishment_request: null };
      const onHand = await this.move(q, user.tenantId, item.id, input.location, difference, 'adjustment', { type: null, id: null }, input.note, user.username);
      const replenishment = difference < 0 ? await this.afterDecrease(q, user.tenantId, item, input.location, onHand) : null;
      return { sku: item.sku, location: input.location, on_hand: onHand, replenishment_request: replenishment };
    });
  }

  movements(user: Principal, sku: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const item = await this.itemBySku(q, sku);
      return q.query('SELECT location, quantity, kind, reference_type, reference_id, note, moved_by, moved_at FROM stock_movements WHERE item_id = $1 ORDER BY moved_at DESC LIMIT 200', [item.id]);
    });
  }

  summary(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => ({
      requests: await q.query('SELECT status, count(*)::int AS count, COALESCE(sum(total_amount), 0) AS total FROM purchase_requests GROUP BY status ORDER BY status'),
      orders: await q.query('SELECT status, count(*)::int AS count FROM purchase_orders GROUP BY status ORDER BY status'),
      low_stock: await q.query(
        `SELECT i.sku, i.name, l.location, l.on_hand, i.reorder_level FROM stock_levels l JOIN items i ON i.id = l.item_id
          WHERE i.reorder_level > 0 AND l.on_hand <= i.reorder_level ORDER BY i.sku`,
      ),
      stock_value: (await q.one<{ value: number }>('SELECT COALESCE(round(sum(l.on_hand * i.unit_cost), 2), 0) AS value FROM stock_levels l JOIN items i ON i.id = l.item_id')).value,
    }));
  }

  // --- events ----------------------------------------------------------------------

  /**
   * A completed work order names the parts used: book them out of the named store. Not enough
   * stock (or an unknown item) is reported back, never invented; the work order itself stays done.
   */
  private async onWorkOrderCompleted(event: EventEnvelope, q: Q): Promise<void> {
    const p = event.payload as EventPayload<'maintenance.work_order.completed.v1'>;
    if (!p.parts?.length) return;
    if (!(await this.entitlements.has(event.tenant_id, Capabilities.Procurement))) return;
    for (const part of p.parts) {
      const fail = async (reason: string) => {
        await this.outbox.emit(q, {
          type: 'procurement.stock.issue_failed.v1',
          aggregateType: 'work_order',
          aggregateId: p.work_order_id,
          tenantId: event.tenant_id,
          payload: { sku: part.sku, quantity: part.quantity, location: part.location, reference_type: 'work_order', reference_id: p.work_order_id, reason },
        });
        await this.outbox.emit(q, {
          type: 'notification.requested.v1',
          aggregateType: 'work_order',
          aggregateId: p.work_order_id,
          tenantId: event.tenant_id,
          payload: {
            dedupe_key: `parts-failed:${p.work_order_id}:${part.sku}:${part.location}`,
            channel: 'in_app',
            category: 'procurement.parts_not_booked',
            external: false,
            recipient_user_id: null,
            recipient_role: Roles.Storekeeper,
            recipient_address: null,
            subject: `Parts for ${p.reference_no} not booked out`,
            body: `${part.quantity} x ${part.sku} from ${part.location}: ${reason}`,
            reference_type: 'work_order',
            reference_id: p.work_order_id,
          },
        });
      };
      const item = await q.maybeOne<ItemRow>(`SELECT ${ITEM} FROM items WHERE sku = $1 AND active`, [part.sku]);
      if (!item) {
        await fail('unknown item');
        continue;
      }
      // Idempotent per work order, item and store (a redelivered event books nothing twice).
      const done = await q.maybeOne("SELECT 1 FROM stock_movements WHERE kind = 'issue' AND reference_type = 'work_order' AND reference_id = $1 AND item_id = $2 AND location = $3", [
        p.work_order_id,
        item.id,
        part.location,
      ]);
      if (done) continue;
      const level = await q.maybeOne<{ on_hand: number }>('SELECT on_hand FROM stock_levels WHERE item_id = $1 AND location = $2 FOR UPDATE', [item.id, part.location]);
      if (!level || Number(level.on_hand) < part.quantity) {
        await fail(`only ${level ? Number(level.on_hand) : 0} ${item.unit} in stock`);
        continue;
      }
      const onHand = await this.move(q, event.tenant_id, item.id, part.location, -part.quantity, 'issue', { type: 'work_order', id: p.work_order_id }, `Used on ${p.reference_no}`, p.completed_by_username);
      await this.outbox.emit(q, {
        type: 'procurement.stock.issued.v1',
        aggregateType: 'item',
        aggregateId: item.id,
        tenantId: event.tenant_id,
        payload: {
          item_id: item.id,
          sku: item.sku,
          quantity: part.quantity,
          location: part.location,
          reference_type: 'work_order',
          reference_id: p.work_order_id,
          issued_by: p.completed_by,
          unit_cost: Number(item.unit_cost),
          currency: item.currency,
        },
      });
      await this.afterDecrease(q, event.tenant_id, item, part.location, onHand);
    }
  }

  private async onApprovalCompleted(event: EventEnvelope, q: Q): Promise<void> {
    const p = event.payload as EventPayload<'workflow.instance.completed.v1'>;
    if (p.subject_type !== 'purchase_request') return;
    const pr = await q.maybeOne<PurchaseRequestRow>(`SELECT ${PR} FROM purchase_requests WHERE id = $1 FOR UPDATE`, [p.subject_id]);
    if (!pr || pr.status !== 'submitted') return;
    await this.decide(q, pr, p.outcome, new Date(p.completed_at));
    if (p.outcome !== 'approved') return;
    // The capability may have been withdrawn while the request was in approval: record the decision, issue nothing.
    if (!(await this.entitlements.has(event.tenant_id, Capabilities.Procurement))) {
      this.logger.warn({ tenant_id: event.tenant_id, reference: pr.reference_no }, 'procurement capability not active; no purchase order issued');
      return;
    }
    await this.issueOrder(q, { ...pr, status: 'approved' });
  }
}
