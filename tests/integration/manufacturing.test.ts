// Industry B: manufacturing, end to end, on the real stack.
//
//   machine asset -> vibration/temperature telemetry (MQTT) -> alarm -> equipment incident
//   -> maintenance request -> approval workflow -> work order -> completion -> asset and incident updated
//
// Runs in the tenant "Meridian Industrial Group", which has the manufacturing AND
// facilities packs active. Nothing is mocked; all readings are synthetic.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, closeConnections, decideSubject, pendingSubjectTask, publishTelemetry, rawApi, requestStatus, sleep, TENANT_C, unique, userId, waitFor, waitForAccess } from '../helpers/stack.ts';

const ADMIN = 'maya.admin';
const SUPERVISOR = 'sam.supervisor';
const PLANNER = 'paula.planner';
const TECHNICIAN = 'tim.technician';
const OTHER_TECHNICIAN = 'tess.technician';

let machine: any;
let monitor: any;

const machineAttributes = { manufacturer: 'Synthetic Machine Works', model: 'VMC-1100', serial_number: unique('SMW-'), rated_power_kw: 30, commissioning_year: 2023, synthetic: true };
const reading = (vibration: number, temperature = 55) => [
  { sensor: 'vibration_rms', value: vibration },
  { sensor: 'bearing_temperature', value: temperature },
  { sensor: 'spindle_load', value: 62 },
];
const openIncidents = async () => (await api(SUPERVISOR, 'GET', `/api/incident/incidents?asset_id=${machine.id}&limit=50`)) as any[];
const requestsForMachine = async () => (await api(PLANNER, 'GET', `/api/maintenance/requests?asset_id=${machine.id}`)) as any[];

before(async () => {
  await waitForAccess(ADMIN, '/api/device/devices', 200, 'the iot capability to be active for Meridian');
  await waitForAccess(ADMIN, '/api/maintenance/request-types', 200, 'the maintenance capability to be active for Meridian');
  const line = (await api(ADMIN, 'GET', '/api/asset/assets?category=PRODUCTION_LINE')).find((a: any) => a.code === 'MER-LINE-A');
  assert.ok(line, 'the seeded production line exists (run `npm run seed`)');
  machine = await api(ADMIN, 'POST', '/api/asset/assets', { code: unique('MER-CNC-T'), name: 'Test machining centre', category_code: 'CNC_MACHINE', status: 'active', parent_id: line.id, attributes: machineAttributes });
  monitor = await api(ADMIN, 'POST', '/api/device/devices', { serial_no: unique('MCM-T'), name: `Condition monitor of ${machine.code}`, profile_key: 'machine-condition-monitor', asset_id: machine.id });
  // Device and asset reach telemetry, alerting and maintenance through events.
  await waitFor(
    async () => {
      await publishTelemetry(TENANT_C, monitor.id, reading(2.4));
      await sleep(300);
      return (await api(ADMIN, 'GET', `/api/telemetry/measurements?device_id=${monitor.id}`)).length > 0;
    },
    { what: 'the new condition monitor to be known to telemetry-service' },
  );
});

after(closeConnections);

