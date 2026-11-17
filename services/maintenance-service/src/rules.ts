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
