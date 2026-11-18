// Maintenance planning and procurement sourcing, end to end on the real stack (tenant Meridian).
//
//   preventive plan -> work order (no approval) -> parts used -> stock booked out -> parts and labour cost
//   inspection plan -> round due -> results -> one finding request per failed item (normal approval)
//   cost centre budget -> over-budget approval stage;  request for quotation -> quotations -> award -> purchase request
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, closeConnections, decideSubject, pendingSubjectTask, rawApi, unique, userId, waitFor, waitForAccess } from '../helpers/stack.ts';

const ADMIN = 'maya.admin';
const PLANNER = 'paula.planner';
const TECH = 'tim.technician';
const SUPERVISOR = 'sam.supervisor';
const BUYER = 'priya.procurement';
const STORES = 'stan.stores';
const BUDGET_HOLDER = 'dina.director';
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const code = (prefix: string) => `${prefix}-${unique()}`.slice(0, 30);

let assets: Record<string, any>;

before(async () => {
  await waitForAccess(ADMIN, '/api/maintenance/planning/pm-plans', 200, 'the maintenance capability to be active for Meridian');
  await waitForAccess(ADMIN, '/api/procurement/rfqs', 200, 'the procurement capability to be active for Meridian');
  assets = Object.fromEntries((await api(ADMIN, 'GET', '/api/asset/assets?limit=500')).map((a: any) => [a.code, a]));
  assert.ok(assets['MER-CNC-01'], 'seeded assets exist (run `npm run seed`)');
});
after(closeConnections);

async function workOrder(id: string, accept: (w: any) => boolean, what: string) {
  return waitFor(async () => {
    const w = await api(PLANNER, 'GET', `/api/maintenance/work-orders/${id}`);
    return accept(w) ? w : null;
  }, { timeoutMs: 30_000, what });
}

describe('Preventive maintenance', () => {
  let plan: any;

  it('a plan opens an approved work order with its checklist, once per due date, and moves on', async () => {
    plan = await api(PLANNER, 'POST', '/api/maintenance/planning/pm-plans', {
      code: code('PMT'), name: 'Test lubrication', asset_id: assets['MER-CNC-01'].id, request_type: 'equipment-repair',
      interval_days: 14, lead_days: 0, next_due_on: day(5), estimated_hours: 1.25, checklist: ['Lubricate ways', 'Check filter'],
    });
    assert.equal((await rawApi(TECH, 'POST', `/api/maintenance/planning/pm-plans/${plan.id}/generate`)).status, 403, 'only planners');
    const generated = await api(PLANNER, 'POST', `/api/maintenance/planning/pm-plans/${plan.id}/generate`);
    assert.equal(generated.due_on, day(5));
    const orders = await api(PLANNER, 'GET', `/api/maintenance/work-orders?asset_id=${assets['MER-CNC-01'].id}&limit=200`);
    const order = orders.find((w: any) => w.reference_no === generated.work_order);
    assert.ok(order);
    const detail = await api(PLANNER, 'GET', `/api/maintenance/work-orders/${order.id}`);
    assert.equal(detail.origin_type, 'schedule');
    assert.deepEqual(detail.checklist, ['Lubricate ways', 'Check filter']);
    assert.equal(Number(detail.estimated_hours), 1.25);
    const request = await api(PLANNER, 'GET', `/api/maintenance/requests/${detail.request.id}`);
    assert.equal(request.status, 'approved', 'the plan is the authorisation');
    assert.deepEqual(await api(SUPERVISOR, 'GET', `/api/workflow/tasks?subject_id=${detail.request.id}`), [], 'no approval task');
    const plans = await api(PLANNER, 'GET', '/api/maintenance/planning/pm-plans');
    assert.equal(plans.find((p: any) => p.id === plan.id).next_due_on, day(19));
    plan.order = detail;
  });

  it('the sweep opens work for a plan that falls due, without anyone asking', async () => {
    const due = await api(PLANNER, 'POST', '/api/maintenance/planning/pm-plans', {
      code: code('PMS'), name: 'Test sweep', asset_id: assets['MER-CONV-01'].id, request_type: 'equipment-repair', interval_days: 30, lead_days: 2, next_due_on: day(1),
    });
    await waitFor(async () => (await api(PLANNER, 'GET', '/api/maintenance/planning/pm-plans')).find((p: any) => p.id === due.id)?.generated === 1, {
      timeoutMs: 45_000,
      what: 'the planning sweep to open the work order',
    });
  });

  it('parts used are booked out of stores and costed, with labour at the tenant rate', async () => {
    const settings = await api(PLANNER, 'GET', '/api/maintenance/settings');
    const stockBefore = (await api(STORES, 'GET', '/api/procurement/items')).find((i: any) => i.sku === 'BRG-6205');
    const before = Number(stockBefore.locations.find((l: any) => l.location === 'MAIN-STORE').on_hand);
    const order = plan.order;
    await api(PLANNER, 'POST', `/api/maintenance/work-orders/${order.id}/assign`, { assignee_id: await userId(TECH), assignee_username: TECH });
    await api(TECH, 'POST', `/api/maintenance/work-orders/${order.id}/start`);
    await api(TECH, 'POST', `/api/maintenance/work-orders/${order.id}/complete`, {
      summary: 'Lubricated, filter replaced', labor_hours: 1.5, parts: [{ sku: 'BRG-6205', quantity: 2 }, { sku: 'COOLANT-20L', quantity: 999 }],
    });
    const done = await workOrder(order.id, (w) => w.parts.every((p: any) => p.booked || p.error), 'both part lines to be settled by stores');
    assert.equal(Number(done.labor_cost), Math.round(1.5 * Number(settings.labor_rate_per_hour) * 100) / 100);
    const bearing = done.parts.find((p: any) => p.sku === 'BRG-6205');
    assert.equal(bearing.booked, true);
    assert.equal(Number(done.parts_cost), Math.round(2 * Number(bearing.unit_cost) * 100) / 100);
    assert.match(done.parts.find((p: any) => p.sku === 'COOLANT-20L').error, /in stock/, 'not enough stock is reported, not invented');
    const after = (await api(STORES, 'GET', '/api/procurement/items')).find((i: any) => i.sku === 'BRG-6205');
    assert.equal(Number(after.locations.find((l: any) => l.location === 'MAIN-STORE').on_hand), before - 2);
    const moves = await api(STORES, 'GET', '/api/procurement/items/COOLANT-20L/movements');
    assert.ok(!moves.some((m: any) => m.reference_id === order.id), 'nothing booked for the refused line');
  });
});

