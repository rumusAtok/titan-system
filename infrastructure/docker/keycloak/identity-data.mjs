// Realm roles and SYNTHETIC demo identities. Single source for
//   - generate-realm.mjs   (the realm imported into an empty Keycloak)
//   - scripts/identity-sync.mjs (adds what is missing to a Keycloak that already has the realm)
// No real person, organisation or credential appears here.

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
/** Meridian Industrial Group: manufacturing and facilities packs together. */
export const TENANT_C = '33333333-3333-4333-8333-333333333333';
/** Harbourline Properties: used to exercise pack activation, upgrade and deactivation. */
export const TENANT_D = '44444444-4444-4444-8444-444444444444';
export const PLATFORM = '00000000-0000-0000-0000-000000000000';

export const roles = {
  applicant: 'Member of the public who submits and tracks applications',
  validation_officer: 'Checks submitted applications for completeness',
  technical_officer: 'Performs the technical assessment of an application',
  department_head: 'Endorses applications on behalf of the department',
  final_approver: 'Issues the final decision on an application',
  duty_officer: 'Acknowledges and triages operational incidents',
  incident_commander: 'Directs incident response and resolves incidents',
  asset_manager: 'Maintains the asset register',
  iot_operator: 'Manages IoT devices, alert rules and telemetry',
  analyst: 'Reads analytical datasets and reports',
  auditor: 'Reads audit records',
  tenant_admin: 'Administers one tenant (organisation)',
  production_supervisor: 'Acknowledges equipment incidents and approves maintenance requests',
  maintenance_planner: 'Plans and assigns maintenance work orders',
  maintenance_technician: 'Carries out and completes work orders',
  facility_manager: 'Manages facilities, service requests and facility incidents',
  service_requester: 'Raises service requests and follows their own',
  records_manager: 'Reviews and publishes controlled documents; manages retention and legal holds',
  procurement_officer: 'Maintains suppliers and items; reviews purchase requests',
  storekeeper: 'Receives goods, issues stock and records stock counts',
  security_operator: 'Watches cameras and maintains the camera register',
  dr_operator: 'Authorised to operate disaster-recovery controls',
  platform_admin: 'Administers the platform across tenants',
  service: 'Machine identity for service-to-service calls',
};

