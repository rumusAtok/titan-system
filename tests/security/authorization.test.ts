// Security tests: unauthenticated access, privilege escalation, duplicate and
// concurrent decisions, invalid state transitions, input handling.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { api, caseStatus, closeConnections, config, createAndSubmitCase, decide, pendingTask, PERMIT_DATA, rawApi, tokenFor, unique } from '../helpers/stack.ts';

after(closeConnections);

const PROTECTED = [
  ['GET', '/api/tenant/tenants/current'],
  ['GET', '/api/case/cases'],
  ['GET', '/api/workflow/tasks'],
  ['GET', '/api/notification/notifications'],
  ['GET', '/api/audit/audit'],
  ['GET', '/api/asset/assets'],
  ['GET', '/api/device/devices'],
  ['GET', '/api/telemetry/latest'],
  ['GET', '/api/alert/alerts'],
  ['GET', '/api/incident/incidents'],
  ['GET', '/api/platform/health'],
  ['GET', '/api/stream/events'],
] as const;

async function withToken(token: string, method: string, path: string) {
  return fetch(`${config.gatewayUrl}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
}

describe('unauthenticated access', () => {
  it('every API route refuses a request without a token', async () => {
    for (const [method, path] of PROTECTED) assert.equal((await rawApi(null, method, path)).status, 401, `${method} ${path}`);
  });

  it('garbage, unsigned and tampered tokens are refused', async () => {
    const real = await tokenFor('alice.applicant');
    const [h, p, s] = real.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forgeries = {
      garbage: 'not.a.token',
      'unsigned (alg none)': `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`,
      'role injected into payload': `${h}.${b64({ ...claims, realm_access: { roles: ['tenant_admin', 'platform_admin'] } })}.${s}`,
      'tenant swapped in payload': `${h}.${b64({ ...claims, tenant_id: '22222222-2222-4222-8222-222222222222' })}.${s}`,
      'signature stripped': `${h}.${p}.`,
    };
    for (const [name, token] of Object.entries(forgeries)) {
      assert.equal((await withToken(token, 'GET', '/api/case/cases')).status, 401, name);
      assert.equal((await withToken(token, 'GET', '/api/platform/health')).status, 401, `${name} (gateway route)`);
    }
  });

  it('health and metrics of services are not reachable through the public API', async () => {
    const token = await tokenFor('adam.admin');
    // Not routed at all, even for an authenticated administrator.
    assert.equal((await withToken(token, 'GET', '/api/case/metrics')).status, 404);
    assert.equal((await withToken(token, 'GET', '/api/workflow/health/ready')).status, 404);
    assert.equal((await withToken(token, 'GET', '/api/audit/health/live')).status, 404);
  });

  it('error responses do not leak internals', async () => {
    const res = await rawApi('adam.admin', 'GET', "/api/asset/assets/not-a-uuid'--");
    assert.equal(res.status, 400);
    const text = JSON.stringify(res.body);
    assert.ok(!/select|postgres|stack|at .*\.js/i.test(text), text);
    assert.ok(res.body.error.correlation_id);
  });
});

describe('privilege escalation', () => {
  it('an applicant cannot use staff or administration functions', async () => {
    const attempts: Array<[string, string, unknown?]> = [
      ['POST', '/api/workflow/definitions', { key: 'evil', name: 'Evil', subject_type: 'case', definition: { stages: [{ key: 'a', name: 'A', roles: ['applicant'] }] } }],
      ['POST', '/api/case/forms', { key: 'evil', title: 'Evil', workflow_key: 'x', fields: [{ name: 'a', label: 'A', type: 'text' }] }],
      ['GET', '/api/workflow/tasks'],
      ['GET', '/api/workflow/definitions'],
      ['POST', '/api/tenant/departments', { code: 'EVIL', name: 'Evil' }],
      ['PUT', '/api/tenant/tenants/current/config', { settings: {}, expected_version: 1 }],
      ['GET', '/api/tenant/memberships'],
      ['GET', '/api/audit/audit'],
      ['GET', '/api/notification/deliveries'],
      ['POST', '/api/asset/assets', { code: 'X1', name: 'X1', category_code: 'PUMP_STATION' }],
      ['GET', '/api/asset/assets'],
      ['POST', '/api/device/devices', { serial_no: 'EVIL', name: 'Evil', device_type: 'x', sensors: [{ kind: 'water_level', unit: 'm' }] }],
      ['POST', '/api/alert/rules', { name: 'Evil', sensor_kind: 'water_level', operator: 'gt', threshold: 0, severity: 'critical' }],
      ['GET', '/api/incident/incidents'],
      ['POST', '/api/incident/incidents', { title: 'Fake incident', severity: 'critical' }],
      ['GET', '/api/platform/health'],
    ];
    for (const [method, path, body] of attempts) assert.equal((await rawApi('alice.applicant', method, path, body)).status, 403, `${method} ${path}`);
  });

  it('a tenant administrator cannot use platform-level functions', async () => {
    assert.equal((await rawApi('adam.admin', 'GET', '/api/tenant/tenants')).status, 403);
    assert.equal((await rawApi('adam.admin', 'POST', '/api/tenant/tenants', { slug: 'rogue-tenant', name: 'Rogue' })).status, 403);
  });

  it('staff roles are limited to their own function', async () => {
    assert.equal((await rawApi('victor.validator', 'POST', '/api/asset/assets', { code: 'X2', name: 'X2', category_code: 'PUMP_STATION' })).status, 403);
    assert.equal((await rawApi('amy.assets', 'POST', '/api/alert/rules', { name: 'x', sensor_kind: 'water_level', operator: 'gt', threshold: 1, severity: 'info' })).status, 403);
    assert.equal((await rawApi('anna.analyst', 'POST', '/api/incident/incidents', { title: 'Fake incident', severity: 'info' })).status, 403);
    assert.equal((await rawApi('derek.duty', 'POST', '/api/workflow/definitions', { key: 'x', name: 'x', subject_type: 'case', definition: { stages: [] } })).status, 403);
  });

  it('an applicant asking for everybody’s cases still gets only their own', async () => {
    await createAndSubmitCase('aaron.applicant', 'building-permit', PERMIT_DATA);
    const all = (await api('alice.applicant', 'GET', '/api/case/cases?scope=all&limit=200')) as any[];
    assert.ok(all.length > 0);
    assert.ok(all.every((c) => c.applicant_username === 'alice.applicant'));
  });

  it('an applicant cannot read or change another applicant’s case in the same tenant', async () => {
    const mine = await api('aaron.applicant', 'POST', '/api/case/cases', { form_key: 'building-permit', title: `Aaron private draft ${unique()}`, data: {} });
    assert.equal((await rawApi('alice.applicant', 'GET', `/api/case/cases/${mine.id}`)).status, 404);
    assert.equal((await rawApi('alice.applicant', 'PATCH', `/api/case/cases/${mine.id}`, { title: 'taken over', expected_version: 1 })).status, 404);
    assert.equal((await rawApi('alice.applicant', 'POST', `/api/case/cases/${mine.id}/submit`)).status, 404);
    assert.equal((await rawApi('alice.applicant', 'POST', `/api/case/cases/${mine.id}/cancel`)).status, 404);
    // A reviewer may read cases but not edit them on the applicant's behalf, and never sees private drafts in lists.
    assert.equal((await rawApi('victor.validator', 'PATCH', `/api/case/cases/${mine.id}`, { title: 'edited by staff', expected_version: 1 })).status, 403);
    assert.ok(!((await api('victor.validator', 'GET', '/api/case/cases?scope=all&limit=200')) as any[]).some((c) => c.id === mine.id));
  });

  it('nobody can decide on their own application (separation of duties)', async () => {
    // A validation officer files an application themselves...
    const own = await createAndSubmitCase('victor.validator', 'building-permit', PERMIT_DATA, `Officer's own application ${unique()}`);
    const task = await pendingTask('victor.validator', own.id, 'validation');
    // ...and holds exactly the role that would normally approve it.
    const res = await rawApi('victor.validator', 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /own application/);
  });
});

