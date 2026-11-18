// Industry-pack registry: catalogue, tenant activation, entitlements enforced by every
// service, dependency rules, version upgrade with a business process in flight,
// deactivation without data loss, and configuration backup/restoration.
// Real stack, no mocks. The lifecycle tests use the tenant "Harbourline Properties".
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  activeDefinition, api, closeConnections, decideSubject, pendingSubjectTask, rawApi, requestStatus, TENANT_A, TENANT_C, TENANT_D, unique, waitFor, waitForAccess,
} from '../helpers/stack.ts';

const packOf = async (user: string, id: string) => (await api(user, 'GET', '/api/tenant/packs')).find((p: any) => p.pack_id === id);
const capabilities = async (user: string) => (await api(user, 'GET', '/api/tenant/entitlements')).capabilities as string[];
const navigation = async (user: string) => (await api(user, 'GET', '/api/tenant/workspace')).navigation.map((n: any) => n.label) as string[];

after(closeConnections);

describe('Pack catalogue', () => {
  it('lists the shipped packs with versions, capabilities and contents', async () => {
    const catalog = await api('adam.admin', 'GET', '/api/tenant/packs/catalog');
    assert.deepEqual(catalog.map((p: any) => p.id), ['disaster-infrastructure', 'facilities', 'integration-hub', 'manufacturing', 'operational-reporting', 'platform-core', 'procurement-inventory', 'public-services', 'video-monitoring']);
    const manufacturing = catalog.find((p: any) => p.id === 'manufacturing');
    assert.deepEqual(manufacturing.versions.map((v: any) => v.version), ['1.0.0', '1.1.0']);
    assert.equal(manufacturing.latest_version, '1.1.0');
    assert.deepEqual(manufacturing.versions[1].upgrades_from, ['1.0.0']);
    assert.deepEqual(manufacturing.capabilities, ['iot', 'maintenance']);
    assert.ok(catalog.every((p: any) => p.catalog_conflict === false), 'shipped manifests match the registered versions');
    assert.equal(catalog.find((p: any) => p.id === 'platform-core').core, true);
  });

  it('serves a complete manifest, and nothing for an unknown pack or version', async () => {
    const manifest = await api('adam.admin', 'GET', '/api/tenant/packs/catalog/facilities/1.0.0');
    assert.equal(manifest.id, 'facilities');
    assert.ok(manifest.request_types.length > 0 && manifest.asset_categories.length > 0);
    assert.equal((await rawApi('adam.admin', 'GET', '/api/tenant/packs/catalog/facilities/9.9.9')).status, 404);
    assert.equal((await rawApi('adam.admin', 'GET', '/api/tenant/packs/catalog/no-such-pack/1.0.0')).status, 404);
  });

  it('describes the platform layers and the controlled registry of workflow subject types', async () => {
    const platform = await api('adam.admin', 'GET', '/api/tenant/platform/capabilities');
    assert.deepEqual(platform.capabilities.filter((c: any) => c.layer === 'capability').map((c: any) => c.key).sort(), ['case_management', 'integrations', 'iot', 'maintenance', 'procurement', 'reporting', 'video']);
    const registered = (await api('adam.admin', 'GET', '/api/workflow/subject-types')).map((s: any) => s.key).sort();
    assert.deepEqual(registered, platform.workflow_subject_types.map((s: any) => s.key).sort(), 'the database registry and the contract registry agree');
    assert.ok(['case', 'incident', 'maintenance_request', 'service_request', 'work_order', 'inspection', 'purchase_request', 'quality_deviation', 'contract'].every((k) => registered.includes(k)));
  });
});

