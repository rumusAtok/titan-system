import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import { PLATFORM_TENANT_ID } from '@titan/contracts';
import { Db, DomainError, Outbox } from '@titan/platform';
import { z } from 'zod';

export const CreateTenant = z.object({
  id: z.uuid().optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(2).max(200),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const UpdateConfig = z.object({
  settings: z.record(z.string(), z.unknown()),
  /** Version the client last read; the update is rejected if it is stale. */
  expected_version: z.number().int().positive(),
});

export const CreateDepartment = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,32}$/),
  name: z.string().min(2).max(200),
  parent_id: z.uuid().nullable().default(null),
});

export const CreateJurisdiction = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(2).max(200),
  level: z.string().min(1).max(64).default('district'),
  parent_id: z.uuid().nullable().default(null),
});

export const UpsertMembership = z.object({
  username: z.string().min(1).max(255),
  department_id: z.uuid().nullable().default(null),
  title: z.string().max(200).nullable().default(null),
});

@Injectable()
export class TenantService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  listTenants() {
    // Platform-tenant context: the RLS policy exposes all tenants to it.
    return this.db.tx(PLATFORM_TENANT_ID, (q) => q.query('SELECT id, slug, name, status, created_at FROM tenants ORDER BY name'));
  }

  createTenant(input: z.infer<typeof CreateTenant>) {
    return this.db.tx(PLATFORM_TENANT_ID, async (q) => {
      const tenant = await q.one<{ id: string; slug: string; name: string }>(
        `INSERT INTO tenants (id, slug, name) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3)
         RETURNING id, slug, name, status, created_at`,
        [input.id ?? null, input.slug, input.name],
      );
      await q.exec('INSERT INTO tenant_config (tenant_id, settings) VALUES ($1, $2)', [tenant.id, JSON.stringify(input.settings)]);
      await this.outbox.emit(q, {
        type: 'tenant.created.v1',
        aggregateType: 'tenant',
        aggregateId: tenant.id,
        tenantId: tenant.id,
        payload: { tenant_id: tenant.id, name: tenant.name, slug: tenant.slug },
      });
      return tenant;
    });
  }

  currentTenant(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const tenant = await q.maybeOne(
        `SELECT t.id, t.slug, t.name, t.status, t.created_at, c.settings, c.version AS config_version, c.updated_at AS config_updated_at
           FROM tenants t LEFT JOIN tenant_config c ON c.tenant_id = t.id
          WHERE t.id = $1`,
        [user.tenantId],
      );
      if (!tenant) throw DomainError.notFound('tenant');
      return tenant;
    });
  }

  updateConfig(user: Principal, input: z.infer<typeof UpdateConfig>) {
    return this.db.tx(user.tenantId, async (q) => {
      const updated = await q.maybeOne(
        `UPDATE tenant_config
            SET settings = $2, version = version + 1, updated_by = $3, updated_at = now()
          WHERE tenant_id = $1 AND version = $4
          RETURNING tenant_id, settings, version, updated_at`,
        [user.tenantId, JSON.stringify(input.settings), user.username, input.expected_version],
      );
      if (!updated) throw DomainError.conflict('stale_version', 'tenant configuration was changed by someone else; reload and retry');
      await this.outbox.emit(q, {
        type: 'tenant.config.updated.v1',
        aggregateType: 'tenant',
        aggregateId: user.tenantId,
        tenantId: user.tenantId,
        payload: { tenant_id: user.tenantId, keys: Object.keys(input.settings) },
      });
      return updated;
    });
  }

  listDepartments(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT d.id, d.code, d.name, d.parent_id, d.created_at,
                (SELECT count(*)::int FROM memberships m WHERE m.department_id = d.id) AS member_count
           FROM departments d ORDER BY d.code`,
      ),
    );
  }

  createDepartment(user: Principal, input: z.infer<typeof CreateDepartment>) {
    return this.db.tx(user.tenantId, async (q) => {
      const dept = await q.one<{ id: string; code: string; name: string }>(
        'INSERT INTO departments (tenant_id, code, name, parent_id) VALUES ($1, $2, $3, $4) RETURNING id, code, name, parent_id, created_at',
        [user.tenantId, input.code, input.name, input.parent_id],
      );
      await this.outbox.emit(q, {
        type: 'tenant.department.created.v1',
        aggregateType: 'department',
        aggregateId: dept.id,
        tenantId: user.tenantId,
        payload: { department_id: dept.id, code: dept.code, name: dept.name },
      });
      return dept;
    });
  }

  listJurisdictions(user: Principal) {
    return this.db.tx(user.tenantId, (q) => q.query('SELECT id, code, name, level, parent_id, created_at FROM jurisdictions ORDER BY code'));
  }

  createJurisdiction(user: Principal, input: z.infer<typeof CreateJurisdiction>) {
    return this.db.tx(user.tenantId, (q) =>
      q.one(
        'INSERT INTO jurisdictions (tenant_id, code, name, level, parent_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, code, name, level, parent_id, created_at',
        [user.tenantId, input.code, input.name, input.level, input.parent_id],
      ),
    );
  }

  listMemberships(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT m.id, m.user_id, m.username, m.title, m.department_id, d.code AS department_code, d.name AS department_name, m.updated_at
           FROM memberships m LEFT JOIN departments d ON d.id = m.department_id
          ORDER BY m.username`,
      ),
    );
  }

  upsertMembership(user: Principal, userId: string, input: z.infer<typeof UpsertMembership>) {
    return this.db.tx(user.tenantId, (q) =>
      q.one(
        `INSERT INTO memberships (tenant_id, user_id, username, department_id, title)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, user_id)
         DO UPDATE SET username = EXCLUDED.username, department_id = EXCLUDED.department_id, title = EXCLUDED.title, updated_at = now()
         RETURNING id, user_id, username, department_id, title, updated_at`,
        [user.tenantId, userId, input.username, input.department_id, input.title],
      ),
    );
  }

  myMembership(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.maybeOne(
        `SELECT m.id, m.user_id, m.username, m.title, m.department_id, d.code AS department_code, d.name AS department_name
           FROM memberships m LEFT JOIN departments d ON d.id = m.department_id
          WHERE m.user_id = $1`,
        [user.userId],
      ),
    );
  }
}
