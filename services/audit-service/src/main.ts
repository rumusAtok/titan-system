import { Controller, Get, Inject, Injectable, Module, type OnApplicationBootstrap, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { type EventEnvelope, Roles } from '@titan/contracts';
import { bootstrapService, Db, DomainError, EventConsumers, PlatformModule, type Q, uuidParam, ZQuery } from '@titan/platform';
import { z } from 'zod';

const SearchAudit = z.object({
  aggregate_id: z.string().max(100).optional(),
  event_type: z.string().max(100).optional(),
  category: z.string().max(50).optional(),
  actor: z.string().max(255).optional(),
  correlation_id: z.string().max(128).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Event families recorded as audit evidence. High-volume telemetry
 * measurements are deliberately excluded: they are operational data kept by
 * telemetry-service, not administrative activity.
 */
const AUDITED_SUBJECTS = [
  'tenant.>',
  'case.>',
  'workflow.>',
  'asset.>',
  'device.>',
  'alert.>',
  'incident.>',
  'notification.>',
  'security.>',
  'ai.>',
  'pipeline.>',
];

@Injectable()
class AuditService implements OnApplicationBootstrap {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({ subjects: AUDITED_SUBJECTS, handler: (event, q) => this.record(event, q) });
  }

  private async record(event: EventEnvelope, q: Q): Promise<void> {
    await q.exec(
      `INSERT INTO audit_events (event_id, tenant_id, event_type, category, producer, aggregate_type, aggregate_id,
                                 actor_id, actor_username, actor_type, correlation_id, causation_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.event_id,
        event.tenant_id,
        event.event_type,
        event.event_type.split('.')[0],
        event.producer,
        event.aggregate_type,
        event.aggregate_id,
        event.actor?.id ?? null,
        event.actor?.username ?? null,
        event.actor?.type ?? null,
        event.correlation_id,
        event.causation_id,
        event.occurred_at,
        JSON.stringify(event.payload),
      ],
    );
  }

  search(user: Principal, query: z.infer<typeof SearchAudit>) {
    return this.db.tx(user.tenantId, async (q) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace('?', `$${params.length}`));
      };
      if (query.aggregate_id) add('aggregate_id = ?', query.aggregate_id);
      if (query.event_type) add('event_type = ?', query.event_type);
      if (query.category) add('category = ?', query.category);
      if (query.actor) add('actor_username = ?', query.actor);
      if (query.correlation_id) add('correlation_id = ?', query.correlation_id);
      if (query.from) add('occurred_at >= ?', query.from);
      if (query.to) add('occurred_at < ?', query.to);
      const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { total } = await q.one<{ total: number }>(`SELECT count(*)::int AS total FROM audit_events ${filter}`, params);
      params.push(query.limit, query.offset);
      const items = await q.query(
        `SELECT event_id, event_type, category, producer, aggregate_type, aggregate_id, actor_id, actor_username, actor_type,
                correlation_id, causation_id, occurred_at, recorded_at, payload
           FROM audit_events ${filter}
          ORDER BY occurred_at DESC, seq DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { total, items };
    });
  }

  get(user: Principal, eventId: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await q.maybeOne('SELECT * FROM audit_events WHERE event_id = $1', [eventId]);
      if (!row) throw DomainError.notFound('audit record');
      return row;
    });
  }
}

@ApiTags('audit')
@ApiBearerAuth()
@Controller()
@RequireRoles(Roles.Auditor, Roles.TenantAdmin, Roles.PlatformAdmin)
class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get('audit')
  @ApiOperation({ summary: 'Search audit records of the caller’s tenant' })
  search(@CurrentUser() user: Principal, @ZQuery(SearchAudit) query: z.infer<typeof SearchAudit>) {
    return this.audit.search(user, query);
  }

  @Get('audit/:eventId')
  get(@CurrentUser() user: Principal, @Param('eventId', uuidParam) eventId: string) {
    return this.audit.get(user, eventId);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [AuditController],
  providers: [AuditService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN audit-service',
  description: 'Append-only business activity records, security events and traceable administrative operations.',
  migrations: new URL('../migrations', import.meta.url),
});
