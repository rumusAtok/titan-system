// Test C - Tenant isolation, proven at two independent layers:
//   1. the API (authorisation in each service), and
//   2. the database (row-level security), by connecting directly as the same
//      least-privilege role the service uses and trying to break out.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import { api, closeConnections, connectAsAppRole, createAndSubmitCase, pendingTask, PERMIT_DATA, rawApi, TENANT_A, TENANT_B, unique } from '../helpers/stack.ts';

after(closeConnections);

describe('Test C: tenant isolation through the API', () => {
  let assetA: any;
  let assetB: any;
  let caseA: { id: string; reference_no: string };

  before(async () => {
    assetA = await api('adam.admin', 'POST', '/api/asset/assets', { code: unique('ISO-A-'), name: 'Tenant A isolation asset', category_code: 'PUMP_STATION' });
    assetB = await api('brian.admin', 'POST', '/api/asset/assets', { code: unique('ISO-B-'), name: 'Tenant B isolation asset', category_code: 'PUMP_STATION' });
    caseA = await createAndSubmitCase('alice.applicant', 'building-permit', PERMIT_DATA);
  });

  it('each tenant sees only its own records in lists', async () => {
    const listA = (await api('adam.admin', 'GET', '/api/asset/assets?limit=500')) as any[];
    const listB = (await api('brian.admin', 'GET', '/api/asset/assets?limit=500')) as any[];
    assert.ok(listA.some((a) => a.id === assetA.id));
    assert.ok(!listA.some((a) => a.id === assetB.id));
    assert.ok(listB.some((a) => a.id === assetB.id));
    assert.ok(!listB.some((a) => a.id === assetA.id));
    assert.ok(listA.every((a) => a.tenant_id === TENANT_A));
    assert.ok(listB.every((a) => a.tenant_id === TENANT_B));
  });

  it("another tenant's record cannot be read by id (404, not 403: existence is not disclosed)", async () => {
    assert.equal((await rawApi('brian.admin', 'GET', `/api/asset/assets/${assetA.id}`)).status, 404);
    assert.equal((await rawApi('adam.admin', 'GET', `/api/asset/assets/${assetB.id}`)).status, 404);
  });

  it("another tenant's record cannot be modified, even by that tenant's administrator", async () => {
    assert.equal((await rawApi('brian.admin', 'PATCH', `/api/asset/assets/${assetA.id}`, { name: 'hijacked', expected_version: 1 })).status, 404);
    assert.equal((await rawApi('brian.admin', 'POST', `/api/asset/assets/${assetA.id}/status`, { status: 'retired' })).status, 404);
    const unchanged = await api('adam.admin', 'GET', `/api/asset/assets/${assetA.id}`);
    assert.equal(unchanged.name, 'Tenant A isolation asset');
    assert.equal(unchanged.status, 'planned');
  });

  it('a tenant id supplied by the client is ignored; the tenant always comes from the token', async () => {
    const code = unique('SPOOF-');
    const res = await rawApi('brian.admin', 'POST', '/api/asset/assets', { code, name: 'Spoof attempt', category_code: 'PUMP_STATION', tenant_id: TENANT_A }, { 'x-tenant-id': TENANT_A });
    assert.equal(res.status, 201);
    assert.equal(res.body.tenant_id, TENANT_B, 'created in the caller’s own tenant');
    assert.ok(!((await api('adam.admin', 'GET', '/api/asset/assets?limit=500')) as any[]).some((a) => a.code === code));
  });

  it('cases, workflow tasks, devices, incidents and audit records do not cross tenants', async () => {
    // Case: a reviewer role in tenant B cannot read tenant A's case.
    assert.equal((await rawApi('vera.validator', 'GET', `/api/case/cases/${caseA.id}`)).status, 404);
    assert.equal((await rawApi('bob.applicant', 'GET', `/api/case/cases/track/${caseA.reference_no}`)).status, 404);
    assert.ok(!((await api('vera.validator', 'GET', '/api/case/cases?scope=all&limit=200')) as any[]).some((c) => c.id === caseA.id));

    // Workflow.
    const task = await pendingTask('victor.validator', caseA.id, 'validation');
    assert.ok(!((await api('vera.validator', 'GET', '/api/workflow/tasks')) as any[]).some((t) => t.id === task.id));
    assert.equal((await rawApi('vera.validator', 'GET', `/api/workflow/instances/by-subject/case/${caseA.id}`)).status, 404);

    // Devices and incidents.
    const devicesA = (await api('adam.admin', 'GET', '/api/device/devices')) as any[];
    assert.equal((await rawApi('brian.admin', 'GET', `/api/device/devices/${devicesA[0].id}`)).status, 404);
    const incidentsA = (await api('derek.duty', 'GET', '/api/incident/incidents?limit=5')) as any[];
    if (incidentsA.length) assert.equal((await rawApi('dana.duty', 'GET', `/api/incident/incidents/${incidentsA[0].id}`)).status, 404);

    // Audit: tenant B's administrator finds no trace of tenant A's case.
    const audit = await api('brian.admin', 'GET', `/api/audit/audit?aggregate_id=${caseA.id}`);
    assert.equal(audit.total, 0);
  });

  it('tenant administration endpoints are confined to the caller’s tenant', async () => {
    const tenantA = await api('adam.admin', 'GET', '/api/tenant/tenants/current');
    const tenantB = await api('brian.admin', 'GET', '/api/tenant/tenants/current');
    assert.equal(tenantA.id, TENANT_A);
    assert.equal(tenantB.id, TENANT_B);
    const membersB = (await api('brian.admin', 'GET', '/api/tenant/memberships')) as any[];
    assert.ok(!membersB.some((m) => m.username === 'victor.validator'));
  });
});