describe('Inspections', () => {
  let round: any;

  before(async () => {
    const plan = await api(PLANNER, 'POST', '/api/maintenance/planning/inspection-plans', {
      code: code('INS'), name: 'Test safety walk', asset_id: assets['MER-LINE-A'].id, interval_days: 7, next_due_on: day(0),
      assigned_role: 'production_supervisor', finding_request_type: 'equipment-repair',
      checklist: [
        { key: 'guards', question: 'Guards fitted', kind: 'pass_fail' },
        { key: 'noise', question: 'Noise level', kind: 'number', min: 0, max: 85, unit: 'dB(A)' },
        { key: 'estops', question: 'Emergency stops work', kind: 'pass_fail' },
      ],
    });
    const r = await api(PLANNER, 'POST', `/api/maintenance/planning/inspection-plans/${plan.id}/generate`);
    round = (await api(SUPERVISOR, 'GET', '/api/maintenance/planning/rounds?status=due')).find((x: any) => x.reference_no === r.round);
    assert.ok(round);
  });

  it('only the assigned role (or planning) records results, and every item must be answered', async () => {
    assert.equal((await rawApi(TECH, 'POST', `/api/maintenance/planning/rounds/${round.id}/complete`, { results: { guards: true, noise: 70, estops: true } })).status, 403);
    assert.equal((await rawApi(SUPERVISOR, 'POST', `/api/maintenance/planning/rounds/${round.id}/complete`, { results: { guards: true } })).status, 400);
  });

  it('each failed item raises one finding request that goes to its normal approval', async () => {
    const result = await api(SUPERVISOR, 'POST', `/api/maintenance/planning/rounds/${round.id}/complete`, { results: { guards: true, noise: 91, estops: false }, notes: 'Line was running' });
    assert.deepEqual(result.findings.map((f: any) => f.key).sort(), ['estops', 'noise']);
    assert.equal(result.finding_requests.length, 2);
    const detail = await api(PLANNER, 'GET', `/api/maintenance/planning/rounds/${round.id}`);
    assert.equal(detail.status, 'completed');
    assert.equal(detail.finding_requests.length, 2);
    // The request type's own approval starts (maintenance-approval: supervisor first). The inspector
    // raised the finding, so the inspector may not approve it.
    const task = await pendingSubjectTask(SUPERVISOR, detail.finding_requests[0].id, 'supervisor_approval');
    const own = await rawApi(SUPERVISOR, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' });
    assert.ok([403, 409].includes(own.status), `self-approval refused (got ${own.status})`);
    assert.equal((await rawApi(SUPERVISOR, 'POST', `/api/maintenance/planning/rounds/${round.id}/complete`, { results: { guards: true, noise: 1, estops: true } })).status, 409);
  });
});

describe('Budgets and approval', () => {
  it('a request that would exceed its cost centre budget gets the over-budget approval stage', async () => {
    const cc = code('CC');
    await api(BUYER, 'POST', '/api/procurement/cost-centres', { code: cc, name: 'Test centre' });
    assert.equal((await rawApi(STORES, 'PUT', `/api/procurement/cost-centres/${cc}/budget`, { year: new Date().getUTCFullYear(), amount: 1 })).status, 403);
    await api(BUDGET_HOLDER, 'PUT', `/api/procurement/cost-centres/${cc}/budget`, { year: new Date().getUTCFullYear(), amount: 1000 });

    const small = await api(STORES, 'POST', '/api/procurement/purchase-requests', { title: 'Small test buy', supplier_code: 'SYN-HVAC', delivery_location: 'MAIN-STORE', cost_centre_code: cc, lines: [{ sku: 'FLT-HVAC-24', quantity: 2 }] });
    assert.equal(small.over_budget, false);
    const big = await api(STORES, 'POST', '/api/procurement/purchase-requests', { title: 'Big test buy', supplier_code: 'SYN-HVAC', delivery_location: 'MAIN-STORE', cost_centre_code: cc, lines: [{ sku: 'FLT-HVAC-24', quantity: 60 }] });
    assert.equal(big.over_budget, true, '60 x 22 = 1320 is more than the 956 left');
    await decideSubject(BUYER, big.id, 'procurement_review', 'approve');
    await decideSubject(ADMIN, big.id, 'over_budget_approval', 'approve');
    await waitFor(async () => (await api(ADMIN, 'GET', `/api/procurement/purchase-requests/${big.id}`)).status === 'ordered', { what: 'the over-budget request to be ordered' });
    const centre = (await api(BUYER, 'GET', '/api/procurement/cost-centres')).find((c: any) => c.code === cc);
    assert.equal(Number(centre.committed), 44 + 1320);
    assert.ok(Number(centre.available) < 0);
  });
});

describe('Sourcing', () => {
  let rfq: any;

  before(async () => {
    rfq = await api(BUYER, 'POST', '/api/procurement/rfqs', {
      title: `Test sourcing ${unique()}`, delivery_location: 'MAIN-STORE', cost_centre_code: 'MAINT', respond_by: day(7),
      lines: [{ sku: 'BRG-6205', quantity: 10 }, { sku: 'BELT-CONV-18', quantity: 2 }], supplier_codes: ['SYN-BEAR', 'SYN-BELT'],
    });
    assert.ok(rfq.reference_no.startsWith('RFQ-'));
  });

  it('quotations must come from invited suppliers and price every line', async () => {
    assert.equal((await rawApi(BUYER, 'POST', `/api/procurement/rfqs/${rfq.id}/quotations`, { supplier_code: 'SYN-HVAC', lines: [{ line_no: 1, unit_cost: 1 }, { line_no: 2, unit_cost: 1 }] })).status, 400);
    assert.equal((await rawApi(BUYER, 'POST', `/api/procurement/rfqs/${rfq.id}/quotations`, { supplier_code: 'SYN-BEAR', lines: [{ line_no: 1, unit_cost: 1 }] })).status, 400);
    await api(BUYER, 'POST', `/api/procurement/rfqs/${rfq.id}/quotations`, { supplier_code: 'SYN-BEAR', lines: [{ line_no: 1, unit_cost: 35 }, { line_no: 2, unit_cost: 300 }], lead_time_days: 10 });
    await api(BUYER, 'POST', `/api/procurement/rfqs/${rfq.id}/quotations`, { supplier_code: 'SYN-BELT', lines: [{ line_no: 1, unit_cost: 40 }, { line_no: 2, unit_cost: 290 }], lead_time_days: 5 });
    const detail = await api(BUYER, 'GET', `/api/procurement/rfqs/${rfq.id}`);
    assert.deepEqual(detail.quotations.map((q: any) => [q.supplier_code, Number(q.total_amount), q.lowest]), [['SYN-BEAR', 950, true], ['SYN-BELT', 980, false]]);
  });

  it('awarding a quotation that is not the lowest needs a reason; the award becomes a purchase request at the quoted prices', async () => {
    const detail = await api(BUYER, 'GET', `/api/procurement/rfqs/${rfq.id}`);
    const belt = detail.quotations.find((q: any) => q.supplier_code === 'SYN-BELT');
    assert.equal((await rawApi(BUYER, 'POST', `/api/procurement/rfqs/${rfq.id}/award`, { quotation_id: belt.id })).status, 400);
    const award = await api(BUYER, 'POST', `/api/procurement/rfqs/${rfq.id}/award`, { quotation_id: belt.id, reason: 'Five days faster delivery for the line rebuild' });
    const pr = await api(ADMIN, 'GET', `/api/procurement/purchase-requests/${award.purchase_request.id}`);
    assert.equal(pr.origin_type, 'rfq');
    assert.equal(Number(pr.total_amount), 980);
    assert.deepEqual(pr.lines.map((l: any) => Number(l.unit_cost)), [40, 290]);
    assert.match(pr.justification, /not the lowest quotation: Five days faster/);
    assert.equal(pr.cost_centre.code, 'MAINT');
    assert.equal((await rawApi(BUYER, 'POST', `/api/procurement/rfqs/${rfq.id}/award`, { quotation_id: belt.id, reason: 'again and again' })).status, 409);
  });

  it('another tenant sees none of it', async () => {
    assert.equal((await rawApi('adam.admin', 'GET', `/api/procurement/rfqs/${rfq.id}`)).status, 404);
    assert.ok(!(await api('adam.admin', 'GET', '/api/procurement/cost-centres')).some((c: any) => c.code === 'MAINT'));
  });
});
