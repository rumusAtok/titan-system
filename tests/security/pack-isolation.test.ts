// Tenant isolation and authorization of everything TITAN v3 added: the pack registry,
// entitlements, the maintenance service and the workflow subject registry.
// The database tests connect as each service's own least-privilege role, exactly as
// the service does, and try to get around row-level security directly.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import { api, closeConnections, connectAsAppRole, rawApi, TENANT_A, TENANT_C, TENANT_D, unique } from '../helpers/stack.ts';

const PLATFORM = '00000000-0000-0000-0000-000000000000';

async function asTenant<T>(db: pg.Client, tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    if (tenantId) await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn();
  } finally {
    await db.query('ROLLBACK');
  }
}

after(closeConnections);

describe('Pack registry: database protections (tenant-service role)', () => {
  let db: pg.Client;
  before(async () => (db = await connectAsAppRole('tenant')));
  after(async () => db.end());

  it('pack activations are visible only to their own tenant', async () => {
    for (const table of ['tenant_packs', 'tenant_pack_history', 'tenant_entitlement_revisions', 'sites', 'dashboard_layouts']) {
      assert.equal(Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count), 0, `${table}: no tenant bound, no rows`);
    }
    const seenByC = await asTenant(db, TENANT_C, async () => (await db.query('SELECT DISTINCT tenant_id FROM tenant_packs')).rows.map((r) => r.tenant_id));
    assert.deepEqual(seenByC, [TENANT_C]);
    const foreign = await asTenant(db, TENANT_C, async () => (await db.query('SELECT 1 FROM tenant_packs WHERE tenant_id = $1', [TENANT_A])).rowCount);
    assert.equal(foreign, 0);
  });

  it('a tenant cannot activate, change or disable another tenant\'s packs', async () => {
    await assert.rejects(
      asTenant(db, TENANT_C, () => db.query("INSERT INTO tenant_packs (tenant_id, pack_id, version, status, activated_by) VALUES ($1, 'manufacturing', '1.0.0', 'active', 'attacker')", [TENANT_A])),
      /row-level security/,
    );
    const changed = await asTenant(db, TENANT_C, async () => (await db.query("UPDATE tenant_packs SET status = 'disabled' WHERE tenant_id = $1", [TENANT_A])).rowCount);
    assert.equal(changed, 0);
    await assert.rejects(asTenant(db, TENANT_C, () => db.query('UPDATE tenant_packs SET tenant_id = $1', [TENANT_A])), /row-level security/);
  });

  it('a registered pack version is immutable, and the pack history is append-only', async () => {
    assert.ok(Number((await db.query('SELECT count(*) FROM pack_catalog')).rows[0].count) >= 6, 'the catalogue is readable');
    await assert.rejects(db.query("UPDATE pack_catalog SET manifest = '{}'::jsonb"), /permission denied/);
    await assert.rejects(db.query('DELETE FROM pack_catalog'), /permission denied/);
    await assert.rejects(db.query('TRUNCATE pack_catalog'), /permission denied/);
    await assert.rejects(asTenant(db, TENANT_C, () => db.query("UPDATE tenant_pack_history SET actor = 'nobody'")), /permission denied/);
    await assert.rejects(asTenant(db, TENANT_C, () => db.query('DELETE FROM tenant_pack_history')), /permission denied/);
  });

  it('only the platform tenant sees activations across tenants', async () => {
    const tenants = await asTenant(db, PLATFORM, async () => (await db.query('SELECT DISTINCT tenant_id FROM tenant_packs')).rows.length);
    assert.ok(tenants >= 4);
  });
});

