import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { hasAnyRole, type Principal } from '@titan/authentication';
import { type EventEnvelope, type EventPayload, REVIEWER_ROLES, Roles } from '@titan/contracts';
import { Db, DomainError, EventConsumers, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { checkAttachment, FormFields, type FormField, sanitizeFilename, validateFormData } from './forms.js';

export const CreateForm = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  title: z.string().min(2).max(200),
  description: z.string().max(2000).default(''),
  workflow_key: z.string().min(1).max(64),
  fields: FormFields,
});

export const CreateCase = z.object({
  form_key: z.string().min(1),
  title: z.string().min(3).max(200),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const UpdateCase = z.object({
  title: z.string().min(3).max(200).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  expected_version: z.number().int().positive(),
});

export const ListCases = z.object({
  status: z.enum(['draft', 'submitted', 'in_review', 'returned', 'approved', 'rejected', 'cancelled']).optional(),
  scope: z.enum(['mine', 'all']).default('mine'),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const UploadAttachment = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(100),
  content_base64: z.string().min(1).max(3_000_000),
});

/** Roles that may read any case of their tenant. */
const CASE_READER_ROLES = [...REVIEWER_ROLES, Roles.TenantAdmin, Roles.Auditor];

export interface CaseRow {
  id: string;
  tenant_id: string;
  reference_no: string;
  form_id: string;
  form_key: string;
  title: string;
  channel: string;
  applicant_id: string;
  applicant_username: string;
  applicant_email: string | null;
  status: string;
  current_stage: string | null;
  data: Record<string, unknown>;
  version: number;
  submitted_at: Date | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const CASE_COLUMNS = `id, tenant_id, reference_no, form_id, form_key, title, channel, applicant_id, applicant_username,
  applicant_email, status, current_stage, data, version, submitted_at, decided_at, created_at, updated_at`;

@Injectable()
export class CaseService implements OnApplicationBootstrap {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({
      subjects: ['workflow.task.assigned.v1', 'workflow.case.returned.v1', 'workflow.case.completed.v1'],
      handler: (event, q) => this.onWorkflowEvent(event, q),
    });
  }

  // --- forms ---------------------------------------------------------------

  listForms(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query('SELECT id, key, version, title, description, workflow_key, fields, created_at FROM form_definitions WHERE active ORDER BY title'),
    );
  }

  /** Publishing a form creates a new version and retires the previous one; existing cases keep their version. */
  createForm(user: Principal, input: z.infer<typeof CreateForm>) {
    return this.db.tx(user.tenantId, async (q) => {
      const { next } = await q.one<{ next: number }>('SELECT COALESCE(max(version), 0) + 1 AS next FROM form_definitions WHERE key = $1', [input.key]);
      await q.exec('UPDATE form_definitions SET active = false WHERE key = $1 AND active', [input.key]);
      return q.one(
        `INSERT INTO form_definitions (tenant_id, key, version, title, description, workflow_key, fields, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, key, version, title, description, workflow_key, fields, created_at`,
        [user.tenantId, input.key, next, input.title, input.description, input.workflow_key, JSON.stringify(input.fields), user.username],
      );
    });
  }

  // --- access rules ----------------------------------------------------------

  private canReadAll(user: Principal): boolean {
    return hasAnyRole(user, CASE_READER_ROLES);
  }

  /** Attribute-based rule: an applicant may only see their own cases. */
  private assertCanRead(user: Principal, row: CaseRow): void {
    if (row.applicant_id === user.userId || this.canReadAll(user)) return;
    // Same answer as for a missing case, so existence is not disclosed.
    throw DomainError.notFound('case');
  }

  private assertOwner(user: Principal, row: CaseRow): void {
    if (row.applicant_id !== user.userId) {
      if (this.canReadAll(user)) throw DomainError.forbidden('only the applicant may change this case');
      throw DomainError.notFound('case');
    }
  }

  private async load(q: Q, id: string, lock = false): Promise<CaseRow> {
    const row = await q.maybeOne<CaseRow>(`SELECT ${CASE_COLUMNS} FROM cases WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!row) throw DomainError.notFound('case');
    return row;
  }

  private async fieldsOf(q: Q, formId: string): Promise<FormField[]> {
    const form = await q.one<{ fields: FormField[] }>('SELECT fields FROM form_definitions WHERE id = $1', [formId]);
    return form.fields;
  }

  private async recordTransition(
    q: Q,
    row: CaseRow,
    to: string,
    actor: { id: string | null; username: string | null },
    note: string | null,
    stage: string | null = null,
  ): Promise<void> {
    await q.exec(
      `INSERT INTO case_status_history (tenant_id, case_id, from_status, to_status, stage, actor_id, actor_username, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.tenant_id, row.id, row.status, to, stage, actor.id, actor.username, note],
    );
  }

  // --- commands --------------------------------------------------------------

  create(user: Principal, input: z.infer<typeof CreateCase>) {
    return this.db.tx(user.tenantId, async (q) => {
      const form = await q.maybeOne<{ id: string; key: string; fields: FormField[] }>(
        'SELECT id, key, fields FROM form_definitions WHERE key = $1 AND active',
        [input.form_key],
      );
      if (!form) throw DomainError.notFound('form');
      const errors = validateFormData(form.fields, input.data, { partial: true });
      if (errors.length) throw DomainError.invalid('form data is invalid', errors);

      const year = new Date().getUTCFullYear();
      const { last_no } = await q.one<{ last_no: number }>(
        `INSERT INTO case_counters (tenant_id, year, last_no) VALUES ($1, $2, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE SET last_no = case_counters.last_no + 1
         RETURNING last_no`,
        [user.tenantId, year],
      );
      const reference = `APP-${year}-${String(last_no).padStart(6, '0')}`;
      const channel = hasAnyRole(user, [Roles.Applicant]) ? 'public' : 'internal';
      const row = await q.one<CaseRow>(
        `INSERT INTO cases (tenant_id, reference_no, form_id, form_key, title, channel, applicant_id, applicant_username, applicant_email, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${CASE_COLUMNS}`,
        [user.tenantId, reference, form.id, form.key, input.title, channel, user.userId, user.username, user.email, JSON.stringify(input.data)],
      );
      await q.exec(
        `INSERT INTO case_status_history (tenant_id, case_id, from_status, to_status, actor_id, actor_username, note)
         VALUES ($1, $2, NULL, 'draft', $3, $4, 'Draft created')`,
        [user.tenantId, row.id, user.userId, user.username],
      );
      return row;
    });
  }

  update(user: Principal, id: string, input: z.infer<typeof UpdateCase>) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await this.load(q, id, true);
      this.assertOwner(user, row);
      if (row.status !== 'draft' && row.status !== 'returned') {
        throw DomainError.conflict('invalid_state', `a case in status '${row.status}' cannot be edited`);
      }
      if (row.version !== input.expected_version) throw DomainError.conflict('stale_version', 'the case was changed elsewhere; reload and retry');
      const data = input.data ?? row.data;
      const errors = validateFormData(await this.fieldsOf(q, row.form_id), data, { partial: true });
      if (errors.length) throw DomainError.invalid('form data is invalid', errors);
      return q.one<CaseRow>(
        `UPDATE cases SET title = $2, data = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${CASE_COLUMNS}`,
        [id, input.title ?? row.title, JSON.stringify(data)],
      );
    });
  }

  /** Submits a draft, or resubmits a case that was returned for changes. */
  submit(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await this.load(q, id, true);
      this.assertOwner(user, row);
      if (row.status !== 'draft' && row.status !== 'returned') {
        throw DomainError.conflict('invalid_state', `a case in status '${row.status}' cannot be submitted`);
      }
      const errors = validateFormData(await this.fieldsOf(q, row.form_id), row.data);
      if (errors.length) throw DomainError.invalid('the application is incomplete', errors);

      const resubmission = row.status === 'returned';
      const now = new Date();
      const updated = await q.one<CaseRow>(
        `UPDATE cases SET status = 'submitted', current_stage = NULL, submitted_at = COALESCE(submitted_at, $2),
                version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING ${CASE_COLUMNS}`,
        [id, now],
      );
      await this.recordTransition(q, row, 'submitted', { id: user.userId, username: user.username }, resubmission ? 'Resubmitted after changes' : 'Submitted');

      if (resubmission) {
        await this.outbox.emit(q, {
          type: 'case.resubmitted.v1',
          aggregateType: 'case',
          aggregateId: id,
          tenantId: user.tenantId,
          payload: { case_id: id, reference_no: row.reference_no, applicant_id: row.applicant_id, data: row.data, resubmitted_at: now.toISOString() },
        });
      } else {
        const form = await q.one<{ workflow_key: string }>('SELECT workflow_key FROM form_definitions WHERE id = $1', [row.form_id]);
        await this.outbox.emit(q, {
          type: 'case.submitted.v1',
          aggregateType: 'case',
          aggregateId: id,
          tenantId: user.tenantId,
          payload: {
            case_id: id,
            reference_no: row.reference_no,
            form_key: row.form_key,
            workflow_key: form.workflow_key,
            applicant_id: row.applicant_id,
            applicant_username: row.applicant_username,
            applicant_email: row.applicant_email,
            title: row.title,
            data: row.data,
            submitted_at: now.toISOString(),
          },
        });
      }
      return updated;
    });
  }

  cancel(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await this.load(q, id, true);
      const isAdmin = hasAnyRole(user, [Roles.TenantAdmin]);
      if (!isAdmin) this.assertOwner(user, row);
      if (['approved', 'rejected', 'cancelled'].includes(row.status)) {
        throw DomainError.conflict('invalid_state', `a case in status '${row.status}' cannot be cancelled`);
      }
      const updated = await q.one<CaseRow>(
        `UPDATE cases SET status = 'cancelled', current_stage = NULL, decided_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING ${CASE_COLUMNS}`,
        [id],
      );
      await this.recordTransition(q, row, 'cancelled', { id: user.userId, username: user.username }, 'Cancelled');
      // A draft never reached the workflow engine, so there is nothing to tell it.
      if (row.status !== 'draft') {
        await this.outbox.emit(q, {
          type: 'case.cancelled.v1',
          aggregateType: 'case',
          aggregateId: id,
          tenantId: user.tenantId,
          payload: { case_id: id, reference_no: row.reference_no, cancelled_by: user.userId },
        });
      }
      return updated;
    });
  }

  // --- queries ---------------------------------------------------------------

  list(user: Principal, query: z.infer<typeof ListCases>) {
    return this.db.tx(user.tenantId, (q) => {
      const where: string[] = [];
      const params: unknown[] = [];
      // Applicants are always restricted to their own cases, whatever they ask for.
      if (query.scope === 'mine' || !this.canReadAll(user)) {
        params.push(user.userId);
        where.push(`applicant_id = $${params.length}`);
      } else {
        // Other people's unsubmitted drafts are private to their author.
        params.push(user.userId);
        where.push(`(status <> 'draft' OR applicant_id = $${params.length})`);
      }
      if (query.status) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      if (query.q) {
        params.push(`%${query.q.replace(/[%_\\]/g, '\\$&')}%`);
        where.push(`(title ILIKE $${params.length} OR reference_no ILIKE $${params.length})`);
      }
      params.push(query.limit, query.offset);
      return q.query(
        `SELECT id, reference_no, form_key, title, channel, applicant_username, status, current_stage, version, submitted_at, decided_at, created_at, updated_at
           FROM cases
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
    });
  }

  get(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await this.load(q, id);
      this.assertCanRead(user, row);
      const form = await q.one('SELECT key, version, title, fields FROM form_definitions WHERE id = $1', [row.form_id]);
      const attachments = await q.query(
        'SELECT id, filename, content_type, size_bytes, sha256, uploaded_by, uploaded_at FROM case_attachments WHERE case_id = $1 ORDER BY uploaded_at',
        [id],
      );
      return { ...row, form, attachments };
    });
  }

  history(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      this.assertCanRead(user, await this.load(q, id));
      return q.query(
        'SELECT id, from_status, to_status, stage, actor_username, note, occurred_at FROM case_status_history WHERE case_id = $1 ORDER BY occurred_at, id',
        [id],
      );
    });
  }

  /** Applicant-facing status tracking by reference number. */
  track(user: Principal, reference: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await q.maybeOne<CaseRow>(`SELECT ${CASE_COLUMNS} FROM cases WHERE reference_no = $1`, [reference]);
      if (!row) throw DomainError.notFound('case');
      this.assertCanRead(user, row);
      const timeline = await q.query('SELECT to_status AS status, stage, note, occurred_at FROM case_status_history WHERE case_id = $1 ORDER BY occurred_at, id', [row.id]);
      return {
        id: row.id,
        reference_no: row.reference_no,
        title: row.title,
        status: row.status,
        current_stage: row.current_stage,
        submitted_at: row.submitted_at,
        decided_at: row.decided_at,
        timeline,
      };
    });
  }

  // --- attachments -----------------------------------------------------------

  addAttachment(user: Principal, id: string, input: z.infer<typeof UploadAttachment>) {
    const content = Buffer.from(input.content_base64, 'base64');
    const refusal = checkAttachment(input.content_type, content);
    if (refusal) throw DomainError.invalid(refusal);
    return this.db.tx(user.tenantId, async (q) => {
      const row = await this.load(q, id, true);
      this.assertOwner(user, row);
      if (row.status !== 'draft' && row.status !== 'returned') {
        throw DomainError.conflict('invalid_state', 'attachments can only be added before submission');
      }
      const { count } = await q.one<{ count: number }>('SELECT count(*)::int AS count FROM case_attachments WHERE case_id = $1', [id]);
      if (count >= 10) throw DomainError.conflict('attachment_limit', 'a case can have at most 10 attachments');
      return q.one(
        `INSERT INTO case_attachments (tenant_id, case_id, filename, content_type, size_bytes, sha256, content, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, filename, content_type, size_bytes, sha256, uploaded_by, uploaded_at`,
        [user.tenantId, id, sanitizeFilename(input.filename), input.content_type, content.length, createHash('sha256').update(content).digest('hex'), content, user.username],
      );
    });
  }

  attachmentContent(user: Principal, id: string, attachmentId: string) {
    return this.db.tx(user.tenantId, async (q) => {
      this.assertCanRead(user, await this.load(q, id));
      const file = await q.maybeOne<{ filename: string; content_type: string; content: Buffer }>(
        'SELECT filename, content_type, content FROM case_attachments WHERE id = $1 AND case_id = $2',
        [attachmentId, id],
      );
      if (!file) throw DomainError.notFound('attachment');
      return file;
    });
  }

  // --- event handlers --------------------------------------------------------

  /** Keeps the case lifecycle in step with decisions made in workflow-service. */
  private async onWorkflowEvent(event: EventEnvelope, q: Q): Promise<void> {
    switch (event.event_type) {
      case 'workflow.task.assigned.v1': {
        const p = event.payload as EventPayload<'workflow.task.assigned.v1'>;
        if (p.subject_type !== 'case') return;
        const row = await q.maybeOne<CaseRow>(`SELECT ${CASE_COLUMNS} FROM cases WHERE id = $1 FOR UPDATE`, [p.subject_id]);
        if (!row || (row.status !== 'submitted' && row.status !== 'in_review')) return;
        if (row.status === 'in_review' && row.current_stage === p.stage_name) return;
        await q.exec(`UPDATE cases SET status = 'in_review', current_stage = $2, version = version + 1, updated_at = now() WHERE id = $1`, [row.id, p.stage_name]);
        await this.recordTransition(q, row, 'in_review', { id: null, username: null }, `Assigned for review: ${p.stage_name}`, p.stage_name);
        return;
      }
      case 'workflow.case.returned.v1': {
        const p = event.payload as EventPayload<'workflow.case.returned.v1'>;
        const row = await q.maybeOne<CaseRow>(`SELECT ${CASE_COLUMNS} FROM cases WHERE id = $1 FOR UPDATE`, [p.case_id]);
        if (!row || (row.status !== 'submitted' && row.status !== 'in_review')) return;
        await q.exec(`UPDATE cases SET status = 'returned', current_stage = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [row.id]);
        await this.recordTransition(q, row, 'returned', { id: p.returned_by, username: null }, p.comment ?? 'Returned for changes', p.stage_key);
        return;
      }
      case 'workflow.case.completed.v1': {
        const p = event.payload as EventPayload<'workflow.case.completed.v1'>;
        const row = await q.maybeOne<CaseRow>(`SELECT ${CASE_COLUMNS} FROM cases WHERE id = $1 FOR UPDATE`, [p.case_id]);
        // Terminal states are final: a late or repeated event changes nothing.
        if (!row || ['approved', 'rejected', 'cancelled'].includes(row.status)) return;
        await q.exec(`UPDATE cases SET status = $2, current_stage = NULL, decided_at = $3, version = version + 1, updated_at = now() WHERE id = $1`, [
          row.id,
          p.outcome,
          p.completed_at,
        ]);
        await this.recordTransition(q, row, p.outcome, { id: p.decided_by, username: null }, `Workflow completed: ${p.outcome}`);
        return;
      }
    }
  }
}
