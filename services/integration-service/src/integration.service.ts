import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import { Capabilities, type EventEnvelope, Roles } from '@titan/contracts';
import { type Logger, newContext, runWithContext } from '@titan/observability';
import { Db, DomainError, Entitlements, EventConsumers, LOGGER, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { checkDestination, classifyStatus, newSecret, parseAllowList, retryDelay, sealer, sign, verifySignature } from './rules.js';

const POLL_MS = Number(process.env.WEBHOOK_DELIVERY_POLL_MS ?? 2_000);
const DELIVERY_TIMEOUT_MS = Number(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS ?? 10_000);
/** How long a claimed delivery is reserved for the worker that claimed it. */
const LEASE_SECONDS = 60;

/** Events a tenant may forward to an external system. Personal data stays out: these carry references and states. */
export const SUBSCRIBABLE_EVENTS = [
  'incident.created.v1',
  'incident.acknowledged.v1',
  'incident.resolved.v1',
  'alert.raised.v1',
  'alert.cleared.v1',
  'maintenance.work_order.created.v1',
  'maintenance.work_order.completed.v1',
  'procurement.purchase_order.issued.v1',
  'procurement.goods.received.v1',
  'procurement.stock.low.v1',
  'document.version.published.v1',
  'report.generated.v1',
  'geo.incident.in_zone.v1',
  'video.marker.created.v1',
] as const;

export const ADMINS = [Roles.TenantAdmin];
export const READERS = [Roles.TenantAdmin, Roles.Auditor];

const name = z.string().trim().min(3).max(120);
const category = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);

export const CreateEndpoint = z.object({
  name,
  default_severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  default_category: category.nullable().default(null),
});

export const UpdateActive = z.object({ active: z.boolean() });

export const CreateSubscription = z.object({
  name,
  target_url: z.string().max(500),
  event_types: z.array(z.enum(SUBSCRIBABLE_EVENTS)).min(1).max(SUBSCRIBABLE_EVENTS.length),
});

export const UpdateSubscription = z.object({
  active: z.boolean().optional(),
  event_types: z.array(z.enum(SUBSCRIBABLE_EVENTS)).min(1).max(SUBSCRIBABLE_EVENTS.length).optional(),
  expected_version: z.number().int().positive(),
});

/** Body an external system posts to report an incident. */
export const InboundIncident = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().max(4000).default(''),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  category: category.optional(),
  /** The sender's own reference; repeated reports with the same one create one incident. */
  external_id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional(),
});

const EVENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;

interface EndpointRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  sealed_secret: string;
  default_severity: 'info' | 'warning' | 'critical';
  default_category: string | null;
  active: boolean;
}

interface DeliveryClaim {
  id: string;
  tenant_id: string;
  subscription_id: string;
  subscription_name: string;
  event_id: string;
  event_type: string;
  body: unknown;
  attempts: number;
  target_url: string;
  sealed_secret: string;
  subscription_active: boolean;
}

export type InboundResult = { status: number; body: Record<string, unknown> };

/**
 * Integration hub.
 *
 * Inbound: an external system posts a signed incident report to `/hooks/<endpoint-id>` (public
 * gateway route). The signature, timestamp window and event id are checked here; an accepted
 * report becomes `integration.incident.reported.v1`, which incident-service turns into an incident.
 *
 * Outbound: subscriptions forward selected platform events, signed, to destinations on an
 * operator-maintained allow-list (by default only the local test receiver), with retries and a
 * delivery log. Nothing is sent anywhere else.
 */
