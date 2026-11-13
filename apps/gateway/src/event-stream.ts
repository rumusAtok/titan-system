import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import { EVENT_SUBJECT_PREFIX } from '@titan/contracts';
import { gauge, type Logger } from '@titan/observability';
import { LOGGER, NatsClient } from '@titan/platform';

/** Event families pushed to operator screens. Everything else stays server-side. */
const STREAMED_PREFIXES = ['telemetry.measurement.', 'alert.', 'incident.', 'device.status_changed.', 'workflow.task.', 'workflow.case.', 'case.submitted.'];

interface Client {
  tenantId: string;
  res: ServerResponse;
}

const connectedClients = gauge('titan_gateway_sse_clients', 'Connected live-event stream clients');

/**
 * Fans durable business events out to browsers over Server-Sent Events.
 * Delivery here is best-effort and for display only: a client that misses
 * events simply re-reads state from the owning service's API.
 */
@Injectable()
export class EventStream implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly clients = new Set<Client>();
  private heartbeat?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    @Inject(NatsClient) private readonly nats: NatsClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.res.write(': keep-alive\n\n');
    }, 15_000);
    void this.nats.whenReady().then(() => this.pump());
  }

  private async pump(): Promise<void> {
    while (!this.stopping) {
      try {
        const sub = this.nats.connection().subscribe(`${EVENT_SUBJECT_PREFIX}>`);
        for await (const m of sub) {
          if (this.clients.size === 0) continue;
          const type = m.subject.slice(EVENT_SUBJECT_PREFIX.length);
          if (!STREAMED_PREFIXES.some((p) => type.startsWith(p))) continue;
          let event: { tenant_id?: string; event_id?: string; aggregate_id?: string; occurred_at?: string; payload?: unknown };
          try {
            event = JSON.parse(m.string());
          } catch {
            continue;
          }
          const frame = `id: ${event.event_id}\nevent: ${type}\ndata: ${JSON.stringify({
            type,
            aggregate_id: event.aggregate_id,
            occurred_at: event.occurred_at,
            payload: event.payload,
          })}\n\n`;
          // Tenant isolation: an event is only written to clients of its own tenant.
          for (const c of this.clients) if (c.tenantId === event.tenant_id) c.res.write(frame);
        }
      } catch (err) {
        if (!this.stopping) this.logger.warn({ error: (err as Error).message }, 'live event subscription interrupted');
      }
      if (!this.stopping) await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  attach(user: Principal, req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ broker: this.nats.connected ? 'up' : 'down' })}\n\n`);
    const client: Client = { tenantId: user.tenantId, res };
    this.clients.add(client);
    connectedClients.set(this.clients.size);
    req.on('close', () => {
      this.clients.delete(client);
      connectedClients.set(this.clients.size);
    });
  }

  onApplicationShutdown(): void {
    this.stopping = true;
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }
}
