/** Realm roles issued by Keycloak. Keep in sync with infrastructure/docker/keycloak/titan-realm.json. */
export const Roles = {
  Applicant: 'applicant',
  ValidationOfficer: 'validation_officer',
  TechnicalOfficer: 'technical_officer',
  DepartmentHead: 'department_head',
  FinalApprover: 'final_approver',
  DutyOfficer: 'duty_officer',
  IncidentCommander: 'incident_commander',
  AssetManager: 'asset_manager',
  IotOperator: 'iot_operator',
  Analyst: 'analyst',
  Auditor: 'auditor',
  TenantAdmin: 'tenant_admin',
  DrOperator: 'dr_operator',
  PlatformAdmin: 'platform_admin',
  /** Machine identity (client-credentials service accounts). */
  Service: 'service',
} as const;

export type Role = (typeof Roles)[keyof typeof Roles];

/** Roles that review government cases. */
export const REVIEWER_ROLES: readonly string[] = [
  Roles.ValidationOfficer,
  Roles.TechnicalOfficer,
  Roles.DepartmentHead,
  Roles.FinalApprover,
];

/** Internal staff: anyone who is not only an applicant. */
export const STAFF_ROLES: readonly string[] = [
  ...REVIEWER_ROLES,
  Roles.DutyOfficer,
  Roles.IncidentCommander,
  Roles.AssetManager,
  Roles.IotOperator,
  Roles.Analyst,
  Roles.Auditor,
  Roles.TenantAdmin,
];
