import { z } from 'zod';

/**
 * Controlled registry of business subject types a workflow can run on.
 *
 * A subject type is added here (and, by a forward-only migration, to the
 * `workflow_subject_types` table of workflow-service) before any service may
 * start a process for it. `owner` is the service that owns the records;
 * `null` means the type is registered and usable through the generic
 * `workflow.start.requested.v1` contract, but no service in this repository
 * owns such records yet.
 */
export interface SubjectTypeInfo {
  key: string;
  label: string;
  owner: string | null;
  /** Reviewers may send the subject back to its submitter for changes. */
  supportsReturn: boolean;
}

export const SUBJECT_TYPES = [
  { key: 'case', label: 'Application or case', owner: 'case-service', supportsReturn: true },
  { key: 'incident', label: 'Incident', owner: 'incident-service', supportsReturn: false },
  { key: 'maintenance_request', label: 'Maintenance request', owner: 'maintenance-service', supportsReturn: false },
  { key: 'service_request', label: 'Service request', owner: 'maintenance-service', supportsReturn: false },
  { key: 'work_order', label: 'Work order', owner: null, supportsReturn: false },
  { key: 'inspection', label: 'Inspection', owner: null, supportsReturn: false },
  { key: 'purchase_request', label: 'Purchase request', owner: 'procurement-service', supportsReturn: false },
  { key: 'quality_deviation', label: 'Quality deviation', owner: null, supportsReturn: false },
  { key: 'contract', label: 'Contract', owner: null, supportsReturn: false },
  // A controlled document version submitted for review before it is published.
  { key: 'document', label: 'Document review', owner: 'document-service', supportsReturn: false },
] as const satisfies readonly SubjectTypeInfo[];

export type SubjectType = (typeof SUBJECT_TYPES)[number]['key'];

export const SUBJECT_TYPE_KEYS = SUBJECT_TYPES.map((s) => s.key) as [SubjectType, ...SubjectType[]];

export const SubjectTypeSchema = z.enum(SUBJECT_TYPE_KEYS);

export function subjectTypeInfo(key: string): SubjectTypeInfo | undefined {
  return SUBJECT_TYPES.find((s) => s.key === key);
}

/** Where an incident can originate. `alert` and `manual` are the original two. */
export const INCIDENT_SOURCE_TYPES = ['alert', 'manual', 'inspection', 'work_order', 'service_request', 'external'] as const;
export type IncidentSourceType = (typeof INCIDENT_SOURCE_TYPES)[number];
export const IncidentSourceTypeSchema = z.enum(INCIDENT_SOURCE_TYPES);

/** Category every tenant has without any pack. */
export const DEFAULT_INCIDENT_CATEGORY = 'general';
export const DEFAULT_INCIDENT_WORKFLOW = 'incident-response';
