import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { hasAnyRole, type Principal } from '@titan/authentication';
import { Roles } from '@titan/contracts';
import { type Logger, newContext, propagationHeaders, runWithContext } from '@titan/observability';
import { CircuitBreaker, Db, DomainError, LOGGER, Outbox, type Q, withTimeout } from '@titan/platform';
import { z } from 'zod';
import { toPdf, toXlsx } from './formats.js';
import { columnsOf, nextDue, renderHtml, type Schedule, type Section, toCsv } from './rules.js';

const ANALYTICS_URL = (process.env.ANALYTICS_URL ?? 'http://analytics-service:8000').replace(/\/+$/, '');
const ANALYTICS_TIMEOUT_MS = Number(process.env.ANALYTICS_TIMEOUT_MS ?? 20_000);
const SWEEP_MS = Number(process.env.REPORT_SWEEP_MS ?? 60_000);

/** Roles that define reports. Anyone on the staff may generate and read them. */
export const AUTHORS = [
  Roles.Analyst, Roles.TenantAdmin, Roles.DepartmentHead, Roles.IncidentCommander, Roles.FacilityManager, Roles.ProductionSupervisor,
  Roles.MaintenancePlanner, Roles.ProcurementOfficer,
];

const datasetName = z.string().regex(/^[a-z][a-z0-9_]{2,62}$/);
const ReportSection = z.object({
  title: z.string().trim().min(2).max(120),
  dataset: datasetName,
  filters: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.union([z.string().max(200), z.boolean()])).default({}),
  limit: z.number().int().min(1).max(2000).default(500),
});

export const CreateDefinition = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().max(1000).default(''),
  sections: z.array(ReportSection).min(1).max(8),
  schedule: z.enum(['none', 'daily', 'weekly', 'monthly']).default('none'),
  notify_role: z.string().regex(/^[a-z][a-z_]{1,62}$/).nullable().default(null),
});

export const UpdateDefinition = CreateDefinition.partial().extend({
  active: z.boolean().optional(),
  expected_version: z.number().int().positive(),
});

export interface DefinitionRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  sections: z.infer<typeof ReportSection>[];
  schedule: Schedule;
  next_due_at: Date | null;
  notify_role: string | null;
  owner_id: string;
  owner_username: string;
  active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface RunRow {
  id: string;
  definition_id: string;
  definition_name: string;
  status: 'completed' | 'failed';
  result: Section[] | null;
  total_rows: number;
  error: string | null;
  generated_by: string;
  generated_at: Date;
}

const DEF = 'id, tenant_id, name, description, sections, schedule, next_due_at, notify_role, owner_id, owner_username, active, version, created_at, updated_at';

interface RegistryEntry {
  name: string;
  available: boolean;
  columns: string[];
  filterable: Record<string, string>;
}

/**
 * Reports over the registered analytics datasets.
 *
 * A report is generated on request, with the requesting user's token: report-service holds no
 * analytics credentials of its own, so it can never show anyone more than the analytics API would.
 * A schedule therefore produces a reminder (an in-app notification) when a report falls due, not
 * an unattended run.
 */
