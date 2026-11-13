import { describe, expect, it } from 'vitest';
import { Definition, dueDate, evaluateCondition, nextStage, plannedStages, stageOutcome, type TaskState } from './engine.js';

const sequential = Definition.parse({
  stages: [
    { key: 'validation', name: 'Validation', roles: ['validation_officer'], sla_hours: 24 },
    { key: 'technical_review', name: 'Technical review', roles: ['technical_officer'] },
    { key: 'department_endorsement', name: 'Department endorsement', roles: ['department_head'] },
    { key: 'final_approval', name: 'Final approval', roles: ['final_approver'] },
  ],
});

const conditional = Definition.parse({
  stages: [
    { key: 'validation', name: 'Validation', roles: ['validation_officer'] },
    { key: 'joint_review', name: 'Joint review', type: 'parallel', roles: ['technical_officer', 'department_head'] },
    { key: 'final_approval', name: 'Final approval', roles: ['final_approver'], condition: { field: 'expected_attendance', op: 'gte', value: 1000 } },
  ],
});

describe('definition validation', () => {
  it('rejects duplicate stage keys', () => {
    expect(() => Definition.parse({ stages: [{ key: 'a', name: 'A', roles: ['x'] }, { key: 'a', name: 'B', roles: ['y'] }] })).toThrow();
  });
  it('requires a parallel stage to have at least two distinct roles', () => {
    expect(() => Definition.parse({ stages: [{ key: 'a', name: 'A', type: 'parallel', roles: ['x'] }] })).toThrow();
    expect(() => Definition.parse({ stages: [{ key: 'a', name: 'A', type: 'parallel', roles: ['x', 'x'] }] })).toThrow();
  });
  it('requires a single stage to have exactly one role', () => {
    expect(() => Definition.parse({ stages: [{ key: 'a', name: 'A', roles: ['x', 'y'] }] })).toThrow();
  });
  it('rejects a process in which every stage could be skipped', () => {
    expect(() => Definition.parse({ stages: [{ key: 'a', name: 'A', roles: ['x'], condition: { field: 'f', op: 'eq', value: 1 } }] })).toThrow();
  });
});

describe('sequential progression', () => {
  it('visits the four stages in order and then completes', () => {
    const visited: string[] = [];
    let stage = nextStage(sequential, null, {});
    while (stage) {
      visited.push(stage.key);
      stage = nextStage(sequential, stage.key, {});
    }
    expect(visited).toEqual(['validation', 'technical_review', 'department_endorsement', 'final_approval']);
  });

  it('refuses a stage key that is not part of the definition', () => {
    expect(() => nextStage(sequential, 'nonexistent', {})).toThrow();
  });
});

describe('conditional routing', () => {
  it('skips the conditional stage when the condition is false', () => {
    expect(nextStage(conditional, 'joint_review', { expected_attendance: 200 })).toBeNull();
    expect(plannedStages(conditional, { expected_attendance: 200 }).map((s) => s.key)).toEqual(['validation', 'joint_review']);
  });

  it('includes the conditional stage when the condition is true', () => {
    expect(nextStage(conditional, 'joint_review', { expected_attendance: 5000 })?.key).toBe('final_approval');
  });

  it('treats a missing or wrongly typed field as false rather than failing', () => {
    expect(nextStage(conditional, 'joint_review', {})).toBeNull();
    expect(nextStage(conditional, 'joint_review', { expected_attendance: '5000' })).toBeNull();
  });

  it('evaluates every operator', () => {
    const ctx = { n: 5, s: 'commercial' };
    expect(evaluateCondition({ field: 'n', op: 'eq', value: 5 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'n', op: 'ne', value: 5 }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'n', op: 'gt', value: 4 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'n', op: 'gte', value: 5 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'n', op: 'lt', value: 5 }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'n', op: 'lte', value: 5 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 's', op: 'in', value: ['commercial', 'industrial'] }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 's', op: 'in', value: ['residential'] }, ctx)).toBe(false);
  });
});

describe('stage outcome', () => {
  const task = (role: string, status: TaskState['status']): TaskState => ({ id: role, role, status });

  it('a parallel stage waits until every reviewer has approved', () => {
    expect(stageOutcome('approve', [task('technical_officer', 'completed'), task('department_head', 'pending')]).kind).toBe('waiting');
    expect(stageOutcome('approve', [task('technical_officer', 'completed'), task('department_head', 'completed')]).kind).toBe('stage_complete');
  });

  it('a single rejection ends the process even if other reviewers are still pending', () => {
    expect(stageOutcome('reject', [task('technical_officer', 'completed'), task('department_head', 'pending')]).kind).toBe('rejected');
  });

  it('a return sends the subject back regardless of other reviewers', () => {
    expect(stageOutcome('return', [task('technical_officer', 'completed'), task('department_head', 'pending')]).kind).toBe('returned');
  });
});

describe('SLA', () => {
  it('computes the due date from the stage SLA', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(dueDate(sequential.stages[0]!, from)?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(dueDate(sequential.stages[1]!, from)).toBeNull();
  });
});
