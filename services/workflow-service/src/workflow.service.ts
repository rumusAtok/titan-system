import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { hasAnyRole, type Principal } from '@titan/authentication';
import { type EventEnvelope, type EventPayload, Roles, STAFF_ROLES } from '@titan/contracts';
import { type Logger, newContext, runWithContext } from '@titan/observability';
import { Db, DomainError, EventConsumers, LOGGER, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { type Decision, Definition, dueDate, type Milestone, nextStage, plannedStages, type Stage, stageOutcome, type TaskState } from './engine.js';

export const CreateDefinition = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(2).max(200),
  subject_type: z.enum(['case', 'incident']),
  definition: Definition,
});

export const DecideTask = z.object({
  decision: z.enum(['approve', 'reject', 'return']),
  comment: z.string().trim().max(2000).optional(),
});

export const ListTasks = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  status: z.enum(['pending', 'completed', 'cancelled']).default('pending'),
  subject_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const CreateDelegation = z.object({
  to_username: z.string().min(1).max(255),
  role: z.string().min(1).max(64),
  reason: z.string().max(500).optional(),
  valid_to: z.iso.datetime({ offset: true }),
});

interface DefinitionRow {
  id: string;
  key: string;
  version: number;
  name: string;
  subject_type: 'case' | 'incident';
  definition: unknown;
}

interface InstanceRow {
  id: string;
  tenant_id: string;
  definition_id: string;
  definition_key: string;
  definition_version: number;
  subject_type: 'case' | 'incident';
  subject_id: string;
  reference: string;
  title: string;
  applicant_id: string | null;
  applicant_email: string | null;
  status: 'running' | 'returned' | 'approved' | 'rejected' | 'cancelled';
  current_stage_key: string | null;
  cycle: number;
  context: Record<string, unknown>;
  version: number;
  started_at: Date;
  completed_at: Date | null;
}

interface TaskRow {
  id: string;
  tenant_id: string;
  instance_id: string;
  cycle: number;
  stage_key: string;
  stage_name: string;
  role: string;
  status: 'pending' | 'completed' | 'cancelled';
  decision: Decision | null;
  decided_by: string | null;
  decided_by_username: string | null;
  on_behalf_of: string | null;
  comment: string | null;
  assigned_at: Date;
  due_at: Date | null;
  escalate_to_role: string | null;
  escalated_at: Date | null;
  closed_at: Date | null;
}

const INSTANCE_COLUMNS = `id, tenant_id, definition_id, definition_key, definition_version, subject_type, subject_id, reference, title,
  applicant_id, applicant_email, status, current_stage_key, cycle, context, version, started_at, completed_at`;
const TASK_COLUMNS = `id, tenant_id, instance_id, cycle, stage_key, stage_name, role, status, decision, decided_by, decided_by_username,
  on_behalf_of, comment, assigned_at, due_at, escalate_to_role, escalated_at, closed_at`;

const DECISION_EVENT = {
  approve: 'workflow.decision.approved.v1',
  reject: 'workflow.decision.rejected.v1',
  return: 'workflow.decision.returned.v1',
} as const;

const INCIDENT_WORKFLOW_KEY = 'incident-response';
const SLA_SWEEP_MS = Number(process.env.SLA_SWEEP_MS ?? 30_000);

