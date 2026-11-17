import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import { canonicalJson, type EventEnvelope, type EventPayload, type FieldSpec, FieldSpecs, packActor, PackAssetCategory, validateFieldValues } from '@titan/contracts';
import { Db, DomainError, EventConsumers, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';

export const AssetStatus = z.enum(['planned', 'active', 'under_maintenance', 'retired']);
export const AssetCondition = z.enum(['good', 'fair', 'poor', 'critical']);

/** Lifecycle: which status may follow which. `retired` is terminal. */
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  planned: ['active', 'retired'],
  active: ['under_maintenance', 'retired'],
  under_maintenance: ['active', 'retired'],
  retired: [],
};

export function canTransition(from: string, to: string): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export const CreateCategory = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,32}$/),
  name: z.string().min(2).max(200),
  description: z.string().max(500).default(''),
});

/** Publishes the next attribute schema version of a category. */
export const PublishAttributeSchema = z.object({ fields: FieldSpecs.min(1) });

export const CreateAsset = z.object({
  code: z.string().min(2).max(64),
  name: z.string().min(2).max(200),
  category_code: z.string().min(2).max(32),
  parent_id: z.uuid().nullable().default(null),
  status: AssetStatus.default('planned'),
  condition: AssetCondition.default('good'),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  attributes: z.record(z.string(), z.unknown()).default({}),
  commissioned_on: z.iso.date().nullable().default(null),
  next_maintenance_due: z.iso.datetime({ offset: true }).nullable().default(null),
  /** Site (plant, building, line) the asset is at. */
  site_id: z.uuid().nullable().default(null),
});

export const UpdateAsset = z.object({
  name: z.string().min(2).max(200).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  expected_version: z.number().int().positive(),
});

export const ChangeStatus = z.object({ status: AssetStatus, note: z.string().max(1000).optional() });

export const RecordMaintenance = z.object({
  condition: AssetCondition,
  maintained_at: z.iso.datetime({ offset: true }).optional(),
  next_maintenance_due: z.iso.datetime({ offset: true }).nullable().default(null),
  note: z.string().max(1000).optional(),
});

