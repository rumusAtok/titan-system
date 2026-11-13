import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { AckPolicy, type ConsumerMessages, DeliverPolicy, type JsMsg } from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';
import { EVENT_STREAM, EVENT_SUBJECT_PREFIX, type EventEnvelope, EventValidationError, validateEvent } from '@titan/contracts';
import { eventsConsumed, type Logger, newContext, parseTraceparent, runWithContext } from '@titan/observability';
import { CONFIG, LOGGER, type PlatformConfig } from './config.js';
import { Db, type Q } from './db.js';
import { NatsClient } from './nats.js';

export type EventHandler = (event: EventEnvelope, q: Q) => Promise<void>;

export interface ConsumerDefinition {
  /** Durable name; one logical consumer per name. Defaults to the service name. */
  name?: string;
  /** Event types (JetStream wildcards allowed, e.g. `case.>`) without the subject prefix. */
  subjects: string[];
  /**
   * Runs inside a transaction bound to the event's tenant. The inbox row is
   * written in the same transaction, so business effects and the
   * "processed" marker commit or roll back together.
   */
  handler: EventHandler;
}

/** Delay before redelivery attempt n+1 (bounded; no infinite retries). */
const BACKOFF_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

export type HandleOutcome = 'processed' | 'duplicate';

/**
 * Idempotent event handling core, separated from the broker plumbing so it
 * can be exercised directly in tests.
 */
export async function handleOnce(db: Db, consumer: string, event: EventEnvelope, handler: EventHandler): Promise<HandleOutcome> {
  return db.tx(event.tenant_id, async (q) => {
    const inserted = await q.query(
      'INSERT INTO inbox (consumer, event_id, event_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id',
      [consumer, event.event_id, event.event_type],
    );
    if (inserted.length === 0) return 'duplicate';
    await handler(event, q);
    return 'processed';
  });
}

@Injectable()
export class EventConsumers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly definitions: Required<ConsumerDefinition>[] = [];
  private readonly active: ConsumerMessages[] = [];
  private started = false;
  private stopping = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(NatsClient) private readonly nats: NatsClient,
    @Inject(CONFIG) private readonly config: PlatformConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Registers a durable consumer. Safe to call before NATS is connected. */
  register(definition: ConsumerDefinition): void {
    const def = { name: definition.name ?? this.config.SERVICE_NAME, subjects: definition.subjects, handler: definition.handler };
    this.definitions.push(def);
    if (this.started) void this.runConsumer(def);
  }

  onApplicationBootstrap(): void {
    void this.nats.whenReady().then(() => {
      this.started = true;
      for (const def of this.definitions) void this.runConsumer(def);
    });
  }

  private async ensureConsumer(def: Required<ConsumerDefinition>): Promise<void> {
    const jsm = this.nats.manager();
    const cfg = {
      durable_name: def.name,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subjects: def.subjects.map((s) => EVENT_SUBJECT_PREFIX + s),
      // One more than the handler budget so the final attempt is still delivered
      // to us and can be routed to the dead-letter queue explicitly.
      max_deliver: this.config.EVENT_MAX_DELIVER + 1,
      ack_wait: nanos(30_000),
      max_ack_pending: 256,
    };
    try {
      await jsm.consumers.info(EVENT_STREAM, def.name);
      await jsm.consumers.update(EVENT_STREAM, def.name, {
        filter_subjects: cfg.filter_subjects,
        max_deliver: cfg.max_deliver,
        ack_wait: cfg.ack_wait,
        max_ack_pending: cfg.max_ack_pending,
      });
    } catch {
      await jsm.consumers.add(EVENT_STREAM, cfg);
    }
  }

  private async runConsumer(def: Required<ConsumerDefinition>): Promise<void> {
    while (!this.stopping) {
      try {
        await this.ensureConsumer(def);
        const consumer = await this.nats.jetstream().consumers.get(EVENT_STREAM, def.name);
        const messages = await consumer.consume({ max_messages: 64 });
        this.active.push(messages);
        this.logger.info({ consumer: def.name, subjects: def.subjects }, 'event consumer started');
        // Sequential on purpose: preserves stream order within a consumer.
        for await (const m of messages) {
          await this.handleMessage(def, m);
        }
      } catch (err) {
        if (this.stopping) return;
        this.logger.warn({ consumer: def.name, error: (err as Error).message }, 'event consumer interrupted; restarting');
      }
      if (!this.stopping) await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  private async handleMessage(def: Required<ConsumerDefinition>, m: JsMsg): Promise<void> {
    let event: EventEnvelope;
    try {
      event = validateEvent(JSON.parse(m.string()));
    } catch (err) {
      // A malformed event can never succeed: do not retry it.
      const detail = err instanceof EventValidationError ? `${err.message}: ${JSON.stringify(err.issues)}` : (err as Error).message;
      await this.deadLetter(def.name, m, null, 'invalid_event', detail);
      return;
    }

    const ctx = newContext({
      correlationId: event.correlation_id,
      causationId: event.event_id,
      traceId: parseTraceparent(m.headers?.get('traceparent'))?.traceId,
      actor: { id: this.config.SERVICE_NAME, type: 'service' },
    });

    try {
      const outcome = await runWithContext(ctx, () => handleOnce(this.db, def.name, event, def.handler));
      m.ack();
      eventsConsumed.inc({ event_type: event.event_type, outcome });
    } catch (err) {
      const deliveries = m.info.deliveryCount;
      const message = (err as Error).message ?? String(err);
      if (deliveries >= this.config.EVENT_MAX_DELIVER) {
        await runWithContext(ctx, () => this.deadLetter(def.name, m, event, 'max_deliveries_exceeded', message));
        return;
      }
      runWithContext(ctx, () =>
        this.logger.warn({ consumer: def.name, event_type: event.event_type, event_id: event.event_id, deliveries, error: message }, 'event handling failed; will retry'),
      );
      eventsConsumed.inc({ event_type: event.event_type, outcome: 'retry' });
      m.nak(BACKOFF_MS[Math.min(deliveries - 1, BACKOFF_MS.length - 1)]);
    }
  }

  private async deadLetter(consumer: string, m: JsMsg, event: EventEnvelope | null, reason: string, error: string): Promise<void> {
    try {
      await this.db.tx(null, (q) =>
        q.exec(
          `INSERT INTO dead_letters (consumer, subject, event_id, event_type, reason, error, deliveries, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [consumer, m.subject, event?.event_id ?? null, event?.event_type ?? null, reason, error.slice(0, 4000), m.info.deliveryCount, m.string().slice(0, 200_000)],
        ),
      );
      await this.nats.publishDeadLetter(consumer, m.data, { 'titan-dlq-reason': reason, 'titan-dlq-error': error, 'titan-dlq-subject': m.subject });
      m.term(reason);
      eventsConsumed.inc({ event_type: event?.event_type ?? 'unknown', outcome: reason === 'invalid_event' ? 'invalid' : 'dead_letter' });
      this.logger.error({ consumer, subject: m.subject, event_id: event?.event_id, reason, error }, 'event moved to dead-letter queue');
    } catch (err) {
      // Could not record the dead letter: leave the message for redelivery rather than lose it.
      this.logger.error({ consumer, error: (err as Error).message }, 'failed to dead-letter event');
      m.nak(10_000);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.active.map((a) => a.close().catch(() => undefined)));
  }
}
