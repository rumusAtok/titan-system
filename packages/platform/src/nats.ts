import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
  RetentionPolicy,
  StorageType,
} from '@nats-io/jetstream';
import { connect, headers, nanos, type NatsConnection } from '@nats-io/transport-node';
import {
  DLQ_STREAM,
  DLQ_SUBJECT_PREFIX,
  EVENT_STREAM,
  EVENT_SUBJECT_PREFIX,
  type EventEnvelope,
  subjectFor,
} from '@titan/contracts';
import { currentContext, formatTraceparent, type Logger } from '@titan/observability';
import { CONFIG, LOGGER, type PlatformConfig } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Shared NATS connection. Connecting happens in the background so a service
 * can start, serve requests and buffer events in its outbox while the broker
 * is unavailable.
 */
@Injectable()
export class NatsClient implements OnApplicationBootstrap, OnApplicationShutdown {
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private up = false;
  private stopping = false;
  private readonly readyWaiters: Array<() => void> = [];

  constructor(
    @Inject(CONFIG) private readonly config: PlatformConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    void this.start();
  }

  private async start(): Promise<void> {
    while (!this.stopping && !this.nc) {
      try {
        const nc = await connect({
          servers: this.config.NATS_URL.split(','),
          name: this.config.SERVICE_NAME,
          maxReconnectAttempts: -1,
          reconnectTimeWait: 1_000,
          timeout: 5_000,
        });
        this.jsm = await jetstreamManager(nc);
        await this.ensureStreams(this.jsm);
        this.js = jetstream(nc);
        this.nc = nc;
        this.up = true;
        this.logger.info({ server: nc.getServer() }, 'connected to NATS');
        void this.watchStatus(nc);
        for (const resolve of this.readyWaiters.splice(0)) resolve();
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, 'NATS not reachable, retrying');
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  private async watchStatus(nc: NatsConnection): Promise<void> {
    for await (const s of nc.status()) {
      if (s.type === 'disconnect') {
        this.up = false;
        this.logger.warn('NATS disconnected');
      } else if (s.type === 'reconnect') {
        this.up = true;
        this.logger.info('NATS reconnected');
      }
    }
  }

  /** Streams are created idempotently by whichever service starts first. */
  private async ensureStreams(jsm: JetStreamManager): Promise<void> {
    const replicas = this.config.NATS_STREAM_REPLICAS;
    const wanted = [
      {
        name: EVENT_STREAM,
        subjects: [`${EVENT_SUBJECT_PREFIX}>`],
        max_age: nanos(7 * DAY_MS),
        // JetStream drops publishes repeating a Nats-Msg-Id inside this window,
        // which absorbs outbox relay retries.
        duplicate_window: nanos(2 * 60 * 1000),
      },
      { name: DLQ_STREAM, subjects: [`${DLQ_SUBJECT_PREFIX}>`], max_age: nanos(30 * DAY_MS), duplicate_window: nanos(2 * 60 * 1000) },
    ];
    for (const s of wanted) {
      try {
        await jsm.streams.info(s.name);
      } catch {
        try {
          await jsm.streams.add({ ...s, retention: RetentionPolicy.Limits, storage: StorageType.File, num_replicas: replicas });
          this.logger.info({ stream: s.name }, 'created JetStream stream');
        } catch (err) {
          // Another service may have created it between info() and add().
          await jsm.streams.info(s.name).catch(() => {
            throw err;
          });
        }
      }
    }
  }

  get connected(): boolean {
    return this.up && !!this.nc && !this.nc.isClosed();
  }

  /** Resolves once the first connection (and stream setup) has succeeded. */
  whenReady(): Promise<void> {
    if (this.nc) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  connection(): NatsConnection {
    if (!this.nc) throw new Error('NATS is not connected');
    return this.nc;
  }

  jetstream(): JetStreamClient {
    if (!this.js) throw new Error('NATS is not connected');
    return this.js;
  }

  manager(): JetStreamManager {
    if (!this.jsm) throw new Error('NATS is not connected');
    return this.jsm;
  }

  /** Publishes an event durably; resolves only after JetStream acknowledged it. */
  async publishEvent(event: EventEnvelope): Promise<void> {
    const h = headers();
    const ctx = currentContext();
    if (ctx) h.set('traceparent', formatTraceparent(ctx));
    await this.jetstream().publish(subjectFor(event.event_type), JSON.stringify(event), {
      msgID: event.event_id,
      headers: h,
      timeout: 5_000,
    });
  }

  async publishDeadLetter(consumer: string, data: Uint8Array, meta: Record<string, string>): Promise<void> {
    const h = headers();
    for (const [k, v] of Object.entries(meta)) h.set(k, v.slice(0, 500));
    await this.jetstream().publish(`${DLQ_SUBJECT_PREFIX}${consumer}`, data, { headers: h, timeout: 5_000 });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.up = false;
    try {
      await this.nc?.drain();
    } catch {
      // already closed
    }
  }
}