export const ListAssets = z.object({
  status: AssetStatus.optional(),
  category: z.string().max(32).optional(),
  /** Only assets whose category belongs to this industry pack. */
  pack: z.string().max(64).optional(),
  site_id: z.uuid().optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface AssetRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  category_id: string;
  parent_id: string | null;
  status: string;
  condition: string;
  latitude: number | null;
  longitude: number | null;
  attributes: Record<string, unknown>;
  commissioned_on: string | null;
  last_maintained_at: Date | null;
  next_maintenance_due: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  attribute_schema_version: number | null;
  site_id: string | null;
}

const COLUMNS = `a.id, a.tenant_id, a.code, a.name, a.category_id, a.parent_id, a.status, a.condition, a.latitude, a.longitude, a.attributes,
  a.commissioned_on::text AS commissioned_on, a.last_maintained_at, a.next_maintenance_due, a.version, a.created_at, a.updated_at,
  a.attribute_schema_version, a.site_id`;

interface SchemaRow {
  version: number;
  fields: FieldSpec[];
}

const SYSTEM_ACTOR = 'maintenance-service';

@Injectable()
export class AssetService implements OnApplicationBootstrap {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({
      subjects: ['tenant.pack.activated.v1', 'maintenance.work_order.started.v1', 'maintenance.work_order.completed.v1', 'maintenance.work_order.cancelled.v1'],
      handler: (event, q) => this.onEvent(event, q),
    });
  }

  // ---------------------------------------------------------------------------
  // Categories and attribute schemas
  // ---------------------------------------------------------------------------

  listCategories(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT c.id, c.code, c.name, c.description, c.pack_id,
                (SELECT count(*)::int FROM assets a WHERE a.category_id = c.id) AS asset_count,
                s.version AS attribute_schema_version, s.fields AS attribute_fields
           FROM asset_categories c LEFT JOIN asset_attribute_schemas s ON s.category_id = c.id AND s.active
          ORDER BY c.code`,
      ),
    );
  }

  createCategory(user: Principal, input: z.infer<typeof CreateCategory>) {
    return this.db.tx(user.tenantId, (q) =>
      q.one('INSERT INTO asset_categories (tenant_id, code, name, description) VALUES ($1, $2, $3, $4) RETURNING id, code, name, description', [
        user.tenantId,
        input.code,
        input.name,
        input.description,
      ]),
    );
  }

  private activeSchema(q: Q, categoryId: string): Promise<SchemaRow | null> {
    return q.maybeOne<SchemaRow>('SELECT version, fields FROM asset_attribute_schemas WHERE category_id = $1 AND active', [categoryId]);
  }

  /** Puts `version` in force for the category, creating it when it does not exist. A stored version is never rewritten. */
  private async activateSchema(q: Q, tenantId: string, categoryId: string, version: number, fields: FieldSpec[], actor: string): Promise<'unchanged' | 'activated' | 'conflict'> {
    const stored = await q.maybeOne<{ id: string; fields: FieldSpec[]; active: boolean }>(
      'SELECT id, fields, active FROM asset_attribute_schemas WHERE category_id = $1 AND version = $2 FOR UPDATE',
      [categoryId, version],
    );
    if (stored && canonicalJson(stored.fields) !== canonicalJson(fields)) return 'conflict';
    if (stored?.active) return 'unchanged';
    await q.exec('UPDATE asset_attribute_schemas SET active = false WHERE category_id = $1 AND active', [categoryId]);
    if (stored) await q.exec('UPDATE asset_attribute_schemas SET active = true WHERE id = $1', [stored.id]);
    else {
      await q.exec('INSERT INTO asset_attribute_schemas (tenant_id, category_id, version, fields, active, created_by) VALUES ($1, $2, $3, $4, true, $5)', [
        tenantId,
        categoryId,
        version,
        JSON.stringify(fields),
        actor,
      ]);
    }
    return 'activated';
  }

  publishAttributeSchema(user: Principal, categoryCode: string, input: z.infer<typeof PublishAttributeSchema>) {
    return this.db.tx(user.tenantId, async (q) => {
      const category = await q.maybeOne<{ id: string; code: string }>('SELECT id, code FROM asset_categories WHERE code = $1 FOR UPDATE', [categoryCode]);
      if (!category) throw DomainError.notFound('asset category');
      const { next } = await q.one<{ next: number }>('SELECT COALESCE(max(version), 0) + 1 AS next FROM asset_attribute_schemas WHERE category_id = $1', [category.id]);
      await this.activateSchema(q, user.tenantId, category.id, next, input.fields, user.username);
      return { category_code: category.code, version: next, fields: input.fields };
    });
  }

  listAttributeSchemas(user: Principal, categoryCode: string) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT s.version, s.fields, s.active, s.created_by, s.created_at,
                (SELECT count(*)::int FROM assets a WHERE a.category_id = s.category_id AND a.attribute_schema_version = s.version) AS assets_on_version
           FROM asset_attribute_schemas s JOIN asset_categories c ON c.id = s.category_id
          WHERE c.code = $1 ORDER BY s.version DESC`,
        [categoryCode],
      ),
    );
  }

  /** Validates attributes against the schema in force for the category. Returns the schema version, or null when the category has none. */
  private async checkAttributes(q: Q, categoryId: string, attributes: Record<string, unknown>): Promise<number | null> {
    const schema = await this.activeSchema(q, categoryId);
    if (!schema) return null;
    const issues = validateFieldValues(schema.fields, attributes);
    if (issues.length) throw DomainError.invalid(`asset attributes do not match the category's attribute schema (version ${schema.version})`, issues);
    return schema.version;
  }

  // ---------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------

  private async load(q: Q, id: string, lock = false): Promise<AssetRow> {
    const row = await q.maybeOne<AssetRow>(`SELECT ${COLUMNS} FROM assets a WHERE a.id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!row) throw DomainError.notFound('asset');
    return row;
  }

  create(user: Principal, input: z.infer<typeof CreateAsset>) {
    if ((input.latitude === null) !== (input.longitude === null)) throw DomainError.invalid('latitude and longitude must be given together');
    return this.db.tx(user.tenantId, async (q) => {
      const category = await q.maybeOne<{ id: string; code: string }>('SELECT id, code FROM asset_categories WHERE code = $1', [input.category_code]);
      if (!category) throw DomainError.invalid(`unknown category '${input.category_code}'`);
      if (input.parent_id && !(await q.maybeOne('SELECT 1 FROM assets WHERE id = $1', [input.parent_id]))) throw DomainError.invalid('parent asset not found');
      const schemaVersion = await this.checkAttributes(q, category.id, input.attributes);
      const row = await q.one<AssetRow>(
        `INSERT INTO assets AS a (tenant_id, code, name, category_id, parent_id, status, condition, latitude, longitude, attributes, commissioned_on, next_maintenance_due,
                                  attribute_schema_version, site_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING ${COLUMNS}`,
        [
          user.tenantId,
          input.code,
          input.name,
          category.id,
          input.parent_id,
          input.status,
          input.condition,
          input.latitude,
          input.longitude,
          JSON.stringify(input.attributes),
          input.commissioned_on,
          input.next_maintenance_due,
          schemaVersion,
          input.site_id,
        ],
      );
      await q.exec('INSERT INTO asset_status_history (tenant_id, asset_id, from_status, to_status, changed_by, note) VALUES ($1, $2, NULL, $3, $4, $5)', [
        user.tenantId,
        row.id,
        row.status,
        user.username,
        'Registered',
      ]);
      await this.outbox.emit(q, {
        type: 'asset.created.v1',
        aggregateType: 'asset',
        aggregateId: row.id,
        tenantId: user.tenantId,
        payload: {
          asset_id: row.id,
          code: row.code,
          name: row.name,
          category: category.code,
          status: row.status,
          condition: row.condition,
          parent_id: row.parent_id,
          latitude: row.latitude,
          longitude: row.longitude,
          next_maintenance_due: row.next_maintenance_due ? row.next_maintenance_due.toISOString() : null,
        },
      });
      return row;
    });
  }

  list(user: Principal, query: z.infer<typeof ListAssets>) {
    return this.db.tx(user.tenantId, (q) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.status) {
        params.push(query.status);
        where.push(`a.status = $${params.length}`);
      }
      if (query.category) {
        params.push(query.category);
        where.push(`c.code = $${params.length}`);
      }
      if (query.pack) {
        params.push(query.pack);
        where.push(`c.pack_id = $${params.length}`);
      }
      if (query.site_id) {
        params.push(query.site_id);
        where.push(`a.site_id = $${params.length}`);
      }
      if (query.q) {
        params.push(`%${query.q.replace(/[%_\\]/g, '\\$&')}%`);
        where.push(`(a.name ILIKE $${params.length} OR a.code ILIKE $${params.length})`);
      }
      params.push(query.limit, query.offset);
      return q.query(
        `SELECT ${COLUMNS}, c.code AS category_code, c.name AS category_name, c.pack_id AS pack_id,
                (a.status <> 'retired' AND a.next_maintenance_due IS NOT NULL AND a.next_maintenance_due < now()) AS maintenance_overdue
           FROM assets a JOIN asset_categories c ON c.id = a.category_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY a.code
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
    });
  }

  get(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const asset = await this.load(q, id);
      const category = await q.one(
        `SELECT c.code, c.name, c.pack_id, s.version AS attribute_schema_version, s.fields AS attribute_fields
           FROM asset_categories c LEFT JOIN asset_attribute_schemas s ON s.category_id = c.id AND s.active WHERE c.id = $1`,
        [asset.category_id],
      );
      const children = await q.query('SELECT id, code, name, status, condition FROM assets WHERE parent_id = $1 ORDER BY code', [id]);
      // Path from the root of the hierarchy down to this asset.
      const ancestors = await q.query(
        `WITH RECURSIVE up AS (
           SELECT id, code, name, parent_id, 0 AS depth FROM assets WHERE id = $1
           UNION ALL
           SELECT p.id, p.code, p.name, p.parent_id, up.depth + 1 FROM assets p JOIN up ON p.id = up.parent_id WHERE up.depth < 32
         )
         SELECT id, code, name FROM up WHERE depth > 0 ORDER BY depth DESC`,
        [id],
      );
      const history = await q.query('SELECT from_status, to_status, changed_by, note, changed_at FROM asset_status_history WHERE asset_id = $1 ORDER BY changed_at, id', [id]);
      return { ...asset, category, ancestors, children, history };
    });
  }

  update(user: Principal, id: string, input: z.infer<typeof UpdateAsset>) {
    return this.db.tx(user.tenantId, async (q) => {
      const current = await this.load(q, id, true);
      if (current.version !== input.expected_version) throw DomainError.conflict('stale_version', 'the asset was changed elsewhere; reload and retry');
      const latitude = input.latitude === undefined ? current.latitude : input.latitude;
      const longitude = input.longitude === undefined ? current.longitude : input.longitude;
      if ((latitude === null) !== (longitude === null)) throw DomainError.invalid('latitude and longitude must be given together');
      // Changed attributes are validated against the schema now in force; untouched attributes keep the version they had.
      const schemaVersion = input.attributes ? await this.checkAttributes(q, current.category_id, input.attributes) : current.attribute_schema_version;
      return q.one<AssetRow>(
        `UPDATE assets a SET name = $2, attributes = $3, latitude = $4, longitude = $5, attribute_schema_version = $6, version = a.version + 1, updated_at = now()
          WHERE a.id = $1 RETURNING ${COLUMNS}`,
        [id, input.name ?? current.name, JSON.stringify(input.attributes ?? current.attributes), latitude, longitude, schemaVersion],
      );
    });
  }

  changeStatus(user: Principal, id: string, input: z.infer<typeof ChangeStatus>) {
    return this.db.tx(user.tenantId, async (q) => {
      const current = await this.load(q, id, true);
      if (!canTransition(current.status, input.status)) {
        throw DomainError.conflict('invalid_transition', `an asset cannot go from '${current.status}' to '${input.status}'`);
      }
      const updated = await q.one<AssetRow>(`UPDATE assets a SET status = $2, version = a.version + 1, updated_at = now() WHERE a.id = $1 RETURNING ${COLUMNS}`, [
        id,
        input.status,
      ]);
      await q.exec('INSERT INTO asset_status_history (tenant_id, asset_id, from_status, to_status, changed_by, note) VALUES ($1, $2, $3, $4, $5, $6)', [
        user.tenantId,
        id,
        current.status,
        input.status,
        user.username,
        input.note ?? null,
      ]);
      await this.outbox.emit(q, {
        type: 'asset.status_changed.v1',
        aggregateType: 'asset',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: { asset_id: id, code: current.code, from: current.status, to: input.status, changed_by: user.userId },
      });
      return updated;
    });
  }

  recordMaintenance(user: Principal, id: string, input: z.infer<typeof RecordMaintenance>) {
    return this.db.tx(user.tenantId, async (q) => {
      const current = await this.load(q, id, true);
      if (current.status === 'retired') throw DomainError.conflict('invalid_state', 'a retired asset cannot be maintained');
      const maintainedAt = input.maintained_at ?? new Date().toISOString();
      const updated = await q.one<AssetRow>(
        `UPDATE assets a SET condition = $2, last_maintained_at = $3, next_maintenance_due = $4, version = a.version + 1, updated_at = now()
          WHERE a.id = $1 RETURNING ${COLUMNS}`,
        [id, input.condition, maintainedAt, input.next_maintenance_due],
      );
      await this.outbox.emit(q, {
        type: 'asset.maintenance.updated.v1',
        aggregateType: 'asset',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: {
          asset_id: id,
          code: current.code,
          condition: updated.condition,
          last_maintained_at: updated.last_maintained_at ? updated.last_maintained_at.toISOString() : null,
          next_maintenance_due: updated.next_maintenance_due ? updated.next_maintenance_due.toISOString() : null,
        },
      });
      return updated;
    });
  }

  // ---------------------------------------------------------------------------
  // Events: pack templates, and the effect of maintenance work on an asset
  // ---------------------------------------------------------------------------

  private async onEvent(event: EventEnvelope, q: Q): Promise<void> {
    switch (event.event_type) {
      case 'tenant.pack.activated.v1':
        return this.installPackCategories(event.tenant_id, event.payload as EventPayload<'tenant.pack.activated.v1'>, q);
      case 'maintenance.work_order.started.v1': {
        const p = event.payload as EventPayload<'maintenance.work_order.started.v1'>;
        if (!p.asset_id) return;
        const asset = await q.maybeOne<AssetRow>(`SELECT ${COLUMNS} FROM assets a WHERE a.id = $1 FOR UPDATE`, [p.asset_id]);
        if (asset?.status === 'active') await this.systemStatus(q, asset, 'under_maintenance', `Work order ${p.reference_no} started`);
        return;
      }
      case 'maintenance.work_order.cancelled.v1': {
        const p = event.payload as EventPayload<'maintenance.work_order.cancelled.v1'>;
        if (!p.asset_id) return;
        const asset = await q.maybeOne<AssetRow>(`SELECT ${COLUMNS} FROM assets a WHERE a.id = $1 FOR UPDATE`, [p.asset_id]);
        if (asset?.status === 'under_maintenance' && (await this.underMaintenanceFor(q, asset.id, p.reference_no))) {
          await this.systemStatus(q, asset, 'active', `Work order ${p.reference_no} cancelled`);
        }
        return;
      }
      case 'maintenance.work_order.completed.v1': {
        const p = event.payload as EventPayload<'maintenance.work_order.completed.v1'>;
        if (!p.asset_id) return;
        const asset = await q.maybeOne<AssetRow>(`SELECT ${COLUMNS} FROM assets a WHERE a.id = $1 FOR UPDATE`, [p.asset_id]);
        if (!asset || asset.status === 'retired') return;
        const updated = await q.one<AssetRow>(
          `UPDATE assets a SET condition = COALESCE($2, a.condition), last_maintained_at = GREATEST(COALESCE(a.last_maintained_at, $3), $3),
                  version = a.version + 1, updated_at = now()
            WHERE a.id = $1 RETURNING ${COLUMNS}`,
          [asset.id, p.condition_after, p.completed_at],
        );
        await this.outbox.emit(q, {
          type: 'asset.maintenance.updated.v1',
          aggregateType: 'asset',
          aggregateId: asset.id,
          tenantId: asset.tenant_id,
          payload: {
            asset_id: asset.id,
            code: asset.code,
            condition: updated.condition,
            last_maintained_at: updated.last_maintained_at ? updated.last_maintained_at.toISOString() : null,
            next_maintenance_due: updated.next_maintenance_due ? updated.next_maintenance_due.toISOString() : null,
          },
        });
        // Only an asset this work order took out of service is returned to service.
        if (asset.status === 'under_maintenance' && (await this.underMaintenanceFor(q, asset.id, p.reference_no))) {
          await this.systemStatus(q, updated, 'active', `Work order ${p.reference_no} completed`);
        }
        return;
      }
    }
  }

  private async underMaintenanceFor(q: Q, assetId: string, workOrderReference: string): Promise<boolean> {
    const last = await q.maybeOne<{ note: string | null }>(
      `SELECT note FROM asset_status_history WHERE asset_id = $1 AND to_status = 'under_maintenance' ORDER BY changed_at DESC, id DESC LIMIT 1`,
      [assetId],
    );
    return last?.note === `Work order ${workOrderReference} started`;
  }

  private async systemStatus(q: Q, asset: AssetRow, to: string, note: string): Promise<void> {
    await q.exec('UPDATE assets SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [asset.id, to]);
    await q.exec('INSERT INTO asset_status_history (tenant_id, asset_id, from_status, to_status, changed_by, note) VALUES ($1, $2, $3, $4, $5, $6)', [
      asset.tenant_id,
      asset.id,
      asset.status,
      to,
      SYSTEM_ACTOR,
      note,
    ]);
    await this.outbox.emit(q, {
      type: 'asset.status_changed.v1',
      aggregateType: 'asset',
      aggregateId: asset.id,
      tenantId: asset.tenant_id,
      payload: { asset_id: asset.id, code: asset.code, from: asset.status, to, changed_by: SYSTEM_ACTOR },
    });
  }

  /**
   * Installs the asset categories of an industry pack and puts the pack's
   * attribute schema version in force. Idempotent. A category that exists
   * without an owner is adopted; one owned by another pack is left alone.
   */
  private async installPackCategories(tenantId: string, p: EventPayload<'tenant.pack.activated.v1'>, q: Q): Promise<void> {
    const actor = packActor(p.pack_id, p.version);
    for (const raw of p.install.asset_categories) {
      const template = PackAssetCategory.parse(raw);
      let category = await q.maybeOne<{ id: string; pack_id: string | null }>('SELECT id, pack_id FROM asset_categories WHERE code = $1 FOR UPDATE', [template.code]);
      if (!category) {
        category = await q.one<{ id: string; pack_id: string | null }>(
          'INSERT INTO asset_categories (tenant_id, code, name, description, pack_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, pack_id',
          [tenantId, template.code, template.name, template.description, p.pack_id],
        );
      } else if (category.pack_id === null || category.pack_id === p.pack_id) {
        await q.exec('UPDATE asset_categories SET name = $2, description = $3, pack_id = $4 WHERE id = $1', [category.id, template.name, template.description, p.pack_id]);
      } else {
        continue;
      }
      if (template.attribute_schema) {
        const result = await this.activateSchema(q, tenantId, category.id, template.attribute_schema.version, template.attribute_schema.fields, actor);
        // A stored schema version is immutable; a pack that changes fields must raise the version.
        if (result === 'conflict') throw new Error(`pack ${p.pack_id}@${p.version}: attribute schema ${template.code} v${template.attribute_schema.version} differs from the stored version`);
      }
    }
  }

  summary(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const byStatus = await q.query('SELECT status, count(*)::int AS count FROM assets GROUP BY status ORDER BY status');
      const byCondition = await q.query(`SELECT condition, count(*)::int AS count FROM assets WHERE status <> 'retired' GROUP BY condition ORDER BY condition`);
      const maintenance = await q.one(
        `SELECT count(*) FILTER (WHERE next_maintenance_due < now())::int AS overdue,
                count(*) FILTER (WHERE next_maintenance_due >= now() AND next_maintenance_due < now() + interval '30 days')::int AS due_within_30_days,
                count(*) FILTER (WHERE next_maintenance_due IS NULL)::int AS unscheduled,
                count(*)::int AS total
           FROM assets WHERE status <> 'retired'`,
      );
      return { by_status: byStatus, by_condition: byCondition, maintenance };
    });
  }
}
