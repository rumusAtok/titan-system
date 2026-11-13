// Test B - IoT incident, end to end:
// simulated sensor -> MQTT -> telemetry persistence -> rule evaluation ->
// alarm -> incident -> response workflow -> authorised acknowledgment -> dashboards.
// All readings are synthetic; the MQTT messages, broker and services are real.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, closeConnections, publishTelemetry, rawApi, registerTestDevice, sleep, waitFor } from '../helpers/stack.ts';

after(closeConnections);

const openAlerts = async (deviceId: string) => (await api('derek.duty', 'GET', `/api/alert/alerts?status=open&device_id=${deviceId}`)) as any[];
const incidentsFor = async (deviceId: string) => ((await api('derek.duty', 'GET', '/api/incident/incidents?limit=500')) as any[]).filter((i) => i.device_id === deviceId);

describe('Test B: sensor reading to acknowledged incident', () => {
  let device: Awaited<ReturnType<typeof registerTestDevice>>;
  let incidentId: string;

  before(async () => {
    device = await registerTestDevice();
  });

  it('normal readings are persisted with three distinct timestamps and raise nothing', async () => {
    const observedAt = new Date(Date.now() - 2_000);
    const messageId = await publishTelemetry(device.tenantId, device.id, [
      { sensor: 'water_level', value: 2.1 },
      { sensor: 'rainfall', value: 4 },
    ], { observedAt });

    const row = await waitFor(
      async () => ((await api('derek.duty', 'GET', `/api/telemetry/measurements?device_id=${device.id}&sensor_kind=water_level`)) as any[]).find((m) => m.message_id === messageId),
      { what: 'the reading to be persisted' },
    );
    assert.equal(row.value, 2.1);
    assert.equal(row.unit, 'm');
    assert.equal(row.quality, 'ok');
    // observed (device clock) <= received (platform) <= processed (stored)
    assert.equal(new Date(row.observed_at).toISOString(), observedAt.toISOString());
    assert.ok(new Date(row.received_at) > new Date(row.observed_at));
    assert.ok(new Date(row.processed_at) >= new Date(row.received_at));

    await sleep(1_500);
    assert.equal((await openAlerts(device.id)).length, 0);
    assert.equal((await incidentsFor(device.id)).length, 0);
  });

  it('the device is reported online and appears on the live dashboard feed', async () => {
    const status = await waitFor(async () => {
      const d = await api('derek.duty', 'GET', `/api/device/devices/${device.id}`);
      return d.status === 'online' ? d : null;
    }, { what: 'the device to come online' });
    assert.ok(status.last_seen_at);
    const latest = (await api('derek.duty', 'GET', '/api/telemetry/latest')) as any[];
    assert.ok(latest.some((l) => l.device_id === device.id && l.sensor_kind === 'water_level'));
  });

  it('a reading above the threshold raises an alarm and creates an incident', async () => {
    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 3.9 }]);

    const alert = await waitFor(async () => (await openAlerts(device.id))[0], { what: 'an alarm' });
    assert.equal(alert.rule_name, 'High water level');
    assert.equal(alert.severity, 'warning');
    assert.equal(alert.trigger_value, 3.9);
    assert.equal(alert.threshold, 3.5);

    const incident = await waitFor(async () => (await incidentsFor(device.id))[0], { what: 'an incident' });
    assert.equal(incident.status, 'open');
    assert.equal(incident.severity, 'warning');
    assert.equal(incident.source_type, 'alert');
    assert.equal(incident.source_id, alert.id);
    assert.match(incident.reference_no, /^INC-\d{4}-\d{6}$/);
    incidentId = incident.id;
  });

  it('repeated and duplicate readings do not create a second alarm or incident', async () => {
    // The same MQTT message delivered twice (as QoS 1 permits)...
    const duplicateId = await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 4.0 }]);
    const observedAt = new Date();
    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 4.1 }], { messageId: `dup-${duplicateId}`, observedAt });
    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 4.1 }], { messageId: `dup-${duplicateId}`, observedAt });
    // ...and further breaching readings.
    for (const value of [4.2, 4.3, 4.4]) await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value }]);

    const alert = await waitFor(async () => {
      const [a] = await openAlerts(device.id);
      return a && a.occurrences >= 6 ? a : null;
    }, { what: 'the readings to be folded into the open alarm' });
    assert.equal(alert.occurrences, 6, 'six distinct breaching readings: the redelivered message is counted once');
    assert.equal(alert.last_value, 4.4);

    assert.equal((await openAlerts(device.id)).length, 1, 'still exactly one open alarm');
    assert.equal((await incidentsFor(device.id)).length, 1, 'still exactly one incident');

    const stored = ((await api('derek.duty', 'GET', `/api/telemetry/measurements?device_id=${device.id}&sensor_kind=water_level&limit=500`)) as any[]).filter((m) => m.message_id === `dup-${duplicateId}`);
    assert.equal(stored.length, 1, 'the duplicate message was stored once');
  });

  it('the incident starts a response workflow assigned to the duty officer', async () => {
    const task = await waitFor(async () => ((await api('derek.duty', 'GET', `/api/workflow/tasks?subject_id=${incidentId}`)) as any[])[0], { what: 'the acknowledgment task' });
    assert.equal(task.stage_key, 'acknowledge');
    assert.equal(task.role, 'duty_officer');
    assert.equal(task.subject_type, 'incident');
    assert.ok(task.due_at);
    const notified = await waitFor(async () => ((await api('derek.duty', 'GET', '/api/notification/notifications?limit=200')) as any[]).find((n) => n.reference_id === incidentId && n.category === 'incident.created'));
    assert.match(notified.subject, /WARNING incident INC-/);
  });

  it('only an authorised role can acknowledge', async () => {
    const [task] = (await api('derek.duty', 'GET', `/api/workflow/tasks?subject_id=${incidentId}`)) as any[];
    const path = `/api/workflow/tasks/${task.id}/decision`;
    // The incident commander does not hold the duty officer role.
    assert.equal((await rawApi('irene.commander', 'POST', path, { decision: 'approve' })).status, 403);
    assert.equal((await rawApi('victor.validator', 'POST', path, { decision: 'approve' })).status, 403);
    // A duty officer of another tenant cannot see the task.
    assert.equal((await rawApi('dana.duty', 'POST', path, { decision: 'approve' })).status, 404);
    // Incidents cannot be "returned to an applicant".
    assert.equal((await rawApi('derek.duty', 'POST', path, { decision: 'return', comment: 'x' })).status, 409);
    assert.equal((await api('derek.duty', 'GET', `/api/incident/incidents/${incidentId}`)).status, 'open');

    await api('derek.duty', 'POST', path, { decision: 'approve', comment: 'On it' });
    const incident = await waitFor(async () => {
      const i = await api('derek.duty', 'GET', `/api/incident/incidents/${incidentId}`);
      return i.status === 'acknowledged' ? i : null;
    }, { what: 'the incident to be acknowledged' });
    assert.equal(incident.acknowledged_by, 'derek.duty');
    assert.ok(incident.acknowledged_at);
    assert.ok(incident.timeline.some((t: any) => t.entry_type === 'acknowledged' && t.actor_username === 'derek.duty'));
  });

  it('the dashboards reflect the incident', async () => {
    const summary = await api('irene.commander', 'GET', '/api/incident/incidents/summary');
    assert.ok(summary.active_by_severity.find((s: any) => s.severity === 'warning')?.count >= 1);
    const active = (await api('irene.commander', 'GET', '/api/incident/incidents?status=active&limit=500')) as any[];
    assert.ok(active.some((i) => i.id === incidentId && i.status === 'acknowledged'));
    const alerts = await api('irene.commander', 'GET', '/api/alert/alerts/summary');
    assert.ok(alerts.last_24_hours.raised >= 1);
  });

  it('the incident commander resolves and closes it; the alarm clears when the level recedes', async () => {
    assert.equal((await rawApi('irene.commander', 'POST', `/api/incident/incidents/${incidentId}/close`)).status, 409, 'an unresolved incident cannot be closed');

    const resolve = await waitFor(async () => ((await api('irene.commander', 'GET', `/api/workflow/tasks?subject_id=${incidentId}`)) as any[]).find((t) => t.stage_key === 'resolve'));
    assert.equal((await rawApi('derek.duty', 'POST', `/api/workflow/tasks/${resolve.id}/decision`, { decision: 'approve' })).status, 403);
    await api('irene.commander', 'POST', `/api/workflow/tasks/${resolve.id}/decision`, { decision: 'approve', comment: 'Pumps running, level falling' });
    await waitFor(async () => (await api('irene.commander', 'GET', `/api/incident/incidents/${incidentId}`)).status === 'resolved', { what: 'the incident to be resolved' });

    assert.equal((await rawApi('derek.duty', 'POST', `/api/incident/incidents/${incidentId}/close`)).status, 403);
    assert.equal((await api('irene.commander', 'POST', `/api/incident/incidents/${incidentId}/close`)).status, 'closed');

    // 3.4 m is below the trigger (3.5) but inside the hysteresis band (clear at 3.2): stays open.
    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 3.4 }]);
    await sleep(1_500);
    assert.equal((await openAlerts(device.id)).length, 1);
    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 2.0 }]);
    await waitFor(async () => (await openAlerts(device.id)).length === 0, { what: 'the alarm to clear' });
  });
});

