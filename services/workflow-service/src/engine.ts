import { z } from 'zod';

/**
 * Pure workflow rules: definition schema, conditional routing and stage
 * progression. No I/O, so every rule here is unit-testable.
 */

export const Condition = z.object({
  /** Key in the instance context (the submitted form data). */
  field: z.string().min(1),
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
});
export type Condition = z.infer<typeof Condition>;

export const Stage = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    name: z.string().min(1).max(120),
    /** `single`: one role decides. `parallel`: every listed role must approve. */
    type: z.enum(['single', 'parallel']).default('single'),
    roles: z.array(z.string().min(1)).min(1).max(10),
    sla_hours: z.number().positive().max(24 * 365).optional(),
    escalate_to_role: z.string().min(1).optional(),
    /** When present and false for the instance, the stage is skipped. */
    condition: Condition.optional(),
  })
  .superRefine((stage, ctx) => {
    if (stage.type === 'single' && stage.roles.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['roles'], message: 'a single stage has exactly one role' });
    }
    if (stage.type === 'parallel' && stage.roles.length < 2) {
      ctx.addIssue({ code: 'custom', path: ['roles'], message: 'a parallel stage needs at least two roles' });
    }
    if (new Set(stage.roles).size !== stage.roles.length) {
      ctx.addIssue({ code: 'custom', path: ['roles'], message: 'roles must be distinct' });
    }
  });
export type Stage = z.infer<typeof Stage>;

export const Milestone = z.enum(['submitted', 'returned', 'approved', 'rejected']);
export type Milestone = z.infer<typeof Milestone>;

export const Definition = z
  .object({
    stages: z.array(Stage).min(1).max(30),
    /** Reviewers may send the subject back to the applicant for changes. */
    allow_return: z.boolean().default(true),
    /** Milestones at which the applicant receives an external notification. */
    applicant_notifications: z.array(Milestone).default([]),
  })
  .superRefine((def, ctx) => {
    const keys = new Set<string>();
    def.stages.forEach((s, i) => {
      if (keys.has(s.key)) ctx.addIssue({ code: 'custom', path: ['stages', i, 'key'], message: `duplicate stage key '${s.key}'` });
      keys.add(s.key);
    });
    if (def.stages.every((s) => s.condition)) {
      ctx.addIssue({ code: 'custom', path: ['stages'], message: 'at least one stage must be unconditional' });
    }
  });
export type Definition = z.infer<typeof Definition>;

export type Context = Record<string, unknown>;

/** A missing field or a type mismatch makes the condition false (the stage is skipped), never an error. */
export function evaluateCondition(condition: Condition, context: Context): boolean {
  const actual = context[condition.field];
  const expected = condition.value;
  switch (condition.op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== undefined && actual !== expected;
    case 'in':
      return Array.isArray(expected) && (expected as unknown[]).includes(actual);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof actual !== 'number' || typeof expected !== 'number') return false;
      if (condition.op === 'gt') return actual > expected;
      if (condition.op === 'gte') return actual >= expected;
      if (condition.op === 'lt') return actual < expected;
      return actual <= expected;
    }
  }
}

export function stageApplies(stage: Stage, context: Context): boolean {
  return stage.condition ? evaluateCondition(stage.condition, context) : true;
}

/**
 * First applicable stage after `afterKey` (or from the start when null).
 * Returns null when the process has no further stage, i.e. it is complete.
 */
export function nextStage(definition: Definition, afterKey: string | null, context: Context): Stage | null {
  let index = 0;
  if (afterKey !== null) {
    const current = definition.stages.findIndex((s) => s.key === afterKey);
    if (current < 0) throw new Error(`stage '${afterKey}' is not part of the definition`);
    index = current + 1;
  }
  for (; index < definition.stages.length; index++) {
    const stage = definition.stages[index]!;
    if (stageApplies(stage, context)) return stage;
  }
  return null;
}

/** Stages that the given context will actually visit, in order. */
export function plannedStages(definition: Definition, context: Context): Stage[] {
  return definition.stages.filter((s) => stageApplies(s, context));
}

export function dueDate(stage: Stage, from: Date): Date | null {
  return stage.sla_hours ? new Date(from.getTime() + stage.sla_hours * 3_600_000) : null;
}

export type Decision = 'approve' | 'reject' | 'return';

export interface TaskState {
  id: string;
  role: string;
  status: 'pending' | 'completed' | 'cancelled';
}

export type StageOutcome =
  | { kind: 'waiting'; pending: TaskState[] }
  | { kind: 'stage_complete' }
  | { kind: 'rejected' }
  | { kind: 'returned' };

/**
 * Effect of one decision on its stage, given the stage's tasks *after* the
 * deciding task was marked completed.
 * - approve: the stage completes only when no task is still pending
 *   (parallel review needs every reviewer).
 * - reject / return: end the stage immediately, whatever the other reviewers do.
 */
export function stageOutcome(decision: Decision, tasksAfterDecision: TaskState[]): StageOutcome {
  if (decision === 'reject') return { kind: 'rejected' };
  if (decision === 'return') return { kind: 'returned' };
  const pending = tasksAfterDecision.filter((t) => t.status === 'pending');
  return pending.length ? { kind: 'waiting', pending } : { kind: 'stage_complete' };
}
