// Data engineering and analytics: bronze -> silver -> gold -> KPI APIs.
// Runs against the real pipeline, lake and analytics database.
// Requires: docker compose --profile core --profile iot --profile analytics up -d
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { api, closeConnections, config, createAndSubmitCase, decide, rawApi, sleep, TENANT_A, tokenFor, unique, waitFor } from '../helpers/stack.ts';

after(closeConnections);

/** Triggers a pipeline run, waiting out a scheduled run that may be in progress. */
async function runPipeline(body: Record<string, unknown> = {}, path = '/api/pipeline/runs') {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await rawApi('anna.analyst', 'POST', path, body);
    if (res.status === 409 && res.body?.error?.code === 'run_in_progress') {
      await sleep(500);
      continue;
    }
    assert.ok(res.status === 200 || res.status === 201, `pipeline run request failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
  throw new Error('the pipeline stayed busy');
}

const summary = (user = 'anna.analyst') => api(user, 'GET', '/api/analytics/kpis/summary');

async function serviceToken(): Promise<string> {
  const res = await fetch(`${config.keycloakUrl}/realms/titan/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'svc-pipeline', client_secret: config.env.SVC_PIPELINE_CLIENT_SECRET ?? '' }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).access_token;
}

describe('analytics: KPIs are calculated from stored data', () => {
  let before_: any;

  before(async () => {
    await runPipeline();
    before_ = await summary();
  });

  it('completing one approval changes the approval KPI by exactly one', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'event-permit', { event_name: 'KPI check fair', venue: 'Riverbend Square', event_date: '2027-09-01', expected_attendance: 120 });
    await decide('victor.validator', c.id, 'validation', 'approve');
    await decide('tara.technical', c.id, 'joint_review', 'approve');
    await decide('henry.head', c.id, 'joint_review', 'approve');

    // The KPI moves only after the pipeline has processed the new events.
    const after_ = await waitFor(
      async () => {
        await runPipeline();
        const s = await summary();
        return s.approvals.approved === before_.approvals.approved + 1 ? s : null;
      },
      { timeoutMs: 60_000, intervalMs: 1_000, what: 'the approval to appear in the KPI' },
    );
    assert.equal(after_.approvals.completed, before_.approvals.completed + 1);
    assert.equal(after_.approvals.rejected, before_.approvals.rejected);
    assert.ok(after_.approvals.avg_turnaround_hours >= 0);
    assert.equal(after_.freshness.status, 'loaded');
    assert.ok(new Date(after_.freshness.computed_at) > new Date(before_.freshness.computed_at), 'freshness advances with each run');
  });

  it('a submitted but undecided case shows up as a pending task, and disappears when decided', async () => {
    await runPipeline();
    const pendingBefore = (await summary()).workflow_tasks.pending;
    const c = await createAndSubmitCase('alice.applicant', 'building-permit', {
      applicant_name: 'Alice Applicant', site_address: '3 KPI Lane', project_type: 'commercial', floor_area_m2: 300, declaration: true,
    });
    await waitFor(async () => ((await api('victor.validator', 'GET', `/api/workflow/tasks?subject_id=${c.id}`)) as any[]).length === 1);
    await waitFor(async () => {
      await runPipeline();
      return (await summary()).workflow_tasks.pending === pendingBefore + 1;
    }, { timeoutMs: 60_000, intervalMs: 1_000, what: 'the pending task to be counted' });

    await decide('victor.validator', c.id, 'validation', 'reject', 'KPI test');
    await waitFor(async () => {
      await runPipeline();
      return (await summary()).workflow_tasks.pending === pendingBefore;
    }, { timeoutMs: 60_000, intervalMs: 1_000, what: 'the pending count to return' });
  });

  it('every required KPI is served with its provenance', async () => {
    for (const [path, dataset] of [
      ['approval-turnaround', 'approval_turnaround'],
      ['pending-tasks', 'pending_tasks'],
      ['incidents-by-severity', 'incidents_by_severity'],
      ['sensor-availability', 'sensor_availability'],
      ['water-level-trend', 'water_level_trend'],
      ['asset-maintenance', 'asset_maintenance_status'],
    ]) {
      const kpi = await api('anna.analyst', 'GET', `/api/analytics/kpis/${path}`);
      assert.equal(kpi.dataset, dataset);
      assert.ok(Array.isArray(kpi.rows), path);
      assert.ok(kpi.freshness?.computed_at, `${path} states when it was computed`);
      assert.ok(kpi.freshness?.source_run_id, `${path} names the pipeline run that produced it`);
    }
  });

  it('the asset KPI matches the asset register (cross-check against the owning service)', async () => {
    await runPipeline();
    const [register, kpi] = await Promise.all([api('amy.assets', 'GET', '/api/asset/assets/summary'), api('anna.analyst', 'GET', '/api/analytics/kpis/asset-maintenance')]);
    const fromKpi = Object.fromEntries(
      [...new Set(kpi.rows.map((r: any) => r.status))].map((status) => [status, kpi.rows.filter((r: any) => r.status === status).reduce((n: number, r: any) => n + r.assets, 0)]),
    );
    const fromRegister = Object.fromEntries(register.by_status.map((r: any) => [r.status, r.count]));
    assert.deepEqual(fromKpi, fromRegister);
    assert.equal(kpi.rows.reduce((n: number, r: any) => n + r.maintenance_overdue, 0), register.maintenance.overdue);
  });

  it('the water-level trend matches the telemetry store for the same window', async (t) => {
    await runPipeline();
    const trend = await api('anna.analyst', 'GET', '/api/analytics/kpis/water-level-trend');
    assert.ok(trend.rows.length > 0, 'the simulator has been producing readings');
    // Pick a bucket that had fully elapsed when the dataset was computed, and recompute it from telemetry-service.
    const computedAt = new Date(trend.freshness.computed_at).getTime();
    const candidates = trend.rows.filter((r: any) => new Date(r.bucket).getTime() + 5 * 60_000 < computedAt - 30_000 && r.samples > 0);
    const row = candidates.at(-1);
    if (!row) {
      // Only on a stack that has been running for less than one full 5-minute bucket.
      t.skip('no completed 5-minute bucket yet: the stack was started less than about six minutes ago');
      return;
    }
    const from = new Date(row.bucket);
    const to = new Date(from.getTime() + 5 * 60_000);
    const raw = (await api('derek.duty', 'GET', `/api/telemetry/measurements?device_id=${row.device_id}&sensor_kind=water_level&from=${from.toISOString()}&to=${to.toISOString()}&limit=2000`)) as any[];
    const ok = raw.filter((m) => m.quality === 'ok');
    assert.equal(row.samples, ok.length, 'same number of readings');
    assert.equal(row.max_level, Math.max(...ok.map((m) => m.value)));
    assert.equal(row.min_level, Math.min(...ok.map((m) => m.value)));
    const mean = ok.reduce((n, m) => n + m.value, 0) / ok.length;
    assert.ok(Math.abs(row.avg_level - mean) < 0.001, `avg ${row.avg_level} vs recomputed ${mean}`);
  });
});