@Injectable()
export class ReportService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly breaker = new CircuitBreaker('analytics-service', { failureThreshold: 5, resetTimeoutMs: 15_000 });
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweepDue(), SWEEP_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  // --- analytics API (as the user) ------------------------------------------------------

  private async analytics<T>(user: Principal, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.breaker.run(() =>
        withTimeout(async (signal) => {
          const r = await fetch(`${ANALYTICS_URL}${path}`, {
            method,
            signal,
            headers: { ...propagationHeaders(), authorization: `Bearer ${user.token}`, 'content-type': 'application/json', accept: 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          if (r.status >= 500) throw new Error(`analytics-service responded ${r.status}`);
          return r;
        }, ANALYTICS_TIMEOUT_MS),
      );
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'analytics-service call failed');
      throw new DomainError(503, 'analytics_unavailable', 'the analytics service is not available; try again later');
    }
    const json = (await response.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    if (response.ok) return json;
    const message = json.error?.message ?? `analytics-service responded ${response.status}`;
    if (response.status === 403) throw DomainError.forbidden(message);
    if (response.status === 404) throw DomainError.invalid(`unknown dataset (${message})`);
    throw DomainError.invalid(message);
  }

  /** Datasets the caller's tenant may read, with their columns and filters. */
  datasets(user: Principal) {
    return this.analytics<RegistryEntry[]>(user, 'GET', '/datasets/registry');
  }

  private async validateSections(user: Principal, sections: z.infer<typeof ReportSection>[]): Promise<void> {
    const registry = new Map((await this.datasets(user)).map((d) => [d.name, d]));
    sections.forEach((s, i) => {
      const d = registry.get(s.dataset);
      if (!d) throw DomainError.invalid(`section ${i + 1}: unknown dataset '${s.dataset}'`);
      if (!d.available) throw DomainError.invalid(`section ${i + 1}: dataset '${s.dataset}' needs a capability this tenant does not have`);
      for (const f of Object.keys(s.filters)) {
        if (!(f in d.filterable)) throw DomainError.invalid(`section ${i + 1}: '${f}' is not a filterable column of '${s.dataset}'`);
      }
    });
  }

  // --- definitions ---------------------------------------------------------------------

  listDefinitions(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT d.id, d.name, d.description, d.sections, d.schedule, d.next_due_at, d.notify_role, d.owner_username, d.active, d.version, d.updated_at,
                r.id AS last_run_id, r.status AS last_run_status, r.generated_at AS last_generated_at
           FROM report_definitions d
           LEFT JOIN LATERAL (SELECT id, status, generated_at FROM report_runs WHERE definition_id = d.id ORDER BY generated_at DESC LIMIT 1) r ON true
          ORDER BY d.active DESC, d.name`,
      ),
    );
  }

  async createDefinition(user: Principal, input: z.infer<typeof CreateDefinition>) {
    await this.validateSections(user, input.sections);
    return this.db.tx(user.tenantId, async (q) => {
      const existing = await q.maybeOne('SELECT 1 FROM report_definitions WHERE name = $1', [input.name]);
      if (existing) throw DomainError.conflict('duplicate', `a report named '${input.name}' already exists`);
      return q.one<DefinitionRow>(
        `INSERT INTO report_definitions (tenant_id, name, description, sections, schedule, next_due_at, notify_role, owner_id, owner_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${DEF}`,
        [user.tenantId, input.name, input.description, JSON.stringify(input.sections), input.schedule, nextDue(input.schedule, new Date()), input.notify_role, user.userId, user.username],
      );
    });
  }

  private async definition(q: Q, id: string): Promise<DefinitionRow> {
    const d = await q.maybeOne<DefinitionRow>(`SELECT ${DEF} FROM report_definitions WHERE id = $1`, [id]);
    if (!d) throw DomainError.notFound('report definition');
    return d;
  }

  async updateDefinition(user: Principal, id: string, input: z.infer<typeof UpdateDefinition>) {
    if (input.sections) await this.validateSections(user, input.sections);
    return this.db.tx(user.tenantId, async (q) => {
      const d = await this.definition(q, id);
      if (d.owner_id !== user.userId && !hasAnyRole(user, [Roles.TenantAdmin])) throw DomainError.forbidden('only the owner or a tenant administrator may change this report');
      if (d.version !== input.expected_version) throw DomainError.conflict('version_conflict', `the report is at version ${d.version}`);
      const schedule = input.schedule ?? d.schedule;
      const nextDueAt = input.schedule !== undefined || input.active === true ? nextDue(schedule, new Date()) : d.next_due_at;
      return q.one<DefinitionRow>(
        `UPDATE report_definitions SET name = $2, description = $3, sections = $4, schedule = $5, next_due_at = $6, notify_role = $7, active = $8,
                version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${DEF}`,
        [
          id,
          input.name ?? d.name,
          input.description ?? d.description,
          JSON.stringify(input.sections ?? d.sections),
          schedule,
          nextDueAt,
          input.notify_role === undefined ? d.notify_role : input.notify_role,
          input.active ?? d.active,
        ],
      );
    });
  }

  getDefinition(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const d = await this.definition(q, id);
      const runs = await q.query(
        'SELECT id, status, total_rows, error, generated_by, generated_at FROM report_runs WHERE definition_id = $1 ORDER BY generated_at DESC LIMIT 50',
        [id],
      );
      return { ...d, runs };
    });
  }

  // --- generation ----------------------------------------------------------------------

  async generate(user: Principal, id: string) {
    const d = await this.db.tx(user.tenantId, (q) => this.definition(q, id));
    if (!d.active) throw DomainError.conflict('inactive', 'the report is inactive');
    const sections: Section[] = [];
    let failure: DomainError | null = null;
    try {
      for (const s of d.sections) {
        const out = await this.analytics<{ rows: Record<string, unknown>[]; freshness?: unknown }>(user, 'POST', `/datasets/${encodeURIComponent(s.dataset)}/query`, {
          filters: s.filters,
          limit: s.limit,
        });
        sections.push({ title: s.title, dataset: s.dataset, columns: columnsOf(out.rows), rows: out.rows, freshness: out.freshness ?? null });
      }
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      failure = err;
    }
    const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);
    const run = await this.db.tx(user.tenantId, async (q) => {
      const r = await q.one<{ id: string; generated_at: Date }>(
        `INSERT INTO report_runs (tenant_id, definition_id, definition_name, status, result, total_rows, error, generated_by, generated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, generated_at`,
        [user.tenantId, d.id, d.name, failure ? 'failed' : 'completed', failure ? null : JSON.stringify(sections), totalRows, failure?.message ?? null, user.username, user.userId],
      );
      if (!failure) {
        await this.outbox.emit(q, {
          type: 'report.generated.v1',
          aggregateType: 'report_run',
          aggregateId: r.id,
          tenantId: user.tenantId,
          payload: {
            report_run_id: r.id,
            definition_id: d.id,
            definition_name: d.name,
            datasets: d.sections.map((s) => s.dataset),
            rows: totalRows,
            generated_by: user.userId,
            generated_at: r.generated_at.toISOString(),
          },
        });
      }
      return r;
    });
    // A refused or unavailable dataset is recorded as a failed run and reported to the caller.
    if (failure) throw new DomainError(failure.status, failure.code, failure.message, { report_run_id: run.id });
    return { id: run.id, status: 'completed', total_rows: totalRows, generated_at: run.generated_at, sections: sections.map((s) => ({ title: s.title, dataset: s.dataset, rows: s.rows.length })) };
  }

  listRuns(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query('SELECT id, definition_id, definition_name, status, total_rows, error, generated_by, generated_at FROM report_runs ORDER BY generated_at DESC LIMIT 100'),
    );
  }

  getRun(user: Principal, id: string): Promise<RunRow> {
    return this.db.tx(user.tenantId, async (q) => {
      const run = await q.maybeOne<RunRow>(
        'SELECT id, definition_id, definition_name, status, result, total_rows, error, generated_by, generated_at FROM report_runs WHERE id = $1',
        [id],
      );
      if (!run) throw DomainError.notFound('report run');
      return run;
    });
  }

  private async completedRun(user: Principal, id: string): Promise<RunRow & { result: Section[] }> {
    const run = await this.getRun(user, id);
    if (run.status !== 'completed' || !run.result) throw DomainError.conflict('run_failed', 'this run failed and has no output');
    return run as RunRow & { result: Section[] };
  }

  async csv(user: Principal, id: string, section: number): Promise<{ filename: string; body: string }> {
    const run = await this.completedRun(user, id);
    const s = run.result[section];
    if (!s) throw DomainError.notFound('report section');
    const slug = `${run.definition_name}-${s.dataset}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { filename: `${slug}-${run.generated_at.toISOString().slice(0, 10)}.csv`, body: toCsv(s.columns, s.rows) };
  }

  private fileBase(run: RunRow): string {
    return `${run.definition_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${run.generated_at.toISOString().slice(0, 10)}`;
  }

  async xlsx(user: Principal, id: string): Promise<{ filename: string; body: Buffer }> {
    const run = await this.completedRun(user, id);
    return { filename: `${this.fileBase(run)}.xlsx`, body: toXlsx(run.result) };
  }

  async pdf(user: Principal, id: string): Promise<{ filename: string; body: Buffer }> {
    const run = await this.completedRun(user, id);
    const d = await this.db.tx(user.tenantId, (q) => q.maybeOne<{ description: string }>('SELECT description FROM report_definitions WHERE id = $1', [run.definition_id]));
    return {
      filename: `${this.fileBase(run)}.pdf`,
      body: toPdf({ name: run.definition_name, description: d?.description ?? '', generated_at: run.generated_at.toISOString(), generated_by: run.generated_by, sections: run.result }),
    };
  }

  async html(user: Principal, id: string): Promise<string> {
    const run = await this.completedRun(user, id);
    const d = await this.db.tx(user.tenantId, (q) => q.maybeOne<{ description: string }>('SELECT description FROM report_definitions WHERE id = $1', [run.definition_id]));
    return renderHtml({ name: run.definition_name, description: d?.description ?? '', generated_at: run.generated_at.toISOString(), generated_by: run.generated_by, sections: run.result });
  }

  // --- schedules -------------------------------------------------------------------------

  /** Reports that fell due: remind the owner (and the notify role), then move the due date on. */
  async sweepDue(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let reminded = 0;
    try {
      const due = await this.db.tx(null, (q) => q.query<{ definition_id: string; tenant_id: string }>('SELECT definition_id, tenant_id FROM report_definitions_due($1)', [100]));
      for (const row of due) {
        const ctx = newContext({ actor: { id: 'report-service', type: 'system' } });
        const done = await runWithContext(ctx, () =>
          this.db.tx(row.tenant_id, async (q) => {
            const d = await q.maybeOne<DefinitionRow>(`SELECT ${DEF} FROM report_definitions WHERE id = $1 AND active AND next_due_at <= now() FOR UPDATE`, [row.definition_id]);
            if (!d || !d.next_due_at) return false;
            await q.exec('UPDATE report_definitions SET next_due_at = $2 WHERE id = $1', [d.id, nextDue(d.schedule, new Date())]);
            const recipients: { user: string | null; role: string | null }[] = [{ user: d.owner_id, role: null }];
            if (d.notify_role) recipients.push({ user: null, role: d.notify_role });
            for (const r of recipients) {
              await this.outbox.emit(q, {
                type: 'notification.requested.v1',
                aggregateType: 'report_definition',
                aggregateId: d.id,
                tenantId: d.tenant_id,
                payload: {
                  dedupe_key: `report-due:${d.id}:${d.next_due_at.toISOString()}:${r.user ?? r.role}`,
                  channel: 'in_app',
                  category: 'report.due',
                  external: false,
                  recipient_user_id: r.user,
                  recipient_role: r.role,
                  recipient_address: null,
                  subject: `Report due: ${d.name}`,
                  body: `The ${d.schedule} report "${d.name}" is due. Open Reports to generate it.`,
                  reference_type: 'report_definition',
                  reference_id: d.id,
                },
              });
            }
            return true;
          }),
        );
        if (done) reminded += 1;
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'report schedule sweep failed');
    } finally {
      this.sweeping = false;
    }
    return reminded;
  }
}