describe('Different tenants, different packs', () => {
  it('the existing government and flood tenants were given the packs that carry what they already used', async () => {
    const active = async (admin: string) => (await api(admin, 'GET', '/api/tenant/packs')).filter((p: any) => p.status === 'active').map((p: any) => p.pack_id).sort();
    assert.deepEqual(await active('brian.admin'), ['disaster-infrastructure', 'platform-core', 'public-services']);
    assert.deepEqual(await capabilities('brian.admin'), ['case_management', 'iot']);
    // Riverbend also runs the cross-industry modules added after v3 (seeded).
    assert.deepEqual(await active('adam.admin'), ['disaster-infrastructure', 'integration-hub', 'operational-reporting', 'platform-core', 'procurement-inventory', 'public-services', 'video-monitoring']);
    assert.deepEqual(await capabilities('adam.admin'), ['case_management', 'integrations', 'iot', 'procurement', 'reporting', 'video']);
  });

  it('one tenant runs two industry packs at once', async () => {
    const packs = (await api('maya.admin', 'GET', '/api/tenant/packs')).filter((p: any) => p.status === 'active').map((p: any) => p.pack_id).sort();
    assert.deepEqual(packs, ['facilities', 'integration-hub', 'manufacturing', 'operational-reporting', 'platform-core', 'procurement-inventory', 'video-monitoring']);
    assert.deepEqual(await capabilities('maya.admin'), ['integrations', 'iot', 'maintenance', 'procurement', 'reporting', 'video']);
    const workspace = await api('maya.admin', 'GET', '/api/tenant/workspace');
    assert.deepEqual(workspace.workspaces.map((w: any) => w.id).sort(), ['all', 'facilities', 'integration-hub', 'manufacturing', 'operational-reporting', 'procurement-inventory', 'video-monitoring']);
    assert.deepEqual(workspace.dashboards.map((d: any) => `${d.pack_id}:${d.key}`).sort(), ['facilities:facilities', 'manufacturing:manufacturing', 'platform-core:operations']);
  });

  it('a tenant sees only its own activations', async () => {
    const own = await api('maya.admin', 'GET', '/api/tenant/entitlements');
    assert.equal(own.tenant_id, TENANT_C);
    const history = await api('maya.admin', 'GET', '/api/tenant/packs/history');
    assert.ok(history.length >= 3);
    // disaster-infrastructure has only ever been active for the government tenants: none of their rows may appear here.
    assert.ok(!history.some((h: any) => h.pack_id === 'disaster-infrastructure'), 'the pack history of another tenant is visible');
    assert.ok(history.some((h: any) => h.pack_id === 'manufacturing') && history.some((h: any) => h.pack_id === 'facilities'));
    assert.notEqual(own.tenant_id, TENANT_A);
  });

  it('navigation follows packs and roles', async () => {
    const maya = await navigation('maya.admin');
    for (const label of ['Workspace', 'Work inbox', 'Assets', 'Incidents', 'Production equipment', 'Facilities', 'Maintenance', 'Administration']) assert.ok(maya.includes(label), `${label} for the Meridian administrator`);
    assert.ok(!maya.includes('Applications') && !maya.includes('IoT operations'));

    const adam = await navigation('adam.admin');
    for (const label of ['Workspace', 'Applications', 'IoT operations', 'GIS operations', 'Executive dashboard']) assert.ok(adam.includes(label), `${label} for the Riverbend administrator`);
    assert.ok(!adam.includes('Maintenance') && !adam.includes('Production equipment') && !adam.includes('Facilities'));

    // A service requester is not staff: only what the facilities pack offers that role.
    assert.deepEqual(await navigation('rita.requester'), ['Facilities']);
    // An applicant of the government tenant keeps exactly the entry they had.
    assert.deepEqual(await navigation('alice.applicant'), ['Applications']);
    // A technician is staff but not an administrator.
    const tim = await navigation('tim.technician');
    assert.ok(tim.includes('Maintenance') && !tim.includes('Administration'));
  });
});