describe('duplicate and concurrent decisions', () => {
  it('a task can be decided once: a second decision is refused', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'building-permit', PERMIT_DATA);
    const task = await pendingTask('victor.validator', c.id, 'validation');
    const path = `/api/workflow/tasks/${task.id}/decision`;
    assert.equal((await rawApi('victor.validator', 'POST', path, { decision: 'approve' })).status, 200);
    const again = await rawApi('victor.validator', 'POST', path, { decision: 'approve' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'task_already_decided');
    // Changing one's mind afterwards is refused too.
    assert.equal((await rawApi('victor.validator', 'POST', path, { decision: 'reject', comment: 'changed my mind' })).status, 409);
    const instance = await api('victor.validator', 'GET', `/api/workflow/instances/by-subject/case/${c.id}`);
    assert.equal(instance.decisions.length, 1);
    assert.equal(instance.tasks.filter((t: any) => t.stage_key === 'technical_review').length, 1, 'the next stage was created once');
  });

  it('ten simultaneous decisions on the same task produce exactly one decision', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'building-permit', PERMIT_DATA);
    const task = await pendingTask('victor.validator', c.id, 'validation');
    const path = `/api/workflow/tasks/${task.id}/decision`;
    await tokenFor('victor.validator');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => rawApi('victor.validator', 'POST', path, { decision: i % 2 ? 'approve' : 'reject', comment: `racer ${i}` })));
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one winner, got ${statuses}`);
    assert.equal(statuses.filter((s) => s === 409).length, 9);
    const instance = await api('victor.validator', 'GET', `/api/workflow/instances/by-subject/case/${c.id}`);
    assert.equal(instance.decisions.length, 1);
    // The process state is consistent with the single recorded decision.
    const winner = instance.decisions[0].decision;
    assert.equal(instance.status, winner === 'approve' ? 'running' : 'rejected');
  });

  it('a retried request with the same Idempotency-Key reports the original result and changes nothing', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'building-permit', PERMIT_DATA);
    const task = await pendingTask('victor.validator', c.id, 'validation');
    const path = `/api/workflow/tasks/${task.id}/decision`;
    const key = `retry-${unique()}`;
    const first = await rawApi('victor.validator', 'POST', path, { decision: 'approve' }, { 'idempotency-key': key });
    const retry = await rawApi('victor.validator', 'POST', path, { decision: 'approve' }, { 'idempotency-key': key });
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.decision_id, first.body.decision_id);
    // The same key cannot be used to slip in a different decision.
    assert.equal((await rawApi('victor.validator', 'POST', path, { decision: 'reject', comment: 'x' }, { 'idempotency-key': key })).status, 409);
    assert.equal((await api('victor.validator', 'GET', `/api/workflow/instances/by-subject/case/${c.id}`)).decisions.length, 1);
  });
});

describe('invalid state transitions', () => {
  it('a submitted case cannot be edited or submitted again', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'building-permit', PERMIT_DATA);
    assert.equal((await rawApi('alice.applicant', 'POST', `/api/case/cases/${c.id}/submit`)).status, 409);
    assert.equal((await rawApi('alice.applicant', 'PATCH', `/api/case/cases/${c.id}`, { title: 'Changed after submission', expected_version: 2 })).status, 409);
    assert.equal((await rawApi('alice.applicant', 'POST', `/api/case/cases/${c.id}/attachments`, { filename: 'late.txt', content_type: 'text/plain', content_base64: 'aGk=' })).status, 409);
  });

  it('a decided case is final: it cannot be cancelled, and no task remains to decide', async () => {
    const c = await createAndSubmitCase('alice.applicant', 'building-permit', PERMIT_DATA);
    const task = await pendingTask('victor.validator', c.id, 'validation');
    await api('victor.validator', 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'reject', comment: 'Incomplete' });
    await caseStatus('alice.applicant', c.id, 'rejected');
    assert.equal((await rawApi('alice.applicant', 'POST', `/api/case/cases/${c.id}/cancel`)).status, 409);
    assert.equal((await rawApi('alice.applicant', 'POST', `/api/case/cases/${c.id}/submit`)).status, 409);
    assert.equal((await rawApi('victor.validator', 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' })).status, 409);
  });

  it('a stale edit is refused (optimistic concurrency)', async () => {
    const draft = await api('alice.applicant', 'POST', '/api/case/cases', { form_key: 'building-permit', title: `Concurrent edit ${unique()}`, data: {} });
    await api('alice.applicant', 'PATCH', `/api/case/cases/${draft.id}`, { title: 'First edit wins', expected_version: draft.version });
    const stale = await rawApi('alice.applicant', 'PATCH', `/api/case/cases/${draft.id}`, { title: 'Second edit loses', expected_version: draft.version });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'stale_version');
  });

  it('asset lifecycle rules are enforced', async () => {
    const asset = await api('amy.assets', 'POST', '/api/asset/assets', { code: unique('LIFE-'), name: 'Lifecycle asset', category_code: 'FLOOD_GATE' });
    assert.equal((await rawApi('amy.assets', 'POST', `/api/asset/assets/${asset.id}/status`, { status: 'under_maintenance' })).status, 409, 'planned -> under_maintenance');
    await api('amy.assets', 'POST', `/api/asset/assets/${asset.id}/status`, { status: 'active' });
    await api('amy.assets', 'POST', `/api/asset/assets/${asset.id}/status`, { status: 'retired' });
    assert.equal((await rawApi('amy.assets', 'POST', `/api/asset/assets/${asset.id}/status`, { status: 'active' })).status, 409, 'retired is terminal');
    assert.equal((await rawApi('amy.assets', 'POST', `/api/asset/assets/${asset.id}/maintenance`, { condition: 'good' })).status, 409);
  });
});

describe('input handling', () => {
  it('unknown form fields and wrong types are rejected rather than stored', async () => {
    const res = await rawApi('alice.applicant', 'POST', '/api/case/cases', { form_key: 'building-permit', title: 'Mass assignment attempt', data: { status: 'approved', floor_area_m2: 'huge' } });
    assert.equal(res.status, 400);
  });

  it('server-controlled fields in the request body are ignored', async () => {
    const draft = await api('alice.applicant', 'POST', '/api/case/cases', {
      form_key: 'building-permit',
      title: `Field injection ${unique()}`,
      data: {},
      status: 'approved',
      applicant_id: 'someone-else',
      reference_no: 'APP-0000-000001',
    });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.applicant_username, 'alice.applicant');
    assert.notEqual(draft.reference_no, 'APP-0000-000001');
  });

  it('dangerous uploads are refused', async () => {
    const draft = await api('alice.applicant', 'POST', '/api/case/cases', { form_key: 'building-permit', title: `Upload checks ${unique()}`, data: {} });
    const upload = (filename: string, content_type: string, bytes: Buffer) =>
      rawApi('alice.applicant', 'POST', `/api/case/cases/${draft.id}/attachments`, { filename, content_type, content_base64: bytes.toString('base64') });
    assert.equal((await upload('page.html', 'text/html', Buffer.from('<script>alert(1)</script>'))).status, 400);
    assert.equal((await upload('tool.exe', 'application/x-msdownload', Buffer.from('MZ'))).status, 400);
    assert.equal((await upload('fake.pdf', 'application/pdf', Buffer.from('MZ not a pdf'))).status, 400, 'content must match the declared type');
    const ok = await upload('..\\..\\windows\\plan.pdf', 'application/pdf', Buffer.from('%PDF-1.7 synthetic'));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.filename, 'plan.pdf');

    const res = await fetch(`${config.gatewayUrl}/api/case/cases/${draft.id}/attachments/${ok.body.id}/download`, { headers: { authorization: `Bearer ${await tokenFor('alice.applicant')}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '%PDF-1.7 synthetic');
    // Another applicant cannot download it.
    assert.equal((await rawApi('aaron.applicant', 'GET', `/api/case/cases/${draft.id}/attachments/${ok.body.id}/download`)).status, 404);
  });

  it('SQL metacharacters in search input are treated as data', async () => {
    const res = await rawApi('alice.applicant', 'GET', `/api/case/cases?q=${encodeURIComponent("%' OR '1'='1")}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });
});
