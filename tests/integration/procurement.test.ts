// Procurement and stores, end to end on the real stack (tenant Riverbend, pack procurement-inventory).
//
//   purchase request -> purchase-approval workflow (budget stage above 5000) -> purchase order
//   -> partial and full goods receipt -> stock up;  stock issue -> stock down -> replenishment request
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, closeConnections, decideSubject, pendingSubjectTask, rawApi, unique, waitFor, waitForAccess } from '../helpers/stack.ts';

const ADMIN = 'adam.admin';
const OFFICER = 'owen.officer'; // procurement_officer
const STORES = 'sid.stores'; // storekeeper
const BUDGET = 'henry.head'; // department_head
const SUPPLIER = 'SYN-PUMPS';

let sku: string;
const location = 'TEST-STORE';

async function requestState(id: string, status: string) {
  return waitFor(
    async () => {
      const r = await api(ADMIN, 'GET', `/api/procurement/purchase-requests/${id}`);
      return r.status === status ? r : null;
    },
    { what: `purchase request to become '${status}'` },
  );
}

async function raise(quantity: number, unitCost?: number) {
  return api(STORES, 'POST', '/api/procurement/purchase-requests', {
    title: `Test purchase ${unique()}`,
    supplier_code: SUPPLIER,
    delivery_location: location,
    lines: [{ sku, quantity, ...(unitCost === undefined ? {} : { unit_cost: unitCost }) }],
  });
}

before(async () => {
  await waitForAccess(ADMIN, '/api/procurement/items', 200, 'the procurement capability to be active for Riverbend');
  assert.ok((await api(ADMIN, 'GET', '/api/procurement/suppliers')).some((s: any) => s.code === SUPPLIER), 'seeded supplier exists (run `npm run seed`)');
  sku = `T-${unique()}`.slice(0, 30);
  await api(OFFICER, 'POST', '/api/procurement/items', { sku, name: 'Test gasket', unit_cost: 12.5, reorder_level: 5, reorder_quantity: 20, preferred_supplier_code: SUPPLIER });
});
after(closeConnections);

