import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { hasAnyRole, type Principal } from '@titan/authentication';
import {
  compareVersions,
  effectivePackConfig,
  PackConfigError,
  PackManifest,
  PLATFORM_TENANT_ID,
  resolvePackInstall,
  STAFF_ROLES,
} from '@titan/contracts';
import type { Logger } from '@titan/observability';
import { Db, DomainError, LOGGER, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { activationAction, CORE_PACK_ID, entitledCapabilities, missingDependencies, type ActivePack, stableStringify } from './packs.rules.js';

export const ActivatePack = z.object({
  /** Catalogue version to activate; the latest when omitted. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  /** Tenant values for the pack's configuration schema; unchanged when omitted. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** Moving to an older version is refused unless this is set. */
  allow_downgrade: z.boolean().default(false),
});

export const UpdatePackConfig = z.object({
  config: z.record(z.string(), z.unknown()),
  expected_version: z.number().int().positive(),
});

export const SaveDashboardLayout = z.object({
  /** Ids of the dashboard's widgets to show, in display order. */
  widgets: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,62}$/)).max(24),
  /** Layout version last read; 0 when the dashboard has never been customised. */
  expected_version: z.number().int().min(0),
});

export const ImportPackConfiguration = z.object({
  document: z.object({
    format: z.literal('titan-pack-configuration/1'),
    packs: z.array(
      z.object({
        pack_id: z.string(),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        status: z.enum(['active', 'disabled']),
        config: z.record(z.string(), z.unknown()).default({}),
      }),
    ),
    dashboard_layouts: z.array(z.object({ dashboard_key: z.string(), widgets: z.array(z.string()) })).default([]),
  }),
  /** Report what would change without changing anything. */
  dry_run: z.boolean().default(false),
});

export interface TenantPackRow {
  tenant_id: string;
  pack_id: string;
  version: string;
  status: 'active' | 'disabled';
  config: Record<string, unknown>;
  row_version: number;
  activated_by: string;
  activated_at: Date;
  disabled_by: string | null;
  disabled_at: Date | null;
  updated_at: Date;
}

const ROW = 'tenant_id, pack_id, version, status, config, row_version, activated_by, activated_at, disabled_by, disabled_at, updated_at';
const PACKS_DIR = fileURLToPath(new URL('../packs', import.meta.url));

/**
 * Industry-pack registry and tenant activation.
 *
 * The catalogue is read from the declarative manifests shipped with this
 * service (never from uploads) and recorded, immutably, in `pack_catalog`.
 * Activating a pack records it for the tenant and announces, in the same
 * transaction, (a) the templates the owning services install and (b) the
 * tenant's complete entitlements, which every service enforces locally.
 */
