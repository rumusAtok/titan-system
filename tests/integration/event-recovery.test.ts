// Test D - Event recovery.
// Interrupts real containers and the real broker, then verifies that events
// are recovered and that redelivery never duplicates a business operation.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  api,
  closeConnections,
  envelopeFromAudit,
  publishRawEvent,
  publishTelemetry,
  rawApi,
  registerTestDevice,
  sleep,
  startService,
  stopService,
  streamMessageCount,
  unique,
  waitFor,
} from '../helpers/stack.ts';

after(async () => {
  // Never leave the stack degraded, whatever happened in a test.
  await startService('nats', 'incident-service').catch(() => undefined);
  await closeConnections();
});

const incidentsFor = async (deviceId: string) => ((await api('derek.duty', 'GET', '/api/incident/incidents?limit=500')) as any[]).filter((i) => i.device_id === deviceId);
const openAlerts = async (deviceId: string) => (await api('derek.duty', 'GET', `/api/alert/alerts?status=open&device_id=${deviceId}`)) as any[];

describe('Test D: a consumer is interrupted while events are published', () => {
  let device: Awaited<ReturnType<typeof registerTestDevice>>;
  let alertId: string;

  before(async () => {
    device = await registerTestDevice();
  });

  it('events published while the consumer is down are retained and processed after restart', async () => {
    stopService('incident-service');

    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 4.0 }]);
    const alert = await waitFor(async () => (await openAlerts(device.id))[0], { what: 'the alarm (alert-service is unaffected)' });
    alertId = alert.id;

    // The consumer really is down: its API is unavailable through the gateway.
    const down = await rawApi('derek.duty', 'GET', '/api/incident/incidents');
    assert.ok([502, 503, 504].includes(down.status), `expected an unavailable response, got ${down.status}`);
    await sleep(2_000);

    await startService('incident-service');
    const incident = await waitFor(async () => (await incidentsFor(device.id))[0], { timeoutMs: 60_000, what: 'the incident to be created after recovery' });
    assert.equal(incident.source_id, alertId);
    assert.equal(incident.status, 'open');
  });

  it('downstream processing continued from the recovered event (response workflow started)', async () => {
    const [incident] = await incidentsFor(device.id);
    const task = await waitFor(async () => ((await api('derek.duty', 'GET', `/api/workflow/tasks?subject_id=${incident.id}`)) as any[])[0], { what: 'the acknowledgment task' });
    assert.equal(task.stage_key, 'acknowledge');
  });

  it('redelivering the very same event does not repeat the business operation (inbox)', async () => {
    const audit = await waitFor(async () => (await api('oscar.auditor', 'GET', `/api/audit/audit?aggregate_id=${alertId}&event_type=alert.raised.v1`)).items[0], { what: 'the audit record of the alarm' });
    const original = envelopeFromAudit(audit, device.tenantId);

    // Same event id, delivered three more times (new broker message ids, so
    // the broker itself does not drop them: the consumer has to).
    for (let i = 0; i < 3; i++) await publishRawEvent('alert.raised.v1', JSON.stringify(original));
    await sleep(3_000);
    assert.equal((await incidentsFor(device.id)).length, 1);
    const tasks = (await api('adam.admin', 'GET', `/api/workflow/tasks?scope=all&subject_id=${(await incidentsFor(device.id))[0].id}`)) as any[];
    assert.equal(tasks.length, 1, 'no second response task');
    const audited = await api('oscar.auditor', 'GET', `/api/audit/audit?aggregate_id=${alertId}&event_type=alert.raised.v1`);
    assert.equal(audited.total, 1, 'the audit trail records the event once');
  });

  it('a producer emitting the same business fact twice under a new event id is still handled once (unique constraint)', async () => {
    const audit = (await api('oscar.auditor', 'GET', `/api/audit/audit?aggregate_id=${alertId}&event_type=alert.raised.v1`)).items[0];
    const clone = { ...envelopeFromAudit(audit, device.tenantId), event_id: crypto.randomUUID() };
    await publishRawEvent('alert.raised.v1', JSON.stringify(clone));
    await sleep(3_000);
    assert.equal((await incidentsFor(device.id)).length, 1, 'the inbox cannot catch this one; the database constraint does');
  });

  it('the broker drops a repeated publish of the same message id (outbox relay retry)', async () => {
    const before = await streamMessageCount('TITAN_EVENTS');
    const event = {
      event_id: crypto.randomUUID(),
      event_type: 'test.duplicate.published.v1',
      schema_version: 1,
      producer: 'integration-test',
      aggregate_type: 'test',
      aggregate_id: unique(),
      tenant_id: device.tenantId,
      occurred_at: new Date().toISOString(),
      correlation_id: crypto.randomUUID(),
      causation_id: null,
      actor: null,
      payload: {},
    };
    for (let i = 0; i < 5; i++) await publishRawEvent(event.event_type, JSON.stringify(event), event.event_id);
    assert.equal((await streamMessageCount('TITAN_EVENTS')) - before, 1);
  });
});

