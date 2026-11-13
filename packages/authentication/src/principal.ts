import { PLATFORM_TENANT_ID, Roles } from '@titan/contracts';

/** Verified caller identity. Built only from a validated token, never from request input. */
export interface Principal {
  userId: string;
  username: string;
  email: string | null;
  /** Tenant taken from the signed token. Service accounts use the platform tenant id. */
  tenantId: string;
  roles: string[];
  department: string | null;
  isService: boolean;
  /** Raw bearer token, kept so a service can call another service on behalf of the user. */
  token: string;
}

export class TokenClaimsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenClaimsError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === 'string' && v[0].length > 0) return v[0];
  return null;
}

/**
 * Maps verified JWT claims to a Principal.
 * A user token without a well-formed tenant claim is rejected: tenant
 * membership must be asserted by the identity provider.
 */
export function principalFromClaims(claims: Record<string, unknown>, token: string): Principal {
  const sub = firstString(claims.sub);
  if (!sub) throw new TokenClaimsError('token has no subject');
  const realmAccess = claims.realm_access as { roles?: unknown } | undefined;
  const roles = Array.isArray(realmAccess?.roles) ? realmAccess.roles.filter((r): r is string => typeof r === 'string') : [];
  const isService = roles.includes(Roles.Service);
  const username = firstString(claims.preferred_username) ?? sub;

  let tenantId = firstString(claims.tenant_id);
  if (isService) {
    // Machine identities are not tenant members. They may only reach
    // endpoints that explicitly allow the `service` role.
    tenantId = PLATFORM_TENANT_ID;
  } else if (!tenantId || !UUID.test(tenantId)) {
    throw new TokenClaimsError('token has no valid tenant_id claim');
  }

  return {
    userId: sub,
    username,
    email: firstString(claims.email),
    tenantId: tenantId!.toLowerCase(),
    roles,
    department: firstString(claims.department),
    isService,
    token,
  };
}

export function hasAnyRole(principal: Pick<Principal, 'roles'>, required: readonly string[]): boolean {
  if (required.length === 0) return true;
  return required.some((r) => principal.roles.includes(r));
}