@Injectable()
export class PacksService implements OnApplicationBootstrap {
  private readonly catalog = new Map<string, Map<string, PackManifest>>();
  private conflicts: string[] = [];

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.registerCatalog();
    await this.announcePending();
  }

  // ---------------------------------------------------------------------------
  // Catalogue
  // ---------------------------------------------------------------------------

  /** Records the shipped manifests and loads the catalogue from the database, which is authoritative. */
  private async registerCatalog(): Promise<void> {
    const shipped: { manifest: PackManifest; checksum: string }[] = [];
    for (const id of await readdir(PACKS_DIR)) {
      for (const file of (await readdir(path.join(PACKS_DIR, id))).filter((f) => f.endsWith('.json'))) {
        const raw = JSON.parse(await readFile(path.join(PACKS_DIR, id, file), 'utf8')) as unknown;
        const parsed = PackManifest.safeParse(raw);
        if (!parsed.success) throw new Error(`pack manifest ${id}/${file} is invalid: ${JSON.stringify(parsed.error.issues)}`);
        if (parsed.data.id !== id || `${parsed.data.version}.json` !== file) throw new Error(`pack manifest ${id}/${file} does not match its id and version`);
        shipped.push({ manifest: parsed.data, checksum: createHash('sha256').update(stableStringify(raw)).digest('hex') });
      }
    }
    await this.db.tx(null, async (q) => {
      for (const { manifest, checksum } of shipped) {
        const stored = await q.maybeOne<{ checksum: string }>(
          `INSERT INTO pack_catalog (pack_id, version, name, industry, manifest, checksum) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (pack_id, version) DO NOTHING
           RETURNING checksum`,
          [manifest.id, manifest.version, manifest.name, manifest.industry, JSON.stringify(manifest), checksum],
        );
        if (stored) {
          this.logger.info({ pack: manifest.id, version: manifest.version }, 'industry pack version registered');
          continue;
        }
        const existing = await q.one<{ checksum: string }>('SELECT checksum FROM pack_catalog WHERE pack_id = $1 AND version = $2', [manifest.id, manifest.version]);
        if (existing.checksum !== checksum) {
          // A published version never changes. The registered content stays in force.
          this.conflicts.push(`${manifest.id}@${manifest.version}`);
          this.logger.error({ pack: manifest.id, version: manifest.version }, 'shipped manifest differs from the registered version; publish a new version instead');
        }
      }
      this.catalog.clear();
      for (const row of await q.query<{ pack_id: string; version: string; manifest: unknown }>('SELECT pack_id, version, manifest FROM pack_catalog')) {
        const versions = this.catalog.get(row.pack_id) ?? new Map<string, PackManifest>();
        versions.set(row.version, PackManifest.parse(row.manifest));
        this.catalog.set(row.pack_id, versions);
      }
    });
    if (!this.catalog.has(CORE_PACK_ID)) throw new Error(`the '${CORE_PACK_ID}' pack is missing from the catalogue`);
  }

  private versionsOf(packId: string): string[] {
    return [...(this.catalog.get(packId)?.keys() ?? [])].sort(compareVersions);
  }

  private manifest(packId: string, version?: string): PackManifest {
    const versions = this.catalog.get(packId);
    const wanted = version ?? this.versionsOf(packId).at(-1);
    const found = wanted ? versions?.get(wanted) : undefined;
    if (!found) throw DomainError.notFound(version ? `pack ${packId} version ${version}` : `pack ${packId}`);
    return found;
  }

  listCatalog() {
    return [...this.catalog.keys()].sort().map((id) => {
      const versions = this.versionsOf(id);
      const latest = this.manifest(id);
      return {
        id,
        name: latest.name,
        industry: latest.industry,
        description: latest.description,
        latest_version: latest.version,
        core: id === CORE_PACK_ID,
        capabilities: latest.requires.capabilities,
        requires_packs: latest.requires.packs,
        versions: versions.map((v) => {
          const m = this.manifest(id, v);
          return { version: v, upgrades_from: m.lifecycle.upgrades_from, changes: m.lifecycle.changes };
        }),
        contents: {
          roles: latest.roles.map((r) => r.role),
          workflows: latest.workflows.map((w) => ({ key: w.key, subject_type: w.subject_type })),
          forms: latest.forms.map((f) => f.key),
          asset_categories: latest.asset_categories.map((c) => c.code),
          sensor_profiles: latest.sensor_profiles.map((p) => p.key),
          alert_rules: latest.alert_rules.map((r) => r.name),
          incident_categories: latest.incident_categories.map((c) => c.key),
          request_types: latest.request_types.map((t) => t.key),
          dashboards: latest.dashboards.map((d) => d.key),
          ai_tools: latest.ai_tools,
        },
        catalog_conflict: this.conflicts.some((c) => c.startsWith(`${id}@`)),
      };
    });
  }

  getManifest(packId: string, version: string): PackManifest {
    return this.manifest(packId, version);
  }

  // ---------------------------------------------------------------------------
  // Tenant state
  // ---------------------------------------------------------------------------

  private rows(q: Q, tenantId: string, lock = false): Promise<TenantPackRow[]> {
    return q.query<TenantPackRow>(`SELECT ${ROW} FROM tenant_packs WHERE tenant_id = $1 ORDER BY pack_id ${lock ? 'FOR UPDATE' : ''}`, [tenantId]);
  }

  private activeOf(rows: TenantPackRow[]): ActivePack[] {
    return rows.filter((r) => r.status === 'active').map((r) => ({ id: r.pack_id, version: r.version, manifest: this.manifest(r.pack_id, r.version) }));
  }

  private describe(row: TenantPackRow) {
    const manifest = this.manifest(row.pack_id, row.version);
    const latest = this.manifest(row.pack_id);
    return {
      pack_id: row.pack_id,
      name: manifest.name,
      industry: manifest.industry,
      version: row.version,
      status: row.status,
      core: row.pack_id === CORE_PACK_ID,
      capabilities: manifest.requires.capabilities,
      config: row.config,
      effective_config: effectivePackConfig(manifest, row.config),
      config_schema: manifest.config_schema,
      config_version: row.row_version,
      latest_version: latest.version,
      upgrade_available: compareVersions(latest.version, row.version) > 0 && latest.lifecycle.upgrades_from.includes(row.version),
      activated_by: row.activated_by,
      activated_at: row.activated_at,
      disabled_by: row.disabled_by,
      disabled_at: row.disabled_at,
    };
  }

  listTenantPacks(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => (await this.rows(q, user.tenantId)).map((r) => this.describe(r)));
  }

  history(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query('SELECT id, pack_id, action, from_version, to_version, config, actor, occurred_at FROM tenant_pack_history WHERE tenant_id = $1 ORDER BY occurred_at DESC, id LIMIT 200', [
        user.tenantId,
      ]),
    );
  }

  entitlements(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const active = this.activeOf(await this.rows(q, user.tenantId));
      const revision = await q.maybeOne<{ revision: number }>('SELECT revision FROM tenant_entitlement_revisions WHERE tenant_id = $1', [user.tenantId]);
      return {
        tenant_id: user.tenantId,
        revision: revision?.revision ?? 0,
        capabilities: entitledCapabilities(active),
        packs: active.map((p) => ({ id: p.id, version: p.version })),
        query_templates: [...new Set(active.flatMap((p) => p.manifest.query_templates))].sort(),
        ai_tools: [...new Set(active.flatMap((p) => p.manifest.ai_tools))].sort(),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Announcements (outbox, same transaction as the change)
  // ---------------------------------------------------------------------------

  private async announceInstall(q: Q, tenantId: string, row: TenantPackRow, previousVersion: string | null, reason: 'activated' | 'upgraded' | 'reconfigured' | 'resync') {
    const manifest = this.manifest(row.pack_id, row.version);
    await this.outbox.emit(q, {
      type: 'tenant.pack.activated.v1',
      aggregateType: 'tenant_pack',
      aggregateId: tenantId,
      tenantId,
      payload: { tenant_id: tenantId, pack_id: row.pack_id, version: row.version, previous_version: previousVersion, reason, install: resolvePackInstall(manifest, row.config) },
    });
  }

  /** Recomputes the tenant's entitlements from its active packs and announces the complete state. */
  private async announceEntitlements(q: Q, tenantId: string): Promise<void> {
    const active = this.activeOf(await this.rows(q, tenantId));
    const { revision } = await q.one<{ revision: number }>(
      `INSERT INTO tenant_entitlement_revisions (tenant_id, revision) VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET revision = tenant_entitlement_revisions.revision + 1
       RETURNING revision`,
      [tenantId],
    );
    await this.outbox.emit(q, {
      type: 'tenant.entitlements.changed.v1',
      aggregateType: 'tenant',
      aggregateId: tenantId,
      tenantId,
      payload: { tenant_id: tenantId, revision, capabilities: entitledCapabilities(active), packs: active.map((p) => ({ id: p.id, version: p.version })) },
    });
  }

  private record(q: Q, tenantId: string, packId: string, action: string, from: string | null, to: string | null, config: unknown, actor: string) {
    return q.exec('INSERT INTO tenant_pack_history (tenant_id, pack_id, action, from_version, to_version, config, actor) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      tenantId,
      packId,
      action,
      from,
      to,
      config === null ? null : JSON.stringify(config),
      actor,
    ]);
  }

  /** Announces activations recorded without an announcement (the upgrade backfill of migration 0002). */
  private async announcePending(): Promise<void> {
    const announced = await this.db.tx(PLATFORM_TENANT_ID, async (q) => {
      const pending = await q.query<TenantPackRow>(`SELECT ${ROW} FROM tenant_packs WHERE sync_pending ORDER BY tenant_id, pack_id FOR UPDATE SKIP LOCKED`);
      for (const row of pending) {
        if (row.status === 'active') await this.announceInstall(q, row.tenant_id, row, null, 'activated');
        await q.exec('UPDATE tenant_packs SET sync_pending = false WHERE tenant_id = $1 AND pack_id = $2', [row.tenant_id, row.pack_id]);
      }
      for (const tenantId of new Set(pending.map((r) => r.tenant_id))) await this.announceEntitlements(q, tenantId);
      return pending.length;
    });
    if (announced) this.logger.info({ activations: announced }, 'pending pack activations announced');
  }

  /** Re-announces the entitlements of every tenant (for a service whose projection was lost or that joined later). */
  republishEntitlements() {
    return this.db.tx(PLATFORM_TENANT_ID, async (q) => {
      const tenants = await q.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
      for (const t of tenants) await this.announceEntitlements(q, t.id);
      return { tenants: tenants.length };
    });
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** Gives a new tenant the platform core. Called inside the transaction that creates the tenant. */
  async activateCore(q: Q, tenantId: string, actor: string): Promise<void> {
    const manifest = this.manifest(CORE_PACK_ID);
    const row = await q.one<TenantPackRow>(
      `INSERT INTO tenant_packs (tenant_id, pack_id, version, status, activated_by) VALUES ($1, $2, $3, 'active', $4) RETURNING ${ROW}`,
      [tenantId, CORE_PACK_ID, manifest.version, actor],
    );
    await this.record(q, tenantId, CORE_PACK_ID, 'activated', null, manifest.version, {}, actor);
    await this.announceInstall(q, tenantId, row, null, 'activated');
    await this.announceEntitlements(q, tenantId);
  }

  private validConfig(manifest: PackManifest, config: Record<string, unknown>): void {
    try {
      resolvePackInstall(manifest, config);
    } catch (err) {
      if (err instanceof PackConfigError) throw DomainError.invalid(err.message, err.issues);
      throw err;
    }
  }

  private async activateIn(q: Q, tenantId: string, actor: string, packId: string, input: z.infer<typeof ActivatePack>) {
    const target = this.manifest(packId, input.version);
    const rows = await this.rows(q, tenantId, true);
    const current = rows.find((r) => r.pack_id === packId) ?? null;
    const active = this.activeOf(rows).filter((p) => p.id !== packId);

    const missing = missingDependencies(target, active);
    if (missing.length) {
      throw new DomainError(409, 'missing_dependency', `activate ${missing.map((m) => m.id).join(', ')} first`, { missing });
    }
    const action = activationAction(current && { version: current.version, status: current.status }, target, input.config !== undefined && stableStringify(input.config) !== stableStringify(current?.config ?? {}));
    if (action === 'unchanged') return { changed: false, action, pack: this.describe(current!) };
    if (action === 'unsupported_upgrade') {
      throw new DomainError(409, 'unsupported_upgrade', `${packId} ${target.version} cannot be reached directly from ${current!.version}`, { supported_from: target.lifecycle.upgrades_from });
    }
    if (action === 'downgraded' && !input.allow_downgrade) {
      throw new DomainError(409, 'downgrade_not_allowed', `${packId} is at ${current!.version}; moving to the older ${target.version} needs allow_downgrade`);
    }

    const config = input.config ?? current?.config ?? {};
    this.validConfig(target, config);
    const row = await q.one<TenantPackRow>(
      `INSERT INTO tenant_packs (tenant_id, pack_id, version, status, config, activated_by) VALUES ($1, $2, $3, 'active', $4, $5)
       ON CONFLICT (tenant_id, pack_id) DO UPDATE
         SET version = EXCLUDED.version, status = 'active', config = EXCLUDED.config, row_version = tenant_packs.row_version + 1,
             activated_by = EXCLUDED.activated_by, activated_at = now(), disabled_by = NULL, disabled_at = NULL, sync_pending = false, updated_at = now()
       RETURNING ${ROW}`,
      [tenantId, packId, target.version, JSON.stringify(config), actor],
    );
    await this.record(q, tenantId, packId, action, current?.version ?? null, target.version, config, actor);
    const previous = current && current.version !== target.version ? current.version : null;
    await this.announceInstall(q, tenantId, row, previous, action === 'upgraded' ? 'upgraded' : action === 'reconfigured' ? 'reconfigured' : 'activated');
    await this.announceEntitlements(q, tenantId);
    return { changed: true, action, pack: this.describe(row) };
  }

  activate(user: Principal, packId: string, input: z.infer<typeof ActivatePack>) {
    return this.db.tx(user.tenantId, (q) => this.activateIn(q, user.tenantId, user.username, packId, input));
  }

  private async deactivateIn(q: Q, tenantId: string, actor: string, packId: string) {
    if (packId === CORE_PACK_ID) throw DomainError.conflict('core_pack', 'the platform core cannot be deactivated');
    const rows = await this.rows(q, tenantId, true);
    const current = rows.find((r) => r.pack_id === packId);
    if (!current) throw DomainError.notFound(`pack ${packId} for this tenant`);
    if (current.status === 'disabled') return { changed: false, pack: this.describe(current) };
    const dependents = this.activeOf(rows).filter((p) => p.id !== packId && p.manifest.requires.packs.some((r) => r.id === packId));
    if (dependents.length) {
      throw new DomainError(409, 'required_by', `${packId} is required by ${dependents.map((d) => d.id).join(', ')}`, { required_by: dependents.map((d) => d.id) });
    }
    // Only the status changes. Definitions the pack installed and every business record stay where they are.
    const row = await q.one<TenantPackRow>(
      `UPDATE tenant_packs SET status = 'disabled', disabled_by = $3, disabled_at = now(), row_version = row_version + 1, updated_at = now()
        WHERE tenant_id = $1 AND pack_id = $2 RETURNING ${ROW}`,
      [tenantId, packId, actor],
    );
    await this.record(q, tenantId, packId, 'deactivated', current.version, current.version, null, actor);
    await this.outbox.emit(q, {
      type: 'tenant.pack.deactivated.v1',
      aggregateType: 'tenant_pack',
      aggregateId: tenantId,
      tenantId,
      payload: { tenant_id: tenantId, pack_id: packId, version: current.version, deactivated_by: actor },
    });
    await this.announceEntitlements(q, tenantId);
    return { changed: true, pack: this.describe(row) };
  }

  deactivate(user: Principal, packId: string) {
    return this.db.tx(user.tenantId, (q) => this.deactivateIn(q, user.tenantId, user.username, packId));
  }

  updateConfig(user: Principal, packId: string, input: z.infer<typeof UpdatePackConfig>) {
    return this.db.tx(user.tenantId, async (q) => {
      const current = (await this.rows(q, user.tenantId, true)).find((r) => r.pack_id === packId);
      if (!current) throw DomainError.notFound(`pack ${packId} for this tenant`);
      if (current.row_version !== input.expected_version) throw DomainError.conflict('stale_version', 'the pack configuration was changed by someone else; reload and retry');
      this.validConfig(this.manifest(packId, current.version), input.config);
      const row = await q.one<TenantPackRow>(
        `UPDATE tenant_packs SET config = $3, row_version = row_version + 1, updated_at = now() WHERE tenant_id = $1 AND pack_id = $2 RETURNING ${ROW}`,
        [user.tenantId, packId, JSON.stringify(input.config)],
      );
      await this.record(q, user.tenantId, packId, 'reconfigured', current.version, current.version, input.config, user.username);
      // The templates depend on the configuration (e.g. alarm thresholds): owners re-install them.
      if (row.status === 'active') await this.announceInstall(q, user.tenantId, row, null, 'reconfigured');
      return this.describe(row);
    });
  }

  /** Re-announces a pack's templates and the tenant's entitlements. Changes nothing in this service. */
  resync(user: Principal, packId: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const current = (await this.rows(q, user.tenantId, true)).find((r) => r.pack_id === packId);
      if (!current) throw DomainError.notFound(`pack ${packId} for this tenant`);
      if (current.status !== 'active') throw DomainError.conflict('invalid_state', 'only an active pack can be re-synchronised');
      await this.record(q, user.tenantId, packId, 'resync', current.version, current.version, null, user.username);
      await this.announceInstall(q, user.tenantId, current, null, 'resync');
      await this.announceEntitlements(q, user.tenantId);
      return { pack_id: packId, version: current.version, resynchronised: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Configuration backup and restoration
  // ---------------------------------------------------------------------------

  exportConfiguration(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const rows = await this.rows(q, user.tenantId);
      const layouts = await q.query<{ dashboard_key: string; widgets: string[] }>('SELECT dashboard_key, widgets FROM dashboard_layouts WHERE tenant_id = $1 ORDER BY dashboard_key', [user.tenantId]);
      return {
        format: 'titan-pack-configuration/1' as const,
        tenant_id: user.tenantId,
        exported_at: new Date().toISOString(),
        exported_by: user.username,
        packs: rows.map((r) => ({ pack_id: r.pack_id, version: r.version, status: r.status, config: r.config })),
        dashboard_layouts: layouts,
      };
    });
  }

  /**
   * Restores pack activation, versions, configuration and dashboard layouts
   * from an export. Always applied to the caller's own tenant, whatever
   * tenant the document names.
   */
  importConfiguration(user: Principal, input: z.infer<typeof ImportPackConfiguration>) {
    const { document, dry_run: dryRun } = input;
    // Dependencies first: packs that require nothing, then the others.
    const ordered = [...document.packs].sort((a, b) => Number(a.pack_id !== CORE_PACK_ID) - Number(b.pack_id !== CORE_PACK_ID));
    for (const p of ordered) this.manifest(p.pack_id, p.version); // every referenced version must exist in this catalogue
    return this.db.tx(user.tenantId, async (q) => {
      const actions: { pack_id: string; action: string }[] = [];
      for (const p of ordered.filter((x) => x.status === 'active')) {
        const before = (await this.rows(q, user.tenantId)).find((r) => r.pack_id === p.pack_id);
        if (dryRun) {
          const same = before?.status === 'active' && before.version === p.version && stableStringify(before.config) === stableStringify(p.config);
          actions.push({ pack_id: p.pack_id, action: same ? 'unchanged' : before ? 'would_change' : 'would_activate' });
          continue;
        }
        const result = await this.activateIn(q, user.tenantId, user.username, p.pack_id, { version: p.version, config: p.config, allow_downgrade: true });
        actions.push({ pack_id: p.pack_id, action: result.action });
      }
      for (const p of ordered.filter((x) => x.status === 'disabled')) {
        const before = (await this.rows(q, user.tenantId)).find((r) => r.pack_id === p.pack_id);
        if (!before || before.status === 'disabled') {
          actions.push({ pack_id: p.pack_id, action: 'unchanged' });
        } else if (dryRun) {
          actions.push({ pack_id: p.pack_id, action: 'would_deactivate' });
        } else {
          await this.deactivateIn(q, user.tenantId, user.username, p.pack_id);
          actions.push({ pack_id: p.pack_id, action: 'deactivated' });
        }
      }
      if (!dryRun) {
        for (const layout of document.dashboard_layouts) {
          await q.exec(
            `INSERT INTO dashboard_layouts (tenant_id, dashboard_key, widgets, updated_by) VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, dashboard_key) DO UPDATE SET widgets = EXCLUDED.widgets, version = dashboard_layouts.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [user.tenantId, layout.dashboard_key, JSON.stringify(layout.widgets), user.username],
          );
        }
      }
      return { dry_run: dryRun, actions, dashboard_layouts: document.dashboard_layouts.length };
    });
  }

  // ---------------------------------------------------------------------------
  // Workspace: navigation, dashboards and role templates for the caller
  // ---------------------------------------------------------------------------

  workspace(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      let active = this.activeOf(await this.rows(q, user.tenantId));
      // An identity outside any tenant (platform operators) still gets the core workspace.
      if (active.length === 0) active = [{ id: CORE_PACK_ID, version: this.manifest(CORE_PACK_ID).version, manifest: this.manifest(CORE_PACK_ID) }];
      active.sort((a, b) => Number(a.id !== CORE_PACK_ID) - Number(b.id !== CORE_PACK_ID) || a.id.localeCompare(b.id));
      const isStaff = hasAnyRole(user, STAFF_ROLES);
      const layouts = new Map(
        (await q.query<{ dashboard_key: string; widgets: string[]; version: number }>('SELECT dashboard_key, widgets, version FROM dashboard_layouts WHERE tenant_id = $1', [user.tenantId])).map((l) => [
          l.dashboard_key,
          l,
        ]),
      );

      const navigation = new Map<string, { key: string; label: string; href: string; icon: string; order: number; workspaces: string[] }>();
      for (const pack of active) {
        for (const item of pack.manifest.navigation) {
          const visible = item.roles.length ? hasAnyRole(user, item.roles) : item.audience === 'all' || isStaff;
          if (!visible) continue;
          const existing = navigation.get(item.key);
          if (existing) existing.workspaces.push(pack.id);
          else navigation.set(item.key, { key: item.key, label: item.label, href: item.href, icon: item.icon, order: item.order, workspaces: [pack.id] });
        }
      }

      const dashboards = active.flatMap((pack) =>
        pack.manifest.dashboards
          .filter((d) => (d.roles.length ? hasAnyRole(user, d.roles) : isStaff))
          .map((d) => {
            const layout = layouts.get(d.key);
            const byId = new Map(d.widgets.map((w) => [w.id, w]));
            const shown = layout ? layout.widgets.flatMap((id) => byId.get(id) ?? []) : d.widgets;
            return { key: d.key, title: d.title, description: d.description, pack_id: pack.id, customised: !!layout, layout_version: layout?.version ?? 0, widgets: shown, available_widgets: d.widgets.map((w) => ({ id: w.id, title: w.title })) };
          }),
      );

      const roles = new Map<string, { role: string; name: string; description: string; permissions: string[]; packs: string[] }>();
      for (const pack of active) {
        for (const r of pack.manifest.roles) {
          const existing = roles.get(r.role);
          if (existing) {
            existing.packs.push(pack.id);
            existing.permissions = [...new Set([...existing.permissions, ...r.permissions])].sort();
          } else roles.set(r.role, { role: r.role, name: r.name, description: r.description, permissions: [...r.permissions].sort(), packs: [pack.id] });
        }
      }

      return {
        tenant_id: user.tenantId,
        capabilities: entitledCapabilities(active),
        packs: active.map((p) => ({ id: p.id, name: p.manifest.name, industry: p.manifest.industry, version: p.version, core: p.id === CORE_PACK_ID })),
        // The universal workspace shows everything; an industry workspace narrows the view to one pack plus the core.
        workspaces: [{ id: 'all', name: 'Enterprise workspace' }, ...active.filter((p) => p.id !== CORE_PACK_ID).map((p) => ({ id: p.id, name: p.manifest.name }))],
        navigation: [...navigation.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)),
        dashboards,
        role_templates: [...roles.values()].sort((a, b) => a.role.localeCompare(b.role)),
      };
    });
  }

  saveDashboardLayout(user: Principal, dashboardKey: string, input: z.infer<typeof SaveDashboardLayout>) {
    return this.db.tx(user.tenantId, async (q) => {
      const active = this.activeOf(await this.rows(q, user.tenantId));
      const dashboard = active.flatMap((p) => p.manifest.dashboards).find((d) => d.key === dashboardKey);
      if (!dashboard) throw DomainError.notFound('dashboard');
      const known = new Set(dashboard.widgets.map((w) => w.id));
      const unknown = input.widgets.filter((id) => !known.has(id));
      if (unknown.length) throw DomainError.invalid(`unknown widgets: ${unknown.join(', ')}`);
      if (new Set(input.widgets).size !== input.widgets.length) throw DomainError.invalid('a widget can be listed only once');
      const current = await q.maybeOne<{ version: number }>('SELECT version FROM dashboard_layouts WHERE tenant_id = $1 AND dashboard_key = $2 FOR UPDATE', [user.tenantId, dashboardKey]);
      if ((current?.version ?? 0) !== input.expected_version) throw DomainError.conflict('stale_version', 'the dashboard layout was changed by someone else; reload and retry');
      return q.one(
        `INSERT INTO dashboard_layouts (tenant_id, dashboard_key, widgets, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, dashboard_key) DO UPDATE SET widgets = EXCLUDED.widgets, version = dashboard_layouts.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING dashboard_key, widgets, version, updated_by, updated_at`,
        [user.tenantId, dashboardKey, JSON.stringify(input.widgets), user.username],
      );
    });
  }

  resetDashboardLayout(user: Principal, dashboardKey: string) {
    return this.db.tx(user.tenantId, async (q) => ({
      dashboard_key: dashboardKey,
      reset: (await q.exec('DELETE FROM dashboard_layouts WHERE tenant_id = $1 AND dashboard_key = $2', [user.tenantId, dashboardKey])) > 0,
    }));
  }
}
