import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { type Actor, buildEnvelope, type EventEnvelope, type EventPayload, type EventType, validatePayload } from '@titan/contracts';
import { currentContext, eventsPublished, type Logger, outboxPending } from '@titan/observability';
import { CONFIG, LOGGER, type PlatformConfig } from './config.js';
import { Db, type Q } from './db.js';
import { NatsClient } from './nats.js';

export interface EmitInput<T extends EventType> {
  type: T;
  aggregateType: string;
  aggregateId: string;
  tenantId: string;
  payload: EventPayload<T>;
  actor?: Actor | null;
  occurredAt?: Date;
}

/**
 * Transactional outbox writer. `emit` must be called with the `Q` of the
 * transaction that performs the business change, so the event exists if and
 * only if the change committed.
 */
@Injectable()
export class Outbox {
  constructor(@Inject(CONFIG) private readonly config: PlatformConfig) {}

  async emit<T extends EventType>(q: Q, input: EmitInput<T>): Promise<EventEnvelope<EventPayload<T>>> {
    const payload = validatePayload(input.type, input.payload);
    const ctx = currentContext();
    const envelope = buildEnvelope({
      type: input.type,
      producer: this.config.SERVICE_NAME,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      tenantId: input.tenantId,
      payload: payload as Record<string, unknown>,
      correlationId: ctx?.correlationId,
      causationId: ctx?.causationId ?? null,
      actor: input.actor ?? ctx?.actor ?? null,
      occurredAt: input.occurredAt,
    });
    await q.exec('INSERT INTO outbox (event_id, event_type, tenant_id, event) VALUES ($1, $2, $3, $4)', [
      envelope.event_id,
      envelope.event_type,
      envelope.tenant_id,
      JSON.stringify(envelope),
    ]);
    return envelope as EventEnvelope<EventPayload<T>>;
  }
}

const BATCH = 100;

/**
 * Publishes committed outbox rows to JetStream. A row is marked published
 * only after the broker acknowledged it, so a crash in between causes a
 * re-publish (at-least-once); the broker's duplicate window and the
 * consumers' inbox absorb the repeat.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private running = false;
  private loop?: Promise<void>;
  private lastHousekeeping = 0;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(NatsClient) private readonly nats: NatsClient,
    @Inject(CONFIG) private readonly config: PlatformConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (this.running) {
      let published = 0;
      try {
        if (this.nats.connected) published = await this.publishBatch();
        await this.housekeeping();
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'outbox relay iteration failed');
        await sleep(1_000);
      }
      if (published < BATCH) await sleep(this.config.OUTBOX_POLL_MS);
    }
  }

  /** Publishes up to one batch; returns the number of rows published. */
  async publishBatch(): Promise<number> {
    return this.db.tx(null, async (q) => {
      const rows = await q.query<{ seq: number; event_type: string; event: EventEnvelope }>(
        `SELECT seq, event_type, event FROM outbox
          WHERE published_at IS NULL
          ORDER BY seq
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH],
      );
      const done: number[] = [];
      for (const row of rows) {
        try {
          await this.nats.publishEvent(row.event);
          eventsPublished.inc({ event_type: row.event_type });
          done.push(row.seq);
        } catch (err) {
          this.logger.warn({ error: (err as Error).message, event_type: row.event_type }, 'publish failed; will retry');
          break;
        }
      }
      if (done.length) await q.exec('UPDATE outbox SET published_at = now() WHERE seq = ANY($1::bigint[])', [done]);
      return done.length;
    });
  }

  private async housekeeping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHousekeeping < 15_000) return;
    this.lastHousekeeping = now;
    await this.db.tx(null, async (q) => {
      const { pending } = await q.one<{ pending: number }>('SELECT count(*)::int AS pending FROM outbox WHERE published_at IS NULL');
      outboxPending.set(pending);
      await q.exec(`DELETE FROM outbox WHERE published_at < now() - make_interval(hours => $1)`, [this.config.OUTBOX_RETENTION_HOURS]);
      // Inbox rows only need to outlive the broker's redelivery horizon (stream max age: 7 days).
      await q.exec(`DELETE FROM inbox WHERE processed_at < now() - interval '14 days'`);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
