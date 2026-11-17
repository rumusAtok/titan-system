import type { IncidentSourceType } from '@titan/contracts';

/** Pure incident rules (no I/O). */

const ORIGIN_TEXT: Record<IncidentSourceType, string> = {
  alert: 'Incident raised automatically from an alarm',
  manual: 'Incident reported manually',
  inspection: 'Incident reported from an inspection',
  work_order: 'Incident reported from a work order',
  service_request: 'Incident reported from a service request',
  external: 'Incident reported by an external system',
};

export function describeOrigin(source: IncidentSourceType): string {
  return ORIGIN_TEXT[source];
}

/**
 * An incident is overdue for response when it is still unacknowledged after
 * the target its category sets for its severity. No target: never overdue.
 */
export function responseOverdue(
  incident: { status: string; severity: string; created_at: Date },
  targetsMinutes: Record<string, number>,
  now: Date,
): boolean {
  if (incident.status !== 'open') return false;
  const target = targetsMinutes[incident.severity];
  if (typeof target !== 'number' || !(target > 0)) return false;
  return now.getTime() - incident.created_at.getTime() > target * 60_000;
}
