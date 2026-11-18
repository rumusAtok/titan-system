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
  // Roles introduced with the maintenance capability and the industry packs (TITAN v3).
  ProductionSupervisor: 'production_supervisor',
  MaintenancePlanner: 'maintenance_planner',
  MaintenanceTechnician: 'maintenance_technician',
  FacilityManager: 'facility_manager',
  /** Member of the organisation who may raise service requests and follow their own. Not staff. */
  ServiceRequester: 'service_requester',
  // Roles of the modules added after v3: documents, procurement, video.
  RecordsManager: 'records_manager',
  ProcurementOfficer: 'procurement_officer',
  Storekeeper: 'storekeeper',
  SecurityOperator: 'security_operator',
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
  Roles.ProductionSupervisor,
  Roles.MaintenancePlanner,
  Roles.MaintenanceTechnician,
  Roles.FacilityManager,
  Roles.RecordsManager,
  Roles.ProcurementOfficer,
  Roles.Storekeeper,
  Roles.SecurityOperator,
];

/** Roles that take charge of an incident (acknowledge, assign, annotate). */
export const INCIDENT_RESPONDER_ROLES: readonly string[] = [
  Roles.DutyOfficer,
  Roles.IncidentCommander,
  Roles.ProductionSupervisor,
  Roles.FacilityManager,
  Roles.MaintenancePlanner,
];

/** Roles that may close a resolved incident. */
export const INCIDENT_CLOSER_ROLES: readonly string[] = [Roles.IncidentCommander, Roles.ProductionSupervisor, Roles.FacilityManager];