describe('A module that is not active rejects direct API calls', () => {
  const denied = async (user: string, method: string, path: string, body?: unknown) => {
    const res = await rawApi(user, method, path, body);
    assert.equal(res.status, 403, `${method} ${path} as ${user}`);
    assert.equal(res.body.error.code, 'capability_disabled');
    return res;
  };

  it('case management is refused to a tenant without the public-services pack, whatever the role', async () => {
    await denied('maya.admin', 'GET', '/api/case/cases');
    await denied('maya.admin', 'GET', '/api/case/forms');
    await denied('maya.admin', 'POST', '/api/case/cases', { form_key: 'building-permit', title: 'Should not exist', data: {} });
    await denied('maya.admin', 'POST', '/api/case/forms', { key: 'own-form', title: 'Own form', workflow_key: 'x', fields: [{ name: 'a', label: 'A', type: 'text' }] });
  });

  it('maintenance is refused to a tenant without a pack that provides it', async () => {
    const res = await denied('adam.admin', 'GET', '/api/maintenance/work-orders');
    assert.deepEqual(res.body.error.details, { capability: 'maintenance' });
    await denied('adam.admin', 'GET', '/api/maintenance/request-types');
    await denied('derek.duty', 'POST', '/api/maintenance/requests', { request_type: 'equipment-repair', title: 'Should not exist' });
  });

  it('devices, telemetry and alerting are refused to a tenant without the IoT capability', async () => {
    // Harbourline starts with facilities only. (A lifecycle test below adds and removes manufacturing; it restores this state.)
    if ((await capabilities('dora.admin')).includes('iot')) return;
    await denied('dora.admin', 'GET', '/api/device/devices');
    await denied('dora.admin', 'POST', '/api/device/devices', { serial_no: 'HBL-X-001', name: 'Should not exist', device_type: 'x', sensors: [{ kind: 'temperature', unit: 'degC' }] });
    await denied('dora.admin', 'GET', '/api/telemetry/latest');
    await denied('dora.admin', 'GET', '/api/alert/rules');
  });

  it('the refusal is recorded as a security event', async () => {
    await waitFor(
      async () => (await api('adam.admin', 'GET', '/api/audit/audit?event_type=security.access_denied.v1&limit=50')).items.some((r: any) => r.payload.reason === 'capability_disabled:maintenance'),
      { what: 'the denied capability to appear in the audit trail' },
    );
  });

  it('the universal core stays available to every tenant', async () => {
    for (const admin of ['adam.admin', 'maya.admin', 'dora.admin']) {
      for (const path of ['/api/asset/assets', '/api/incident/incidents', '/api/workflow/tasks', '/api/tenant/workspace', '/api/notification/notifications']) {
        assert.equal((await rawApi(admin, 'GET', path)).status, 200, `${path} as ${admin}`);
      }
    }
  });
});

describe('Activation rules', () => {
  it('only a tenant administrator changes packs', async () => {
    for (const user of ['dan.technician', 'daisy.requester']) {
      assert.equal((await rawApi(user, 'POST', '/api/tenant/packs/manufacturing/activate', {})).status, 403);
      assert.equal((await rawApi(user, 'POST', '/api/tenant/packs/facilities/deactivate')).status, 403);
    }
    assert.equal((await rawApi(null, 'POST', '/api/tenant/packs/manufacturing/activate', {})).status, 401);
  });

  it('the platform core cannot be deactivated, and unknown packs or versions cannot be activated', async () => {
    const core = await rawApi('dora.admin', 'POST', '/api/tenant/packs/platform-core/deactivate');
    assert.equal(core.status, 409);
    assert.equal(core.body.error.code, 'core_pack');
    assert.equal((await rawApi('dora.admin', 'POST', '/api/tenant/packs/no-such-pack/activate', {})).status, 404);
    assert.equal((await rawApi('dora.admin', 'POST', '/api/tenant/packs/manufacturing/activate', { version: '7.0.0' })).status, 404);
  });

  it('configuration is validated against the schema the pack declares', async () => {
    for (const config of [{ vibration_warning_mm_s: 'loud' }, { vibration_warning_mm_s: 5000 }, { no_such_setting: 1 }]) {
      const res = await rawApi('dora.admin', 'POST', '/api/tenant/packs/manufacturing/activate', { version: '1.0.0', allow_downgrade: true, config });
      assert.equal(res.status, 400, JSON.stringify(config));
    }
  });

  it('activating a pack twice changes nothing', async () => {
    const before = await packOf('dora.admin', 'facilities');
    const again = await api('dora.admin', 'POST', '/api/tenant/packs/facilities/activate', {});
    assert.equal(again.changed, false);
    assert.equal(again.action, 'unchanged');
    assert.equal((await packOf('dora.admin', 'facilities')).config_version, before.config_version);
  });
});