describe('Maintenance service: database protections (maintenance-service role)', () => {
  let db: pg.Client;
  before(async () => (db = await connectAsAppRole('maintenance')));
  after(async () => db.end());

  const TABLES = ['request_types', 'maintenance_requests', 'work_orders', 'work_order_events', 'asset_projection', 'maintenance_counters', 'tenant_entitlements'];

  it('every tenant table has row-level security enforced for the service role', async () => {
    const flags = (await db.query('SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)', [TABLES])).rows;
    assert.equal(flags.length, TABLES.length);
    assert.ok(flags.every((r) => r.relrowsecurity), 'row-level security is enabled');
    const role = (await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    for (const table of TABLES) assert.equal(Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count), 0, `${table}: no tenant bound, no rows`);
  });

  it('requests and work orders of another tenant cannot be read, changed or created', async () => {
    const seen = await asTenant(db, TENANT_D, async () => (await db.query('SELECT DISTINCT tenant_id FROM maintenance_requests')).rows.map((r) => r.tenant_id));
    assert.deepEqual(seen, [TENANT_D]);
    const result = await asTenant(db, TENANT_D, async () => ({
      read: (await db.query('SELECT 1 FROM work_orders WHERE tenant_id = $1', [TENANT_C])).rowCount,
      updated: (await db.query("UPDATE work_orders SET status = 'cancelled' WHERE tenant_id = $1", [TENANT_C])).rowCount,
      deleted: (await db.query('DELETE FROM work_order_events WHERE tenant_id = $1', [TENANT_C])).rowCount,
    }));
    assert.deepEqual(result, { read: 0, updated: 0, deleted: 0 });
    await assert.rejects(
      asTenant(db, TENANT_D, () =>
        db.query(
          `INSERT INTO maintenance_requests (tenant_id, reference_no, request_type, pack_id, subject_type, workflow_key, title, priority, origin_type)
           VALUES ($1, $2, 'equipment-repair', 'manufacturing', 'maintenance_request', 'maintenance-approval', 'cross-tenant insert', 'low', 'manual')`,
          [TENANT_C, unique('MR-X-')],
        ),
      ),
      /row-level security/,
    );
  });

  it('a tenant cannot grant itself a capability in the service\'s entitlement projection of another tenant', async () => {
    await assert.rejects(
      asTenant(db, TENANT_D, () => db.query("INSERT INTO tenant_entitlements (tenant_id, capabilities, revision) VALUES ($1, '{maintenance,iot,case_management}', 999999)", [TENANT_A])),
      /row-level security/,
    );
    const changed = await asTenant(db, TENANT_D, async () => (await db.query("UPDATE tenant_entitlements SET capabilities = '{maintenance}' WHERE tenant_id = $1", [TENANT_A])).rowCount);
    assert.equal(changed, 0);
  });

  it('the role cannot reach another service\'s database', async () => {
    await assert.rejects(connectAsAppRole('maintenance', 'titan_asset'), /permission denied for database|CONNECT/);
    await assert.rejects(connectAsAppRole('maintenance', 'titan_tenant'), /permission denied for database|CONNECT/);
    await assert.rejects(connectAsAppRole('asset', 'titan_maintenance'), /permission denied for database|CONNECT/);
  });
});

describe('Workflow subject registry: database protections (workflow-service role)', () => {
  let db: pg.Client;
  before(async () => (db = await connectAsAppRole('workflow')));
  after(async () => db.end());

  it('the registry cannot be extended or changed at run time', async () => {
    await assert.rejects(db.query("INSERT INTO workflow_subject_types (key, label) VALUES ('anything', 'Anything')"), /permission denied/);
    await assert.rejects(db.query("UPDATE workflow_subject_types SET supports_return = true WHERE key = 'incident'"), /permission denied/);
    await assert.rejects(db.query('DELETE FROM workflow_subject_types'), /permission denied/);
  });

  it('a definition or process for an unregistered subject type cannot exist', async () => {
    await assert.rejects(
      asTenant(db, TENANT_C, () =>
        db.query("INSERT INTO workflow_definitions (tenant_id, key, version, name, subject_type, definition, created_by) VALUES ($1, $2, 1, 'x', 'unregistered_type', '{}'::jsonb, 'test')", [TENANT_C, unique('wf-').toLowerCase()]),
      ),
      /workflow_definitions_subject_type_fkey/,
    );
  });

  it('existing cases and incidents are untouched by the wider registry', async () => {
    const types = await asTenant(db, TENANT_A, async () => (await db.query('SELECT subject_type, count(*)::int AS n FROM workflow_instances GROUP BY 1 ORDER BY 1')).rows);
    const kinds = types.map((t) => t.subject_type);
    assert.ok(kinds.includes('case') && kinds.includes('incident'), 'cases and incidents keep their processes');
    // Besides them only the subject types of the modules added after v3 (documents, procurement) have processes here.
    assert.deepEqual(kinds.filter((k) => !['case', 'incident'].includes(k)).every((k) => ['document', 'purchase_request'].includes(k)), true);
    assert.ok(types.every((t) => t.n > 0));
  });
});