@Injectable()
export class WorkflowService implements OnApplicationBootstrap, OnApplicationShutdown {
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({
      subjects: ['case.submitted.v1', 'case.resubmitted.v1', 'case.cancelled.v1', 'incident.created.v1'],
      handler: (event, q) => this.onEvent(event, q),
    });
    this.sweepTimer = setInterval(() => void this.sweepSla(), SLA_SWEEP_MS);
    this.sweepTimer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.sweepTimer);
  }

  // ---------------------------------------------------------------------------
  // Definitions
  // ---------------------------------------------------------------------------

  listDefinitions(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query('SELECT id, key, version, name, subject_type, definition, active, created_by, created_at FROM workflow_definitions ORDER BY key, version DESC'),
    );
  }

  /** Publishes a new version. Running instances continue on the version they started with. */
  createDefinition(user: Principal, input: z.infer<typeof CreateDefinition>) {
    return this.db.tx(user.tenantId, async (q) => {
      const { next } = await q.one<{ next: number }>('SELECT COALESCE(max(version), 0) + 1 AS next FROM workflow_definitions WHERE key = $1', [input.key]);
      await q.exec('UPDATE workflow_definitions SET active = false WHERE key = $1 AND active', [input.key]);
      return q.one(
        `INSERT INTO workflow_definitions (tenant_id, key, version, name, subject_type, definition, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, key, version, name, subject_type, definition, active, created_at`,
        [user.tenantId, input.key, next, input.name, input.subject_type, JSON.stringify(input.definition), user.username],
      );
    });
  }

  private async definitionOf(q: Q, instance: InstanceRow): Promise<Definition> {
    const row = await q.one<{ definition: unknown }>('SELECT definition FROM workflow_definitions WHERE id = $1', [instance.definition_id]);
    return Definition.parse(row.definition);
  }

  // ---------------------------------------------------------------------------
  // Process execution
  // ---------------------------------------------------------------------------

  private async activateStage(q: Q, instance: InstanceRow, stage: Stage): Promise<void> {
    const now = new Date();
    const due = dueDate(stage, now);
    for (const role of stage.roles) {
      const task = await q.maybeOne<TaskRow>(
        `INSERT INTO workflow_tasks (tenant_id, instance_id, cycle, stage_key, stage_name, role, assigned_at, due_at, escalate_to_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (instance_id, cycle, stage_key, role) DO NOTHING
         RETURNING ${TASK_COLUMNS}`,
        [instance.tenant_id, instance.id, instance.cycle, stage.key, stage.name, role, now, due, stage.escalate_to_role ?? null],
      );
      if (!task) continue;
      await this.outbox.emit(q, {
        type: 'workflow.task.assigned.v1',
        aggregateType: 'workflow_task',
        aggregateId: task.id,
        tenantId: instance.tenant_id,
        payload: {
          task_id: task.id,
          instance_id: instance.id,
          subject_type: instance.subject_type,
          subject_id: instance.subject_id,
          reference: instance.reference,
          stage_key: stage.key,
          stage_name: stage.name,
          role,
          due_at: due ? due.toISOString() : null,
        },
      });
      // Internal, in-app only: tells the reviewing role that work is waiting.
      await this.outbox.emit(q, {
        type: 'notification.requested.v1',
        aggregateType: 'workflow_task',
        aggregateId: task.id,
        tenantId: instance.tenant_id,
        payload: {
          dedupe_key: `task-assigned:${task.id}`,
          channel: 'in_app',
          category: 'workflow.task_assigned',
          external: false,
          recipient_user_id: null,
          recipient_role: role,
          recipient_address: null,
          subject: `${stage.name}: ${instance.reference}`,
          body: `"${instance.title}" is waiting for ${stage.name.toLowerCase()}.`,
          reference_type: instance.subject_type,
          reference_id: instance.subject_id,
        },
      });
    }
    await q.exec('UPDATE workflow_instances SET current_stage_key = $2, version = version + 1, updated_at = now() WHERE id = $1', [instance.id, stage.key]);
  }

  /**
   * Applicant-facing (external) notification. Sent only for milestones the
   * definition lists, and written to the outbox in the same transaction as
   * the state change, so it cannot be delivered for a decision that did not commit.
   */
  private async notifyApplicant(q: Q, instance: InstanceRow, definition: Definition, milestone: Milestone, body: string): Promise<void> {
    if (instance.subject_type !== 'case' || !instance.applicant_id) return;
    if (!definition.applicant_notifications.includes(milestone)) return;
    await this.outbox.emit(q, {
      type: 'notification.requested.v1',
      aggregateType: 'workflow_instance',
      aggregateId: instance.id,
      tenantId: instance.tenant_id,
      payload: {
        dedupe_key: `applicant:${instance.id}:${instance.cycle}:${milestone}`,
        channel: 'email',
        category: `case.${milestone}`,
        external: true,
        recipient_user_id: instance.applicant_id,
        recipient_role: null,
        recipient_address: instance.applicant_email,
        subject: `Application ${instance.reference}: ${milestone}`,
        body,
        reference_type: 'case',
        reference_id: instance.subject_id,
      },
    });
  }

  private async cancelPendingTasks(q: Q, instance: InstanceRow): Promise<void> {
    const cancelled = await q.query<TaskRow>(
      `UPDATE workflow_tasks SET status = 'cancelled', closed_at = now() WHERE instance_id = $1 AND status = 'pending' RETURNING ${TASK_COLUMNS}`,
      [instance.id],
    );
    for (const t of cancelled) await this.emitTaskClosed(q, instance, t);
  }

  private emitTaskClosed(q: Q, instance: InstanceRow, task: TaskRow) {
    return this.outbox.emit(q, {
      type: 'workflow.task.closed.v1',
      aggregateType: 'workflow_task',
      aggregateId: task.id,
      tenantId: instance.tenant_id,
      payload: {
        task_id: task.id,
        instance_id: instance.id,
        subject_type: instance.subject_type,
        subject_id: instance.subject_id,
        stage_key: task.stage_key,
        role: task.role,
        status: task.status as 'completed' | 'cancelled',
        decision: task.decision,
        decided_by: task.decided_by,
        assigned_at: task.assigned_at.toISOString(),
        closed_at: (task.closed_at ?? new Date()).toISOString(),
      },
    });
  }

  private async completeInstance(
    q: Q,
    instance: InstanceRow,
    definition: Definition,
    outcome: 'approved' | 'rejected' | 'cancelled',
    decidedBy: string | null,
  ): Promise<void> {
    const completedAt = new Date();
    await this.cancelPendingTasks(q, instance);
    await q.exec(
      `UPDATE workflow_instances SET status = $2, current_stage_key = NULL, completed_at = $3, version = version + 1, updated_at = now() WHERE id = $1`,
      [instance.id, outcome, completedAt],
    );
    if (instance.subject_type === 'case') {
      await this.outbox.emit(q, {
        type: 'workflow.case.completed.v1',
        aggregateType: 'case',
        aggregateId: instance.subject_id,
        tenantId: instance.tenant_id,
        payload: {
          instance_id: instance.id,
          case_id: instance.subject_id,
          outcome,
          decided_by: decidedBy,
          started_at: instance.started_at.toISOString(),
          completed_at: completedAt.toISOString(),
        },
      });
    } else {
      await this.outbox.emit(q, {
        type: 'workflow.instance.completed.v1',
        aggregateType: 'workflow_instance',
        aggregateId: instance.id,
        tenantId: instance.tenant_id,
        payload: {
          instance_id: instance.id,
          subject_type: instance.subject_type,
          subject_id: instance.subject_id,
          outcome,
          started_at: instance.started_at.toISOString(),
          completed_at: completedAt.toISOString(),
        },
      });
    }
    if (outcome === 'approved') {
      await this.notifyApplicant(q, instance, definition, 'approved', `Your application "${instance.title}" (${instance.reference}) has been approved.`);
    } else if (outcome === 'rejected') {
      await this.notifyApplicant(q, instance, definition, 'rejected', `Your application "${instance.title}" (${instance.reference}) was not approved.`);
    }
  }

  private async startInstance(
    q: Q,
    tenantId: string,
    def: DefinitionRow,
    subject: { type: 'case' | 'incident'; id: string; reference: string; title: string; applicantId: string | null; applicantEmail: string | null },
    context: Record<string, unknown>,
  ): Promise<void> {
    const definition = Definition.parse(def.definition);
    const instance = await q.maybeOne<InstanceRow>(
      `INSERT INTO workflow_instances (tenant_id, definition_id, definition_key, definition_version, subject_type, subject_id, reference, title, applicant_id, applicant_email, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, subject_type, subject_id) DO NOTHING
       RETURNING ${INSTANCE_COLUMNS}`,
      [tenantId, def.id, def.key, def.version, subject.type, subject.id, subject.reference, subject.title, subject.applicantId, subject.applicantEmail, JSON.stringify(context)],
    );
    // A process already exists for this subject: the event is a repeat.
    if (!instance) return;

    await this.outbox.emit(q, {
      type: 'workflow.instance.started.v1',
      aggregateType: 'workflow_instance',
      aggregateId: instance.id,
      tenantId,
      payload: { instance_id: instance.id, subject_type: subject.type, subject_id: subject.id, definition_key: def.key, definition_version: def.version },
    });
    const first = nextStage(definition, null, context);
    if (!first) {
      await this.completeInstance(q, instance, definition, 'approved', null);
      return;
    }
    await this.activateStage(q, instance, first);
    await this.notifyApplicant(q, instance, definition, 'submitted', `We received your application "${instance.title}" (${instance.reference}).`);
  }

  // ---------------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------------

  async decide(user: Principal, taskId: string, input: z.infer<typeof DecideTask>, idempotencyKey: string | null) {
    try {
      return await this.decideInTransaction(user, taskId, input, idempotencyKey);
    } catch (err) {
      if (err instanceof DomainError && err.status === 403) {
        // The decision transaction rolled back; record the refusal separately as audit evidence.
        await this.db
          .tx(user.tenantId, (q) =>
            this.outbox.emit(q, {
              type: 'security.access_denied.v1',
              aggregateType: 'workflow_task',
              aggregateId: taskId,
              tenantId: user.tenantId,
              payload: { user_id: user.userId, username: user.username, method: 'POST', path: `/tasks/${taskId}/decision`, required_roles: [], reason: err.message },
            }),
          )
          .catch((e) => this.logger.warn({ error: (e as Error).message }, 'could not record denied decision'));
      }
      throw err;
    }
  }

  private decideInTransaction(user: Principal, taskId: string, input: z.infer<typeof DecideTask>, idempotencyKey: string | null) {
    return this.db.tx(user.tenantId, async (q) => {
      const probe = await q.maybeOne<{ instance_id: string }>('SELECT instance_id FROM workflow_tasks WHERE id = $1', [taskId]);
      if (!probe) throw DomainError.notFound('task');
      // Lock order: instance, then task. Every decision on the same process
      // is serialised here, so two concurrent decisions cannot both proceed.
      const instance = await q.one<InstanceRow>(`SELECT ${INSTANCE_COLUMNS} FROM workflow_instances WHERE id = $1 FOR UPDATE`, [probe.instance_id]);
      const task = await q.one<TaskRow>(`SELECT ${TASK_COLUMNS} FROM workflow_tasks WHERE id = $1 FOR UPDATE`, [taskId]);

      if (task.status !== 'pending') {
        if (idempotencyKey && task.status === 'completed' && task.decided_by === user.userId) {
          const previous = await q.maybeOne<{ id: string; decision: Decision }>(
            'SELECT id, decision FROM workflow_decisions WHERE task_id = $1 AND idempotency_key = $2',
            [taskId, idempotencyKey],
          );
          // Same caller retrying the same request: report the original result, do nothing.
          if (previous && previous.decision === input.decision) {
            const current = await q.one<InstanceRow>(`SELECT ${INSTANCE_COLUMNS} FROM workflow_instances WHERE id = $1`, [instance.id]);
            return { task_id: taskId, decision_id: previous.id, decision: previous.decision, instance_status: current.status, replayed: true };
          }
        }
        throw DomainError.conflict('task_already_decided', `this task is already ${task.status}`);
      }
      if (instance.status !== 'running') throw DomainError.conflict('invalid_state', `the process is ${instance.status}`);

      // --- authorisation: role, or an active delegation of that role ---------
      let onBehalfOf: string | null = null;
      if (!user.roles.includes(task.role)) {
        const delegation = await q.maybeOne<{ from_user_id: string }>(
          `SELECT from_user_id FROM delegations
            WHERE to_username = $1 AND role = $2 AND revoked_at IS NULL AND valid_from <= now() AND valid_to > now()
            ORDER BY created_at LIMIT 1`,
          [user.username, task.role],
        );
        if (!delegation) throw DomainError.forbidden(`this task requires the role '${task.role}'`);
        onBehalfOf = delegation.from_user_id;
      }
      // Separation of duties: nobody decides on their own application.
      if (instance.applicant_id && instance.applicant_id === user.userId) {
        throw DomainError.forbidden('you cannot decide on your own application');
      }

      const definition = await this.definitionOf(q, instance);
      if (input.decision === 'return' && (!definition.allow_return || instance.subject_type !== 'case')) {
        throw DomainError.conflict('return_not_allowed', 'this process does not allow returning for changes');
      }
      if (input.decision !== 'approve' && !input.comment) {
        throw DomainError.invalid('a comment is required when rejecting or returning');
      }

      // --- record the decision -------------------------------------------------
      const comment = input.comment ?? null;
      const decision = await q.one<{ id: string }>(
        `INSERT INTO workflow_decisions (tenant_id, instance_id, task_id, stage_key, decision, decided_by, decided_by_username, on_behalf_of, comment, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [user.tenantId, instance.id, task.id, task.stage_key, input.decision, user.userId, user.username, onBehalfOf, comment, idempotencyKey],
      );
      const closed = await q.one<TaskRow>(
        `UPDATE workflow_tasks
            SET status = 'completed', decision = $2, decided_by = $3, decided_by_username = $4, on_behalf_of = $5, comment = $6, closed_at = now()
          WHERE id = $1 RETURNING ${TASK_COLUMNS}`,
        [task.id, input.decision, user.userId, user.username, onBehalfOf, comment],
      );
      await this.outbox.emit(q, {
        type: DECISION_EVENT[input.decision],
        aggregateType: 'workflow_task',
        aggregateId: task.id,
        tenantId: user.tenantId,
        payload: {
          decision_id: decision.id,
          task_id: task.id,
          instance_id: instance.id,
          subject_type: instance.subject_type,
          subject_id: instance.subject_id,
          stage_key: task.stage_key,
          decided_by: user.userId,
          decided_by_username: user.username,
          on_behalf_of: onBehalfOf,
          comment,
        },
      });
      await this.emitTaskClosed(q, instance, closed);

      // --- advance the process ---------------------------------------------------
      const stageTasks = await q.query<TaskState>('SELECT id, role, status FROM workflow_tasks WHERE instance_id = $1 AND cycle = $2 AND stage_key = $3', [
        instance.id,
        instance.cycle,
        task.stage_key,
      ]);
      const outcome = stageOutcome(input.decision, stageTasks);
      let instanceStatus: InstanceRow['status'] = 'running';

      if (outcome.kind === 'stage_complete') {
        await this.outbox.emit(q, {
          type: 'workflow.stage.completed.v1',
          aggregateType: 'workflow_instance',
          aggregateId: instance.id,
          tenantId: user.tenantId,
          payload: {
            instance_id: instance.id,
            subject_type: instance.subject_type,
            subject_id: instance.subject_id,
            stage_key: task.stage_key,
            stage_name: task.stage_name,
            completed_by: user.userId,
            completed_by_username: user.username,
            completed_at: new Date().toISOString(),
          },
        });
        const next = nextStage(definition, task.stage_key, instance.context);
        if (next) {
          await this.activateStage(q, instance, next);
        } else {
          await this.completeInstance(q, instance, definition, 'approved', user.userId);
          instanceStatus = 'approved';
        }
      } else if (outcome.kind === 'rejected') {
        await this.completeInstance(q, instance, definition, 'rejected', user.userId);
        instanceStatus = 'rejected';
      } else if (outcome.kind === 'returned') {
        await this.cancelPendingTasks(q, instance);
        await q.exec(`UPDATE workflow_instances SET status = 'returned', current_stage_key = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [instance.id]);
        await this.outbox.emit(q, {
          type: 'workflow.case.returned.v1',
          aggregateType: 'case',
          aggregateId: instance.subject_id,
          tenantId: user.tenantId,
          payload: { instance_id: instance.id, case_id: instance.subject_id, stage_key: task.stage_key, returned_by: user.userId, comment },
        });
        await this.notifyApplicant(
          q,
          instance,
          definition,
          'returned',
          `Your application "${instance.title}" (${instance.reference}) needs changes before it can continue: ${comment}`,
        );
        instanceStatus = 'returned';
      } else {
        await q.exec('UPDATE workflow_instances SET version = version + 1, updated_at = now() WHERE id = $1', [instance.id]);
      }

      return { task_id: task.id, decision_id: decision.id, decision: input.decision, instance_status: instanceStatus, replayed: false };
    });
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  listTasks(user: Principal, query: z.infer<typeof ListTasks>) {
    return this.db.tx(user.tenantId, (q) => {
      const params: unknown[] = [query.status];
      const where = ['t.status = $1'];
      const seeAll = query.scope === 'all' && hasAnyRole(user, [Roles.TenantAdmin, Roles.Auditor]);
      if (!seeAll) {
        params.push(user.roles, user.username);
        where.push(`(t.role = ANY($2::text[]) OR t.role IN (
          SELECT d.role FROM delegations d
           WHERE d.to_username = $3 AND d.revoked_at IS NULL AND d.valid_from <= now() AND d.valid_to > now()))`);
      }
      if (query.subject_id) {
        params.push(query.subject_id);
        where.push(`i.subject_id = $${params.length}`);
      }
      params.push(query.limit);
      return q.query(
        `SELECT t.id, t.instance_id, t.stage_key, t.stage_name, t.role, t.status, t.decision, t.decided_by_username, t.comment,
                t.assigned_at, t.due_at, t.escalated_at, t.closed_at,
                (t.status = 'pending' AND t.due_at IS NOT NULL AND t.due_at < now()) AS overdue,
                i.subject_type, i.subject_id, i.reference, i.title, i.status AS instance_status
           FROM workflow_tasks t JOIN workflow_instances i ON i.id = t.instance_id
          WHERE ${where.join(' AND ')}
          ORDER BY t.assigned_at
          LIMIT $${params.length}`,
        params,
      );
    });
  }

  private assertCanReadInstance(user: Principal, instance: InstanceRow): void {
    if (instance.applicant_id === user.userId || hasAnyRole(user, STAFF_ROLES)) return;
    throw DomainError.notFound('workflow');
  }

  private async describe(q: Q, instance: InstanceRow) {
    const definition = await this.definitionOf(q, instance);
    const tasks = await q.query(
      `SELECT id, cycle, stage_key, stage_name, role, status, decision, decided_by_username, on_behalf_of, comment, assigned_at, due_at, escalated_at, closed_at
         FROM workflow_tasks WHERE instance_id = $1 ORDER BY assigned_at, role`,
      [instance.id],
    );
    const decisions = await q.query(
      `SELECT id, task_id, stage_key, decision, decided_by_username, on_behalf_of, comment, decided_at
         FROM workflow_decisions WHERE instance_id = $1 ORDER BY decided_at, id`,
      [instance.id],
    );
    const { context: _context, applicant_email: _email, ...summary } = instance;
    return {
      ...summary,
      stages: plannedStages(definition, instance.context).map((s) => ({ key: s.key, name: s.name, type: s.type, roles: s.roles, sla_hours: s.sla_hours ?? null })),
      tasks,
      decisions,
    };
  }

  getInstance(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const instance = await q.maybeOne<InstanceRow>(`SELECT ${INSTANCE_COLUMNS} FROM workflow_instances WHERE id = $1`, [id]);
      if (!instance) throw DomainError.notFound('workflow');
      this.assertCanReadInstance(user, instance);
      return this.describe(q, instance);
    });
  }

  getInstanceBySubject(user: Principal, subjectType: string, subjectId: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const instance = await q.maybeOne<InstanceRow>(`SELECT ${INSTANCE_COLUMNS} FROM workflow_instances WHERE subject_type = $1 AND subject_id = $2`, [
        subjectType,
        subjectId,
      ]);
      if (!instance) throw DomainError.notFound('workflow');
      this.assertCanReadInstance(user, instance);
      return this.describe(q, instance);
    });
  }

  stats(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const pendingByRole = await q.query(
        `SELECT role, count(*)::int AS pending, count(*) FILTER (WHERE due_at < now())::int AS overdue
           FROM workflow_tasks WHERE status = 'pending' GROUP BY role ORDER BY role`,
      );
      const instances = await q.query('SELECT subject_type, status, count(*)::int AS count FROM workflow_instances GROUP BY subject_type, status ORDER BY 1, 2');
      const turnaround = await q.one<{ avg_hours: number | null; completed: number }>(
        `SELECT round((avg(extract(epoch FROM completed_at - started_at)) / 3600)::numeric, 2) AS avg_hours, count(*)::int AS completed
           FROM workflow_instances WHERE subject_type = 'case' AND status IN ('approved', 'rejected')`,
      );
      return { pending_by_role: pendingByRole, instances, case_turnaround: turnaround };
    });
  }

  // ---------------------------------------------------------------------------
  // Delegations
  // ---------------------------------------------------------------------------

  createDelegation(user: Principal, input: z.infer<typeof CreateDelegation>) {
    // A user can only delegate authority they hold themselves.
    if (!user.roles.includes(input.role)) throw DomainError.forbidden(`you do not hold the role '${input.role}'`);
    if (input.to_username === user.username) throw DomainError.invalid('you cannot delegate to yourself');
    if (new Date(input.valid_to).getTime() <= Date.now()) throw DomainError.invalid('valid_to must be in the future');
    return this.db.tx(user.tenantId, (q) =>
      q.one(
        `INSERT INTO delegations (tenant_id, from_user_id, from_username, to_username, role, reason, valid_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, from_username, to_username, role, reason, valid_from, valid_to, revoked_at`,
        [user.tenantId, user.userId, user.username, input.to_username, input.role, input.reason ?? null, input.valid_to],
      ),
    );
  }

  listDelegations(user: Principal) {
    return this.db.tx(user.tenantId, (q) => {
      const admin = hasAnyRole(user, [Roles.TenantAdmin, Roles.Auditor]);
      return q.query(
        `SELECT id, from_username, to_username, role, reason, valid_from, valid_to, revoked_at,
                (revoked_at IS NULL AND valid_from <= now() AND valid_to > now()) AS active
           FROM delegations
          WHERE $1::boolean OR from_user_id = $2 OR to_username = $3
          ORDER BY created_at DESC`,
        [admin, user.userId, user.username],
      );
    });
  }

  revokeDelegation(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await q.maybeOne<{ from_user_id: string }>('SELECT from_user_id FROM delegations WHERE id = $1 FOR UPDATE', [id]);
      if (!row) throw DomainError.notFound('delegation');
      if (row.from_user_id !== user.userId && !hasAnyRole(user, [Roles.TenantAdmin])) throw DomainError.forbidden('only the delegator may revoke a delegation');
      return q.one('UPDATE delegations SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING id, revoked_at', [id]);
    });
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private async onEvent(event: EventEnvelope, q: Q): Promise<void> {
    switch (event.event_type) {
      case 'case.submitted.v1': {
        const p = event.payload as EventPayload<'case.submitted.v1'>;
        const def = await q.maybeOne<DefinitionRow>(
          `SELECT id, key, version, name, subject_type, definition FROM workflow_definitions WHERE key = $1 AND subject_type = 'case' AND active`,
          [p.workflow_key],
        );
        // Failing here is deliberate: the event is retried and finally
        // dead-lettered, which is visible, instead of a case silently stalling.
        if (!def) throw new Error(`no active workflow definition '${p.workflow_key}' for tenant ${event.tenant_id}`);
        await this.startInstance(
          q,
          event.tenant_id,
          def,
          { type: 'case', id: p.case_id, reference: p.reference_no, title: p.title, applicantId: p.applicant_id, applicantEmail: p.applicant_email },
          p.data,
        );
        return;
      }
      case 'case.resubmitted.v1': {
        const p = event.payload as EventPayload<'case.resubmitted.v1'>;
        const instance = await q.maybeOne<InstanceRow>(
          `SELECT ${INSTANCE_COLUMNS} FROM workflow_instances WHERE subject_type = 'case' AND subject_id = $1 FOR UPDATE`,
          [p.case_id],
        );
        if (!instance || instance.status !== 'returned') return;
        const definition = await this.definitionOf(q, instance);
        const resumed = await q.one<InstanceRow>(
          `UPDATE workflow_instances SET status = 'running', cycle = cycle + 1, context = $2, version = version + 1, updated_at = now()
            WHERE id = $1 RETURNING ${INSTANCE_COLUMNS}`,
          [instance.id, JSON.stringify(p.data)],
        );
        // Review restarts from the first stage: the changed application is re-validated in full.
        const first = nextStage(definition, null, resumed.context);
        if (first) await this.activateStage(q, resumed, first);
        return;
      }
      case 'case.cancelled.v1': {
        const p = event.payload as EventPayload<'case.cancelled.v1'>;
        const instance = await q.maybeOne<InstanceRow>(
          `SELECT ${INSTANCE_COLUMNS} FROM workflow_instances WHERE subject_type = 'case' AND subject_id = $1 FOR UPDATE`,
          [p.case_id],
        );
        if (!instance || (instance.status !== 'running' && instance.status !== 'returned')) return;
        await this.completeInstance(q, instance, await this.definitionOf(q, instance), 'cancelled', p.cancelled_by);
        return;
      }
      case 'incident.created.v1': {
        const p = event.payload as EventPayload<'incident.created.v1'>;
        const def = await q.maybeOne<DefinitionRow>(
          `SELECT id, key, version, name, subject_type, definition FROM workflow_definitions WHERE key = $1 AND subject_type = 'incident' AND active`,
          [INCIDENT_WORKFLOW_KEY],
        );
        if (!def) {
          this.logger.warn({ tenant_id: event.tenant_id, incident_id: p.incident_id }, 'no incident-response workflow configured; incident has no response process');
          return;
        }
        await this.startInstance(
          q,
          event.tenant_id,
          def,
          { type: 'incident', id: p.incident_id, reference: p.reference_no, title: p.title, applicantId: null, applicantEmail: null },
          { severity: p.severity, source_type: p.source_type },
        );
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SLA tracking
  // ---------------------------------------------------------------------------

  /** Flags overdue tasks once, emits escalation metadata and notifies the escalation role. */
  async sweepSla(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let escalated = 0;
    try {
      const due = await this.db.tx(null, (q) => q.query<{ task_id: string; tenant_id: string }>('SELECT task_id, tenant_id FROM workflow_overdue_tasks($1)', [200]));
      for (const row of due) {
        const ctx = newContext({ actor: { id: 'workflow-service', type: 'system' } });
        const done = await runWithContext(ctx, () =>
          this.db.tx(row.tenant_id, async (q) => {
            const task = await q.maybeOne<TaskRow>(
              `UPDATE workflow_tasks SET escalated_at = now()
                WHERE id = $1 AND status = 'pending' AND escalated_at IS NULL
                RETURNING ${TASK_COLUMNS}`,
              [row.task_id],
            );
            if (!task || !task.due_at || !task.escalated_at) return false;
            const instance = await q.one<InstanceRow>(`SELECT ${INSTANCE_COLUMNS} FROM workflow_instances WHERE id = $1`, [task.instance_id]);
            await this.outbox.emit(q, {
              type: 'workflow.task.escalated.v1',
              aggregateType: 'workflow_task',
              aggregateId: task.id,
              tenantId: row.tenant_id,
              payload: {
                task_id: task.id,
                instance_id: instance.id,
                subject_type: instance.subject_type,
                subject_id: instance.subject_id,
                stage_key: task.stage_key,
                role: task.role,
                escalate_to_role: task.escalate_to_role,
                due_at: task.due_at.toISOString(),
                escalated_at: task.escalated_at.toISOString(),
              },
            });
            if (task.escalate_to_role) {
              await this.outbox.emit(q, {
                type: 'notification.requested.v1',
                aggregateType: 'workflow_task',
                aggregateId: task.id,
                tenantId: row.tenant_id,
                payload: {
                  dedupe_key: `task-escalated:${task.id}`,
                  channel: 'in_app',
                  category: 'workflow.task_escalated',
                  external: false,
                  recipient_user_id: null,
                  recipient_role: task.escalate_to_role,
                  recipient_address: null,
                  subject: `Overdue: ${task.stage_name} for ${instance.reference}`,
                  body: `The ${task.stage_name.toLowerCase()} task for "${instance.title}" passed its deadline and is still pending with role ${task.role}.`,
                  reference_type: instance.subject_type,
                  reference_id: instance.subject_id,
                },
              });
            }
            return true;
          }),
        );
        if (done) escalated += 1;
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'SLA sweep failed');
    } finally {
      this.sweeping = false;
    }
    return escalated;
  }
}
