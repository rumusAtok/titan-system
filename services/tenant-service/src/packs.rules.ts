import { canonicalJson, compareVersions, type PackManifest } from '@titan/contracts';

/**
 * Pure rules of pack activation: no I/O, so each one is unit-tested.
 */

/** Present for every tenant; cannot be deactivated. */
export const CORE_PACK_ID = 'platform-core';

export interface ActivePack {
  id: string;
  version: string;
  manifest: PackManifest;
}

/** Canonical JSON (fixed key order): equal content always gives equal text. */
export const stableStringify = canonicalJson;

/** Capabilities a tenant holds: the union of what its active packs switch on. */
export function entitledCapabilities(active: readonly ActivePack[]): string[] {
  return [...new Set(active.flatMap((p) => p.manifest.requires.capabilities))].sort();
}

export interface MissingDependency {
  id: string;
  min_version: string | null;
  active_version: string | null;
}

/** Packs the target needs that the tenant does not have active (or has in too old a version). */
export function missingDependencies(target: PackManifest, active: readonly ActivePack[]): MissingDependency[] {
  return target.requires.packs.flatMap((dependency) => {
    const found = active.find((p) => p.id === dependency.id);
    const tooOld = found && dependency.min_version ? compareVersions(found.version, dependency.min_version) < 0 : false;
    return !found || tooOld ? [{ id: dependency.id, min_version: dependency.min_version ?? null, active_version: found?.version ?? null }] : [];
  });
}

export type ActivationAction = 'activated' | 'reactivated' | 'upgraded' | 'downgraded' | 'reconfigured' | 'unchanged' | 'unsupported_upgrade';

/**
 * What activating `target` means for a tenant whose current state is `current`.
 * A newer version must name the current one in `lifecycle.upgrades_from`.
 */
export function activationAction(current: { version: string; status: 'active' | 'disabled' } | null, target: PackManifest, configChanged: boolean): ActivationAction {
  if (!current) return 'activated';
  const direction = compareVersions(target.version, current.version);
  if (direction > 0) return target.lifecycle.upgrades_from.includes(current.version) ? 'upgraded' : 'unsupported_upgrade';
  if (direction < 0) return 'downgraded';
  if (current.status === 'disabled') return 'reactivated';
  return configChanged ? 'reconfigured' : 'unchanged';
}