describe('Pack and maintenance APIs across tenants', () => {
  it('the workflow API accepts only registered subject types', async () => {
    const definition = { stages: [{ key: 'review', name: 'Review', roles: ['tenant_admin'] }], allow_return: false };
    const bad = await rawApi('maya.admin', 'POST', '/api/workflow/definitions', { key: unique('wf-').toLowerCase(), name: 'Unregistered', subject_type: 'unregistered_type', definition });
    assert.equal(bad.status, 400);
    // A registered type no service owns yet can already be given a workflow (prepared for future services).
    const ok = await rawApi('maya.admin', 'POST', '/api/workflow/definitions', { key: unique('wf-').toLowerCase(), name: 'Purchase approval (prepared)', subject_type: 'purchase_request', definition });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.subject_type, 'purchase_request');
  });

  it('requests, work orders and processes of another tenant answer 404', async () => {
    const own = await api('dora.admin', 'POST', '/api/maintenance/requests', { request_type: 'facility-service-request', title: `Isolation probe ${unique()}`, details: { location: 'Lobby', service_category: 'other' } });
    for (const outsider of ['maya.admin', 'paula.planner']) {
      assert.equal((await rawApi(outsider, 'GET', `/api/maintenance/requests/${own.id}`)).status, 404);
      assert.equal((await rawApi(outsider, 'POST', `/api/maintenance/requests/${own.id}/cancel`)).status, 404);
      assert.equal((await rawApi(outsider, 'GET', `/api/workflow/instances/by-subject/service_request/${own.id}`)).status, 404);
    }
    assert.ok(!(await api('paula.planner', 'GET', '/api/maintenance/requests?limit=500')).some((r: any) => r.id === own.id));
    const orders = await api('dora.admin', 'GET', '/api/maintenance/work-orders?limit=1');
    if (orders[0]) {
      assert.equal((await rawApi('paula.planner', 'GET', `/api/maintenance/work-orders/${orders[0].id}`)).status, 404);
      assert.equal((await rawApi('paula.planner', 'POST', `/api/maintenance/work-orders/${orders[0].id}/assign`, { assignee_id: 'x', assignee_username: 'x' })).status, 404);
    }
    await api('dora.admin', 'POST', `/api/maintenance/requests/${own.id}/cancel`);
  });

  it('a request cannot refer to another tenant\'s asset', async () => {
    const foreignAsset = (await api('maya.admin', 'GET', '/api/asset/assets?limit=1'))[0];
    const res = await rawApi('dora.admin', 'POST', '/api/maintenance/requests', { request_type: 'facility-service-request', title: 'Foreign asset', asset_id: foreignAsset.id, details: { location: 'x', service_category: 'other' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message, 'asset not found');
  });

  it('a tenant identifier supplied by the client is ignored', async () => {
    const res = await rawApi('dora.admin', 'POST', '/api/maintenance/requests', { request_type: 'facility-service-request', title: `Tenant override attempt ${unique()}`, tenant_id: TENANT_C, details: { location: 'x', service_category: 'other' } }, { 'x-tenant-id': TENANT_C });
    assert.equal(res.status, 201);
    assert.equal(res.body.tenant_id, TENANT_D);
    assert.ok(!(await api('paula.planner', 'GET', '/api/maintenance/requests?limit=500')).some((r: any) => r.id === res.body.id));
    await api('dora.admin', 'POST', `/api/maintenance/requests/${res.body.id}/cancel`);
  });

  it('platform administration of entitlements is not open to tenant administrators', async () => {
    assert.equal((await rawApi('maya.admin', 'POST', '/api/tenant/platform/entitlements/republish')).status, 403);
    const res = await api('pat.platform', 'POST', '/api/tenant/platform/entitlements/republish');
    assert.ok(res.tenants >= 4);
  });
});