describe('Purchase request to purchase order', () => {
  it('a request below 5000 needs procurement review only, and approval issues a purchase order', async () => {
    const pr = await raise(8);
    assert.equal(pr.status, 'submitted');
    assert.equal(Number(pr.total_amount), 100);
    // The storekeeper who asked cannot decide; the procurement officer can.
    const task = await pendingSubjectTask(OFFICER, pr.id, 'procurement_review');
    assert.equal((await rawApi(STORES, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' })).status, 403);
    await api(OFFICER, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' });
    const ordered = await requestState(pr.id, 'ordered');
    assert.ok(ordered.purchase_order?.reference_no.startsWith('PO-'), 'a purchase order was issued');
    assert.equal(ordered.purchase_order.status, 'issued');
  });

  it('5000 or more also needs the budget holder', async () => {
    const pr = await raise(400, 12.5); // 5000.00
    await decideSubject(OFFICER, pr.id, 'procurement_review', 'approve');
    await decideSubject(BUDGET, pr.id, 'budget_approval', 'approve');
    const ordered = await requestState(pr.id, 'ordered');
    assert.ok(ordered.purchase_order);
  });

  it('a rejected request issues nothing', async () => {
    const pr = await raise(2);
    await decideSubject(OFFICER, pr.id, 'procurement_review', 'reject', 'Use existing stock first');
    const rejected = await requestState(pr.id, 'rejected');
    assert.equal(rejected.purchase_order, null);
  });

  it('a request is cancelled by its requester while it waits, and the approval task goes away', async () => {
    const pr = await raise(1);
    await pendingSubjectTask(OFFICER, pr.id, 'procurement_review');
    assert.equal((await rawApi('anna.analyst', 'POST', `/api/procurement/purchase-requests/${pr.id}/cancel`)).status, 403, 'not the requester and not procurement');
    await api(STORES, 'POST', `/api/procurement/purchase-requests/${pr.id}/cancel`);
    await requestState(pr.id, 'cancelled');
    await waitFor(async () => (await api(OFFICER, 'GET', `/api/workflow/tasks?subject_id=${pr.id}`)).length === 0, { what: 'the approval task to be withdrawn' });
  });
});

describe('Goods receipt and stock', () => {
  let order: any;

  before(async () => {
    const pr = await raise(10);
    await decideSubject(OFFICER, pr.id, 'procurement_review', 'approve');
    order = (await requestState(pr.id, 'ordered')).purchase_order;
  });

  it('a partial receipt adds stock at the delivery location; over-receipt is refused', async () => {
    assert.equal((await rawApi(STORES, 'POST', `/api/procurement/purchase-orders/${order.id}/receive`, { lines: [{ line_no: 1, quantity: 11 }] })).status, 400);
    const r = await api(STORES, 'POST', `/api/procurement/purchase-orders/${order.id}/receive`, { lines: [{ line_no: 1, quantity: 4 }], note: 'First delivery' });
    assert.equal(r.status, 'partially_received');
    assert.ok(r.receipt_reference.startsWith('GR-'));
    const item = (await api(STORES, 'GET', '/api/procurement/items')).find((i: any) => i.sku === sku);
    assert.equal(Number(item.locations.find((l: any) => l.location === location).on_hand), 4);
  });

  it('receiving the rest completes the order; a received order takes no more', async () => {
    const r = await api(STORES, 'POST', `/api/procurement/purchase-orders/${order.id}/receive`, { lines: [{ line_no: 1, quantity: 6 }] });
    assert.equal(r.status, 'received');
    assert.equal((await rawApi(STORES, 'POST', `/api/procurement/purchase-orders/${order.id}/receive`, { lines: [{ line_no: 1, quantity: 1 }] })).status, 409);
    const detail = await api(ADMIN, 'GET', `/api/procurement/purchase-orders/${order.id}`);
    assert.equal(detail.receipts.length, 2);
    assert.equal(Number(detail.lines[0].quantity_received), 10);
  });

  it('stock cannot go below zero', async () => {
    const res = await rawApi(STORES, 'POST', '/api/procurement/stock/issue', { sku, location, quantity: 11 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'insufficient_stock');
  });

  it('issuing down to the reorder level raises one replenishment request, not one per issue', async () => {
    const first = await api(STORES, 'POST', '/api/procurement/stock/issue', { sku, location, quantity: 5, reference_type: 'work_order', reference_id: 'WO-TEST' });
    assert.equal(Number(first.on_hand), 5);
    assert.ok(first.replenishment_request?.startsWith('PR-'), 'stock at the reorder level raises a replenishment request');
    const second = await api(STORES, 'POST', '/api/procurement/stock/issue', { sku, location, quantity: 1 });
    assert.equal(second.replenishment_request, null, 'an open replenishment request already exists');
    const auto = (await api(ADMIN, 'GET', '/api/procurement/purchase-requests?status=submitted')).filter((r: any) => r.origin_type === 'low_stock' && r.origin_id?.endsWith(`:${location}`) && r.title.includes(sku));
    assert.equal(auto.length, 1);
    const movements = await api(STORES, 'GET', `/api/procurement/items/${sku}/movements`);
    assert.deepEqual(movements.map((m: any) => m.kind).sort(), ['issue', 'issue', 'receipt', 'receipt']);
  });

  it('a stock count books the difference as an adjustment', async () => {
    const r = await api(STORES, 'POST', '/api/procurement/stock/adjust', { sku, location, counted: 7, note: 'Cycle count' });
    assert.equal(Number(r.on_hand), 7);
    const movements = await api(STORES, 'GET', `/api/procurement/items/${sku}/movements`);
    assert.equal(movements.filter((m: any) => m.kind === 'adjustment').length, 1);
  });
});

describe('Procurement access control', () => {
  it('roles: an analyst may read but not move stock; an applicant may not read', async () => {
    assert.equal((await rawApi('anna.analyst', 'GET', '/api/procurement/items')).status, 200);
    assert.equal((await rawApi('anna.analyst', 'POST', '/api/procurement/stock/issue', { sku, location, quantity: 1 })).status, 403);
    assert.equal((await rawApi('alice.applicant', 'GET', '/api/procurement/items')).status, 403);
  });

  it('a tenant without the capability is refused by the service', async () => {
    const res = await rawApi('brian.admin', 'GET', '/api/procurement/items');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'capability_disabled');
  });

  it('another tenant with the same capability sees nothing of Riverbend', async () => {
    const own = (await api(ADMIN, 'GET', '/api/procurement/purchase-requests'))[0];
    assert.equal((await rawApi('maya.admin', 'GET', `/api/procurement/purchase-requests/${own.id}`)).status, 404);
    assert.ok(!(await api('maya.admin', 'GET', '/api/procurement/items')).some((i: any) => i.sku === sku));
  });
});
