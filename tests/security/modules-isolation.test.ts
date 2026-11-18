// Tenant isolation of the modules added after v3, tested directly in each service's database
// with the service's own least-privilege role (exactly as the service connects), trying to get
// around row-level security, plus append-only audit trails.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type pg from 'pg';
import { closeConnections, connectAsAppRole, TENANT_A, TENANT_C } from '../helpers/stack.ts';

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

const MODULES: Array<{ service: string; tables: string[]; probe: string; insert: string; appendOnly?: string[] }> = [
  {
    service: 'document',
    tables: ['documents', 'document_versions', 'document_links', 'document_events', 'document_counters', 'tenant_entitlements'],
    probe: 'documents',
    insert: "INSERT INTO documents (tenant_id, reference_no, title, document_type, classification, retention_class, created_by, created_by_id) VALUES ($1, 'DOC-X', 'x', 'other', 'internal', 'transitory', 'attacker', 'attacker')",
    appendOnly: ['document_events'],
  },
  {
    service: 'geo',
    tables: ['zones', 'located_features', 'incident_locations', 'tenant_entitlements'],
    probe: 'zones',
    insert: "INSERT INTO located_features (feature_type, feature_id, tenant_id, code, name, latitude, longitude) VALUES ('asset', gen_random_uuid(), $1, 'X', 'x', 0, 0)",
  },
  {
    service: 'procurement',
    tables: ['suppliers', 'items', 'stock_levels', 'stock_movements', 'purchase_requests', 'purchase_request_lines', 'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'procurement_counters', 'tenant_entitlements'],
    probe: 'items',
    insert: "INSERT INTO suppliers (tenant_id, code, name) VALUES ($1, 'EVIL', 'attacker')",
    appendOnly: ['stock_movements'],
  },
  {
    service: 'report',
    tables: ['report_definitions', 'report_runs', 'tenant_entitlements'],
    probe: 'report_definitions',
    insert: "INSERT INTO report_definitions (tenant_id, name, sections, owner_id, owner_username) VALUES ($1, 'evil', '[]', 'x', 'x')",
  },
  {
    service: 'integration',
    tables: ['inbound_endpoints', 'inbound_messages', 'subscriptions', 'deliveries', 'tenant_entitlements'],
    probe: 'subscriptions',
    insert: "INSERT INTO subscriptions (tenant_id, name, target_url, event_types, sealed_secret, created_by) VALUES ($1, 'evil', 'http://webhook-sink/x', '{incident.created.v1}', 'x', 'attacker')",
    appendOnly: ['inbound_messages'],
  },
  {
    service: 'video',
    tables: ['cameras', 'view_sessions', 'recordings', 'markers', 'incident_refs', 'tenant_entitlements'],
    probe: 'cameras',
    insert: "INSERT INTO cameras (tenant_id, code, name) VALUES ($1, 'EVIL', 'attacker')",
  },
];

for (const m of MODULES) {
  describe(`${m.service}: database protections (${m.service}_app role)`, () => {
    let db: pg.Client;
    after(async () => db?.end());

    it('every tenant table enforces row-level security, and the role cannot bypass it', async () => {
      db = await connectAsAppRole(m.service);
      const flags = (await db.query('SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)', [m.tables])).rows;
      assert.equal(flags.length, m.tables.length, 'all expected tables exist');
      assert.ok(flags.every((r) => r.relrowsecurity), `row-level security on ${flags.filter((r) => !r.relrowsecurity).map((r) => r.relname)}`);
      assert.deepEqual((await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0], { rolsuper: false, rolbypassrls: false });
      for (const t of m.tables) assert.equal(Number((await db.query(`SELECT count(*) FROM ${t}`)).rows[0].count), 0, `${t}: no tenant bound, no rows`);
    });

    it('rows of another tenant cannot be read, changed or created', async () => {
      const seen = await asTenant(db, TENANT_C, async () => (await db.query(`SELECT DISTINCT tenant_id FROM ${m.probe}`)).rows.map((r) => r.tenant_id));
      assert.ok(seen.every((t) => t === TENANT_C), `only Meridian rows are visible to Meridian (saw ${seen})`);
      const result = await asTenant(db, TENANT_C, async () => ({
        read: (await db.query(`SELECT 1 FROM ${m.probe} WHERE tenant_id = $1`, [TENANT_A])).rowCount,
        updated: (await db.query(`UPDATE ${m.probe} SET tenant_id = tenant_id WHERE tenant_id = $1`, [TENANT_A])).rowCount,
        deleted: (await db.query(`DELETE FROM ${m.probe} WHERE tenant_id = $1`, [TENANT_A])).rowCount,
      }));
      assert.deepEqual(result, { read: 0, updated: 0, deleted: 0 });
      await assert.rejects(asTenant(db, TENANT_C, () => db.query(m.insert, [TENANT_A])), /row-level security/);
    });

    if (m.appendOnly) {
      it(`audit trail ${m.appendOnly.join(', ')} cannot be rewritten by the service role`, async () => {
        for (const t of m.appendOnly!) {
          await assert.rejects(asTenant(db, TENANT_A, () => db.query(`UPDATE ${t} SET tenant_id = tenant_id`)), /permission denied/);
          await assert.rejects(asTenant(db, TENANT_A, () => db.query(`DELETE FROM ${t}`)), /permission denied/);
        }
      });
    }
  });
}