describe('Test C: tenant isolation in the database (row-level security)', () => {
  let db: pg.Client;

  /** Runs statements in one transaction bound to a tenant, like the service does, then rolls back. */
  async function asTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
    await db.query('BEGIN');
    try {
      if (tenantId) await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      return await fn();
    } finally {
      await db.query('ROLLBACK');
    }
  }

  before(async () => {
    db = await connectAsAppRole('asset');
  });
  after(async () => {
    await db.end();
  });

  it('the service role is not a superuser, does not own the tables and cannot bypass RLS', async () => {
    const { rows } = await db.query(
      `SELECT r.rolsuper, r.rolbypassrls, c.relrowsecurity, (c.relowner = r.oid) AS owns_table
         FROM pg_roles r, pg_class c WHERE r.rolname = current_user AND c.relname = 'assets'`,
    );
    assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false, relrowsecurity: true, owns_table: false });
  });

  it('with no tenant bound, no rows are visible at all (fail closed)', async () => {
    const count = await asTenant(null, async () => Number((await db.query('SELECT count(*) FROM assets')).rows[0].count));
    assert.equal(count, 0);
  });

  it('with a tenant bound, only that tenant’s rows are visible, even without a WHERE clause', async () => {
    const tenantsSeenAsA = await asTenant(TENANT_A, async () => (await db.query('SELECT DISTINCT tenant_id FROM assets')).rows.map((r) => r.tenant_id));
    const tenantsSeenAsB = await asTenant(TENANT_B, async () => (await db.query('SELECT DISTINCT tenant_id FROM assets')).rows.map((r) => r.tenant_id));
    assert.deepEqual(tenantsSeenAsA, [TENANT_A]);
    assert.deepEqual(tenantsSeenAsB, [TENANT_B]);
  });

  it('explicitly asking for another tenant’s rows returns nothing', async () => {
    const rows = await asTenant(TENANT_A, async () => (await db.query('SELECT id FROM assets WHERE tenant_id = $1', [TENANT_B])).rows);
    assert.equal(rows.length, 0);
  });

  it('updating or deleting another tenant’s rows affects nothing', async () => {
    const result = await asTenant(TENANT_A, async () => {
      const updated = await db.query("UPDATE assets SET name = 'hijacked' WHERE tenant_id = $1", [TENANT_B]);
      const deleted = await db.query('DELETE FROM asset_status_history WHERE tenant_id = $1', [TENANT_B]);
      return { updated: updated.rowCount, deleted: deleted.rowCount };
    });
    assert.deepEqual(result, { updated: 0, deleted: 0 });
  });

  it('inserting a row for another tenant, or moving a row to another tenant, is refused', async () => {
    await assert.rejects(
      asTenant(TENANT_A, async () => {
        const category = (await db.query('SELECT id FROM asset_categories LIMIT 1')).rows[0].id;
        await db.query('INSERT INTO assets (tenant_id, code, name, category_id) VALUES ($1, $2, $3, $4)', [TENANT_B, unique('RLS-'), 'cross-tenant insert', category]);
      }),
      /row-level security/,
    );
    await assert.rejects(
      asTenant(TENANT_A, () => db.query('UPDATE assets SET tenant_id = $1', [TENANT_B])),
      /row-level security/,
    );
  });

  it('the role cannot switch row-level security off or alter the policy', async () => {
    await assert.rejects(
      asTenant(TENANT_A, async () => {
        await db.query('SET LOCAL row_security = off');
        await db.query('SELECT count(*) FROM assets');
      }),
      /row-level security/,
    );
    await assert.rejects(db.query('ALTER TABLE assets DISABLE ROW LEVEL SECURITY'), /must be owner/);
    await assert.rejects(db.query('DROP POLICY assets_isolation ON assets'), /must be owner/);
  });

  it('a service role cannot connect to another service’s database', async () => {
    await assert.rejects(connectAsAppRole('asset', 'titan_case'), /permission denied for database|CONNECT/);
    await assert.rejects(connectAsAppRole('asset', 'titan_workflow'), /permission denied for database|CONNECT/);
  });
});

describe('Test C: database-level protections of other services', () => {
  it('the audit trail is append-only for the audit service’s own role', async () => {
    const db = await connectAsAppRole('audit');
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A]);
      const visible = Number((await db.query('SELECT count(*) FROM audit_events')).rows[0].count);
      assert.ok(visible > 0, 'records are readable');
      await db.query('ROLLBACK');
      await assert.rejects(db.query("UPDATE audit_events SET actor_username = 'nobody'"), /permission denied/);
      await assert.rejects(db.query('DELETE FROM audit_events'), /permission denied/);
      await assert.rejects(db.query('TRUNCATE audit_events'), /permission denied/);
    } finally {
      await db.end();
    }
  });

  it('recorded workflow decisions cannot be rewritten by the workflow service’s role', async () => {
    const db = await connectAsAppRole('workflow');
    try {
      await assert.rejects(db.query("UPDATE workflow_decisions SET decision = 'approve'"), /permission denied/);
      await assert.rejects(db.query('DELETE FROM workflow_decisions'), /permission denied/);
    } finally {
      await db.end();
    }
  });

  it('time-series partitions cannot be read directly, bypassing the policy on the parent table', async () => {
    const db = await connectAsAppRole('telemetry');
    try {
      const partitions = (await db.query("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'measurements'")).rows.map((r) => r.relname);
      assert.ok(partitions.length >= 4, 'monthly partitions exist');
      for (const name of partitions) await assert.rejects(db.query(`SELECT count(*) FROM "${name}"`), /permission denied/);
      // Through the parent, with no tenant bound: nothing.
      assert.equal(Number((await db.query('SELECT count(*) FROM measurements')).rows[0].count), 0);
    } finally {
      await db.end();
    }
  });
});