@Injectable()
export class IntegrationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly secrets = sealer(process.env.INTEGRATION_SECRET_KEY ?? '');
  private readonly allowedHosts = parseAllowList(process.env.WEBHOOK_ALLOWED_HOSTS ?? 'webhook-sink');
  private timer?: NodeJS.Timeout;
  private delivering = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(Entitlements) private readonly entitlements: Entitlements,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({ subjects: [...SUBSCRIBABLE_EVENTS], handler: (event, q) => this.enqueue(event, q) });
    this.timer = setInterval(() => void this.deliverDue(), POLL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  catalogue() {
    return { event_types: SUBSCRIBABLE_EVENTS, allowed_hosts: [...this.allowedHosts].sort(), signature: 'HMAC-SHA256 over "<x-titan-timestamp>.<raw body>", header x-titan-signature: sha256=<hex>' };
  }

  // --- inbound endpoints ---------------------------------------------------------

  listEndpoints(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT e.id, e.name, e.kind, e.default_severity, e.default_category, e.active, e.created_by, e.created_at, e.secret_rotated_at, e.last_received_at,
                '/hooks/' || e.id AS path,
                (SELECT count(*)::int FROM inbound_messages m WHERE m.endpoint_id = e.id AND m.status = 'accepted') AS accepted,
                (SELECT count(*)::int FROM inbound_messages m WHERE m.endpoint_id = e.id AND m.status = 'rejected') AS rejected
           FROM inbound_endpoints e ORDER BY e.name`,
      ),
    );
  }

  createEndpoint(user: Principal, input: z.infer<typeof CreateEndpoint>) {
    const secret = newSecret();
    return this.db.tx(user.tenantId, async (q) => {
      if (await q.maybeOne('SELECT 1 FROM inbound_endpoints WHERE name = $1', [input.name])) throw DomainError.conflict('duplicate', `an endpoint named '${input.name}' exists`);
      const row = await q.one<{ id: string; name: string; created_at: Date }>(
        `INSERT INTO inbound_endpoints (tenant_id, name, sealed_secret, default_severity, default_category, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, created_at`,
        [user.tenantId, input.name, this.secrets.seal(secret), input.default_severity, input.default_category, user.username],
      );
      // The secret is shown once; afterwards it can only be rotated.
      return { ...row, path: `/hooks/${row.id}`, secret };
    });
  }

  rotateEndpointSecret(user: Principal, id: string) {
    const secret = newSecret();
    return this.db.tx(user.tenantId, async (q) => {
      const row = await q.maybeOne<{ id: string }>('UPDATE inbound_endpoints SET sealed_secret = $2, secret_rotated_at = now() WHERE id = $1 RETURNING id', [id, this.secrets.seal(secret)]);
      if (!row) throw DomainError.notFound('endpoint');
      return { id, secret };
    });
  }

  setEndpointActive(user: Principal, id: string, active: boolean) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await q.maybeOne('UPDATE inbound_endpoints SET active = $2 WHERE id = $1 RETURNING id, name, active', [id, active]);
      if (!row) throw DomainError.notFound('endpoint');
      return row;
    });
  }

  endpointMessages(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      if (!(await q.maybeOne('SELECT 1 FROM inbound_endpoints WHERE id = $1', [id]))) throw DomainError.notFound('endpoint');
      return q.query('SELECT id, event_id, status, reason, external_id, body_sha256, received_at FROM inbound_messages WHERE endpoint_id = $1 ORDER BY received_at DESC LIMIT 200', [id]);
    });
  }

  /**
   * A webhook from outside. Unknown endpoints, inactive endpoints and tenants without the
   * integrations capability all answer 404, so the response reveals nothing about them.
   */
  async receive(endpointId: string, headers: Record<string, string | string[] | undefined>, raw: Buffer | undefined): Promise<InboundResult> {
    const notFound: InboundResult = { status: 404, body: { error: { status: 404, code: 'not_found', message: 'endpoint not found' } } };
    const tenantId = await this.db.tx(null, async (q) => (await q.maybeOne<{ t: string | null }>('SELECT inbound_endpoint_tenant($1) AS t', [endpointId]))?.t ?? null);
    if (!tenantId) return notFound;
    if (!(await this.entitlements.has(tenantId, Capabilities.Integrations))) return notFound;
    const header = (n: string) => (typeof headers[n] === 'string' ? (headers[n] as string) : undefined);
    const body = raw ?? Buffer.alloc(0);
    const bodySha = createHash('sha256').update(body).digest('hex');

    const ctx = newContext({ actor: { id: `integration-endpoint:${endpointId}`, type: 'system' } });
    return runWithContext(ctx, () =>
      this.db.tx(tenantId, async (q) => {
        const endpoint = await q.maybeOne<EndpointRow>(
          'SELECT id, tenant_id, name, kind, sealed_secret, default_severity, default_category, active FROM inbound_endpoints WHERE id = $1 FOR UPDATE',
          [endpointId],
        );
        if (!endpoint || !endpoint.active) return notFound;
        const eventId = header('x-titan-event-id');
        const reject = async (status: number, code: string, reason: string): Promise<InboundResult> => {
          await q.exec('INSERT INTO inbound_messages (tenant_id, endpoint_id, event_id, status, reason, body_sha256) VALUES ($1, $2, $3, $4, $5, $6)', [
            tenantId,
            endpointId,
            eventId && EVENT_ID.test(eventId) ? eventId : null,
            'rejected',
            reason,
            bodySha,
          ]);
          return { status, body: { error: { status, code, message: reason } } };
        };

        const verified = verifySignature(this.secrets.open(endpoint.sealed_secret), { signature: header('x-titan-signature'), timestamp: header('x-titan-timestamp') }, body);
        if (!verified.ok) return reject(401, 'invalid_signature', verified.reason);
        if (!eventId || !EVENT_ID.test(eventId)) return reject(400, 'validation_failed', 'x-titan-event-id header is missing or malformed');
        let parsed: z.infer<typeof InboundIncident>;
        try {
          parsed = InboundIncident.parse(JSON.parse(body.toString('utf8')));
        } catch {
          return reject(400, 'validation_failed', 'body must be JSON with title (3-200 chars) and optional description, severity, category, external_id');
        }
        const externalId = parsed.external_id ?? eventId;
        const accepted = await q.maybeOne<{ id: string }>(
          `INSERT INTO inbound_messages (tenant_id, endpoint_id, event_id, status, external_id, body_sha256) VALUES ($1, $2, $3, 'accepted', $4, $5)
           ON CONFLICT (endpoint_id, event_id) WHERE status = 'accepted' DO NOTHING RETURNING id`,
          [tenantId, endpointId, eventId, externalId, bodySha],
        );
        if (!accepted) {
          await q.exec(`INSERT INTO inbound_messages (tenant_id, endpoint_id, event_id, status, reason, external_id, body_sha256) VALUES ($1, $2, $3, 'duplicate', 'event id already accepted', $4, $5)`, [
            tenantId,
            endpointId,
            eventId,
            externalId,
            bodySha,
          ]);
          return { status: 200, body: { status: 'duplicate', event_id: eventId } };
        }
        await q.exec('UPDATE inbound_endpoints SET last_received_at = now() WHERE id = $1', [endpointId]);
        await this.outbox.emit(q, {
          type: 'integration.incident.reported.v1',
          aggregateType: 'inbound_endpoint',
          aggregateId: endpointId,
          tenantId,
          payload: {
            endpoint_id: endpointId,
            endpoint_name: endpoint.name,
            external_id: externalId,
            title: parsed.title,
            description: parsed.description,
            severity: parsed.severity ?? endpoint.default_severity,
            category: parsed.category ?? endpoint.default_category,
          },
        });
        return { status: 202, body: { status: 'accepted', event_id: eventId, message_id: accepted.id } };
      }),
    );
  }

  // --- outbound subscriptions -----------------------------------------------------

  listSubscriptions(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT s.id, s.name, s.target_url, s.event_types, s.active, s.created_by, s.created_at, s.version,
                (SELECT count(*)::int FROM deliveries d WHERE d.subscription_id = s.id AND d.status = 'delivered') AS delivered,
                (SELECT count(*)::int FROM deliveries d WHERE d.subscription_id = s.id AND d.status = 'pending') AS pending,
                (SELECT count(*)::int FROM deliveries d WHERE d.subscription_id = s.id AND d.status = 'failed') AS failed
           FROM subscriptions s ORDER BY s.name`,
      ),
    );
  }

  createSubscription(user: Principal, input: z.infer<typeof CreateSubscription>) {
    const destination = checkDestination(input.target_url, this.allowedHosts);
    if (!destination.ok) throw DomainError.invalid(destination.reason);
    const secret = newSecret();
    return this.db.tx(user.tenantId, async (q) => {
      if (await q.maybeOne('SELECT 1 FROM subscriptions WHERE name = $1', [input.name])) throw DomainError.conflict('duplicate', `a subscription named '${input.name}' exists`);
      const row = await q.one(
        `INSERT INTO subscriptions (tenant_id, name, target_url, event_types, sealed_secret, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, target_url, event_types, active, version, created_at`,
        [user.tenantId, input.name, destination.url.toString(), [...new Set(input.event_types)], this.secrets.seal(secret), user.username],
      );
      return { ...row, secret };
    });
  }

  updateSubscription(user: Principal, id: string, input: z.infer<typeof UpdateSubscription>) {
    return this.db.tx(user.tenantId, async (q) => {
      const s = await q.maybeOne<{ version: number; active: boolean; event_types: string[] }>('SELECT version, active, event_types FROM subscriptions WHERE id = $1 FOR UPDATE', [id]);
      if (!s) throw DomainError.notFound('subscription');
      if (s.version !== input.expected_version) throw DomainError.conflict('version_conflict', `the subscription is at version ${s.version}`);
      return q.one('UPDATE subscriptions SET active = $2, event_types = $3, version = version + 1 WHERE id = $1 RETURNING id, name, target_url, event_types, active, version', [
        id,
        input.active ?? s.active,
        input.event_types ? [...new Set(input.event_types)] : s.event_types,
      ]);
    });
  }

  deliveries(user: Principal, subscriptionId: string) {
    return this.db.tx(user.tenantId, async (q) => {
      if (!(await q.maybeOne('SELECT 1 FROM subscriptions WHERE id = $1', [subscriptionId]))) throw DomainError.notFound('subscription');
      return q.query(
        `SELECT id, event_id, event_type, status, attempts, next_attempt_at, last_status_code, last_error, created_at, delivered_at
           FROM deliveries WHERE subscription_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [subscriptionId],
      );
    });
  }

  retryDelivery(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const row = await q.maybeOne(
        `UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 AND status = 'failed' RETURNING id, status`,
        [id],
      );
      if (!row) throw DomainError.conflict('invalid_state', 'only a failed delivery can be retried');
      return row;
    });
  }

  /** Consumer: one delivery per active subscription that asked for this event type. */
  private async enqueue(event: EventEnvelope, q: Q): Promise<void> {
    const subs = await q.query<{ id: string }>('SELECT id FROM subscriptions WHERE active AND $1 = ANY (event_types)', [event.event_type]);
    if (!subs.length) return;
    if (!(await this.entitlements.has(event.tenant_id, Capabilities.Integrations))) return;
    const body = { event_id: event.event_id, event_type: event.event_type, occurred_at: event.occurred_at, tenant_id: event.tenant_id, data: event.payload };
    for (const s of subs) {
      await q.exec(
        `INSERT INTO deliveries (tenant_id, subscription_id, event_id, event_type, body) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (subscription_id, event_id) DO NOTHING`,
        [event.tenant_id, s.id, event.event_id, event.event_type, JSON.stringify(body)],
      );
    }
  }

  // --- delivery worker ---------------------------------------------------------------

  async deliverDue(): Promise<number> {
    if (this.delivering) return 0;
    this.delivering = true;
    let done = 0;
    try {
      const due = await this.db.tx(null, (q) => q.query<{ delivery_id: string; tenant_id: string }>('SELECT delivery_id, tenant_id FROM deliveries_due($1)', [50]));
      for (const row of due) {
        const ctx = newContext({ actor: { id: 'integration-service', type: 'system' } });
        if (await runWithContext(ctx, () => this.deliverOne(row.tenant_id, row.delivery_id))) done += 1;
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'webhook delivery sweep failed');
    } finally {
      this.delivering = false;
    }
    return done;
  }

  private async deliverOne(tenantId: string, deliveryId: string): Promise<boolean> {
    const claim = await this.db.tx(tenantId, async (q) => {
      const d = await q.maybeOne<DeliveryClaim>(
        `SELECT d.id, d.tenant_id, d.subscription_id, s.name AS subscription_name, d.event_id, d.event_type, d.body, d.attempts, s.target_url, s.sealed_secret, s.active AS subscription_active
           FROM deliveries d JOIN subscriptions s ON s.id = d.subscription_id
          WHERE d.id = $1 AND d.status = 'pending' AND d.next_attempt_at <= now()
          FOR UPDATE OF d SKIP LOCKED`,
        [deliveryId],
      );
      if (!d) return null;
      await q.exec(`UPDATE deliveries SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2) WHERE id = $1`, [deliveryId, LEASE_SECONDS]);
      return { ...d, attempts: d.attempts + 1 };
    });
    if (!claim) return false;

    let outcome: 'delivered' | 'retry' | 'rejected';
    let statusCode: number | null = null;
    let error: string | null = null;
    const destination = checkDestination(claim.target_url, this.allowedHosts);
    if (!claim.subscription_active) {
      outcome = 'rejected';
      error = 'subscription is inactive';
    } else if (!destination.ok) {
      outcome = 'rejected';
      error = destination.reason;
    } else if (!(await this.entitlements.has(tenantId, Capabilities.Integrations))) {
      outcome = 'rejected';
      error = 'the integrations capability is not active for this tenant';
    } else {
      const payload = JSON.stringify(claim.body);
      const timestamp = Math.floor(Date.now() / 1000);
      try {
        const response = await fetch(destination.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            'user-agent': 'TITAN-Webhooks/0.1',
            'x-titan-event-id': claim.event_id,
            'x-titan-event-type': claim.event_type,
            'x-titan-timestamp': String(timestamp),
            'x-titan-signature': sign(this.secrets.open(claim.sealed_secret), timestamp, payload),
          },
          body: payload,
        });
        statusCode = response.status;
        await response.body?.cancel();
        outcome = classifyStatus(response.status);
        if (outcome !== 'delivered') error = `destination answered ${response.status}`;
      } catch (err) {
        outcome = 'retry';
        error = (err as Error).name === 'TimeoutError' ? `no answer within ${DELIVERY_TIMEOUT_MS} ms` : `could not connect: ${(err as Error).message}`.slice(0, 300);
      }
    }

    await this.db.tx(tenantId, async (q) => {
      if (outcome === 'delivered') {
        await q.exec(`UPDATE deliveries SET status = 'delivered', delivered_at = now(), last_status_code = $2, last_error = NULL WHERE id = $1`, [deliveryId, statusCode]);
        return;
      }
      const delay = outcome === 'retry' ? retryDelay(claim.attempts) : null;
      if (delay !== null) {
        await q.exec('UPDATE deliveries SET next_attempt_at = now() + make_interval(secs => $2), last_status_code = $3, last_error = $4 WHERE id = $1', [deliveryId, delay, statusCode, error]);
        return;
      }
      await q.exec(`UPDATE deliveries SET status = 'failed', last_status_code = $2, last_error = $3 WHERE id = $1`, [deliveryId, statusCode, error]);
      await this.outbox.emit(q, {
        type: 'integration.delivery.failed.v1',
        aggregateType: 'subscription',
        aggregateId: claim.subscription_id,
        tenantId,
        payload: { subscription_id: claim.subscription_id, event_id: claim.event_id, event_type: claim.event_type, attempts: claim.attempts, error: error ?? 'unknown error' },
      });
      await this.outbox.emit(q, {
        type: 'notification.requested.v1',
        aggregateType: 'subscription',
        aggregateId: claim.subscription_id,
        tenantId,
        payload: {
          dedupe_key: `delivery-failed:${deliveryId}:${claim.attempts}`,
          channel: 'in_app',
          category: 'integration.delivery_failed',
          external: false,
          recipient_user_id: null,
          recipient_role: Roles.TenantAdmin,
          recipient_address: null,
          subject: `Webhook delivery failed: ${claim.subscription_name}`,
          body: `${claim.event_type} could not be delivered after ${claim.attempts} attempt(s): ${error}`,
          reference_type: 'subscription',
          reference_id: claim.subscription_id,
        },
      });
    });
    return outcome === 'delivered';
  }
}