describe('Pack lifecycle: upgrade with a process in flight, deactivation, reactivation', () => {
  const ADMIN = 'dora.admin';
  let inFlight: any;
  let inFlightVersion: number;
  let device: any;

  before(async () => {
    // Known starting point, whatever earlier runs left behind: manufacturing at 1.0.0.
    await api(ADMIN, 'POST', '/api/tenant/packs/manufacturing/activate', { version: '1.0.0', allow_downgrade: true, config: {} });
    await waitForAccess(ADMIN, '/api/device/devices', 200, 'the iot capability to reach device-service');
    await activeDefinition(ADMIN, 'maintenance-approval', (d) => d.definition.stages.length === 1);
    await waitFor(async () => (await api(ADMIN, 'GET', '/api/maintenance/request-types')).some((t: any) => t.key === 'equipment-repair'), { what: 'the equipment-repair request type' });
    await waitFor(async () => (await api(ADMIN, 'GET', '/api/device/sensor-profiles')).some((p: any) => p.key === 'machine-condition-monitor'), { what: 'the sensor profile' });
  });

  it('activation installs the templates of version 1.0.0 and switches on its capabilities', async () => {
    assert.deepEqual(await capabilities(ADMIN), ['iot', 'maintenance']);
    const pack = await packOf(ADMIN, 'manufacturing');
    assert.equal(pack.version, '1.0.0');
    assert.equal(pack.upgrade_available, true);
    assert.equal(pack.effective_config.vibration_warning_mm_s, 7.1, 'manifest default');
    const rule = await waitFor(async () => (await api(ADMIN, 'GET', '/api/alert/rules')).find((r: any) => r.name === 'High machine vibration'), { what: 'the alert rule' });
    assert.equal(rule.threshold, 7.1);
    assert.equal(rule.pack_id, 'manufacturing');
    assert.equal(rule.incident_category, 'equipment');
    const schema = await waitFor(async () => (await api(ADMIN, 'GET', '/api/asset/categories')).find((c: any) => c.code === 'CNC_MACHINE' && c.attribute_schema_version === 1), { what: 'CNC schema version 1 to be in force' });
    assert.ok(!schema.attribute_fields.some((f: any) => f.name === 'last_calibration_date'));
    device = await api(ADMIN, 'POST', '/api/device/devices', { serial_no: unique('HBL-MCM-'), name: 'Lifecycle test monitor', profile_key: 'machine-condition-monitor' });
  });

  it('a maintenance request starts on the workflow version in force', async () => {
    inFlight = await api(ADMIN, 'POST', '/api/maintenance/requests', { request_type: 'equipment-repair', title: `In flight during upgrade ${unique()}`, priority: 'high', details: { symptom: 'Synthetic test', production_impact: 'reduced' } });
    await pendingSubjectTask('pete.supervisor', inFlight.id, 'supervisor_approval');
    const instance = await api(ADMIN, 'GET', `/api/workflow/instances/by-subject/maintenance_request/${inFlight.id}`);
    inFlightVersion = instance.definition_version;
    assert.deepEqual(instance.stages.map((s: any) => s.key), ['supervisor_approval']);
  });

  it('activating the version already in force changes nothing', async () => {
    const down = await rawApi(ADMIN, 'POST', '/api/tenant/packs/manufacturing/activate', { version: '1.0.0' });
    assert.equal(down.status, 200, 'same version: nothing to do');
    assert.equal(down.body.changed, false);
  });

  it('upgrading to 1.1.0 publishes new definition versions and keeps the old ones', async () => {
    const result = await api(ADMIN, 'POST', '/api/tenant/packs/manufacturing/activate', { version: '1.1.0' });
    assert.equal(result.action, 'upgraded');
    assert.equal(result.pack.version, '1.1.0');
    assert.equal(result.pack.upgrade_available, false);
    const upgraded = await activeDefinition(ADMIN, 'maintenance-approval', (d) => d.definition.stages.length === 2);
    assert.ok(upgraded.version > inFlightVersion);
    assert.equal(upgraded.pack_version, '1.1.0');
    assert.equal(upgraded.created_by, 'pack:manufacturing@1.1.0');
    const versions = (await api(ADMIN, 'GET', '/api/workflow/definitions')).filter((d: any) => d.key === 'maintenance-approval');
    assert.ok(versions.some((d: any) => d.version === inFlightVersion && !d.active), 'the earlier version is kept, inactive');
    // The unchanged incident workflow was not re-published.
    const response = (await api(ADMIN, 'GET', '/api/workflow/definitions')).filter((d: any) => d.key === 'equipment-incident-response' && d.active);
    assert.equal(response.length, 1);
    assert.notEqual(response[0].pack_version, '1.1.0');
    await waitFor(async () => (await api(ADMIN, 'GET', '/api/asset/categories')).some((c: any) => c.code === 'CNC_MACHINE' && c.attribute_schema_version === 2), { what: 'CNC schema version 2 to be in force' });
    await waitFor(async () => (await api(ADMIN, 'GET', '/api/asset/categories')).some((c: any) => c.code === 'INDUSTRIAL_ROBOT'), { what: 'the new asset category' });
  });

  it('the process that was running finishes on the version it started with', async () => {
    const instance = await api(ADMIN, 'GET', `/api/workflow/instances/by-subject/maintenance_request/${inFlight.id}`);
    assert.equal(instance.definition_version, inFlightVersion);
    assert.equal(instance.status, 'running');
    assert.deepEqual(instance.stages.map((s: any) => s.key), ['supervisor_approval'], 'no stage was added to the running process');
    const decision = await decideSubject('pete.supervisor', inFlight.id, 'supervisor_approval', 'approve');
    assert.equal(decision.instance_status, 'approved', 'one stage, as defined when it started');
    const approved = await requestStatus(ADMIN, inFlight.id, 'approved', true);
    assert.equal(approved.work_order.status, 'open');
  });

  it('a request raised after the upgrade follows the new version', async () => {
    const fresh = await api(ADMIN, 'POST', '/api/maintenance/requests', { request_type: 'equipment-repair', title: `Raised after upgrade ${unique()}`, priority: 'high' });
    const first = await decideSubject('pete.supervisor', fresh.id, 'supervisor_approval', 'approve');
    assert.equal(first.instance_status, 'running', 'high priority now needs a planning review');
    const second = await decideSubject('penny.planner', fresh.id, 'planning_review', 'approve');
    assert.equal(second.instance_status, 'approved');
    await requestStatus(ADMIN, fresh.id, 'approved', true);
    // A normal-priority request skips the conditional stage.
    const normal = await api(ADMIN, 'POST', '/api/maintenance/requests', { request_type: 'equipment-repair', title: `Normal priority ${unique()}`, priority: 'normal' });
    assert.equal((await decideSubject('pete.supervisor', normal.id, 'supervisor_approval', 'approve')).instance_status, 'approved');
  });

  it('moving back to an older version needs an explicit flag', async () => {
    const res = await rawApi(ADMIN, 'POST', '/api/tenant/packs/manufacturing/activate', { version: '1.0.0' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'downgrade_not_allowed');
    assert.equal((await packOf(ADMIN, 'manufacturing')).version, '1.1.0');
  });

  it('changing the pack configuration re-installs the templates that depend on it', async () => {
    const pack = await packOf(ADMIN, 'manufacturing');
    assert.equal((await rawApi(ADMIN, 'PUT', '/api/tenant/packs/manufacturing/config', { config: { vibration_warning_mm_s: 6.5 }, expected_version: pack.config_version + 7 })).status, 409, 'stale version');
    const updated = await api(ADMIN, 'PUT', '/api/tenant/packs/manufacturing/config', { config: { vibration_warning_mm_s: 6.5, vibration_warning_clear_mm_s: 5.5 }, expected_version: pack.config_version });
    assert.equal(updated.effective_config.vibration_warning_mm_s, 6.5);
    assert.equal(updated.effective_config.vibration_critical_mm_s, 11.2, 'untouched settings keep the manifest default');
    await waitFor(async () => (await api(ADMIN, 'GET', '/api/alert/rules')).find((r: any) => r.name === 'High machine vibration')?.threshold === 6.5, { what: 'the alert rule to take the configured threshold' });
  });

  it('a rule a person created is never changed by a pack', async () => {
    const own = await api(ADMIN, 'POST', '/api/alert/rules', { name: `Own rule ${unique()}`, sensor_kind: 'vibration_rms', operator: 'gt', threshold: 20, severity: 'info', create_incident: false });
    await api(ADMIN, 'POST', '/api/tenant/packs/manufacturing/resync');
    await waitFor(async () => (await api(ADMIN, 'GET', '/api/tenant/packs/history')).some((h: any) => h.action === 'resync'), { what: 'the resync to be recorded' });
    const after = (await api(ADMIN, 'GET', '/api/alert/rules')).find((r: any) => r.id === own.id);
    assert.equal(after.threshold, 20);
    assert.equal(after.pack_id, null);
    assert.equal(after.version, own.version);
  });

  let exported: any;

  it('the configuration can be exported', async () => {
    exported = await api(ADMIN, 'GET', '/api/tenant/packs/export');
    assert.equal(exported.format, 'titan-pack-configuration/1');
    assert.equal(exported.tenant_id, TENANT_D);
    const manufacturing = exported.packs.find((p: any) => p.pack_id === 'manufacturing');
    assert.deepEqual([manufacturing.version, manufacturing.status, manufacturing.config.vibration_warning_mm_s], ['1.1.0', 'active', 6.5]);
    assert.equal((await rawApi('dan.technician', 'GET', '/api/tenant/packs/export')).status, 403);
  });

  it('deactivation withdraws the capabilities only that pack provided, and deletes nothing', async () => {
    const result = await api(ADMIN, 'POST', '/api/tenant/packs/manufacturing/deactivate');
    assert.equal(result.pack.status, 'disabled');
    // facilities still provides maintenance; nothing provides iot any more.
    assert.deepEqual(await capabilities(ADMIN), ['maintenance']);
    await waitForAccess(ADMIN, '/api/device/devices', 403, 'device-service to refuse the tenant');
    assert.equal((await rawApi(ADMIN, 'GET', `/api/device/devices/${device.id}`)).body.error.code, 'capability_disabled');
    assert.ok(!(await navigation(ADMIN)).includes('Production equipment'));
    // Maintenance records of the deactivated pack are still there, through the capability the other pack provides.
    const kept = await api(ADMIN, 'GET', '/api/maintenance/requests?pack=manufacturing&limit=500');
    assert.ok(kept.some((r: any) => r.id === inFlight.id));
    // Definitions and categories the pack installed remain (processes in flight could still need them).
    assert.ok((await api(ADMIN, 'GET', '/api/workflow/definitions')).some((d: any) => d.key === 'maintenance-approval' && d.active));
    assert.ok((await api(ADMIN, 'GET', '/api/asset/categories')).some((c: any) => c.code === 'CNC_MACHINE'));
    assert.equal((await api(ADMIN, 'POST', '/api/tenant/packs/manufacturing/deactivate')).changed, false, 'deactivating again changes nothing');
  });

  it('restoring the exported configuration brings back packs, versions, settings and data access', async () => {
    const plan = await api(ADMIN, 'POST', '/api/tenant/packs/import', { document: exported, dry_run: true });
    assert.equal(plan.dry_run, true);
    assert.equal(plan.actions.find((a: any) => a.pack_id === 'manufacturing').action, 'would_change');
    assert.equal((await packOf(ADMIN, 'manufacturing')).status, 'disabled', 'a dry run changes nothing');

    const restored = await api(ADMIN, 'POST', '/api/tenant/packs/import', { document: exported });
    assert.equal(restored.actions.find((a: any) => a.pack_id === 'manufacturing').action, 'reactivated');
    const pack = await packOf(ADMIN, 'manufacturing');
    assert.deepEqual([pack.version, pack.status, pack.effective_config.vibration_warning_mm_s], ['1.1.0', 'active', 6.5]);
    await waitForAccess(ADMIN, '/api/device/devices', 200, 'device-service to serve the tenant again');
    assert.equal((await api(ADMIN, 'GET', `/api/device/devices/${device.id}`)).serial_no, device.serial_no, 'the device registered before deactivation is still there');
  });

  it('an export of another tenant is applied to the caller\'s own tenant only', async () => {
    const foreign = { ...exported, tenant_id: TENANT_A };
    await api(ADMIN, 'POST', '/api/tenant/packs/import', { document: foreign });
    assert.deepEqual((await api('adam.admin', 'GET', '/api/tenant/packs')).map((p: any) => p.pack_id).sort(), ['disaster-infrastructure', 'integration-hub', 'operational-reporting', 'platform-core', 'procurement-inventory', 'public-services', 'video-monitoring']);
  });

  it('every change is in the pack history and in the audit trail', async () => {
    const actions = new Set((await api(ADMIN, 'GET', '/api/tenant/packs/history')).filter((h: any) => h.pack_id === 'manufacturing').map((h: any) => h.action));
    for (const action of ['upgraded', 'reconfigured', 'deactivated', 'reactivated', 'resync']) assert.ok(actions.has(action), `history has '${action}'`);
    await waitFor(async () => {
      const types = new Set((await api(ADMIN, 'GET', `/api/audit/audit?aggregate_id=${TENANT_D}&limit=200`)).items.map((r: any) => r.event_type));
      return ['tenant.pack.activated.v1', 'tenant.pack.deactivated.v1', 'tenant.entitlements.changed.v1'].every((t) => types.has(t));
    }, { what: 'pack events to be audited' });
  });

  after(async () => {
    // Leave Harbourline as the seed made it: facilities only. Records stay.
    await api(ADMIN, 'POST', `/api/device/devices/${device.id}/decommission`).catch(() => undefined);
    await api(ADMIN, 'POST', '/api/tenant/packs/manufacturing/deactivate');
    await waitForAccess(ADMIN, '/api/device/devices', 403);
  });
});

describe('Pack dependencies and tenant dashboards', () => {
  it('a dashboard layout is the tenant\'s own, validated against the dashboard\'s widgets', async () => {
    const before = (await api('maya.admin', 'GET', '/api/tenant/workspace')).dashboards.find((d: any) => d.key === 'facilities');
    await api('maya.admin', 'DELETE', '/api/tenant/workspace/dashboards/facilities');
    assert.equal((await rawApi('maya.admin', 'PUT', '/api/tenant/workspace/dashboards/facilities', { widgets: ['no-such-widget'], expected_version: 0 })).status, 400);
    assert.equal((await rawApi('tim.technician', 'PUT', '/api/tenant/workspace/dashboards/facilities', { widgets: [], expected_version: 0 })).status, 403);
    const chosen = [before.available_widgets[1].id, before.available_widgets[0].id];
    const saved = await api('maya.admin', 'PUT', '/api/tenant/workspace/dashboards/facilities', { widgets: chosen, expected_version: 0 });
    assert.equal(saved.version, 1);
    const after = (await api('tim.technician', 'GET', '/api/tenant/workspace')).dashboards.find((d: any) => d.key === 'facilities');
    assert.deepEqual(after.widgets.map((w: any) => w.id), chosen, 'every user of the tenant gets the tenant layout');
    assert.equal(after.customised, true);
    // Another tenant with the same pack keeps the pack's own layout.
    const other = (await api('dora.admin', 'GET', '/api/tenant/workspace')).dashboards.find((d: any) => d.key === 'facilities');
    assert.equal(other.customised, false);
    assert.equal(other.widgets.length, before.available_widgets.length);
    assert.equal((await rawApi('maya.admin', 'PUT', '/api/tenant/workspace/dashboards/facilities', { widgets: chosen, expected_version: 0 })).status, 409, 'stale layout version');
    await api('maya.admin', 'DELETE', '/api/tenant/workspace/dashboards/facilities');
  });

  it('a dashboard of a pack the tenant does not have cannot be customised', async () => {
    assert.equal((await rawApi('adam.admin', 'PUT', '/api/tenant/workspace/dashboards/manufacturing', { widgets: [], expected_version: 0 })).status, 404);
  });

  it('every tenant has the platform core, which is what the other packs depend on', async () => {
    for (const admin of ['adam.admin', 'brian.admin', 'maya.admin', 'dora.admin']) {
      const core = await packOf(admin, 'platform-core');
      assert.equal(core.status, 'active');
      assert.equal(core.core, true);
    }
    const catalog = await api('adam.admin', 'GET', '/api/tenant/packs/catalog');
    for (const pack of catalog.filter((p: any) => !p.core)) assert.deepEqual(pack.requires_packs.map((r: any) => r.id), ['platform-core']);
  });
});
