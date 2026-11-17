// AI tools, query templates and analytical datasets of industry packs: available only to
// tenants whose active packs register them, and never returning another tenant's records.
// Real stack, deterministic mode (no model needed); nothing is mocked.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, closeConnections, rawApi, waitFor } from '../helpers/stack.ts';

after(closeConnections);

const chat = (user: string, message: string) => api(user, 'POST', '/api/ai/chat', { message });

describe('AI tools follow the tenant\'s industry packs', () => {
  before(async () => {
    // The AI service learns entitlements from tenant-service with the caller's token (cached 5 s).
    await waitFor(async () => (await api('maya.admin', 'GET', '/api/ai/status')).industry_tools?.includes('maintenance_backlog'), { what: 'the AI service to see Meridian\'s packs' });
  });

  it('each tenant is offered the core tools plus the industry tools of its own packs', async () => {
    const riverbend = await api('adam.admin', 'GET', '/api/ai/status');
    assert.deepEqual(riverbend.industry_tools, ['water_levels']);
    const meridian = await api('maya.admin', 'GET', '/api/ai/status');
    assert.deepEqual(meridian.industry_tools, ['equipment_readings', 'maintenance_backlog']);
    for (const status of [riverbend, meridian]) assert.ok(['kpi_summary', 'list_incidents', 'search_documents'].every((t) => status.tools.includes(t)));
  });

  it('a question about another industry never reaches that industry\'s tool', async () => {
    const answer = await chat('adam.admin', 'Which work orders are open?');
    assert.notEqual(answer.tool?.name, 'maintenance_backlog');
    const river = await chat('maya.admin', 'What is the current river level?');
    assert.notEqual(river.tool?.name, 'water_levels');
  });

  it('the maintenance backlog cites only the caller\'s own work orders', async () => {
    const answer = await chat('maya.admin', 'Which work orders are open?');
    assert.equal(answer.tool.name, 'maintenance_backlog');
    // Without a model the answer must be labelled as a deterministic summary, never as AI output.
    if (answer.ai.mode !== 'model') assert.equal(answer.generated_by.kind, 'deterministic');
    const own = new Set((await api('paula.planner', 'GET', '/api/maintenance/work-orders?status=active&limit=200')).map((w: any) => w.id));
    const foreign = new Set((await api('dora.admin', 'GET', '/api/maintenance/work-orders?limit=200')).map((w: any) => w.id));
    assert.ok(answer.sources.length > 0, 'there are open work orders to cite');
    for (const s of answer.sources) {
      assert.equal(s.type, 'work_order');
      assert.ok(own.has(s.id), `${s.id} is a work order of the caller's tenant`);
      assert.ok(!foreign.has(s.id));
    }
  });

  it('equipment readings come only from the caller\'s own devices', async () => {
    const answer = await chat('maya.admin', 'What is the vibration on the machines?');
    assert.equal(answer.tool.name, 'equipment_readings');
    // The manufacturing simulator (iot profile) publishes continuously, so there is evidence.
    assert.equal(answer.status, 'ok', 'machine readings exist (is the iot profile with its simulators running?)');
    const devices = new Set((await api('maya.admin', 'GET', '/api/device/devices?limit=500')).map((d: any) => d.serial_no));
    const serials = [...answer.evidence.matchAll(/\(([A-Z0-9-]+)\):/g)].map((m: RegExpMatchArray) => m[1]);
    assert.ok(serials.length > 0);
    for (const serial of serials) assert.ok(devices.has(serial), `${serial} belongs to the caller's tenant`);
  });

  it('the daily report has sections only for the tenant\'s own tools', async () => {
    const meridian = await api('maya.admin', 'POST', '/api/ai/reports/draft', { report_type: 'daily_operations' });
    assert.match(meridian.evidence, /Maintenance backlog/);
    assert.doesNotMatch(meridian.evidence, /Water levels/);
    const riverbend = await api('adam.admin', 'POST', '/api/ai/reports/draft', { report_type: 'daily_operations' });
    assert.match(riverbend.evidence, /Water levels/);
    assert.doesNotMatch(riverbend.evidence, /Maintenance backlog|Machine condition/);
  });
});

describe('Query templates and datasets follow the tenant\'s packs', () => {
  it('a query template registered by a pack runs only for tenants with that pack', async () => {
    assert.equal((await rawApi('maya.admin', 'POST', '/api/analytics/query-templates/maintenance_backlog/run', { params: { limit: 5 } })).status, 200);
    const refused = await rawApi('adam.admin', 'POST', '/api/analytics/query-templates/maintenance_backlog/run', { params: { limit: 5 } });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'capability_disabled');
    assert.equal((await rawApi('adam.admin', 'POST', '/api/analytics/query-templates/water_level_peaks/run', { params: { hours: 6 } })).status, 200);
    assert.equal((await rawApi('maya.admin', 'POST', '/api/analytics/query-templates/water_level_peaks/run', { params: { hours: 6 } })).status, 403);
    const listed = (await api('maya.admin', 'GET', '/api/analytics/query-templates')).map((t: any) => t.name);
    assert.ok(listed.includes('maintenance_backlog') && !listed.includes('water_level_peaks'));
  });

  it('a dataset of a capability the tenant lacks is refused; an available one returns only the tenant\'s rows', async () => {
    const refused = await rawApi('adam.admin', 'POST', '/api/analytics/datasets/maintenance_work_orders/query', { filters: {} });
    assert.equal(refused.status, 403);
    assert.equal((await rawApi('dora.admin', 'POST', '/api/analytics/datasets/metric_trend/query', { filters: {} })).status, 403);
    const registry = await api('adam.admin', 'GET', '/api/analytics/datasets/registry');
    assert.equal(registry.find((d: any) => d.name === 'maintenance_work_orders').available, false);
    assert.equal(registry.find((d: any) => d.name === 'water_level_trend').available, true);

    // Rows are bound to the caller's tenant: the counts in the dataset can never exceed the work
    // orders the same tenant can see through maintenance-service (work orders are never deleted,
    // and the dataset is computed from events that happened earlier).
    const total = (rows: any[]) => rows.reduce((n, r) => n + r.work_orders, 0);
    for (const [admin, planner] of [['maya.admin', 'paula.planner'], ['dora.admin', 'penny.planner']]) {
      const dataset = await api(admin, 'POST', '/api/analytics/datasets/maintenance_work_orders/query', { filters: {} });
      const live = (await api(planner, 'GET', '/api/maintenance/work-orders?limit=500')).length;
      assert.ok(total(dataset.rows) <= live, `${admin}: dataset counts ${total(dataset.rows)} work orders, the tenant has ${live}`);
    }
    const meridian = await api('maya.admin', 'POST', '/api/analytics/datasets/maintenance_work_orders/query', { filters: {} });
    assert.ok(meridian.rows.every((r: any) => ['manufacturing', 'facilities'].includes(r.pack_id)));
  });

  it('a filter on an undeclared column, or a value of the wrong type, is refused', async () => {
    for (const filters of [{ tenant_id: '11111111-1111-4111-8111-111111111111' }, { open: 'true' }, { 'pack_id; DROP TABLE x': 'a' }]) {
      const res = await rawApi('maya.admin', 'POST', '/api/analytics/datasets/maintenance_work_orders/query', { filters });
      assert.equal(res.status, 400, JSON.stringify(filters));
    }
  });
});
