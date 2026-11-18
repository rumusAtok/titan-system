import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import { Capabilities, Roles } from '@titan/contracts';
import { type Logger, newContext, runWithContext } from '@titan/observability';
import { Db, DomainError, Entitlements, LOGGER, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { MaintenanceService, type RequestTypeRow } from './maintenance.service.js';
import { type ChecklistItem, evaluateChecklist, isoDay, nextDueAfter, type Priority } from './rules.js';

const SWEEP_MS = Number(process.env.MAINTENANCE_PLAN_SWEEP_MS ?? 60_000);
const code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/);
const typeKey = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
const role = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CreatePmPlan = z.object({
  code,
  name: z.string().trim().min(3).max(200),
  description: z.string().max(2000).default(''),
  asset_id: z.uuid(),
  request_type: typeKey,
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  interval_days: z.number().int().min(1).max(3650),
  lead_days: z.number().int().min(0).max(90).default(3),
  next_due_on: day,
  estimated_hours: z.number().min(0).max(1000).nullable().default(null),
  checklist: z.array(z.string().trim().min(2).max(200)).max(40).default([]),
});

const ChecklistItemSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
    question: z.string().trim().min(3).max(200),
    kind: z.enum(['pass_fail', 'number']),
    min: z.number().optional(),
    max: z.number().optional(),
    unit: z.string().max(20).optional(),
  })
  .refine((i) => i.kind === 'number' || (i.min === undefined && i.max === undefined), { message: 'min and max apply to number items only' });

export const CreateInspectionPlan = z.object({
  code,
  name: z.string().trim().min(3).max(200),
  asset_id: z.uuid().nullable().default(null),
  location: z.string().max(200).default(''),
  checklist: z
    .array(ChecklistItemSchema)
    .min(1)
    .max(60)
    .refine((items) => new Set(items.map((i) => i.key)).size === items.length, { message: 'checklist keys must be unique' }),
  interval_days: z.number().int().min(1).max(3650),
  next_due_on: day,
  assigned_role: role,
  finding_request_type: typeKey,
});

export const SetActive = z.object({ active: z.boolean() });

export const CompleteRound = z.object({
  results: z.record(z.string(), z.union([z.boolean(), z.number()])),
  notes: z.string().max(4000).default(''),
});

interface PmPlanRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string;
  asset_id: string;
  request_type: string;
  priority: Priority;
  interval_days: number;
  lead_days: number;
  next_due_on: string;
  estimated_hours: number | null;
  checklist: string[];
  active: boolean;
}

interface InspectionPlanRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  asset_id: string | null;
  location: string;
  checklist: ChecklistItem[];
  interval_days: number;
  next_due_on: string;
  assigned_role: string;
  finding_request_type: string;
  active: boolean;
}

interface RoundRow {
  id: string;
  tenant_id: string;
  reference_no: string;
  plan_id: string;
  due_on: string;
  status: 'due' | 'completed' | 'skipped';
  asset_id: string | null;
  checklist: ChecklistItem[];
}

const PM = `id, tenant_id, code, name, description, asset_id, request_type, priority, interval_days, lead_days, next_due_on::text AS next_due_on,
  estimated_hours, checklist, active`;
const IP = `id, tenant_id, code, name, asset_id, location, checklist, interval_days, next_due_on::text AS next_due_on, assigned_role, finding_request_type, active`;
const TYPE = 'key, name, description, subject_type, workflow_key, default_priority, requester_roles, auto_from_incident_category, detail_fields, pack_id';

/**
 * Maintenance planning.
 *
 *  - Preventive plans: planned work on an asset every N days. Within the plan's lead time a work
 *    order is opened (the plan is the authorisation: no approval workflow), once per due date.
 *  - Inspection plans: a checklist done every N days. A round becomes due, the assigned role is
 *    told, and completing it with a failed item raises a finding request of the plan's request type,
 *    which goes through that type's normal approval.
 */