// username, first, last, tenant, department, roles
export const users = [
  ['alice.applicant', 'Alice', 'Applicant', TENANT_A, null, ['applicant']],
  ['aaron.applicant', 'Aaron', 'Applicant', TENANT_A, null, ['applicant']],
  ['victor.validator', 'Victor', 'Validator', TENANT_A, 'PERMITS', ['validation_officer']],
  ['tara.technical', 'Tara', 'Technical', TENANT_A, 'ENGINEERING', ['technical_officer']],
  ['henry.head', 'Henry', 'Head', TENANT_A, 'ENGINEERING', ['department_head']],
  ['fiona.final', 'Fiona', 'Final', TENANT_A, 'EXECUTIVE', ['final_approver']],
  ['derek.duty', 'Derek', 'Duty', TENANT_A, 'OPERATIONS', ['duty_officer', 'iot_operator']],
  ['irene.commander', 'Irene', 'Commander', TENANT_A, 'OPERATIONS', ['incident_commander', 'iot_operator']],
  ['amy.assets', 'Amy', 'Assets', TENANT_A, 'ENGINEERING', ['asset_manager']],
  ['anna.analyst', 'Anna', 'Analyst', TENANT_A, 'EXECUTIVE', ['analyst']],
  ['oscar.auditor', 'Oscar', 'Auditor', TENANT_A, 'EXECUTIVE', ['auditor']],
  ['adam.admin', 'Adam', 'Admin', TENANT_A, 'EXECUTIVE', ['tenant_admin', 'asset_manager', 'iot_operator', 'analyst', 'auditor']],
  ['rex.records', 'Rex', 'Records', TENANT_A, 'EXECUTIVE', ['records_manager']],
  ['sara.security', 'Sara', 'Security', TENANT_A, 'OPERATIONS', ['security_operator']],
  ['owen.officer', 'Owen', 'Officer', TENANT_A, 'ENGINEERING', ['procurement_officer']],
  ['sid.stores', 'Sid', 'Stores', TENANT_A, 'OPERATIONS', ['storekeeper']],
  ['bob.applicant', 'Bob', 'Applicant', TENANT_B, null, ['applicant']],
  ['vera.validator', 'Vera', 'Validator', TENANT_B, 'PERMITS', ['validation_officer']],
  ['tom.technical', 'Tom', 'Technical', TENANT_B, 'ENGINEERING', ['technical_officer']],
  ['hana.head', 'Hana', 'Head', TENANT_B, 'ENGINEERING', ['department_head']],
  ['frank.final', 'Frank', 'Final', TENANT_B, 'EXECUTIVE', ['final_approver']],
  ['dana.duty', 'Dana', 'Duty', TENANT_B, 'OPERATIONS', ['duty_officer', 'iot_operator']],
  ['brian.admin', 'Brian', 'Admin', TENANT_B, 'EXECUTIVE', ['tenant_admin', 'asset_manager', 'iot_operator', 'analyst', 'auditor']],
  // Meridian Industrial Group (manufacturing + facilities)
  ['maya.admin', 'Maya', 'Admin', TENANT_C, 'EXECUTIVE', ['tenant_admin', 'asset_manager', 'iot_operator', 'analyst', 'auditor']],
  ['sam.supervisor', 'Sam', 'Supervisor', TENANT_C, 'PRODUCTION', ['production_supervisor']],
  ['paula.planner', 'Paula', 'Planner', TENANT_C, 'MAINTENANCE', ['maintenance_planner']],
  ['tim.technician', 'Tim', 'Technician', TENANT_C, 'MAINTENANCE', ['maintenance_technician']],
  ['tess.technician', 'Tess', 'Technician', TENANT_C, 'MAINTENANCE', ['maintenance_technician']],
  ['fred.facilities', 'Fred', 'Facilities', TENANT_C, 'FACILITIES', ['facility_manager']],
  ['rita.requester', 'Rita', 'Requester', TENANT_C, 'FINANCE', ['service_requester']],
  ['ravi.requester', 'Ravi', 'Requester', TENANT_C, 'FINANCE', ['service_requester']],
  ['rachel.records', 'Rachel', 'Records', TENANT_C, 'EXECUTIVE', ['records_manager']],
  ['priya.procurement', 'Priya', 'Procurement', TENANT_C, 'FINANCE', ['procurement_officer']],
  ['stan.stores', 'Stan', 'Stores', TENANT_C, 'MAINTENANCE', ['storekeeper']],
  ['dina.director', 'Dina', 'Director', TENANT_C, 'FINANCE', ['department_head']],
  ['sol.security', 'Sol', 'Security', TENANT_C, 'FACILITIES', ['security_operator']],
  // Harbourline Properties (pack lifecycle)
  ['dora.admin', 'Dora', 'Admin', TENANT_D, 'EXECUTIVE', ['tenant_admin', 'asset_manager', 'iot_operator', 'facility_manager']],
  ['pete.supervisor', 'Pete', 'Supervisor', TENANT_D, 'OPERATIONS', ['production_supervisor']],
  ['penny.planner', 'Penny', 'Planner', TENANT_D, 'OPERATIONS', ['maintenance_planner']],
  ['dan.technician', 'Dan', 'Technician', TENANT_D, 'OPERATIONS', ['maintenance_technician']],
  ['daisy.requester', 'Daisy', 'Requester', TENANT_D, 'OPERATIONS', ['service_requester']],
  ['pat.platform', 'Pat', 'Platform', PLATFORM, null, ['platform_admin', 'dr_operator']],
];
