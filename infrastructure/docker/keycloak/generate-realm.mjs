// Generates titan-realm.json (the Keycloak realm imported at startup).
// This script is the source of truth; re-run it after editing:
//   node infrastructure/docker/keycloak/generate-realm.mjs
//
// All users are SYNTHETIC demo identities. Secrets are not stored in the
// file: Keycloak substitutes ${ENV_VAR} placeholders from its environment
// when importing.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
export const PLATFORM = '00000000-0000-0000-0000-000000000000';

const roles = {
  applicant: 'Member of the public who submits and tracks applications',
  validation_officer: 'Checks submitted applications for completeness',
  technical_officer: 'Performs the technical assessment of an application',
  department_head: 'Endorses applications on behalf of the department',
  final_approver: 'Issues the final decision on an application',
  duty_officer: 'Acknowledges and triages operational incidents',
  incident_commander: 'Directs incident response and resolves incidents',
  asset_manager: 'Maintains the infrastructure asset register',
  iot_operator: 'Manages IoT devices, alert rules and telemetry',
  analyst: 'Reads analytical datasets and reports',
  auditor: 'Reads audit records',
  tenant_admin: 'Administers one tenant (organisation)',
  dr_operator: 'Authorised to operate disaster-recovery controls',
  platform_admin: 'Administers the platform across tenants',
  service: 'Machine identity for service-to-service calls',
};

// username, first, last, tenant, department, roles
const users = [
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
  ['bob.applicant', 'Bob', 'Applicant', TENANT_B, null, ['applicant']],
  ['vera.validator', 'Vera', 'Validator', TENANT_B, 'PERMITS', ['validation_officer']],
  ['tom.technical', 'Tom', 'Technical', TENANT_B, 'ENGINEERING', ['technical_officer']],
  ['hana.head', 'Hana', 'Head', TENANT_B, 'ENGINEERING', ['department_head']],
  ['frank.final', 'Frank', 'Final', TENANT_B, 'EXECUTIVE', ['final_approver']],
  ['dana.duty', 'Dana', 'Duty', TENANT_B, 'OPERATIONS', ['duty_officer', 'iot_operator']],
  ['brian.admin', 'Brian', 'Admin', TENANT_B, 'EXECUTIVE', ['tenant_admin', 'asset_manager', 'iot_operator', 'analyst', 'auditor']],
  ['pat.platform', 'Pat', 'Platform', PLATFORM, null, ['platform_admin', 'dr_operator']],
];

const attributeMapper = (name) => ({
  name,
  protocol: 'openid-connect',
  protocolMapper: 'oidc-usermodel-attribute-mapper',
  consentRequired: false,
  config: {
    'user.attribute': name,
    'claim.name': name,
    'jsonType.label': 'String',
    'id.token.claim': 'true',
    'access.token.claim': 'true',
    'userinfo.token.claim': 'true',
  },
});

const audienceMapper = {
  name: 'titan-api-audience',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-audience-mapper',
  consentRequired: false,
  config: { 'included.custom.audience': 'titan-api', 'access.token.claim': 'true', 'id.token.claim': 'false' },
};

const userMappers = [attributeMapper('tenant_id'), attributeMapper('department'), audienceMapper];

const serviceClient = (clientId, secretEnv, description) => ({
  clientId,
  name: clientId,
  description,
  enabled: true,
  publicClient: false,
  clientAuthenticatorType: 'client-secret',
  secret: `\${${secretEnv}}`,
  standardFlowEnabled: false,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: true,
  protocolMappers: [audienceMapper],
});

const serviceAccountUser = (clientId) => ({
  username: `service-account-${clientId}`,
  enabled: true,
  serviceAccountClientId: clientId,
  realmRoles: ['service'],
});

