import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import { Db, DomainError, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { ProcurementService } from './procurement.service.js';
import { budgetPosition, quotationTotal } from './rules.js';

const code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/);

export const CreateCostCentre = z.object({ code, name: z.string().trim().min(2).max(200) });

export const SetBudget = z.object({
  year: z.number().int().min(2000).max(2100),
  amount: z.number().min(0).max(1_000_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
});

export const CreateRfq = z.object({
  title: z.string().trim().min(3).max(200),
  delivery_location: code,
  cost_centre_code: code.nullable().default(null),
  respond_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(z.object({ sku: z.string().min(2).max(41), quantity: z.number().positive().max(1_000_000) })).min(1).max(50),
  supplier_codes: z.array(code).min(1).max(20),
});

export const RecordQuotation = z.object({
  supplier_code: code,
  lines: z.array(z.object({ line_no: z.number().int().positive(), unit_cost: z.number().min(0).max(10_000_000) })).min(1).max(50),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  lead_time_days: z.number().int().min(0).max(3650).nullable().default(null),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  note: z.string().max(1000).default(''),
});

export const Award = z.object({
  quotation_id: z.uuid(),
  /** Required when the chosen quotation is not the lowest. */
  reason: z.string().trim().max(1000).default(''),
});

interface RfqRow {
  id: string;
  tenant_id: string;
  reference_no: string;
  title: string;
  delivery_location: string;
  cost_centre_id: string | null;
  respond_by: string;
  status: 'open' | 'awarded' | 'cancelled';
  created_by: string;
  created_by_id: string;
}

const RFQ = 'id, tenant_id, reference_no, title, delivery_location, cost_centre_id, respond_by::text AS respond_by, status, created_by, created_by_id';

/**
 * Sourcing and budgets.
 *
 *   request for quotation (items, invited suppliers) -> quotations recorded by a buyer
 *   -> award -> purchase request (normal approval, charged to the cost centre) -> order ...
 *
 * Suppliers are not contacted by TITAN: a buyer records the quotations they received.
 */
@Injectable()
export class SourcingService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(ProcurementService) private readonly procurement: ProcurementService,
  ) {}

  // --- cost centres and budgets --------------------------------------------------------

  listCostCentres(user: Principal) {
    const year = new Date().getUTCFullYear();
    return this.db.tx(user.tenantId, async (q) => {
      const centres = await q.query<{ id: string; code: string; name: string; active: boolean }>('SELECT id, code, name, active FROM cost_centres ORDER BY code');
      const out = [];
      for (const c of centres) {
        const b = await this.procurement.budgetOf(q, c.id);
        out.push({ ...c, year, budget: b.budget, committed: b.committed, available: b.budget === null ? null : budgetPosition(b.budget, b.committed, 0).available, currency: b.currency });
      }
      return out;
    });
  }

  createCostCentre(user: Principal, input: z.infer<typeof CreateCostCentre>) {
    return this.db.tx(user.tenantId, async (q) => {
      if (await q.maybeOne('SELECT 1 FROM cost_centres WHERE code = $1', [input.code])) throw DomainError.conflict('duplicate', `cost centre ${input.code} exists`);
      return q.one('INSERT INTO cost_centres (tenant_id, code, name) VALUES ($1, $2, $3) RETURNING id, code, name, active', [user.tenantId, input.code, input.name]);
    });
  }

  setBudget(user: Principal, costCentreCode: string, input: z.infer<typeof SetBudget>) {
    return this.db.tx(user.tenantId, async (q) => {
      const cc = await q.maybeOne<{ id: string }>('SELECT id FROM cost_centres WHERE code = $1', [costCentreCode]);
      if (!cc) throw DomainError.notFound('cost centre');
      return q.one(
        `INSERT INTO budgets (tenant_id, cost_centre_id, year, amount, currency, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (cost_centre_id, year) DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING year, amount, currency, updated_by, updated_at`,
        [user.tenantId, cc.id, input.year, input.amount, input.currency, user.username],
      );
    });
  }

  // --- requests for quotation --------------------------------------------------------

  private async nextRfqReference(q: Q, tenantId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    const { last_no } = await q.one<{ last_no: number }>(
      `INSERT INTO procurement_counters (tenant_id, series, year, last_no) VALUES ($1, 'RFQ', $2, 1)
       ON CONFLICT (tenant_id, series, year) DO UPDATE SET last_no = procurement_counters.last_no + 1 RETURNING last_no`,
      [tenantId, year],
    );
    return `RFQ-${year}-${String(last_no).padStart(6, '0')}`;
  }

  listRfqs(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT r.id, r.reference_no, r.title, r.delivery_location, r.respond_by::text AS respond_by, r.status, r.created_by, r.created_at, cc.code AS cost_centre_code,
                (SELECT count(*)::int FROM rfq_suppliers s WHERE s.rfq_id = r.id) AS invited,
                (SELECT count(*)::int FROM quotations qt WHERE qt.rfq_id = r.id) AS quotations,
                (SELECT min(total_amount) FROM quotations qt WHERE qt.rfq_id = r.id) AS lowest_total,
                pr.reference_no AS purchase_request_reference, r.purchase_request_id
           FROM rfqs r LEFT JOIN cost_centres cc ON cc.id = r.cost_centre_id LEFT JOIN purchase_requests pr ON pr.id = r.purchase_request_id
          ORDER BY r.created_at DESC LIMIT 200`,
      ),
    );
  }

  createRfq(user: Principal, input: z.infer<typeof CreateRfq>) {
    return this.db.tx(user.tenantId, async (q) => {
      let costCentreId: string | null = null;
      if (input.cost_centre_code) {
        const cc = await q.maybeOne<{ id: string }>('SELECT id FROM cost_centres WHERE code = $1 AND active', [input.cost_centre_code]);
        if (!cc) throw DomainError.invalid(`unknown cost centre '${input.cost_centre_code}'`);
        costCentreId = cc.id;
      }
      const suppliers = [];
      for (const c of new Set(input.supplier_codes)) {
        const s = await q.maybeOne<{ id: string }>('SELECT id FROM suppliers WHERE code = $1 AND active', [c]);
        if (!s) throw DomainError.invalid(`unknown or inactive supplier '${c}'`);
        suppliers.push(s.id);
      }
      const reference = await this.nextRfqReference(q, user.tenantId);
      const rfq = await q.one<RfqRow>(
        `INSERT INTO rfqs (tenant_id, reference_no, title, delivery_location, cost_centre_id, respond_by, created_by, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${RFQ}`,
        [user.tenantId, reference, input.title, input.delivery_location, costCentreId, input.respond_by, user.username, user.userId],
      );
      let n = 0;
      for (const l of input.lines) {
        const item = await this.procurement.itemBySku(q, l.sku);
        n += 1;
        await q.exec('INSERT INTO rfq_lines (tenant_id, rfq_id, line_no, item_id, quantity) VALUES ($1, $2, $3, $4, $5)', [user.tenantId, rfq.id, n, item.id, l.quantity]);
      }
      for (const s of suppliers) await q.exec('INSERT INTO rfq_suppliers (tenant_id, rfq_id, supplier_id) VALUES ($1, $2, $3)', [user.tenantId, rfq.id, s]);
      return rfq;
    });
  }

  private async load(q: Q, id: string, lock = false): Promise<RfqRow> {
    const rfq = await q.maybeOne<RfqRow>(`SELECT ${RFQ} FROM rfqs WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!rfq) throw DomainError.notFound('request for quotation');
    return rfq;
  }

  private lines(q: Q, id: string) {
    return q.query<{ line_no: number; item_id: string; sku: string; name: string; unit: string; quantity: number; unit_cost: number; currency: string }>(
      `SELECT l.line_no, l.item_id, i.sku, i.name, i.unit, l.quantity, i.unit_cost, i.currency FROM rfq_lines l JOIN items i ON i.id = l.item_id
        WHERE l.rfq_id = $1 ORDER BY l.line_no`,
      [id],
    );
  }

  getRfq(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const rfq = await this.load(q, id);
      const lines = await this.lines(q, id);
      const invited = await q.query('SELECT s.code, s.name FROM rfq_suppliers r JOIN suppliers s ON s.id = r.supplier_id WHERE r.rfq_id = $1 ORDER BY s.code', [id]);
      const quotations = await q.query<{ id: string; total_amount: number }>(
        `SELECT qt.id, s.code AS supplier_code, s.name AS supplier_name, qt.lines, qt.total_amount, qt.currency, qt.lead_time_days, qt.valid_until::text AS valid_until,
                qt.note, qt.recorded_by, qt.recorded_at
           FROM quotations qt JOIN suppliers s ON s.id = qt.supplier_id WHERE qt.rfq_id = $1 ORDER BY qt.total_amount, qt.recorded_at`,
        [id],
      );
      const lowest = quotations.length ? Math.min(...quotations.map((x) => Number(x.total_amount))) : null;
      const award = await q.maybeOne('SELECT awarded_quotation_id, purchase_request_id FROM rfqs WHERE id = $1', [id]);
      return { ...rfq, lines, invited, quotations: quotations.map((x) => ({ ...x, lowest: Number(x.total_amount) === lowest })), award };
    });
  }

  recordQuotation(user: Principal, id: string, input: z.infer<typeof RecordQuotation>) {
    return this.db.tx(user.tenantId, async (q) => {
      const rfq = await this.load(q, id, true);
      if (rfq.status !== 'open') throw DomainError.conflict('invalid_state', `the request for quotation is ${rfq.status}`);
      const supplier = await q.maybeOne<{ id: string }>(
        'SELECT s.id FROM suppliers s JOIN rfq_suppliers r ON r.supplier_id = s.id AND r.rfq_id = $2 WHERE s.code = $1',
        [input.supplier_code, id],
      );
      if (!supplier) throw DomainError.invalid(`supplier '${input.supplier_code}' was not invited`);
      const lines = await this.lines(q, id);
      const total = quotationTotal(lines.map((l) => ({ line_no: l.line_no, quantity: Number(l.quantity) })), input.lines);
      if (!total.ok) throw DomainError.invalid(total.reason);
      return q.one(
        `INSERT INTO quotations (tenant_id, rfq_id, supplier_id, lines, total_amount, currency, lead_time_days, valid_until, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (rfq_id, supplier_id) DO UPDATE SET lines = EXCLUDED.lines, total_amount = EXCLUDED.total_amount, currency = EXCLUDED.currency,
             lead_time_days = EXCLUDED.lead_time_days, valid_until = EXCLUDED.valid_until, note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by, recorded_at = now()
         RETURNING id, total_amount, currency, recorded_at`,
        [user.tenantId, id, supplier.id, JSON.stringify(input.lines), total.total, input.currency, input.lead_time_days, input.valid_until, input.note, user.username],
      );
    });
  }

  /**
   * Award: the chosen quotation becomes a purchase request at the quoted prices, charged to the
   * request's cost centre, and goes through the normal approval. Choosing a quotation that is not
   * the lowest needs a written reason, which is kept in the justification.
   */
  award(user: Principal, id: string, input: z.infer<typeof Award>) {
    return this.db.tx(user.tenantId, async (q) => {
      const rfq = await this.load(q, id, true);
      if (rfq.status !== 'open') throw DomainError.conflict('invalid_state', `the request for quotation is ${rfq.status}`);
      const quote = await q.maybeOne<{ id: string; supplier_id: string; lines: { line_no: number; unit_cost: number }[]; total_amount: number; currency: string; valid_until: string | null }>(
        'SELECT id, supplier_id, lines, total_amount, currency, valid_until::text AS valid_until FROM quotations WHERE id = $1 AND rfq_id = $2',
        [input.quotation_id, id],
      );
      if (!quote) throw DomainError.invalid('the quotation does not belong to this request for quotation');
      if (quote.valid_until && quote.valid_until < new Date().toISOString().slice(0, 10)) throw DomainError.conflict('expired', 'the quotation is no longer valid');
      const lowest = await q.one<{ min: number }>('SELECT min(total_amount) AS min FROM quotations WHERE rfq_id = $1', [id]);
      const notLowest = Number(quote.total_amount) > Number(lowest.min);
      if (notLowest && input.reason.length < 10) throw DomainError.invalid('a quotation that is not the lowest needs a reason of at least 10 characters');
      const lines = await this.lines(q, id);
      const items = await Promise.all(lines.map((l) => this.procurement.itemBySku(q, l.sku)));
      const pr = await this.procurement.submit(q, user.tenantId, {
        title: rfq.title,
        justification: `Awarded from ${rfq.reference_no}${notLowest ? `, not the lowest quotation: ${input.reason}` : ' to the lowest quotation'}.`,
        supplierId: quote.supplier_id,
        location: rfq.delivery_location,
        lines: lines.map((l, i) => ({ item: { ...items[i]!, currency: quote.currency }, quantity: Number(l.quantity), unit_cost: quote.lines.find((x) => x.line_no === l.line_no)!.unit_cost })),
        origin: { type: 'rfq', id: rfq.id },
        requester: { id: user.userId, username: user.username },
        costCentreId: rfq.cost_centre_id,
      });
      if (!pr) throw DomainError.conflict('duplicate', 'a purchase request already exists for this award');
      await q.exec(`UPDATE rfqs SET status = 'awarded', awarded_quotation_id = $2, purchase_request_id = $3 WHERE id = $1`, [id, quote.id, pr.id]);
      await this.outbox.emit(q, {
        type: 'procurement.rfq.awarded.v1',
        aggregateType: 'rfq',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: {
          rfq_id: id,
          reference_no: rfq.reference_no,
          quotation_id: quote.id,
          supplier_id: quote.supplier_id,
          purchase_request_id: pr.id,
          total_amount: Number(quote.total_amount),
          lowest: !notLowest,
          awarded_by: user.userId,
        },
      });
      return { rfq: rfq.reference_no, purchase_request: { id: pr.id, reference_no: pr.reference_no, total_amount: pr.total_amount, over_budget: pr.over_budget } };
    });
  }

  cancelRfq(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const rfq = await this.load(q, id, true);
      if (rfq.status !== 'open') throw DomainError.conflict('invalid_state', `the request for quotation is ${rfq.status}`);
      await q.exec(`UPDATE rfqs SET status = 'cancelled' WHERE id = $1`, [id]);
      return { id, status: 'cancelled' };
    });
  }
}
