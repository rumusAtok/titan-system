import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { currentContext } from '@titan/observability';
import { hasAnyRole, type Principal } from './principal.js';
import { JwtVerifier } from './verifier.js';

const IS_PUBLIC = 'titan:public';
const ROLES = 'titan:roles';

/** Marks a handler as reachable without a token (health probes, metrics). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restricts a handler (or controller) to callers holding at least one of the roles. */
export const RequireRoles = (...roles: string[]) => SetMetadata(ROLES, roles);

/** Injects the verified caller into a handler parameter. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const principal = ctx.switchToHttp().getRequest().principal as Principal | undefined;
  if (!principal) throw new UnauthorizedException('authentication required');
  return principal;
});

export interface AccessDeniedInfo {
  principal: Principal;
  method: string;
  path: string;
  requiredRoles: string[];
  reason: string;
}

/** Optional hook so the host service can record denied access as a security event. */
export const ACCESS_DENIED_HOOK = Symbol('ACCESS_DENIED_HOOK');
export type AccessDeniedHook = (info: AccessDeniedInfo) => void | Promise<void>;

/**
 * Global guard: every route requires a valid bearer token unless marked
 * @Public(). Role requirements are enforced here, per service (distributed
 * authorization); the gateway is never trusted to have done it.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JwtVerifier) private readonly verifier: JwtVerifier,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(ACCESS_DENIED_HOOK) private readonly onDenied?: AccessDeniedHook,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const header: unknown = req.headers?.authorization;
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    const token = header.slice(7).trim();

    let principal: Principal;
    try {
      principal = await this.verifier.verify(token);
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }
    req.principal = principal;
    const ctx = currentContext();
    if (ctx) ctx.actor = { id: principal.userId, username: principal.username, type: principal.isService ? 'service' : 'user' };

    const required = this.reflector.getAllAndOverride<string[]>(ROLES, targets) ?? [];
    if (!hasAnyRole(principal, required)) {
      await this.reportDenied({
        principal,
        method: req.method,
        path: String(req.originalUrl ?? req.url ?? '').split('?')[0] ?? '',
        requiredRoles: required,
        reason: 'missing_role',
      });
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }

  private async reportDenied(info: AccessDeniedInfo): Promise<void> {
    if (!this.onDenied) return;
    try {
      await this.onDenied(info);
    } catch {
      // Recording the denial must never turn a 403 into a 500.
    }
  }
}
