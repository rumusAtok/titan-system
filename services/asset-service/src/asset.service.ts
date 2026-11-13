import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import { Db, DomainError, Outbox, type Q } from '@titan/platform';
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
});

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
}

const COLUMNS = `a.id, a.tenant_id, a.code, a.name, a.category_id, a.parent_id, a.status, a.condition, a.latitude, a.longitude, a.attributes,
  a.commissioned_on::text AS commissioned_on, a.last_maintained_at, a.next_maintenance_due, a.version, a.created_at, a.updated_at`;

@Injectable()
export class AssetService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  listCategories(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT c.id, c.code, c.name, (SELECT count(*)::int FROM assets a WHERE a.category_id = c.id) AS asset_count
           FROM asset_categories c ORDER BY c.code`,
      ),
    );
  }

  createCategory(user: Principal, input: z.infer<typeof CreateCategory>) {
    return this.db.tx(user.tenantId, (q) =>
      q.one('INSERT INTO asset_categories (tenant_id, code, name) VALUES ($1, $2, $3) RETURNING id, code, name', [user.tenantId, input.code, input.name]),
    );
  }

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
      const row = await q.one<AssetRow>(
        `INSERT INTO assets AS a (tenant_id, code, name, category_id, parent_id, status, condition, latitude, longitude, attributes, commissioned_on, next_maintenance_due)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      if (query.q) {
        params.push(`%${query.q.replace(/[%_\\]/g, '\\$&')}%`);
        where.push(`(a.name ILIKE $${params.length} OR a.code ILIKE $${params.length})`);
      }
      params.push(query.limit, query.offset);
      return q.query(
        `SELECT ${COLUMNS}, c.code AS category_code, c.name AS category_name,
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
      const category = await q.one('SELECT code, name FROM asset_categories WHERE id = $1', [asset.category_id]);
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
      return q.one<AssetRow>(
        `UPDATE assets a SET name = $2, attributes = $3, latitude = $4, longitude = $5, version = a.version + 1, updated_at = now()
          WHERE a.id = $1 RETURNING ${COLUMNS}`,
        [id, input.name ?? current.name, JSON.stringify(input.attributes ?? current.attributes), latitude, longitude],
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
