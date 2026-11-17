import { PackManifest, resolvePackInstall, PackConfigError } from '@titan/contracts';
import { describe, expect, it } from 'vitest';
import { activationAction, entitledCapabilities, missingDependencies, stableStringify } from './packs.rules.js';

const manifest = (over: Record<string, unknown> = {}) =>
  PackManifest.parse({ schema_version: 1, id: 'demo-pack', version: '1.0.0', name: 'Demo', industry: 'Demo', description: 'Demo pack', ...over });

describe('pack manifest schema', () => {
  it('rejects a capability the platform does not offer', () => {
    const result = PackManifest.safeParse({ schema_version: 1, id: 'demo-pack', version: '1.0.0', name: 'Demo', industry: 'Demo', description: '', requires: { capabilities: ['root_access'] } });
    expect(result.success).toBe(false);
  });

  it('rejects templates whose installing capability is not requested', () => {
    const result = PackManifest.safeParse({
      schema_version: 1, id: 'demo-pack', version: '1.0.0', name: 'Demo', industry: 'Demo', description: '',
      alert_rules: [{ name: 'Too hot', sensor_kind: 'temperature', operator: 'gt', threshold: 50, severity: 'warning' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a reference to a configuration key that is not declared', () => {
    const result = PackManifest.safeParse({
      schema_version: 1, id: 'demo-pack', version: '1.0.0', name: 'Demo', industry: 'Demo', description: '',
      requires: { capabilities: ['iot'] },
      alert_rules: [{ name: 'Too hot', sensor_kind: 'temperature', operator: 'gt', threshold: { $config: 'limit' }, severity: 'warning' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects anything that is not declarative data in a configuration reference', () => {
    const result = PackManifest.safeParse({
      schema_version: 1, id: 'demo-pack', version: '1.0.0', name: 'Demo', industry: 'Demo', description: '',
      requires: { capabilities: ['iot'] },
      config_schema: [{ name: 'limit', label: 'Limit', type: 'number' }],
      alert_rules: [{ name: 'Too hot', sensor_kind: 'temperature', operator: 'gt', threshold: { $config: 'limit', $eval: 'process.exit()' }, severity: 'warning' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('configuration resolution', () => {
  const pack = manifest({
    requires: { capabilities: ['iot'] },
    config_schema: [{ name: 'limit', label: 'Limit', type: 'number', required: true, min: 0, max: 100 }],
    config_defaults: { limit: 50 },
    alert_rules: [{ name: 'Too hot', sensor_kind: 'temperature', operator: 'gt', threshold: { $config: 'limit' }, clear_threshold: 40, severity: 'warning' }],
  });

  it('uses the manifest default, and the tenant value when given', () => {
    expect(resolvePackInstall(pack).alert_rules[0]!.threshold).toBe(50);
    expect(resolvePackInstall(pack, { limit: 70 }).alert_rules[0]!.threshold).toBe(70);
  });

  it('refuses tenant values outside the schema, and unknown keys', () => {
    expect(() => resolvePackInstall(pack, { limit: 500 })).toThrow(PackConfigError);
    expect(() => resolvePackInstall(pack, { limit: 'hot' })).toThrow(PackConfigError);
    expect(() => resolvePackInstall(pack, { other: 1 })).toThrow(PackConfigError);
  });
});

describe('entitlements', () => {
  it('are the union of the capabilities of the active packs', () => {
    const a = manifest({ id: 'pack-a', requires: { capabilities: ['iot', 'maintenance'] } });
    const b = manifest({ id: 'pack-b', requires: { capabilities: ['maintenance'] } });
    expect(entitledCapabilities([{ id: 'pack-a', version: '1.0.0', manifest: a }, { id: 'pack-b', version: '1.0.0', manifest: b }])).toEqual(['iot', 'maintenance']);
    // Deactivating one pack keeps a capability another active pack still provides.
    expect(entitledCapabilities([{ id: 'pack-b', version: '1.0.0', manifest: b }])).toEqual(['maintenance']);
    expect(entitledCapabilities([])).toEqual([]);
  });
});

describe('dependencies', () => {
  const core = manifest({ id: 'platform-core', version: '1.2.0' });
  const needsCore = manifest({ requires: { packs: [{ id: 'platform-core', min_version: '1.1.0' }] } });

  it('are satisfied by an active pack of a sufficient version', () => {
    expect(missingDependencies(needsCore, [{ id: 'platform-core', version: '1.2.0', manifest: core }])).toEqual([]);
  });

  it('report a missing pack and a pack that is too old', () => {
    expect(missingDependencies(needsCore, [])).toEqual([{ id: 'platform-core', min_version: '1.1.0', active_version: null }]);
    expect(missingDependencies(needsCore, [{ id: 'platform-core', version: '1.0.0', manifest: core }])).toEqual([{ id: 'platform-core', min_version: '1.1.0', active_version: '1.0.0' }]);
  });
});

describe('activation action', () => {
  const v1 = manifest();
  const v11 = manifest({ version: '1.1.0', lifecycle: { upgrades_from: ['1.0.0'] } });
  const v2 = manifest({ version: '2.0.0', lifecycle: { upgrades_from: ['1.1.0'] } });

  it('distinguishes first activation, reactivation, reconfiguration and no change', () => {
    expect(activationAction(null, v1, false)).toBe('activated');
    expect(activationAction({ version: '1.0.0', status: 'disabled' }, v1, false)).toBe('reactivated');
    expect(activationAction({ version: '1.0.0', status: 'active' }, v1, true)).toBe('reconfigured');
    expect(activationAction({ version: '1.0.0', status: 'active' }, v1, false)).toBe('unchanged');
  });

  it('allows an upgrade only along a declared path', () => {
    expect(activationAction({ version: '1.0.0', status: 'active' }, v11, false)).toBe('upgraded');
    expect(activationAction({ version: '1.0.0', status: 'active' }, v2, false)).toBe('unsupported_upgrade');
    expect(activationAction({ version: '1.1.0', status: 'disabled' }, v2, false)).toBe('upgraded');
  });

  it('recognises a move to an older version', () => {
    expect(activationAction({ version: '1.1.0', status: 'active' }, v1, false)).toBe('downgraded');
  });
});

describe('stableStringify', () => {
  it('ignores key order and keeps array order', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});
