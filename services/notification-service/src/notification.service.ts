import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import type { EventEnvelope, EventPayload } from '@titan/contracts';
import { type Logger, newContext, runWithContext } from '@titan/observability';
import { Db, DomainError, EventConsumers, LOGGER, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { afterAttempt, createEmailAdapter, type EmailAdapter } from './delivery.js';

export const ListNotifications = z.object({
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ListDeliveries = z.object({
  status: z.enum(['pending', 'sent', 'failed']).optional(),
  channel: z.enum(['in_app', 'email']).optional(),
  reference_id: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

interface NotificationRow {
  id: string;
  tenant_id: string;
  channel: 'in_app' | 'email';
  category: string;
  recipient_address: string | null;
  subject: string;
  body: string;
  status: string;
  attempts: number;
  max_attempts: number;
}

const DELIVERY_POLL_MS = Number(process.env.DELIVERY_POLL_MS ?? 2_000);
const RETRY_BASE_MS = Number(process.env.DELIVERY_RETRY_BASE_MS ?? 30_000);

@Injectable()
export class NotificationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly email: EmailAdapter;
  private timer?: NodeJS.Timeout;
  private delivering = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.email = createEmailAdapter(process.env.EMAIL_ADAPTER, logger);
  }

  onApplicationBootstrap(): void {
    this.consumers.register({ subjects: ['notification.requested.v1'], handler: (event, q) => this.onRequested(event, q) });
    this.timer = setInterval(() => void this.deliverDue(), DELIVERY_POLL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Stores the request. In-app notifications are delivered by being stored; e-mail is queued. */
  private async onRequested(event: EventEnvelope, q: Q): Promise<void> {
    const p = event.payload as EventPayload<'notification.requested.v1'>;
    const inApp = p.channel === 'in_app';
    await q.exec(
      `INSERT INTO notifications (tenant_id, dedupe_key, channel, category, external, recipient_user_id, recipient_role, recipient_address,
                                  subject, body, reference_type, reference_id, status, sent_at, adapter, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
      [
        event.tenant_id,
        p.dedupe_key,
        p.channel,
        p.category,
        p.external,
        p.recipient_user_id,
        p.recipient_role,
        p.recipient_address,
        p.subject,
        p.body,
        p.reference_type,
        p.reference_id,
        inApp ? 'sent' : 'pending',
        inApp ? new Date() : null,
        inApp ? 'in_app' : null,
        event.event_id,
      ],
    );
  }

  /** One pass of the delivery worker. Returns the number of notifications attempted. */
  async deliverDue(): Promise<number> {
    if (this.delivering) return 0;
    this.delivering = true;
    let attempted = 0;
    try {
      const due = await this.db.tx(null, (q) =>
        q.query<{ notification_id: string; tenant_id: string }>('SELECT notification_id, tenant_id FROM notifications_due($1)', [50]),
      );
      for (const row of due) {
        const ctx = newContext({ actor: { id: 'notification-service', type: 'system' } });
        if (await runWithContext(ctx, () => this.deliverOne(row.tenant_id, row.notification_id))) attempted += 1;
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'delivery pass failed');
    } finally {
      this.delivering = false;
    }
    return attempted;
  }

  private deliverOne(tenantId: string, id: string): Promise<boolean> {
    return this.db.tx(tenantId, async (q) => {
      // SKIP LOCKED: with several replicas, each notification is attempted by one worker at a time.
      const n = await q.maybeOne<NotificationRow>(
        `SELECT id, tenant_id, channel, category, recipient_address, subject, body, status, attempts, max_attempts
           FROM notifications WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now()
           FOR UPDATE SKIP LOCKED`,
        [id],
      );
      if (!n) return false;

      let error: string | null = null;
      if (!n.recipient_address) {
        error = 'no delivery address on record';
      } else {
        try {
          await this.email.send({ to: n.recipient_address, subject: n.subject, body: n.body, notificationId: n.id });
        } catch (err) {
          error = (err as Error).message;
        }
      }

      const attempts = n.attempts + 1;
      // A missing address will not fix itself: fail immediately instead of retrying.
      const outcome = afterAttempt(error === null, n.recipient_address ? attempts : n.max_attempts, n.max_attempts, RETRY_BASE_MS);
      if (outcome.status === 'sent') {
        await q.exec(`UPDATE notifications SET status = 'sent', attempts = $2, sent_at = now(), last_error = NULL, adapter = $3 WHERE id = $1`, [
          n.id,
          attempts,
          this.email.name,
        ]);
        await this.outbox.emit(q, {
          type: 'notification.delivered.v1',
          aggregateType: 'notification',
          aggregateId: n.id,
          tenantId,
          payload: { notification_id: n.id, channel: n.channel, category: n.category, attempts },
        });
      } else if (outcome.status === 'pending') {
        await q.exec(
          `UPDATE notifications SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4::double precision / 1000) WHERE id = $1`,
          [n.id, attempts, error, outcome.retryInMs],
        );
      } else {
        await q.exec(`UPDATE notifications SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1`, [n.id, attempts, error]);
        await this.outbox.emit(q, {
          type: 'notification.failed.v1',
          aggregateType: 'notification',
          aggregateId: n.id,
          tenantId,
          payload: { notification_id: n.id, channel: n.channel, category: n.category, attempts, error: error ?? 'unknown error' },
        });
      }
      return true;
    });
  }

  // --- queries ---------------------------------------------------------------

  /** Notifications addressed to the caller personally or to one of their roles. */
  listMine(user: Principal, query: z.infer<typeof ListNotifications>) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT n.id, n.channel, n.category, n.subject, n.body, n.reference_type, n.reference_id, n.status, n.created_at,
                (r.read_at IS NOT NULL) AS read, r.read_at
           FROM notifications n
           LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1
          WHERE (n.recipient_user_id = $1 OR n.recipient_role = ANY($2::text[]))
            AND ($3::boolean IS NULL OR (r.read_at IS NULL) = $3)
          ORDER BY n.created_at DESC
          LIMIT $4`,
        [user.userId, user.roles, query.unread ?? null, query.limit],
      ),
    );
  }

  unreadCount(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.one<{ unread: number }>(
        `SELECT count(*)::int AS unread
           FROM notifications n
          WHERE (n.recipient_user_id = $1 OR n.recipient_role = ANY($2::text[]))
            AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = $1)`,
        [user.userId, user.roles],
      ),
    );
  }

  markRead(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const visible = await q.maybeOne('SELECT 1 FROM notifications WHERE id = $1 AND (recipient_user_id = $2 OR recipient_role = ANY($3::text[]))', [
        id,
        user.userId,
        user.roles,
      ]);
      if (!visible) throw DomainError.notFound('notification');
      await q.exec('INSERT INTO notification_reads (notification_id, tenant_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, user.tenantId, user.userId]);
      return { id, read: true };
    });
  }

  /** Delivery status for administrators. */
  listDeliveries(user: Principal, query: z.infer<typeof ListDeliveries>) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT id, channel, category, external, recipient_user_id, recipient_role, recipient_address, subject, reference_type, reference_id,
                status, attempts, max_attempts, next_attempt_at, last_error, adapter, sent_at, created_at
           FROM notifications
          WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR channel = $2) AND ($3::text IS NULL OR reference_id = $3)
          ORDER BY created_at DESC
          LIMIT $4`,
        [query.status ?? null, query.channel ?? null, query.reference_id ?? null, query.limit],
      ),
    );
  }
}
