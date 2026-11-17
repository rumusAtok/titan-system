// Industry C: facilities management, end to end, on the real stack.
//
//   facility asset -> service request or inspection finding -> configurable approval
//   -> assigned maintenance work -> completion -> the asset and the requester see the result
//
// Runs in the tenant "Harbourline Properties", whose facilities pack switches on the
// maintenance capability only: the tenant has NO device/telemetry capability, which
// is asserted first. No device, sensor or MQTT message takes part in this file.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, closeConnections, decideSubject, pendingSubjectTask, rawApi, requestStatus, unique, userId, waitFor, waitForAccess } from '../helpers/stack.ts';

const ADMIN = 'dora.admin'; // tenant administrator and facility manager
const TECHNICIAN = 'dan.technician';
const REQUESTER = 'daisy.requester';

let building: any;

before(async () => {
  await waitForAccess(ADMIN, '/api/maintenance/request-types', 200, 'the maintenance capability to be active for Harbourline');
  building = (await api(ADMIN, 'GET', '/api/asset/assets?pack=facilities')).find((a: any) => a.code === 'HBL-TOWER');
  assert.ok(building, 'the seeded building exists (run `npm run seed`)');
  // A request refers to the asset, which maintenance-service learns about from an event: wait until it has.
  const probe = await waitFor(
    async () => {
      const res = await rawApi(ADMIN, 'POST', '/api/maintenance/requests', { request_type: 'facility-service-request', title: 'Readiness probe', asset_id: building.id, details: { location: 'n/a', service_category: 'other' } });
      return res.status === 201 ? res.body : null;
    },
    { what: 'maintenance-service to know the building' },
  );
  await api(ADMIN, 'POST', `/api/maintenance/requests/${probe.id}/cancel`);
});

after(closeConnections);

const serviceRequest = (over: Record<string, unknown> = {}) => ({
  request_type: 'facility-service-request',
  title: `Meeting room too warm ${unique()}`,
  description: 'Synthetic request raised by an automated test.',
  asset_id: building.id,
  details: { location: 'Level 14, meeting room 3', service_category: 'hvac', estimated_cost: 800 },
  ...over,
});

describe('Facilities: the pack works without the device capability', () => {
  it('the tenant has maintenance but no IoT capability', async () => {
    const entitlements = await api(ADMIN, 'GET', '/api/tenant/entitlements');
    assert.ok(entitlements.capabilities.includes('maintenance'));
    assert.ok(entitlements.packs.some((p: any) => p.id === 'facilities'));
    // (The pack-lifecycle tests may add manufacturing to this tenant temporarily; facilities itself never needs it.)
    const facilities = (await api(ADMIN, 'GET', '/api/tenant/packs/catalog')).find((p: any) => p.id === 'facilities');
    assert.deepEqual(facilities.capabilities, ['maintenance']);
    assert.deepEqual(facilities.contents.sensor_profiles, []);
    assert.deepEqual(facilities.contents.alert_rules, []);
  });

  it('the pack installed its request types, each with its own approval workflow', async () => {
    const types = await api(ADMIN, 'GET', '/api/maintenance/request-types');
    const service = types.find((t: any) => t.key === 'facility-service-request');
    assert.equal(service.subject_type, 'service_request');
    assert.equal(service.workflow_key, 'facility-request-approval');
    assert.equal(service.pack_id, 'facilities');
    assert.equal(types.find((t: any) => t.key === 'inspection-finding').workflow_key, 'inspection-follow-up');
  });

  it('building assets are validated against the attribute schema of their category', async () => {
    const invalid = await rawApi(ADMIN, 'POST', '/api/asset/assets', { code: unique('HBL-'), name: 'Annex', category_code: 'BUILDING', attributes: { floors: 3, colour: 'grey' } });
    assert.equal(invalid.status, 400);
    const fields = invalid.body.error.details.map((d: any) => d.field).sort();
    assert.deepEqual(fields, ['colour', 'floor_area_m2'], 'a required attribute is missing and an unknown one was given');

    const annex = await api(ADMIN, 'POST', '/api/asset/assets', { code: unique('HBL-'), name: 'Annex', category_code: 'BUILDING', status: 'active', attributes: { floor_area_m2: 900, floors: 3, use: 'office', synthetic: true } });
    assert.equal(annex.attribute_schema_version, 1);
  });
});