describe('Test D: poison messages', () => {
  it('a malformed event is moved to the dead-letter queue and does not block the consumer', async () => {
    const before = await streamMessageCount('TITAN_DLQ');
    await publishRawEvent('alert.raised.v1', '{"this is not": "a valid event envelope"}');
    await publishRawEvent('alert.raised.v1', 'not even json');
    // incident-service and audit-service both consume this subject: each dead-letters both messages.
    await waitFor(async () => (await streamMessageCount('TITAN_DLQ')) - before >= 4, { timeoutMs: 30_000, what: 'dead-lettered messages' });

    // The consumers are still working.
    const device = await registerTestDevice();
    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 4.0 }]);
    await waitFor(async () => (await incidentsFor(device.id))[0], { what: 'a new incident after the poison messages' });
  });
});

describe('Test D: the event broker is interrupted', () => {
  it('writes keep working while NATS is down; buffered events are published after it returns', async () => {
    stopService('nats');
    await sleep(1_500);

    // Business operations do not depend on the broker being up.
    const code = unique('OUTBOX-');
    const asset = await api('amy.assets', 'POST', '/api/asset/assets', { code, name: 'Created while the broker was down', category_code: 'DRAINAGE' });
    const draft = await api('alice.applicant', 'POST', '/api/case/cases', {
      form_key: 'building-permit',
      title: `Submitted while the broker was down ${unique()}`,
      data: { applicant_name: 'Alice Applicant', site_address: '1 Outage Road', project_type: 'residential', floor_area_m2: 90, declaration: true },
    });
    const submitted = await api('alice.applicant', 'POST', `/api/case/cases/${draft.id}/submit`);
    assert.equal(submitted.status, 'submitted');

    const health = await api('adam.admin', 'GET', '/api/platform/health');
    assert.equal(health.services.find((s: any) => s.service === 'asset-service').status, 'degraded', 'ready, but reporting the broker as down');
    assert.equal(health.services.find((s: any) => s.service === 'asset-service').checks.broker, 'down');
    // Nothing can have been processed downstream yet.
    assert.equal((await api('alice.applicant', 'GET', `/api/case/cases/${draft.id}`)).status, 'submitted');

    await startService('nats');

    // The outbox relays the buffered events: the workflow starts and the audit trail fills in.
    const task = await waitFor(async () => ((await api('victor.validator', 'GET', `/api/workflow/tasks?subject_id=${draft.id}`)) as any[])[0], {
      timeoutMs: 90_000,
      what: 'the workflow to start once the broker is back',
    });
    assert.equal(task.stage_key, 'validation');
    await waitFor(async () => (await api('oscar.auditor', 'GET', `/api/audit/audit?aggregate_id=${asset.id}`)).total === 1, { timeoutMs: 60_000, what: 'the asset event to reach the audit trail' });
    // Exactly once downstream, despite the interruption.
    await sleep(2_000);
    assert.equal(((await api('adam.admin', 'GET', `/api/workflow/tasks?scope=all&subject_id=${draft.id}`)) as any[]).length, 1);
  });
});
