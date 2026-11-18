// Switchable capabilities added after v3, on the real stack (tenant Riverbend):
//   integrations: signed inbound webhook -> external incident; outbound subscription -> signed delivery
//                 to the LOCAL test receiver (webhook-sink container; nothing leaves the machine)
//   reporting:    definition over registered datasets -> generated with the caller's access -> CSV / HTML
//   video:        camera register, audited viewing sessions, recordings, incident markers
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { api, closeConnections, config, rawApi, tokenFor, unique, waitFor, waitForAccess } from '../helpers/stack.ts';

const ADMIN = 'adam.admin';
const DUTY = 'derek.duty';
const SINK = `http://127.0.0.1:${process.env.WEBHOOK_SINK_HOST_PORT ?? 8099}`;

const sign = (secret: string, ts: number | string, body: string) => `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

async function hook(endpointId: string, secret: string, payload: unknown, opts: { eventId?: string; ts?: number; signature?: string } = {}) {
  const body = JSON.stringify(payload);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  // No bearer token: external systems authenticate with the signature.
  const res = await fetch(`${config.gatewayUrl}/hooks/${endpointId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-titan-timestamp': String(ts), 'x-titan-event-id': opts.eventId ?? randomUUID(), 'x-titan-signature': opts.signature ?? sign(secret, ts, body) },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

after(closeConnections);

describe('Integration hub: inbound webhooks', () => {
  let endpoint: any;

  before(async () => {
    await waitForAccess(ADMIN, '/api/integration/endpoints', 200, 'the integrations capability to be active for Riverbend');
    endpoint = await api(ADMIN, 'POST', '/api/integration/endpoints', { name: `Test sender ${unique()}`, default_severity: 'warning' });
    assert.match(endpoint.secret, /^whsec_/);
    assert.equal(endpoint.path, `/hooks/${endpoint.id}`);
  });

  it('only the tenant administrator manages endpoints; the secret is never listed', async () => {
    assert.equal((await rawApi(DUTY, 'POST', '/api/integration/endpoints', { name: `No ${unique()}` })).status, 403);
    const listed = (await api('oscar.auditor', 'GET', '/api/integration/endpoints')).find((e: any) => e.id === endpoint.id);
    assert.ok(listed);
    assert.ok(!JSON.stringify(listed).includes(endpoint.secret));
  });

  it('a signed report becomes an external incident, once, however often it is repeated', async () => {
    const title = `External report ${unique()}`;
    const eventId = randomUUID();
    const first = await hook(endpoint.id, endpoint.secret, { title, description: 'Reported by a test system', severity: 'critical', external_id: 'EXT-42' }, { eventId });
    assert.equal(first.status, 202);
    const again = await hook(endpoint.id, endpoint.secret, { title, severity: 'critical', external_id: 'EXT-42' }, { eventId });
    assert.equal(again.status, 200);
    assert.equal(again.body.status, 'duplicate');
    const incident = await waitFor(async () => (await api(DUTY, 'GET', '/api/incident/incidents?limit=200')).find((i: any) => i.title === title) ?? null, { what: 'the external incident' });
    assert.equal(incident.source_type, 'external');
    assert.equal(incident.severity, 'critical');
    // A new event id with the same external reference is still the same incident.
    await hook(endpoint.id, endpoint.secret, { title, severity: 'critical', external_id: 'EXT-42' });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await api(DUTY, 'GET', '/api/incident/incidents?limit=200')).filter((i: any) => i.title === title).length, 1);
  });

  it('refuses a wrong signature, an old timestamp and an unknown endpoint, and records the refusals', async () => {
    assert.equal((await hook(endpoint.id, 'whsec_wrong', { title: 'Forged report' })).status, 401);
    assert.equal((await hook(endpoint.id, endpoint.secret, { title: 'Replayed report' }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
    assert.equal((await hook(randomUUID(), endpoint.secret, { title: 'Nowhere' })).status, 404);
    assert.equal((await hook(endpoint.id, endpoint.secret, { nope: true })).status, 400);
    const messages = await api(ADMIN, 'GET', `/api/integration/endpoints/${endpoint.id}/messages`);
    assert.ok(messages.filter((m: any) => m.status === 'rejected').length >= 3);
    assert.ok(messages.some((m: any) => m.reason === 'timestamp outside the accepted window'));
  });

  it('a rotated secret replaces the old one; a deactivated endpoint does not exist from outside', async () => {
    const rotated = await api(ADMIN, 'POST', `/api/integration/endpoints/${endpoint.id}/rotate-secret`);
    assert.equal((await hook(endpoint.id, endpoint.secret, { title: 'Old secret' })).status, 401);
    assert.equal((await hook(endpoint.id, rotated.secret, { title: `New secret ${unique()}` })).status, 202);
    await api(ADMIN, 'PATCH', `/api/integration/endpoints/${endpoint.id}`, { active: false });
    assert.equal((await hook(endpoint.id, rotated.secret, { title: 'Inactive' })).status, 404);
  });

  it('another tenant cannot see the endpoint', async () => {
    assert.equal((await rawApi('maya.admin', 'GET', `/api/integration/endpoints/${endpoint.id}/messages`)).status, 404);
  });
});

describe('Integration hub: outbound subscriptions', () => {
  it('destinations outside the allow-list are refused', async () => {
    const res = await rawApi(ADMIN, 'POST', '/api/integration/subscriptions', { name: `Evil ${unique()}`, target_url: 'https://collector.example.test/in', event_types: ['incident.created.v1'] });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /allow-list/);
  });

  it('a subscribed event is delivered, signed, to the local test receiver', async () => {
    const path = `/test-${unique().toLowerCase()}`;
    const sub = await api(ADMIN, 'POST', '/api/integration/subscriptions', { name: `Sink ${unique()}`, target_url: `http://webhook-sink:8080${path}`, event_types: ['incident.created.v1'] });
    const title = `Delivered incident ${unique()}`;
    await api(DUTY, 'POST', '/api/incident/incidents', { title, severity: 'info' });
    const received = await waitFor(
      async () => ((await (await fetch(`${SINK}/requests`)).json()) as any[]).find((r) => r.path === path && JSON.parse(r.body).data.title === title) ?? null,
      { what: 'the webhook to reach the test receiver' },
    );
    assert.equal(received.headers['x-titan-event-type'], 'incident.created.v1');
    assert.equal(received.headers['x-titan-signature'], sign(sub.secret, received.headers['x-titan-timestamp'], received.body), 'the signature verifies with the subscription secret');
    const deliveries = await waitFor(async () => {
      const d = await api(ADMIN, 'GET', `/api/integration/subscriptions/${sub.id}/deliveries`);
      return d.some((x: any) => x.status === 'delivered') ? d : null;
    }, { what: 'the delivery to be recorded' });
    assert.equal(deliveries[0].last_status_code, 204);
  });

  it('a destination that refuses the event fails the delivery, which can be retried', async () => {
    const sub = await api(ADMIN, 'POST', '/api/integration/subscriptions', { name: `Refusing ${unique()}`, target_url: 'http://webhook-sink:8080/status/400/refuse', event_types: ['incident.created.v1'] });
    await api(DUTY, 'POST', '/api/incident/incidents', { title: `Refused ${unique()}`, severity: 'info' });
    const failed = await waitFor(async () => (await api(ADMIN, 'GET', `/api/integration/subscriptions/${sub.id}/deliveries`)).find((d: any) => d.status === 'failed') ?? null, {
      what: 'the delivery to fail',
    });
    assert.equal(failed.last_status_code, 400);
    assert.equal(failed.attempts, 1, 'a 400 is final: not retried automatically');
    const retried = await api(ADMIN, 'POST', `/api/integration/deliveries/${failed.id}/retry`);
    assert.equal(retried.status, 'pending');
    await api(ADMIN, 'PATCH', `/api/integration/subscriptions/${sub.id}`, { active: false, expected_version: 1 });
  });
});

describe('Operational reporting', () => {
  let definition: any;

  before(async () => {
    await waitForAccess('anna.analyst', '/api/report/definitions', 200, 'the reporting capability to be active for Riverbend');
  });

  it('offers the analytics datasets, and accepts only those the tenant may read, with declared filters', async () => {
    const datasets = await api('anna.analyst', 'GET', '/api/report/datasets');
    assert.ok(datasets.find((d: any) => d.name === 'incidents_by_severity').available);
    const base = { name: `Bad ${unique()}`, sections: [{ title: 'S', dataset: 'no_such_dataset' }] };
    assert.equal((await rawApi('anna.analyst', 'POST', '/api/report/definitions', base)).status, 400);
    assert.equal((await rawApi('anna.analyst', 'POST', '/api/report/definitions', { ...base, sections: [{ title: 'S', dataset: 'maintenance_requests' }] })).status, 400, 'Riverbend has no maintenance capability');
    assert.equal((await rawApi('anna.analyst', 'POST', '/api/report/definitions', { ...base, sections: [{ title: 'S', dataset: 'incidents_by_severity', filters: { not_a_column: 'x' } }] })).status, 400);
    assert.equal((await rawApi(DUTY, 'POST', '/api/report/definitions', { ...base, sections: [{ title: 'S', dataset: 'incidents_by_severity' }] })).status, 403, 'a duty officer does not define reports');
  });

  it('generates a report with the reader\'s own access, as CSV and as printable HTML', async () => {
    definition = await api('anna.analyst', 'POST', '/api/report/definitions', {
      name: `Test report ${unique()}`,
      description: 'Integration test <b>bold</b>',
      sections: [{ title: 'Incidents', dataset: 'incidents_by_severity' }, { title: 'Waiting work', dataset: 'pending_tasks', filters: { subject_type: 'incident' } }],
      schedule: 'weekly',
    });
    assert.ok(definition.next_due_at, 'a weekly report has a due date');
    const run = await api(DUTY, 'POST', `/api/report/definitions/${definition.id}/generate`);
    assert.equal(run.status, 'completed');
    assert.deepEqual(run.sections.map((s: any) => s.dataset), ['incidents_by_severity', 'pending_tasks']);
    const csv = await fetch(`${config.gatewayUrl}/api/report/runs/${run.id}/csv?section=0`, { headers: { authorization: `Bearer ${await tokenFor(DUTY)}` } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition') ?? '', /^attachment; filename=".+\.csv"$/);
    assert.match((await csv.text()).split('\r\n')[0]!, /severity/);
    const html = await fetch(`${config.gatewayUrl}/api/report/runs/${run.id}/html`, { headers: { authorization: `Bearer ${await tokenFor(DUTY)}` } });
    assert.match(html.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    const page = await html.text();
    assert.ok(page.includes('Integration test &lt;b&gt;bold&lt;/b&gt;'), 'text from the definition is escaped');
    assert.ok(!page.includes('<script'));
  });

  it('runs and definitions are the tenant\'s own; a tenant without the capability is refused', async () => {
    const runs = await api('anna.analyst', 'GET', '/api/report/runs');
    assert.equal((await rawApi('maya.admin', 'GET', `/api/report/runs/${runs[0].id}`)).status, 404);
    assert.equal((await rawApi('brian.admin', 'GET', '/api/report/definitions')).status, 403);
  });
});

describe('Video monitoring', () => {
  let camera: any;

  before(async () => {
    await waitForAccess(ADMIN, '/api/video/cameras', 200, 'the video capability to be active for Riverbend');
    camera = await api('sara.security', 'POST', '/api/video/cameras', { code: `TCAM-${unique()}`.slice(0, 30), name: 'Test camera', stream_url: 'rtsp://vms.riverbend.example.test/test' });
  });

  it('refuses stream URLs with embedded credentials', async () => {
    const res = await rawApi('sara.security', 'POST', '/api/video/cameras', { code: `TCAM-${unique()}`.slice(0, 30), name: 'Leaky', stream_url: 'rtsp://admin:admin@10.0.0.5/live' });
    assert.equal(res.status, 400);
  });

  it('the register never lists stream URLs; viewing needs a stated purpose, an online camera and a viewer role, and is logged', async () => {
    const listed = (await api(DUTY, 'GET', '/api/video/cameras')).find((c: any) => c.id === camera.id);
    assert.equal(listed.stream_url, undefined);
    assert.equal(listed.has_stream, true);
    assert.equal((await rawApi(DUTY, 'POST', `/api/video/cameras/${camera.id}/sessions`, { purpose: 'Check the river level' })).status, 409, 'the camera is not online yet');
    await api('sara.security', 'POST', `/api/video/cameras/${camera.id}/status`, { status: 'online' });
    assert.equal((await rawApi(DUTY, 'POST', `/api/video/cameras/${camera.id}/sessions`, { purpose: 'x' })).status, 400, 'a purpose is required');
    assert.equal((await rawApi('anna.analyst', 'POST', `/api/video/cameras/${camera.id}/sessions`, { purpose: 'Just curious about it' })).status, 403);
    const session = await api(DUTY, 'POST', `/api/video/cameras/${camera.id}/sessions`, { purpose: 'Check the river level at the gate' });
    assert.equal(session.stream_url, 'rtsp://vms.riverbend.example.test/test');
    await api(DUTY, 'POST', `/api/video/sessions/${session.session_id}/end`);
    assert.equal((await rawApi(DUTY, 'GET', '/api/video/sessions')).status, 403, 'the viewing log is for security and audit');
    const log = await api('oscar.auditor', 'GET', '/api/video/sessions');
    const entry = log.find((s: any) => s.id === session.session_id);
    assert.equal(entry.viewer_username, DUTY);
    assert.ok(entry.ended_at);
  });

  it('a marker on an incident is recorded on the incident timeline', async () => {
    const incident = await api(DUTY, 'POST', '/api/incident/incidents', { title: `Camera-observed debris ${unique()}`, severity: 'warning' });
    assert.equal((await rawApi('sara.security', 'POST', `/api/video/cameras/${camera.id}/markers`, { at: new Date().toISOString(), label: 'Debris', incident_id: randomUUID() })).status, 400, 'unknown incident');
    const marker = await waitFor(async () => {
      const res = await rawApi('sara.security', 'POST', `/api/video/cameras/${camera.id}/markers`, { at: new Date().toISOString(), label: 'Debris at the gate', incident_id: incident.id });
      return res.status === 201 ? res.body : null;
    }, { what: 'video-service to know the incident' });
    assert.equal(marker.incident_id, incident.id);
    await waitFor(async () => (await api(DUTY, 'GET', `/api/incident/incidents/${incident.id}`)).timeline.some((t: any) => t.entry_type === 'video' && t.message.includes('Debris at the gate')), {
      what: 'the incident timeline to show the marker',
    });
  });

  it('recordings: no future segments; markers must fall inside their recording; a decommissioned camera stays so', async () => {
    const future = await rawApi('sara.security', 'POST', `/api/video/cameras/${camera.id}/recordings`, { started_at: new Date().toISOString(), ended_at: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(future.status, 400);
    const rec = await api('sara.security', 'POST', `/api/video/cameras/${camera.id}/recordings`, { started_at: new Date(Date.now() - 7_200_000).toISOString(), ended_at: new Date(Date.now() - 3_600_000).toISOString(), storage_ref: 'vms://test/1' });
    const outside = await rawApi('sara.security', 'POST', `/api/video/cameras/${camera.id}/markers`, { at: new Date().toISOString(), label: 'Outside', recording_id: rec.id });
    assert.equal(outside.status, 400);
    const held = await api('sara.security', 'POST', `/api/video/recordings/${rec.id}/legal-hold`, { legal_hold: true });
    assert.equal(held.legal_hold, true);
    await api('sara.security', 'POST', `/api/video/cameras/${camera.id}/status`, { status: 'decommissioned' });
    assert.equal((await rawApi('sara.security', 'POST', `/api/video/cameras/${camera.id}/status`, { status: 'online' })).status, 409);
  });

  it('cameras are the tenant\'s own; a tenant without the capability is refused', async () => {
    assert.equal((await rawApi('maya.admin', 'GET', `/api/video/cameras/${camera.id}`)).status, 404);
    assert.equal((await rawApi('brian.admin', 'GET', '/api/video/cameras')).status, 403);
  });
});