describe('Manufacturing: machines, sensor profiles and metrics', () => {
  it('a machine is validated against the versioned attribute schema of its category', async () => {
    const invalid = await rawApi(ADMIN, 'POST', '/api/asset/assets', { code: unique('MER-X'), name: 'Incomplete machine', category_code: 'CNC_MACHINE', attributes: { manufacturer: 'Synthetic Machine Works', rated_power_kw: 'a lot' } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.error.details.map((d: any) => d.field).sort(), ['model', 'rated_power_kw', 'serial_number']);
    assert.equal(machine.attribute_schema_version, 2, 'the tenant runs manufacturing 1.1, whose CNC schema is version 2');
    const schemas = await api(ADMIN, 'GET', '/api/asset/categories/CNC_MACHINE/attribute-schemas');
    assert.deepEqual(schemas.map((s: any) => [s.version, s.active]), [[2, true]]);
  });

  it('a device registered from a sensor profile gets the profile\'s device type and metrics', async () => {
    assert.equal(monitor.device_type, 'machine-condition-monitor');
    assert.equal(monitor.profile_key, 'machine-condition-monitor');
    assert.deepEqual(monitor.sensors.map((s: any) => `${s.kind}:${s.unit}`).sort(), ['bearing_temperature:degC', 'spindle_load:%', 'vibration_rms:mm/s']);
    assert.equal((await rawApi(ADMIN, 'POST', '/api/device/devices', { serial_no: unique('MCM-X'), name: 'No such profile', profile_key: 'does-not-exist' })).status, 400);
  });

  it('machine metrics coexist with water-level metrics in the same tenant', async () => {
    const gauge = await api(ADMIN, 'POST', '/api/device/devices', {
      serial_no: unique('MER-WL-T'), name: 'Cooling pond level gauge', device_type: 'level-gauge', expected_interval_seconds: 30,
      sensors: [{ kind: 'water_level', unit: 'm', min_valid: 0, max_valid: 15 }],
    });
    await waitFor(async () => {
      await publishTelemetry(TENANT_C, gauge.id, [{ sensor: 'water_level', value: 1.2 }]);
      await sleep(300);
      return (await api(ADMIN, 'GET', `/api/telemetry/latest?device_id=${gauge.id}`)).length === 1;
    }, { what: 'the gauge reading to be stored' });
    const latest = await api(ADMIN, 'GET', '/api/telemetry/latest?sensor_kind=vibration_rms,water_level');
    assert.ok(latest.some((r: any) => r.device_id === monitor.id && r.sensor_kind === 'vibration_rms' && r.unit === 'mm/s'));
    assert.ok(latest.some((r: any) => r.device_id === gauge.id && r.sensor_kind === 'water_level' && r.unit === 'm'));
    assert.ok(latest.every((r: any) => ['vibration_rms', 'water_level'].includes(r.sensor_kind)));
    const metrics = await api(ADMIN, 'GET', '/api/device/metric-types');
    assert.ok(metrics.some((m: any) => m.kind === 'vibration_rms' && m.unit === 'mm/s' && m.profiles.includes('machine-condition-monitor')));
    assert.ok(metrics.some((m: any) => m.kind === 'water_level' && m.unit === 'm'));
    // No flood rule exists in this tenant: a high pond level is stored and raises nothing.
    await publishTelemetry(TENANT_C, gauge.id, [{ sensor: 'water_level', value: 9.5 }]);
    await sleep(1500);
    assert.equal((await api(ADMIN, 'GET', `/api/alert/alerts?device_id=${gauge.id}`)).length, 0);
    await api(ADMIN, 'POST', `/api/device/devices/${gauge.id}/decommission`);
  });
});

describe('Manufacturing: alarm to equipment incident to maintenance request', () => {
  let incident: any;
  let request: any;
  let workOrder: any;

  it('normal vibration raises nothing', async () => {
    await publishTelemetry(TENANT_C, monitor.id, reading(3.1));
    await sleep(1500);
    assert.equal((await api(ADMIN, 'GET', `/api/alert/alerts?device_id=${monitor.id}`)).length, 0);
    assert.equal((await openIncidents()).length, 0);
  });

  it('vibration above the warning level raises an alarm and one equipment incident on the machine', async () => {
    await publishTelemetry(TENANT_C, monitor.id, reading(8.4, 71));
    const alarm = await waitFor(async () => (await api(ADMIN, 'GET', `/api/alert/alerts?device_id=${monitor.id}&status=open`))[0], { what: 'the vibration alarm' });
    assert.equal(alarm.rule_name, 'High machine vibration');
    assert.equal(alarm.threshold, 7.1);
    incident = await waitFor(async () => (await openIncidents())[0], { what: 'the equipment incident' });
    assert.equal(incident.category, 'equipment');
    assert.equal(incident.source_type, 'alert');
    assert.equal(incident.source_id, alarm.id);
    assert.equal(incident.asset_id, machine.id, 'the incident refers to the machine, not only to the sensor');
    assert.equal(incident.severity, 'warning');
  });

  it('the incident starts the equipment response process and tells the production supervisor', async () => {
    const task = await pendingSubjectTask(SUPERVISOR, incident.id, 'acknowledge');
    assert.equal(task.role, 'production_supervisor');
    const instance = await api(SUPERVISOR, 'GET', `/api/workflow/instances/by-subject/incident/${incident.id}`);
    assert.equal(instance.definition_key, 'equipment-incident-response');
    await waitFor(async () => (await api(SUPERVISOR, 'GET', '/api/notification/notifications?limit=100')).some((n: any) => n.category === 'incident.created' && n.reference_id === incident.id), {
      what: 'the supervisor to be notified',
    });
  });

  it('the incident raises exactly one repair request, with priority from its severity', async () => {
    request = await waitFor(async () => (await requestsForMachine())[0], { what: 'the automatic maintenance request' });
    assert.equal(request.request_type, 'equipment-repair');
    assert.equal(request.pack_id, 'manufacturing');
    assert.equal(request.origin_type, 'incident');
    assert.equal(request.origin_id, incident.id);
    assert.equal(request.priority, 'high', 'a warning incident gives a high-priority request');
    assert.equal(request.requested_by_username, null, 'raised by the platform, not by a person');
    assert.equal(request.status, 'submitted');
  });

  it('further breaching readings add to the same alarm: no second incident, no second request', async () => {
    await publishTelemetry(TENANT_C, monitor.id, reading(8.9, 73));
    await publishTelemetry(TENANT_C, monitor.id, reading(9.3, 75));
    await waitFor(async () => (await api(ADMIN, 'GET', `/api/alert/alerts?device_id=${monitor.id}&status=open`))[0]?.occurrences >= 3, { what: 'the readings to be folded into the alarm' });
    assert.equal((await openIncidents()).length, 1);
    assert.equal((await requestsForMachine()).length, 1);
  });

  it('approval follows the pack\'s workflow: supervisor, then planning review for a high-priority request', async () => {
    const task = await pendingSubjectTask(SUPERVISOR, request.id, 'supervisor_approval');
    assert.equal(task.subject_type, 'maintenance_request');
    // The planner is staff but does not hold the approving role of this stage.
    assert.equal((await rawApi(PLANNER, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve' })).status, 403);
    const first = await api(SUPERVISOR, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision: 'approve', comment: 'Machine stopped for repair.' });
    assert.equal(first.instance_status, 'running');
    assert.equal((await api(PLANNER, 'GET', `/api/maintenance/requests/${request.id}`)).work_order, null, 'no work order before the last approval');
    const second = await decideSubject(PLANNER, request.id, 'planning_review', 'approve');
    assert.equal(second.instance_status, 'approved');
    workOrder = (await requestStatus(PLANNER, request.id, 'approved', true)).work_order;
    assert.equal(workOrder.status, 'open');
  });

  it('the planner assigns the work order; only the assigned technician can start it', async () => {
    await api(PLANNER, 'POST', `/api/maintenance/work-orders/${workOrder.id}/assign`, { assignee_id: await userId(TECHNICIAN), assignee_username: TECHNICIAN });
    assert.equal((await rawApi(OTHER_TECHNICIAN, 'POST', `/api/maintenance/work-orders/${workOrder.id}/start`)).status, 403);
    assert.equal((await rawApi(SUPERVISOR, 'POST', `/api/maintenance/work-orders/${workOrder.id}/start`)).status, 403);
    assert.equal((await api(TECHNICIAN, 'POST', `/api/maintenance/work-orders/${workOrder.id}/start`)).status, 'in_progress');
    await waitFor(async () => (await api(ADMIN, 'GET', `/api/asset/assets/${machine.id}`)).status === 'under_maintenance', { what: 'the machine to be under maintenance' });
    await waitFor(async () => (await api(TECHNICIAN, 'GET', '/api/notification/notifications?limit=100')).some((n: any) => n.category === 'maintenance.work_order_assigned' && n.reference_id === workOrder.id), {
      what: 'the technician to be told about the assignment',
    });
  });

  it('completing the work order updates the machine and is recorded on the incident', async () => {
    const done = await api(TECHNICIAN, 'POST', `/api/maintenance/work-orders/${workOrder.id}/complete`, { summary: 'Replaced spindle bearing set; vibration back to 2.3 mm/s on test run.', labor_hours: 3.5, condition_after: 'good' });
    assert.equal(done.status, 'completed');
    const asset = await waitFor(async () => {
      const a = await api(ADMIN, 'GET', `/api/asset/assets/${machine.id}`);
      return a.status === 'active' && a.last_maintained_at ? a : null;
    }, { what: 'the machine to be back in service' });
    assert.equal(asset.condition, 'good');
    const detail = await waitFor(async () => {
      const i = await api(SUPERVISOR, 'GET', `/api/incident/incidents/${incident.id}`);
      return i.timeline.filter((t: any) => t.entry_type === 'maintenance').length >= 3 ? i : null;
    }, { what: 'the maintenance steps to appear on the incident timeline' });
    const notes = detail.timeline.filter((t: any) => t.entry_type === 'maintenance').map((t: any) => t.message);
    assert.ok(notes.some((m: string) => m.includes(request.reference_no) && m.includes('raised')));
    assert.ok(notes.some((m: string) => m.includes(workOrder.reference_no) && m.includes('created')));
    assert.ok(notes.some((m: string) => m.includes(workOrder.reference_no) && m.includes('completed')));
    // Finished work does not resolve the incident by itself: a person still confirms it.
    assert.equal(detail.status, 'open');
  });

  it('the incident is acknowledged and resolved by the roles of its category, then closed', async () => {
    assert.equal((await rawApi(TECHNICIAN, 'POST', `/api/incident/incidents/${incident.id}/close`)).status, 403);
    await decideSubject(SUPERVISOR, incident.id, 'acknowledge', 'approve');
    await waitFor(async () => (await api(SUPERVISOR, 'GET', `/api/incident/incidents/${incident.id}`)).status === 'acknowledged', { what: 'acknowledgment' });
    // The alarm clears once vibration is back below the clear level; that alone does not end the incident.
    await publishTelemetry(TENANT_C, monitor.id, reading(2.3, 56));
    await waitFor(async () => (await api(ADMIN, 'GET', `/api/alert/alerts?device_id=${monitor.id}&status=cleared`)).length === 1, { what: 'the alarm to clear' });
    assert.equal((await rawApi(SUPERVISOR, 'POST', `/api/incident/incidents/${incident.id}/close`)).status, 409, 'an unresolved incident cannot be closed');
    await decideSubject(PLANNER, incident.id, 'resolve', 'approve');
    const resolved = await waitFor(async () => {
      const i = await api(SUPERVISOR, 'GET', `/api/incident/incidents/${incident.id}`);
      return i.status === 'resolved' ? i : null;
    }, { what: 'resolution' });
    assert.equal(resolved.resolved_by, PLANNER);
    assert.equal((await api(SUPERVISOR, 'POST', `/api/incident/incidents/${incident.id}/close`)).status, 'closed');
  });
});

describe('Manufacturing: one tenant, two industries, records kept apart', () => {
  it('maintenance records carry their pack and can be listed per industry', async () => {
    const service = await api('rita.requester', 'POST', '/api/maintenance/requests', { request_type: 'facility-service-request', title: `Flickering light ${unique()}`, details: { location: 'Finance office', service_category: 'electrical' } });
    const manufacturing = await api(PLANNER, 'GET', '/api/maintenance/requests?pack=manufacturing&limit=500');
    const facilities = await api(PLANNER, 'GET', '/api/maintenance/requests?pack=facilities&limit=500');
    assert.ok(manufacturing.length > 0 && manufacturing.every((r: any) => r.pack_id === 'manufacturing' && r.request_type === 'equipment-repair'));
    assert.ok(facilities.some((r: any) => r.id === service.id) && facilities.every((r: any) => r.pack_id === 'facilities'));
    // Each request type keeps its own approver: the facility request is not in the production supervisor's inbox.
    await pendingSubjectTask('fred.facilities', service.id, 'facility_review');
    assert.equal((await api(SUPERVISOR, 'GET', `/api/workflow/tasks?subject_id=${service.id}`)).length, 0);
    await api('rita.requester', 'POST', `/api/maintenance/requests/${service.id}/cancel`);
  });

  it('assets and incidents can be listed per industry', async () => {
    const machines = await api(ADMIN, 'GET', '/api/asset/assets?pack=manufacturing&limit=500');
    const buildings = await api(ADMIN, 'GET', '/api/asset/assets?pack=facilities&limit=500');
    assert.ok(machines.some((a: any) => a.id === machine.id) && machines.every((a: any) => ['CNC_MACHINE', 'CONVEYOR', 'PRODUCTION_LINE', 'INDUSTRIAL_ROBOT'].includes(a.category_code)));
    assert.ok(buildings.length > 0 && buildings.every((a: any) => ['BUILDING', 'HVAC_UNIT', 'ELEVATOR', 'FIRE_SAFETY_SYSTEM'].includes(a.category_code)));
    const categories = (await api(SUPERVISOR, 'GET', '/api/incident/categories')).map((c: any) => `${c.key}:${c.pack_id}`).sort();
    assert.deepEqual(categories, ['equipment:manufacturing', 'facility:facilities', 'general:platform-core']);
    assert.ok((await api(SUPERVISOR, 'GET', '/api/incident/incidents?category=equipment&limit=500')).every((i: any) => i.category === 'equipment'));
  });

  it('another tenant sees none of it', async () => {
    assert.equal((await rawApi('adam.admin', 'GET', `/api/asset/assets/${machine.id}`)).status, 404);
    assert.equal((await rawApi('adam.admin', 'GET', `/api/device/devices/${monitor.id}`)).status, 404);
    assert.equal((await rawApi('dora.admin', 'GET', `/api/asset/assets/${machine.id}`)).status, 404);
  });
});