describe('Facilities: service request to completed work', () => {
  let request: any;
  let workOrder: any;

  it('an occupant raises a service request; incomplete details are refused', async () => {
    const incomplete = await rawApi(REQUESTER, 'POST', '/api/maintenance/requests', serviceRequest({ details: { service_category: 'hvac' } }));
    assert.equal(incomplete.status, 400);
    assert.ok(incomplete.body.error.details.some((d: any) => d.field === 'location'));

    request = await api(REQUESTER, 'POST', '/api/maintenance/requests', serviceRequest());
    assert.match(request.reference_no, /^MR-\d{4}-\d{6}$/);
    assert.equal(request.status, 'submitted');
    assert.equal(request.pack_id, 'facilities');
    assert.equal(request.priority, 'normal', 'the request type default');
  });

  it('the request goes to the facility manager; the requester cannot decide or see the work queue', async () => {
    const task = await pendingSubjectTask(ADMIN, request.id, 'facility_review');
    assert.equal(task.role, 'facility_manager');
    assert.equal(task.subject_type, 'service_request');
    assert.equal(task.reference, request.reference_no);
    // The requester is not staff: no inbox, no decision, no work orders.
    assert.equal((await rawApi(REQUESTER, 'GET', '/api/workflow/tasks')).status, 403);
    assert.equal((await rawApi(REQUESTER, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' })).status, 403);
    assert.equal((await rawApi(REQUESTER, 'GET', '/api/maintenance/work-orders')).status, 403);
    // A technician is staff but does not hold the reviewing role.
    assert.equal((await rawApi(TECHNICIAN, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' })).status, 403);
  });

  it('approval of a small request needs no budget stage and creates exactly one work order', async () => {
    const decision = await decideSubject(ADMIN, request.id, 'facility_review', 'approve');
    assert.equal(decision.instance_status, 'approved', 'estimated cost below 5000 skips budget approval');
    const approved = await requestStatus(REQUESTER, request.id, 'approved', true);
    workOrder = approved.work_order;
    assert.match(workOrder.reference_no, /^WO-\d{4}-\d{6}$/);
    assert.equal(workOrder.status, 'open');
    const orders = (await api(ADMIN, 'GET', '/api/maintenance/work-orders?pack=facilities')).filter((w: any) => w.request_id === request.id);
    assert.equal(orders.length, 1);
  });

  it('the facility manager assigns the work; only the assigned technician can carry it out', async () => {
    assert.equal((await rawApi(TECHNICIAN, 'POST', `/api/maintenance/work-orders/${workOrder.id}/assign`, { assignee_id: 'x', assignee_username: 'x' })).status, 403, 'technicians do not assign work');
    assert.equal((await rawApi(TECHNICIAN, 'POST', `/api/maintenance/work-orders/${workOrder.id}/start`)).status, 403, 'not assigned yet');
    const assigned = await api(ADMIN, 'POST', `/api/maintenance/work-orders/${workOrder.id}/assign`, { assignee_id: await userId(TECHNICIAN), assignee_username: TECHNICIAN });
    assert.equal(assigned.status, 'assigned');
    assert.equal((await rawApi(TECHNICIAN, 'POST', `/api/maintenance/work-orders/${workOrder.id}/complete`, { summary: 'Done already' })).status, 409, 'work cannot be completed before it is started');

    const started = await api(TECHNICIAN, 'POST', `/api/maintenance/work-orders/${workOrder.id}/start`);
    assert.equal(started.status, 'in_progress');
    const mine = await api(TECHNICIAN, 'GET', '/api/maintenance/work-orders?mine=true&status=active');
    assert.ok(mine.some((w: any) => w.id === workOrder.id));
  });

  it('starting the work takes the building system out of service in the asset register', async () => {
    await waitFor(async () => (await api(ADMIN, 'GET', `/api/asset/assets/${building.id}`)).status === 'under_maintenance', { what: 'the asset to be under maintenance' });
  });

  it('completion records the result, returns the asset to service and tells the requester', async () => {
    const done = await api(TECHNICIAN, 'POST', `/api/maintenance/work-orders/${workOrder.id}/complete`, { summary: 'Replaced a failed damper actuator and rebalanced the air flow.', labor_hours: 1.5, condition_after: 'good' });
    assert.equal(done.status, 'completed');
    assert.equal(done.labor_hours, 1.5);
    assert.equal((await rawApi(TECHNICIAN, 'POST', `/api/maintenance/work-orders/${workOrder.id}/complete`, { summary: 'Again' })).status, 409, 'a completed work order is final');

    const asset = await waitFor(async () => {
      const a = await api(ADMIN, 'GET', `/api/asset/assets/${building.id}`);
      return a.status === 'active' && a.last_maintained_at ? a : null;
    }, { what: 'the asset to be back in service' });
    assert.equal(asset.condition, 'good');
    assert.ok(asset.history.some((h: any) => h.note === `Work order ${workOrder.reference_no} completed`));

    const mine = await api(REQUESTER, 'GET', `/api/maintenance/requests/${request.id}`);
    assert.equal(mine.work_order.status, 'completed');
    await waitFor(async () => (await api(REQUESTER, 'GET', '/api/notification/notifications?limit=100')).some((n: any) => n.category === 'maintenance.work_order_completed' && n.reference_id === workOrder.id), {
      what: 'the requester to be told the work is complete',
    });
  });

  it('the work order keeps its own history, and the audit trail has every step', async () => {
    const detail = await api(ADMIN, 'GET', `/api/maintenance/work-orders/${workOrder.id}`);
    assert.deepEqual(detail.events.map((e: any) => e.entry_type), ['created', 'assigned', 'started', 'completed']);
    assert.equal(detail.request.reference_no, request.reference_no);
    await waitFor(async () => {
      const types = new Set((await api(ADMIN, 'GET', `/api/audit/audit?aggregate_id=${workOrder.id}&limit=50`)).items.map((r: any) => r.event_type));
      return ['maintenance.work_order.created.v1', 'maintenance.work_order.assigned.v1', 'maintenance.work_order.started.v1', 'maintenance.work_order.completed.v1'].every((t) => types.has(t));
    }, { what: 'the work order events to be audited' });
  });
});

describe('Facilities: configurable approval', () => {
  it('a costly request is routed through the conditional budget stage', async () => {
    const request = await api(REQUESTER, 'POST', '/api/maintenance/requests', serviceRequest({ details: { location: 'Plant room', service_category: 'hvac', estimated_cost: 9000 } }));
    const first = await decideSubject(ADMIN, request.id, 'facility_review', 'approve');
    assert.equal(first.instance_status, 'running', 'budget approval is still needed');
    const budget = await pendingSubjectTask(ADMIN, request.id, 'budget_approval');
    assert.equal(budget.role, 'tenant_admin');
    assert.equal((await api(REQUESTER, 'GET', `/api/maintenance/requests/${request.id}`)).status, 'submitted', 'no work order before the last approval');
    await api(ADMIN, 'POST', `/api/workflow/tasks/${budget.id}/decision`, { decision: 'approve' });
    await requestStatus(REQUESTER, request.id, 'approved', true);
  });

  it('a rejected request creates no work order', async () => {
    const request = await api(REQUESTER, 'POST', '/api/maintenance/requests', serviceRequest({ title: `Repaint the lobby ${unique()}` }));
    const task = await pendingSubjectTask(ADMIN, request.id, 'facility_review');
    assert.equal((await rawApi(ADMIN, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'reject' })).status, 400, 'a rejection needs a reason');
    assert.equal((await rawApi(ADMIN, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'return', comment: 'Please add detail' })).status, 409, 'only cases can be returned for changes');
    await api(ADMIN, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'reject', comment: 'Not in this year\'s plan' });
    const rejected = await requestStatus(REQUESTER, request.id, 'rejected');
    assert.equal(rejected.work_order, null);
  });

  it('nobody approves their own request (separation of duties)', async () => {
    const own = await api(ADMIN, 'POST', '/api/maintenance/requests', serviceRequest({ title: `Manager's own request ${unique()}` }));
    const task = await pendingSubjectTask(ADMIN, own.id, 'facility_review');
    const res = await rawApi(ADMIN, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /own/);
    // The requester withdraws it instead; the pending task disappears.
    const cancelled = await api(ADMIN, 'POST', `/api/maintenance/requests/${own.id}/cancel`);
    assert.equal(cancelled.status, 'cancelled');
    await waitFor(async () => (await api(ADMIN, 'GET', `/api/workflow/tasks?subject_id=${own.id}`)).length === 0, { what: 'the approval task to be withdrawn' });
  });

  it('an inspection finding follows its own workflow and request type rules', async () => {
    const res = await rawApi(REQUESTER, 'POST', '/api/maintenance/requests', { request_type: 'inspection-finding', title: 'Blocked fire exit', details: { inspection_type: 'fire_safety', finding: 'Boxes stored in front of exit B2.' } });
    assert.equal(res.status, 403, 'occupants cannot record inspection findings');
    const finding = await api(TECHNICIAN, 'POST', '/api/maintenance/requests', { request_type: 'inspection-finding', title: `Blocked fire exit ${unique()}`, priority: 'high', details: { inspection_type: 'fire_safety', finding: 'Boxes stored in front of exit B2.' } });
    assert.equal(finding.subject_type, 'maintenance_request');
    const task = await pendingSubjectTask(ADMIN, finding.id, 'facility_review');
    assert.equal(task.subject_type, 'maintenance_request');
    await api(ADMIN, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' });
    const approved = await requestStatus(TECHNICIAN, finding.id, 'approved', true);
    assert.equal(approved.work_order.status, 'open');
  });
});

describe('Facilities: access to requests', () => {
  it('a requester sees only their own requests; a missing and a foreign request look the same', async () => {
    const mine = await api(REQUESTER, 'POST', '/api/maintenance/requests', serviceRequest());
    const other = await api(TECHNICIAN, 'POST', '/api/maintenance/requests', serviceRequest());
    const list = await api(REQUESTER, 'GET', '/api/maintenance/requests?limit=500');
    assert.ok(list.some((r: any) => r.id === mine.id));
    assert.ok(list.every((r: any) => r.requested_by_username === REQUESTER));
    assert.equal((await rawApi(REQUESTER, 'GET', `/api/maintenance/requests/${other.id}`)).status, 404);
    assert.equal((await rawApi(REQUESTER, 'POST', `/api/maintenance/requests/${other.id}/cancel`)).status, 404);
    // Staff see every request of the tenant.
    assert.ok((await api(TECHNICIAN, 'GET', '/api/maintenance/requests?limit=500')).some((r: any) => r.id === mine.id));
    for (const id of [mine.id, other.id]) await api(ADMIN, 'POST', `/api/maintenance/requests/${id}/cancel`);
  });

  it('a facility incident is reported against the building and uses the facility response process', async () => {
    const incident = await api(ADMIN, 'POST', '/api/incident/incidents', { title: `Water leak in plant room ${unique()}`, severity: 'warning', category: 'facility', asset_id: building.id, source_type: 'inspection', source_id: unique('INSP-') });
    assert.equal(incident.category, 'facility');
    assert.equal(incident.source_type, 'inspection');
    assert.equal(incident.asset_id, building.id);
    const task = await pendingSubjectTask(ADMIN, incident.id, 'acknowledge');
    assert.equal(task.role, 'facility_manager');
    await api(ADMIN, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' });
    await waitFor(async () => (await api(ADMIN, 'GET', `/api/incident/incidents/${incident.id}`)).status === 'acknowledged', { what: 'the incident to be acknowledged' });
    assert.ok((await api(ADMIN, 'GET', `/api/incident/incidents?category=facility&asset_id=${building.id}`)).some((i: any) => i.id === incident.id));
    assert.equal((await rawApi(ADMIN, 'POST', '/api/incident/incidents', { title: 'Unknown category', severity: 'info', category: 'no-such-category' })).status, 400);
  });
});
