import { type CanActivate, type ExecutionContext, Inject, Injectable, type OnApplicationBootstrap, Optional, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ACCESS_DENIED_HOOK, type AccessDeniedHook, type Principal } from '@titan/authentication';
import type { EventEnvelope, EventPayload } from '@titan/contracts';
import { CONFIG, type PlatformConfig } from './config.js';
import { EventConsumers } from './consumer.js';
import { Db, type Q } from './db.js';
import { DomainError } from './errors.js';

const CAPABILITY = 'titan:capability';

/**
 * Restricts a handler (or controller) to tenants that have activated a
 * capability. This is the server-side half of module visibility: hiding a
 * menu entry is cosmetic, this check is the control.
 */
export const RequireCapability = (capability: string) => SetMetadata(CAPABILITY, capability);

export interface TenantEntitlements {
  capabilities: string[];
  packs: { id: string; version: string }[];
  revision: number;
}

const NONE: TenantEntitlements = { capabilities: [], packs: [], revision: 0 };
const CACHE_MS = 3_000;

/** Pure rule, separated so it can be unit-tested: a state is applied only if it is newer. */
export function isNewerRevision(current: number | null, incoming: number): boolean {
  return current === null || incoming > current;
}

/**
 * Per-service view of tenant entitlements, kept up to date from
 * `tenant.entitlements.changed.v1`. Fails closed: a tenant the service has
 * never heard about has no switchable capability.
 */
@Injectable()
export class Entitlements implements OnApplicationBootstrap {
  private readonly cache = new Map<string, { value: TenantEntitlements; expires: number }>();

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(CONFIG) private readonly config: PlatformConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({
      // Its own durable consumer: independent of the service's business consumer.
      name: `${this.config.SERVICE_NAME}-entitlements`,
      subjects: ['tenant.entitlements.changed.v1'],
      handler: (event, q) => this.apply(event, q),
    });
  }

  private async apply(event: EventEnvelope, q: Q): Promise<void> {
    const p = event.payload as EventPayload<'tenant.entitlements.changed.v1'>;
    // The event's own tenant is authoritative; the handler already runs inside that tenant's transaction.
    await q.exec(
      `INSERT INTO tenant_entitlements (tenant_id, capabilities, packs, revision)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE
         SET capabilities = EXCLUDED.capabilities, packs = EXCLUDED.packs, revision = EXCLUDED.revision, updated_at = now()
       WHERE tenant_entitlements.revision < EXCLUDED.revision`,
      [event.tenant_id, p.capabilities, JSON.stringify(p.packs), p.revision],
    );
    this.cache.delete(event.tenant_id);
  }

  async of(tenantId: string): Promise<TenantEntitlements> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expires > Date.now()) return cached.value;
    const row = await this.db.tx(tenantId, (q) =>
      q.maybeOne<TenantEntitlements>('SELECT capabilities, packs, revision FROM tenant_entitlements WHERE tenant_id = $1', [tenantId]),
    );
    const value = row ?? NONE;
    this.cache.set(tenantId, { value, expires: Date.now() + CACHE_MS });
    return value;
  }

  async has(tenantId: string, capability: string): Promise<boolean> {
    return (await this.of(tenantId)).capabilities.includes(capability);
  }
}

/** Runs after AuthGuard. Routes without @RequireCapability are not affected. */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(Entitlements) private readonly entitlements?: Entitlements,
    @Optional() @Inject(ACCESS_DENIED_HOOK) private readonly onDenied?: AccessDeniedHook,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string | undefined>(CAPABILITY, [context.getHandler(), context.getClass()]);
    if (!required) return true;
    const req = context.switchToHttp().getRequest();
    const principal = req.principal as Principal | undefined;
    // No principal: a @Public() route. Capabilities are a tenant concept and do not apply.
    if (!principal) return true;
    if (this.entitlements && (await this.entitlements.has(principal.tenantId, required))) return true;

    if (this.onDenied) {
      try {
        await this.onDenied({
          principal,
          method: req.method,
          path: String(req.originalUrl ?? req.url ?? '').split('?')[0] ?? '',
          requiredRoles: [],
          reason: `capability_disabled:${required}`,
        });
      } catch {
        // Recording the denial must never turn a 403 into a 500.
      }
    }
    throw new DomainError(403, 'capability_disabled', `the '${required}' capability is not active for your organisation`, { capability: required });
  }
}