describe('Test B: data quality and device health', () => {
  let device: Awaited<ReturnType<typeof registerTestDevice>>;

  before(async () => {
    device = await registerTestDevice();
  });

  const stored = async (messageId: string) =>
    waitFor(async () => ((await api('derek.duty', 'GET', `/api/telemetry/measurements?device_id=${device.id}&limit=500&from=${new Date(Date.now() - 86_400_000).toISOString()}`)) as any[]).find((m) => m.message_id === messageId), {
      what: `message ${messageId} to be stored`,
    });

  it('an implausible value is stored with a quality flag and never raises an alarm', async () => {
    const id = await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 99 }]);
    assert.equal((await stored(id)).quality, 'out_of_range');
    await sleep(1_500);
    assert.equal((await openAlerts(device.id)).length, 0);
  });

  it('delayed data is flagged late, kept, and does not overwrite the latest value or raise an alarm', async () => {
    const fresh = await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 2.2 }]);
    await stored(fresh);
    const late = await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 4.9 }], { observedAt: new Date(Date.now() - 45 * 60_000) });
    assert.equal((await stored(late)).quality, 'late');
    await sleep(1_500);
    const latest = ((await api('derek.duty', 'GET', '/api/telemetry/latest')) as any[]).find((l) => l.device_id === device.id && l.sensor_kind === 'water_level');
    assert.equal(latest.value, 2.2);
    assert.equal((await openAlerts(device.id)).length, 0);
  });

  it('a reading time-stamped in the future is flagged', async () => {
    const id = await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 2.3 }], { observedAt: new Date(Date.now() + 30 * 60_000) });
    assert.equal((await stored(id)).quality, 'future_timestamp');
  });

  it('malformed payloads and unknown sensors are rejected and recorded, without stopping ingestion', async () => {
    await publishTelemetry(device.tenantId, device.id, [], { raw: '{"this is": not json' });
    await publishTelemetry(device.tenantId, device.id, [], { raw: JSON.stringify({ message_id: 'x', observed_at: 'not-a-date', readings: [] }) });
    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'radiation', value: 1 }]);
    const stats = await waitFor(async () => {
      const s = await api('derek.duty', 'GET', '/api/telemetry/ingest/stats');
      const reasons = Object.fromEntries(s.rejected.map((r: any) => [r.reason, r.count]));
      return reasons.invalid_payload >= 2 && reasons.unknown_sensor >= 1 ? s : null;
    }, { what: 'rejections to be recorded' });
    assert.equal(stats.mqtt_connected, true);
    const ok = await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 2.0 }]);
    assert.equal((await stored(ok)).quality, 'ok');
  });

  it('telemetry for an unregistered device, or under the wrong tenant, is ignored', async () => {
    const ghost = '99999999-9999-4999-8999-999999999999';
    await publishTelemetry(device.tenantId, ghost, [{ sensor: 'water_level', value: 9 }]);
    // A real device id published under ANOTHER tenant's topic must not be accepted.
    const otherTenant = '22222222-2222-4222-8222-222222222222';
    const spoofed = await publishTelemetry(otherTenant, device.id, [{ sensor: 'water_level', value: 9 }]);
    await sleep(2_000);
    const rows = (await api('derek.duty', 'GET', `/api/telemetry/measurements?device_id=${device.id}&limit=500`)) as any[];
    assert.ok(!rows.some((m) => m.message_id === spoofed));
    assert.equal(((await api('brian.admin', 'GET', `/api/telemetry/measurements?device_id=${device.id}`)) as any[]).length, 0);
  });

  it('a silent device is detected as offline, raises a device-health alarm, and recovers when it reports again', async () => {
    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 2.0 }]);
    await waitFor(async () => (await api('derek.duty', 'GET', `/api/device/devices/${device.id}`)).status === 'online', { what: 'device online' });

    // Stop publishing. Expected interval 5 s -> offline after about 20 s of silence.
    const offline = await waitFor(async () => {
      const d = await api('derek.duty', 'GET', `/api/device/devices/${device.id}`);
      return d.status === 'offline' ? d : null;
    }, { timeoutMs: 75_000, intervalMs: 2_000, what: 'offline detection' });
    assert.ok(offline.history.some((h: any) => h.to_status === 'offline'));

    const alarm = await waitFor(async () => (await openAlerts(device.id)).find((a) => a.kind === 'device_offline'), { what: 'the device-offline alarm' });
    assert.equal(alarm.severity, 'warning');

    await publishTelemetry(device.tenantId, device.id, [{ sensor: 'water_level', value: 2.0 }]);
    await waitFor(async () => (await api('derek.duty', 'GET', `/api/device/devices/${device.id}`)).status === 'online', { timeoutMs: 30_000, what: 'device back online' });
    await waitFor(async () => !(await openAlerts(device.id)).some((a) => a.kind === 'device_offline'), { what: 'the device-offline alarm to clear' });
  });
});
