/** Pure maintenance rules (no I/O). */

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type WorkOrderStatus = 'open' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';
export type WorkOrderAction = 'assign' | 'start' | 'complete' | 'cancel';

/** Priority of a request raised automatically from an incident. */
export function priorityFromSeverity(severity: string, fallback: Priority): Priority {
  if (severity === 'critical') return 'urgent';
  if (severity === 'warning') return 'high';
  if (severity === 'info') return 'normal';
  return fallback;
}

/** Work order lifecycle: open -> assigned -> in_progress -> completed. `completed` and `cancelled` are final. */
const ALLOWED: Record<WorkOrderAction, WorkOrderStatus[]> = {
  // Re-assigning is allowed until the work has started.
  assign: ['open', 'assigned'],
  start: ['assigned'],
  complete: ['in_progress'],
  cancel: ['open', 'assigned', 'in_progress'],
};

export function canPerform(action: WorkOrderAction, status: WorkOrderStatus): boolean {
  return ALLOWED[action].includes(status);
}

/**
 * Who may start or complete a work order: the person it is assigned to, or
 * someone holding a planning role. Being a technician is not enough.
 */
export function mayExecute(user: { userId: string; roles: string[] }, assigneeId: string | null, planningRoles: readonly string[]): boolean {
  return (assigneeId !== null && assigneeId === user.userId) || planningRoles.some((r) => user.roles.includes(r));
}

/** Hours between two instants, rounded to two decimals; null when either is missing. */
export function hoursBetween(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  return Math.round(((to.getTime() - from.getTime()) / 3_600_000) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Planning (preventive plans, inspections) and cost
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** YYYY-MM-DD of a date in UTC. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The due date after `dueOn`: one interval later, or, when the plan has fallen behind,
 * the first date after `today` on the plan's rhythm (missed periods are not back-filled).
 */
export function nextDueAfter(dueOn: string, intervalDays: number, today: string): string {
  let next = new Date(`${dueOn}T00:00:00Z`).getTime() + intervalDays * DAY_MS;
  const limit = new Date(`${today}T00:00:00Z`).getTime();
  while (next <= limit) next += intervalDays * DAY_MS;
  return isoDay(new Date(next));
}

export interface ChecklistItem {
  key: string;
  question: string;
  kind: 'pass_fail' | 'number';
  min?: number;
  max?: number;
  unit?: string;
}

export type ChecklistOutcome =
  | { ok: true; failures: { key: string; question: string; reason: string }[] }
  | { ok: false; reason: string };

/**
 * Checks inspection results against the checklist: every item must be answered with the right
 * kind of value. A pass/fail item fails when false; a number fails outside [min, max].
 */
export function evaluateChecklist(items: ChecklistItem[], results: Record<string, unknown>): ChecklistOutcome {
  const unknown = Object.keys(results).filter((k) => !items.some((i) => i.key === k));
  if (unknown.length) return { ok: false, reason: `unknown checklist item(s): ${unknown.join(', ')}` };
  const failures: { key: string; question: string; reason: string }[] = [];
  for (const item of items) {
    const v = results[item.key];
    if (v === undefined || v === null) return { ok: false, reason: `item '${item.key}' is not answered` };
    if (item.kind === 'pass_fail') {
      if (typeof v !== 'boolean') return { ok: false, reason: `item '${item.key}' needs true or false` };
      if (!v) failures.push({ key: item.key, question: item.question, reason: 'failed' });
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: `item '${item.key}' needs a number` };
      const unit = item.unit ? ` ${item.unit}` : '';
      if (item.min !== undefined && v < item.min) failures.push({ key: item.key, question: item.question, reason: `${v}${unit} is below the minimum of ${item.min}${unit}` });
      else if (item.max !== undefined && v > item.max) failures.push({ key: item.key, question: item.question, reason: `${v}${unit} is above the maximum of ${item.max}${unit}` });
    }
  }
  return { ok: true, failures };
}

/** Cost in cents-exact decimal: hours x rate, rounded to two decimals. */
export function laborCost(hours: number | null, rate: number): number | null {
  if (hours === null) return null;
  return Math.round(hours * rate * 100) / 100;
}