const userProfile = {
  attributes: [
    {
      name: 'username',
      displayName: 'Username',
      validations: { length: { min: 3, max: 255 }, 'username-prohibited-characters': {}, 'up-username-not-idn-homograph': {} },
      permissions: { view: ['admin', 'user'], edit: ['admin'] },
    },
    {
      name: 'email',
      displayName: 'Email',
      validations: { email: {}, length: { max: 255 } },
      permissions: { view: ['admin', 'user'], edit: ['admin'] },
    },
    { name: 'firstName', displayName: 'First name', validations: { length: { max: 255 } }, permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] } },
    { name: 'lastName', displayName: 'Last name', validations: { length: { max: 255 } }, permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] } },
    // Tenant and department are authorisation attributes: only an administrator may set them.
    { name: 'tenant_id', displayName: 'Tenant ID', validations: { length: { min: 36, max: 36 } }, permissions: { view: ['admin'], edit: ['admin'] } },
    { name: 'department', displayName: 'Department', validations: { length: { max: 64 } }, permissions: { view: ['admin', 'user'], edit: ['admin'] } },
  ],
  groups: [{ name: 'user-metadata', displayHeader: 'User metadata', displayDescription: 'Attributes which refer to user metadata' }],
};

const realm = {
  realm: 'titan',
  displayName: 'TITAN Platform (development realm)',
  enabled: true,
  sslRequired: 'none',
  registrationAllowed: false,
  loginWithEmailAllowed: false,
  duplicateEmailsAllowed: false,
  resetPasswordAllowed: false,
  editUsernameAllowed: false,
  bruteForceProtected: true,
  failureFactor: 10,
  accessTokenLifespan: 900,
  ssoSessionIdleTimeout: 3600,
  ssoSessionMaxLifespan: 36000,
  // TOTP is available to every account; see docs/security/identity-and-authorization.md
  // for enforcing it on privileged roles.
  otpPolicyType: 'totp',
  otpPolicyAlgorithm: 'HmacSHA1',
  otpPolicyDigits: 6,
  otpPolicyPeriod: 30,
  roles: { realm: Object.entries(roles).map(([name, description]) => ({ name, description })) },
  clients: [
    {
      clientId: 'titan-web',
      name: 'TITAN web command center',
      enabled: true,
      publicClient: true,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      rootUrl: '${TITAN_WEB_ORIGIN}',
      redirectUris: ['${TITAN_WEB_ORIGIN}/*'],
      webOrigins: ['${TITAN_WEB_ORIGIN}'],
      attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': '${TITAN_WEB_ORIGIN}/*' },
      protocolMappers: userMappers,
    },
    {
      clientId: 'titan-cli',
      name: 'TITAN test and automation client',
      description: 'DEVELOPMENT/TEST ONLY: allows the password grant for automated tests and seed scripts. Remove in production.',
      enabled: true,
      publicClient: true,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: true,
      serviceAccountsEnabled: false,
      protocolMappers: userMappers,
    },
    serviceClient('svc-pipeline', 'SVC_PIPELINE_CLIENT_SECRET', 'data-pipeline-service machine identity'),
    serviceClient('svc-ai', 'SVC_AI_CLIENT_SECRET', 'ai-gateway-service machine identity'),
  ],
  users: [
    ...users.map(([username, firstName, lastName, tenant, department, realmRoles]) => ({
      username,
      enabled: true,
      emailVerified: true,
      firstName,
      lastName,
      email: `${username}@titan.example`,
      attributes: { tenant_id: [tenant], ...(department ? { department: [department] } : {}) },
      credentials: [{ type: 'password', value: '${DEMO_USER_PASSWORD}', temporary: false }],
      realmRoles,
    })),
    serviceAccountUser('svc-pipeline'),
    serviceAccountUser('svc-ai'),
  ],
  components: {
    'org.keycloak.userprofile.UserProfileProvider': [
      { providerId: 'declarative-user-profile', config: { 'kc.user.profile.config': [JSON.stringify(userProfile)] } },
    ],
  },
};

const out = fileURLToPath(new URL('./titan-realm.json', import.meta.url));
writeFileSync(out, JSON.stringify(realm, null, 2) + '\n');
console.log(`wrote ${out}: ${users.length} demo users, ${realm.clients.length} clients, ${Object.keys(roles).length} roles`);