@Injectable()
export class PlanningService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(Entitlements) private readonly entitlements: Entitlements,
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  private async requestType(q: Q, key: string): Promise<RequestTypeRow> {
    const t = await q.maybeOne<RequestTypeRow>(`SELECT ${TYPE} FROM request_types WHERE key = $1`, [key]);
    if (!t) throw DomainError.invalid(`unknown request type '${key}' (installed by an industry pack)`);
    return t;
  }

  private async asset(q: Q, id: string | null): Promise<{ code: string; name: string; status: string } | null> {
    if (!id) return null;
    const a = await q.maybeOne<{ code: string; name: string; status: string }>('SELECT code, name, status FROM asset_projection WHERE asset_id = $1', [id]);
    if (!a) throw DomainError.invalid('asset not found');
    if (a.status === 'retired') throw DomainError.conflict('invalid_state', 'a retired asset cannot be planned for');
    return a;
  }

  // --- preventive plans -------------------------------------------------------------

  listPmPlans(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT p.id, p.code, p.name, p.description, p.asset_id, a.code AS asset_code, a.name AS asset_name, p.request_type, p.priority, p.interval_days,
                p.lead_days, p.next_due_on::text AS next_due_on, p.estimated_hours, p.checklist, p.active, p.version,
                (SELECT count(*)::int FROM pm_plan_runs r WHERE r.plan_id = p.id) AS generated,
                (SELECT w.reference_no FROM pm_plan_runs r JOIN work_orders w ON w.id = r.work_order_id WHERE r.plan_id = p.id ORDER BY r.due_on DESC LIMIT 1) AS last_work_order
           FROM pm_plans p LEFT JOIN asset_projection a ON a.asset_id = p.asset_id ORDER BY p.active DESC, p.next_due_on`,
      ),
    );
  }

  createPmPlan(user: Principal, input: z.infer<typeof CreatePmPlan>) {
    return this.db.tx(user.tenantId, async (q) => {
      await this.requestType(q, input.request_type);
      await this.asset(q, input.asset_id);
      if (await q.maybeOne('SELECT 1 FROM pm_plans WHERE code = $1', [input.code])) throw DomainError.conflict('duplicate', `plan ${input.code} exists`);
      return q.one(
        `INSERT INTO pm_plans (tenant_id, code, name, description, asset_id, request_type, priority, interval_days, lead_days, next_due_on, estimated_hours, checklist, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${PM}`,
        [user.tenantId, input.code, input.name, input.description, input.asset_id, input.request_type, input.priority, input.interval_days, input.lead_days, input.next_due_on, input.estimated_hours, input.checklist, user.username],
      );
    });
  }

  setPmActive(user: Principal, id: string, active: boolean) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await q.maybeOne(`UPDATE pm_plans SET active = $2, version = version + 1 WHERE id = $1 RETURNING ${PM}`, [id, active]);
      if (!row) throw DomainError.notFound('plan');
      return row;
    });
  }

  /** Opens the work order for the plan's current due date (if not already done) and moves the plan on. */
  private async generatePm(q: Q, plan: PmPlanRow): Promise<string | null> {
    const type = await q.maybeOne<RequestTypeRow>(`SELECT ${TYPE} FROM request_types WHERE key = $1`, [plan.request_type]);
    const assetOk = await q.maybeOne<{ status: string }>('SELECT status FROM asset_projection WHERE asset_id = $1', [plan.asset_id]);
    const today = isoDay(new Date());
    const next = nextDueAfter(plan.next_due_on, plan.interval_days, today);
    if (!type || !assetOk || assetOk.status === 'retired') {
      this.logger.warn({ tenant_id: plan.tenant_id, plan: plan.code }, 'preventive plan skipped: request type or asset unavailable');
      await q.exec('UPDATE pm_plans SET next_due_on = $2 WHERE id = $1', [plan.id, next]);
      return null;
    }
    const already = await q.maybeOne('SELECT 1 FROM pm_plan_runs WHERE plan_id = $1 AND due_on = $2', [plan.id, plan.next_due_on]);
    let reference: string | null = null;
    if (!already) {
      const order = await this.maintenance.createPlannedWork(q, plan.tenant_id, {
        type,
        title: `${plan.name} (due ${plan.next_due_on})`,
        description: plan.description || `Preventive maintenance from plan ${plan.code}.`,
        priority: plan.priority,
        assetId: plan.asset_id,
        origin: { type: 'schedule', id: `${plan.id}:${plan.next_due_on}` },
        estimatedHours: plan.estimated_hours === null ? null : Number(plan.estimated_hours),
        checklist: plan.checklist,
      });
      if (order) {
        await q.exec('INSERT INTO pm_plan_runs (plan_id, due_on, tenant_id, work_order_id) VALUES ($1, $2, $3, $4)', [plan.id, plan.next_due_on, plan.tenant_id, order.id]);
        reference = order.reference_no;
      }
    }
    await q.exec('UPDATE pm_plans SET next_due_on = $2 WHERE id = $1', [plan.id, next]);
    return reference;
  }

  /** "Generate now": the planner brings the next due work forward (same idempotency). */
  generatePmNow(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const plan = await q.maybeOne<PmPlanRow>(`SELECT ${PM} FROM pm_plans WHERE id = $1 FOR UPDATE`, [id]);
      if (!plan) throw DomainError.notFound('plan');
      if (!plan.active) throw DomainError.conflict('inactive', 'the plan is inactive');
      const reference = await this.generatePm(q, plan);
      if (!reference) throw DomainError.conflict('not_generated', 'no work order was generated (request type or asset unavailable)');
      return { plan: plan.code, due_on: plan.next_due_on, work_order: reference };
    });
  }

  // --- inspections -------------------------------------------------------------------

  listInspectionPlans(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT p.id, p.code, p.name, p.asset_id, a.code AS asset_code, a.name AS asset_name, p.location, p.checklist, p.interval_days,
                p.next_due_on::text AS next_due_on, p.assigned_role, p.finding_request_type, p.active, p.version,
                (SELECT count(*)::int FROM inspection_rounds r WHERE r.plan_id = p.id AND r.status = 'completed') AS completed_rounds,
                (SELECT COALESCE(sum(findings), 0)::int FROM inspection_rounds r WHERE r.plan_id = p.id) AS findings
           FROM inspection_plans p LEFT JOIN asset_projection a ON a.asset_id = p.asset_id ORDER BY p.active DESC, p.next_due_on`,
      ),
    );
  }

  createInspectionPlan(user: Principal, input: z.infer<typeof CreateInspectionPlan>) {
    return this.db.tx(user.tenantId, async (q) => {
      await this.requestType(q, input.finding_request_type);
      await this.asset(q, input.asset_id);
      if (await q.maybeOne('SELECT 1 FROM inspection_plans WHERE code = $1', [input.code])) throw DomainError.conflict('duplicate', `plan ${input.code} exists`);
      return q.one(
        `INSERT INTO inspection_plans (tenant_id, code, name, asset_id, location, checklist, interval_days, next_due_on, assigned_role, finding_request_type, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${IP}`,
        [user.tenantId, input.code, input.name, input.asset_id, input.location, JSON.stringify(input.checklist), input.interval_days, input.next_due_on, input.assigned_role, input.finding_request_type, user.username],
      );
    });
  }

  setInspectionActive(user: Principal, id: string, active: boolean) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await q.maybeOne(`UPDATE inspection_plans SET active = $2, version = version + 1 WHERE id = $1 RETURNING ${IP}`, [id, active]);
      if (!row) throw DomainError.notFound('plan');
      return row;
    });
  }

  private async generateRound(q: Q, plan: InspectionPlanRow): Promise<string | null> {
    const year = new Date().getUTCFullYear();
    const { last_no } = await q.one<{ last_no: number }>(
      `INSERT INTO maintenance_counters (tenant_id, series, year, last_no) VALUES ($1, 'IR', $2, 1)
       ON CONFLICT (tenant_id, series, year) DO UPDATE SET last_no = maintenance_counters.last_no + 1 RETURNING last_no`,
      [plan.tenant_id, year],
    );
    const reference = `IR-${year}-${String(last_no).padStart(6, '0')}`;
    const round = await q.maybeOne<{ id: string }>(
      `INSERT INTO inspection_rounds (tenant_id, reference_no, plan_id, due_on, asset_id, checklist) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (plan_id, due_on) DO NOTHING RETURNING id`,
      [plan.tenant_id, reference, plan.id, plan.next_due_on, plan.asset_id, JSON.stringify(plan.checklist)],
    );
    await q.exec('UPDATE inspection_plans SET next_due_on = $2 WHERE id = $1', [plan.id, nextDueAfter(plan.next_due_on, plan.interval_days, isoDay(new Date()))]);
    if (!round) return null;
    await this.outbox.emit(q, {
      type: 'notification.requested.v1',
      aggregateType: 'inspection_round',
      aggregateId: round.id,
      tenantId: plan.tenant_id,
      payload: {
        dedupe_key: `inspection-due:${round.id}`,
        channel: 'in_app',
        category: 'maintenance.inspection_due',
        external: false,
        recipient_user_id: null,
        recipient_role: plan.assigned_role,
        recipient_address: null,
        subject: `Inspection ${reference} due ${plan.next_due_on}: ${plan.name}`,
        body: `${plan.checklist.length} checklist item(s)${plan.location ? ` at ${plan.location}` : ''}.`,
        reference_type: 'inspection_round',
        reference_id: round.id,
      },
    });
    return reference;
  }

  generateRoundNow(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const plan = await q.maybeOne<InspectionPlanRow>(`SELECT ${IP} FROM inspection_plans WHERE id = $1 FOR UPDATE`, [id]);
      if (!plan) throw DomainError.notFound('plan');
      if (!plan.active) throw DomainError.conflict('inactive', 'the plan is inactive');
      const reference = await this.generateRound(q, plan);
      return { plan: plan.code, due_on: plan.next_due_on, round: reference };
    });
  }

  listRounds(user: Principal, status?: string) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT r.id, r.reference_no, r.plan_id, p.code AS plan_code, p.name AS plan_name, p.assigned_role, p.location, r.due_on::text AS due_on, r.status,
                r.asset_id, a.code AS asset_code, r.findings, r.performed_by, r.completed_at
           FROM inspection_rounds r JOIN inspection_plans p ON p.id = r.plan_id LEFT JOIN asset_projection a ON a.asset_id = r.asset_id
          WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.due_on DESC, r.reference_no DESC LIMIT 200`,
        [status ?? null],
      ),
    );
  }

  getRound(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const round = await q.maybeOne(
        `SELECT r.id, r.reference_no, r.plan_id, p.code AS plan_code, p.name AS plan_name, p.assigned_role, p.location, r.due_on::text AS due_on, r.status,
                r.asset_id, a.code AS asset_code, a.name AS asset_name, r.checklist, r.results, r.findings, r.notes, r.performed_by, r.completed_at
           FROM inspection_rounds r JOIN inspection_plans p ON p.id = r.plan_id LEFT JOIN asset_projection a ON a.asset_id = r.asset_id WHERE r.id = $1`,
        [id],
      );
      if (!round) throw DomainError.notFound('inspection round');
      const requests = await q.query('SELECT id, reference_no, title, status FROM maintenance_requests WHERE origin_type = $1 AND origin_id LIKE $2 ORDER BY reference_no', [
        'inspection',
        `${id}:%`,
      ]);
      return { ...round, finding_requests: requests };
    });
  }

  /**
   * Records the results. Each failed item raises one request of the plan's finding type (origin
   * `inspection`, so a repeat cannot create a second one), which then needs its normal approval.
   */
  completeRound(user: Principal, id: string, input: z.infer<typeof CompleteRound>) {
    return this.db.tx(user.tenantId, async (q) => {
      const round = await q.maybeOne<RoundRow>('SELECT id, tenant_id, reference_no, plan_id, due_on::text AS due_on, status, asset_id, checklist FROM inspection_rounds WHERE id = $1 FOR UPDATE', [id]);
      if (!round) throw DomainError.notFound('inspection round');
      const plan = await q.one<InspectionPlanRow>(`SELECT ${IP} FROM inspection_plans WHERE id = $1`, [round.plan_id]);
      if (!user.roles.includes(plan.assigned_role) && !user.roles.some((r) => [Roles.MaintenancePlanner, Roles.FacilityManager, Roles.TenantAdmin].includes(r as never))) {
        throw DomainError.forbidden(`this inspection is for the ${plan.assigned_role} role`);
      }
      if (round.status !== 'due') throw DomainError.conflict('invalid_state', `the round is ${round.status}`);
      const outcome = evaluateChecklist(round.checklist, input.results);
      if (!outcome.ok) throw DomainError.invalid(outcome.reason);
      const type = await this.requestType(q, plan.finding_request_type);
      const raised: string[] = [];
      for (const f of outcome.failures) {
        const request = await this.maintenance.submit(q, user.tenantId, {
          type,
          title: `${plan.name}: ${f.question}`,
          description: `Inspection ${round.reference_no} (${plan.code}) found: ${f.question}: ${f.reason}.${input.notes ? `\nNotes: ${input.notes}` : ''}`,
          priority: type.default_priority,
          assetId: round.asset_id,
          details: {},
          origin: { type: 'inspection', id: `${round.id}:${f.key}` },
          requester: { id: user.userId, username: user.username },
        });
        if (request) raised.push(request.reference_no);
      }
      const completed = await q.one<{ completed_at: Date }>(
        `UPDATE inspection_rounds SET status = 'completed', results = $2, findings = $3, notes = $4, performed_by = $5, performed_by_id = $6, completed_at = now()
          WHERE id = $1 RETURNING completed_at`,
        [id, JSON.stringify(input.results), outcome.failures.length, input.notes, user.username, user.userId],
      );
      await this.outbox.emit(q, {
        type: 'maintenance.inspection.completed.v1',
        aggregateType: 'inspection_round',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: {
          round_id: id,
          reference_no: round.reference_no,
          plan_id: plan.id,
          plan_code: plan.code,
          asset_id: round.asset_id,
          findings: outcome.failures.length,
          completed_by: user.userId,
          completed_at: completed.completed_at.toISOString(),
        },
      });
      return { id, reference_no: round.reference_no, findings: outcome.failures, finding_requests: raised };
    });
  }

  /** What is coming up: plans due in the next `days` days, and rounds waiting to be done. */
  upcoming(user: Principal, days: number) {
    return this.db.tx(user.tenantId, async (q) => ({
      preventive: await q.query(
        `SELECT p.id, p.code, p.name, a.code AS asset_code, p.next_due_on::text AS due_on, p.interval_days FROM pm_plans p LEFT JOIN asset_projection a ON a.asset_id = p.asset_id
          WHERE p.active AND p.next_due_on <= current_date + $1::int ORDER BY p.next_due_on`,
        [days],
      ),
      inspections: await q.query(
        `SELECT p.id, p.code, p.name, a.code AS asset_code, p.next_due_on::text AS due_on, p.interval_days FROM inspection_plans p LEFT JOIN asset_projection a ON a.asset_id = p.asset_id
          WHERE p.active AND p.next_due_on <= current_date + $1::int ORDER BY p.next_due_on`,
        [days],
      ),
      rounds_due: await q.query(`SELECT count(*)::int AS n FROM inspection_rounds WHERE status = 'due'`).then((r) => r[0]),
    }));
  }

  // --- sweep -------------------------------------------------------------------------

  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let generated = 0;
    try {
      const due = await this.db.tx(null, (q) => q.query<{ kind: 'pm' | 'inspection'; plan_id: string; tenant_id: string }>('SELECT kind, plan_id, tenant_id FROM maintenance_plans_due($1)', [200]));
      for (const row of due) {
        if (!(await this.entitlements.has(row.tenant_id, Capabilities.Maintenance))) continue;
        const ctx = newContext({ actor: { id: 'maintenance-planning', type: 'system' } });
        const made = await runWithContext(ctx, () =>
          this.db.tx(row.tenant_id, async (q) => {
            if (row.kind === 'pm') {
              const plan = await q.maybeOne<PmPlanRow>(`SELECT ${PM} FROM pm_plans WHERE id = $1 AND active AND next_due_on - lead_days <= current_date FOR UPDATE SKIP LOCKED`, [row.plan_id]);
              return plan ? this.generatePm(q, plan) : null;
            }
            const plan = await q.maybeOne<InspectionPlanRow>(`SELECT ${IP} FROM inspection_plans WHERE id = $1 AND active AND next_due_on <= current_date + 1 FOR UPDATE SKIP LOCKED`, [row.plan_id]);
            return plan ? this.generateRound(q, plan) : null;
          }),
        );
        if (made) generated += 1;
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'maintenance planning sweep failed');
    } finally {
      this.sweeping = false;
    }
    return generated;
  }
}