describe('analytics: tenant isolation and access control', () => {
  it('each tenant sees only its own figures', async () => {
    const [a, b] = await Promise.all([summary('anna.analyst'), summary('brian.admin')]);
    assert.ok(a.assets.total > 0 && b.assets.total > 0);
    assert.notDeepEqual(a.assets, b.assets);
    const devicesB = await api('brian.admin', 'GET', '/api/analytics/kpis/sensor-availability');
    assert.ok(devicesB.rows.every((r: any) => r.serial_no.startsWith('NF-')), 'tenant B sees only its own devices');
    const csv = await rawApi('brian.admin', 'GET', '/api/analytics/export/asset_maintenance_status?format=csv');
    assert.ok(!String(csv.body).includes(TENANT_A));
  });

  it('applicants cannot read KPIs; ordinary staff cannot export; users cannot call the internal refresh', async () => {
    assert.equal((await rawApi('alice.applicant', 'GET', '/api/analytics/kpis/summary')).status, 403);
    assert.equal((await rawApi('derek.duty', 'GET', '/api/analytics/export/incidents_by_severity')).status, 403);
    assert.equal((await rawApi('adam.admin', 'POST', '/api/analytics/internal/refresh', {})).status, 403);
    assert.equal((await rawApi('derek.duty', 'POST', '/api/pipeline/runs', {})).status, 403);
  });

  it('the internal refresh accepts a service identity, which in turn cannot read tenant data', async () => {
    const token = await serviceToken();
    const call = (method: string, path: string) => fetch(`${config.gatewayUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    const refresh = await call('POST', '/api/analytics/internal/refresh');
    assert.equal(refresh.status, 200);
    assert.equal((await refresh.json()).missing.length, 0);
    assert.equal((await call('GET', '/api/analytics/kpis/summary')).status, 403);
    assert.equal((await call('GET', '/api/case/cases')).status, 200, 'a service identity belongs to no tenant...');
    assert.deepEqual(await (await call('GET', '/api/case/cases')).json(), [], '...and therefore sees no tenant records');
  });
});

describe('analytics: exports and approved query templates', () => {
  it('exports a dataset as CSV and as Parquet', async () => {
    const csv = await rawApi('anna.analyst', 'GET', '/api/analytics/export/approval_turnaround?format=csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    const lines = String(csv.body).trim().split('\n');
    assert.match(lines[0]!, /^tenant_id,form_key,outcome,cases,avg_hours/);
    assert.equal(lines.length - 1, Number(csv.headers.get('x-total-count')));

    const res = await fetch(`${config.gatewayUrl}/api/analytics/export/approval_turnaround?format=parquet`, { headers: { authorization: `Bearer ${await tokenFor('anna.analyst')}` } });
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), 'PAR1', 'Parquet magic number');
    assert.equal(bytes.subarray(-4).toString(), 'PAR1');
    assert.equal((await rawApi('anna.analyst', 'GET', '/api/analytics/export/pg_shadow')).status, 404);
  });

  it('query templates validate their parameters and refuse anything not on the list', async () => {
    const list = await api('anna.analyst', 'GET', '/api/analytics/query-templates');
    assert.ok(list.some((t: any) => t.name === 'workflow_bottlenecks'));
    const ok = await api('anna.analyst', 'POST', '/api/analytics/query-templates/workflow_bottlenecks/run', { params: { limit: 3 } });
    assert.ok(ok.rows.length <= 3);
    assert.equal(ok.source.dataset, 'pending_tasks');

    const run = (name: string, params: unknown) => rawApi('anna.analyst', 'POST', `/api/analytics/query-templates/${name}/run`, { params });
    assert.equal((await run('workflow_bottlenecks', { limit: 100000 })).status, 400);
    assert.equal((await run('workflow_bottlenecks', { limit: '1; DROP TABLE kpi_pending_tasks' })).status, 400);
    assert.equal((await run('approval_turnaround_by_form', { outcome: "approved' OR '1'='1" })).status, 400);
    assert.equal((await run('workflow_bottlenecks', { limit: 3, sql: 'SELECT * FROM pg_user' })).status, 400, 'unknown parameters are refused');
    assert.equal((await run('select_everything', {})).status, 404);
  });

  it('the database role behind query templates is read-only and tenant-bound', async () => {
    const db = new pg.Client({
      host: '127.0.0.1', port: Number(config.env.POSTGRES_HOST_PORT ?? 5432), user: 'analytics_ro',
      password: `${config.env.DB_DEV_PASSWORD}_analytics_ro`, database: 'titan_analytics',
    });
    await db.connect();
    try {
      assert.equal(Number((await db.query('SELECT count(*) FROM kpi_asset_maintenance_status')).rows[0].count), 0, 'no tenant bound: no rows');
      await assert.rejects(db.query("INSERT INTO kpi_asset_maintenance_status VALUES ($1, 'active', 'good', 1, 0, 0)", [TENANT_A]), /read-only|permission denied/);
      await assert.rejects(db.query('DELETE FROM kpi_asset_maintenance_status'), /read-only|permission denied/);
      await assert.rejects(db.query('CREATE TABLE x (a int)'), /read-only|permission denied/);
      // Even after turning the session writable, the role has no write privilege.
      await db.query('SET default_transaction_read_only = off');
      await assert.rejects(db.query('DELETE FROM kpi_asset_maintenance_status'), /permission denied/);
      await assert.rejects(db.query("SELECT analytics_load('pending_tasks', '[]'::jsonb, NULL, now())"), /permission denied/);
    } finally {
      await db.end();
    }
  });
});

describe('data pipeline: history, idempotency, failure tracking, lineage', () => {
  it('records each run with its watermark range, and runs are contiguous', async () => {
    const first = await runPipeline();
    const second = await runPipeline();
    assert.equal(first.status, 'succeeded');
    assert.equal(second.status, 'succeeded');
    assert.equal(first.trigger, 'manual');
    assert.equal(first.triggered_by, 'anna.analyst');
    assert.ok(second.watermark_from >= first.watermark_to, 'no event is processed by two successful runs');
    assert.equal(first.watermark_to - first.watermark_from >= first.events_read, true);
    const history = await api('anna.analyst', 'GET', '/api/pipeline/runs?limit=5');
    assert.ok(history.some((r: any) => r.id === second.id));
  });

  it('re-running without relevant new events leaves the entity KPIs unchanged (idempotent)', async () => {
    await runPipeline();
    const a = await api('anna.analyst', 'GET', '/api/analytics/kpis/approval-turnaround');
    const assetsA = await api('anna.analyst', 'GET', '/api/analytics/kpis/asset-maintenance');
    await runPipeline();
    await runPipeline();
    const b = await api('anna.analyst', 'GET', '/api/analytics/kpis/approval-turnaround');
    const assetsB = await api('anna.analyst', 'GET', '/api/analytics/kpis/asset-maintenance');
    assert.deepEqual(b.rows, a.rows);
    assert.deepEqual(assetsB.rows, assetsA.rows);
  });

  it('a failed run is recorded, does not advance the watermark, and can be retried', async () => {
    const failed = await runPipeline({ simulate_failure: true });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /SimulatedFailure/);
    assert.equal(failed.watermark_to, null);
    assert.ok(failed.finished_at);
    const status = await api('anna.analyst', 'GET', '/api/pipeline/status');
    assert.ok(status.watermark <= failed.watermark_from || status.last_run.id !== failed.id, 'the failed run did not move the watermark');

    const retried = await runPipeline({}, `/api/pipeline/runs/${failed.id}/retry`);
    assert.equal(retried.status, 'succeeded');
    assert.equal(retried.trigger, 'retry');
    assert.equal(retried.retry_of, failed.id);
    assert.equal(retried.attempt, 2);
    assert.ok(retried.watermark_from <= failed.watermark_from + retried.events_read + 100_000);

    // Only failed runs are retryable.
    const again = await rawApi('anna.analyst', 'POST', `/api/pipeline/runs/${retried.id}/retry`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'not_retryable');
  });

  it('each run stores data-quality results and lineage', async () => {
    const run = await runPipeline();
    const detail = await api('anna.analyst', 'GET', `/api/pipeline/runs/${run.id}`);
    const rules = detail.quality.map((q: any) => `${q.dataset}.${q.rule}`);
    for (const expected of ['measurements.value_is_finite', 'cases.completed_not_before_submitted', 'workflow_tasks.primary_key_unique', 'bronze_events.event_maps_to_schema']) {
      assert.ok(rules.includes(expected), `missing quality rule ${expected}`);
    }
    assert.ok(detail.quality.every((q: any) => typeof q.passed === 'boolean' && q.failed_rows <= q.total_rows));
    const edges = detail.lineage.map((e: any) => `${e.source_dataset}->${e.target_dataset}`);
    assert.ok(edges.includes('bronze_events->cases'));
    assert.ok(edges.includes('cases->gold.approval_turnaround'));
    assert.ok(edges.includes('measurements->gold.water_level_trend'));
    assert.ok(edges.includes('devices->gold.sensor_availability'));
  });

  it('the catalog lists every layer with an owner, and lineage can be queried per dataset', async () => {
    const catalog = await api('anna.analyst', 'GET', '/api/pipeline/datasets');
    assert.deepEqual([...new Set(catalog.map((d: any) => d.layer))], ['bronze', 'silver', 'gold']);
    assert.ok(catalog.every((d: any) => d.owner && d.steward && d.location && d.description));
    assert.equal(catalog.find((d: any) => d.name === 'incidents').owner, 'incident-service');
    const lineage = await api('anna.analyst', 'GET', '/api/pipeline/lineage?dataset=gold.sensor_availability');
    assert.deepEqual(lineage.edges.map((e: any) => e.source_dataset).sort(), ['devices', 'measurements']);
  });

  it('a new entity reaches the analytical layer incrementally', async () => {
    const code = unique('KPI-');
    await api('amy.assets', 'POST', '/api/asset/assets', { code, name: 'Incremental ingestion asset', category_code: 'DRAINAGE', status: 'active' });
    const before_ = (await summary()).assets.total;
    await waitFor(async () => {
      const run = await runPipeline();
      return run.events_read > 0 && (await summary()).assets.total === before_ + 1;
    }, { timeoutMs: 60_000, intervalMs: 1_000, what: 'the new asset to be counted' });
  });
});
