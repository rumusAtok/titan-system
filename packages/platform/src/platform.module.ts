import { type DynamicModule, Global, Module, type OnApplicationShutdown, type Provider, Inject, Injectable } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ACCESS_DENIED_HOOK, type AccessDeniedHook, AuthGuard, JwtVerifier } from '@titan/authentication';
import { createLogger, type Logger } from '@titan/observability';
import { CONFIG, loadConfig, LOGGER, type PlatformConfig } from './config.js';
import { EventConsumers } from './consumer.js';
import { Db } from './db.js';
import { HealthController } from './health.controller.js';
import { NatsClient } from './nats.js';
import { Outbox, OutboxRelay } from './outbox.js';

export interface PlatformModuleOptions {
  /** false for services without their own database (the API gateway). */
  database?: boolean;
}

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(Db) private readonly db: Db) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.close().catch(() => undefined);
  }
}

/**
 * Infrastructure wiring shared by every TITAN service: configuration,
 * logging, token verification, the global auth guard, health endpoints and
 * (for services with a database) the outbox relay and event consumers.
 * It contains no business logic.
 */
@Global()
@Module({})
export class PlatformModule {
  static forRoot(options: PlatformModuleOptions = {}): DynamicModule {
    const withDatabase = options.database ?? true;
    const config = loadConfig();

    const providers: Provider[] = [
      { provide: CONFIG, useValue: config },
      { provide: LOGGER, useValue: createLogger(config.SERVICE_NAME) },
      {
        provide: JwtVerifier,
        useValue: new JwtVerifier({ issuer: config.OIDC_ISSUER, jwksUri: config.OIDC_JWKS_URI, audience: config.OIDC_AUDIENCE }),
      },
      NatsClient,
      { provide: APP_GUARD, useClass: AuthGuard },
    ];
    const exports: NonNullable<DynamicModule['exports']> = [CONFIG, LOGGER, JwtVerifier, NatsClient];

    if (withDatabase) {
      if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required');
      providers.push(
        {
          provide: Db,
          useValue: new Db(config.DATABASE_URL, { max: config.DB_POOL_MAX, applicationName: config.SERVICE_NAME }),
        },
        DbLifecycle,
        Outbox,
        OutboxRelay,
        EventConsumers,
        {
          // Denied access is recorded as a durable security event (audit trail).
          provide: ACCESS_DENIED_HOOK,
          inject: [Db, Outbox, LOGGER],
          useFactory:
            (db: Db, outbox: Outbox, logger: Logger): AccessDeniedHook =>
            async (info) => {
              logger.warn({ user: info.principal.username, path: info.path, required: info.requiredRoles }, 'access denied');
              await db.tx(info.principal.tenantId, (q) =>
                outbox.emit(q, {
                  type: 'security.access_denied.v1',
                  aggregateType: 'user',
                  aggregateId: info.principal.userId,
                  tenantId: info.principal.tenantId,
                  payload: {
                    user_id: info.principal.userId,
                    username: info.principal.username,
                    method: info.method,
                    path: info.path,
                    required_roles: info.requiredRoles,
                    reason: info.reason,
                  },
                }),
              );
            },
        },
      );
      exports.push(Db, Outbox, EventConsumers);
    }

    return { module: PlatformModule, controllers: [HealthController], providers, exports };
  }
}

export type { PlatformConfig };
