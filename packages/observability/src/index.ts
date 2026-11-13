import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pino, type Logger } from 'pino';
import client from 'prom-client';

export type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Request / message context
// ---------------------------------------------------------------------------

export interface RequestContext {
  /** Stable id that follows a business operation across services and events. */
  correlationId: string;
  /** Id of the event (or request) that directly caused the current work. */
  causationId: string | null;
  /** W3C trace id (32 hex chars). */
  traceId: string;
  /** W3C span id (16 hex chars) of the current unit of work. */
  spanId: string;
  actor?: { id: string; username?: string; type: 'user' | 'service' | 'system' | 'device' } | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function newContext(partial: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: partial.correlationId ?? randomUUID(),
    causationId: partial.causationId ?? null,
    traceId: partial.traceId ?? randomBytes(16).toString('hex'),
    spanId: partial.spanId ?? randomBytes(8).toString('hex'),
    actor: partial.actor ?? null,
  };
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Parses a W3C `traceparent` header; returns undefined when absent or malformed. */
export function parseTraceparent(value: string | undefined | null): { traceId: string; parentSpanId: string } | undefined {
  if (!value) return undefined;
  const m = TRACEPARENT.exec(value.trim());
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return undefined;
  return { traceId: m[1]!, parentSpanId: m[2]! };
}

export function formatTraceparent(ctx: Pick<RequestContext, 'traceId' | 'spanId'>): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

/** Headers to attach to outgoing HTTP calls so the callee continues the trace. */
export function propagationHeaders(): Record<string, string> {
  const ctx = currentContext();
  if (!ctx) return {};
  return { 'x-correlation-id': ctx.correlationId, traceparent: formatTraceparent(ctx) };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export function createLogger(service: string): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ['req.headers.authorization', 'headers.authorization', '*.password', '*.token', '*.client_secret'],
      censor: '[redacted]',
    },
    mixin() {
      const ctx = currentContext();
      return ctx ? { correlation_id: ctx.correlationId, trace_id: ctx.traceId, span_id: ctx.spanId } : {};
    },
  });
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const registry = new client.Registry();
let defaultsStarted = false;

export function startDefaultMetrics(service: string): void {
  if (defaultsStarted) return;
  defaultsStarted = true;
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });
}

export const httpRequestDuration = new client.Histogram({
  name: 'titan_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const eventsPublished = new client.Counter({
  name: 'titan_events_published_total',
  help: 'Events published from the transactional outbox',
  labelNames: ['event_type'] as const,
  registers: [registry],
});

export const eventsConsumed = new client.Counter({
  name: 'titan_events_consumed_total',
  help: 'Events handled by a consumer, by outcome (processed|duplicate|retry|dead_letter|invalid)',
  labelNames: ['event_type', 'outcome'] as const,
  registers: [registry],
});

export const outboxPending = new client.Gauge({
  name: 'titan_outbox_pending',
  help: 'Outbox rows not yet published',
  registers: [registry],
});

export const upstreamRequests = new client.Counter({
  name: 'titan_upstream_requests_total',
  help: 'Outbound calls to other services, by outcome (ok|error|timeout|circuit_open|rejected)',
  labelNames: ['upstream', 'outcome'] as const,
  registers: [registry],
});

export const circuitState = new client.Gauge({
  name: 'titan_circuit_breaker_open',
  help: '1 when the circuit breaker for an upstream is open',
  labelNames: ['upstream'] as const,
  registers: [registry],
});

export function counter(name: string, help: string, labelNames: string[] = []): client.Counter {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as client.Counter;
  return new client.Counter({ name, help, labelNames, registers: [registry] });
}

export function gauge(name: string, help: string, labelNames: string[] = []): client.Gauge {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as client.Gauge;
  return new client.Gauge({ name, help, labelNames, registers: [registry] });
}

export async function metricsText(): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}

// ---------------------------------------------------------------------------
// HTTP middleware (framework-agnostic, express compatible)
// ---------------------------------------------------------------------------

type Req = IncomingMessage & { originalUrl?: string; route?: { path?: string }; baseUrl?: string };

const QUIET_PATHS = new Set(['/health/live', '/health/ready', '/metrics']);

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Establishes the request context (correlation id + trace), echoes the
 * correlation id to the caller, and records access logs and latency metrics.
 */
export function httpObservability(logger: Logger) {
  return (req: Req, res: ServerResponse, next: () => void): void => {
    const incoming = headerValue(req.headers['x-correlation-id']);
    const correlationId = incoming && /^[A-Za-z0-9._:-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    const parent = parseTraceparent(headerValue(req.headers['traceparent']));
    const ctx = newContext({ correlationId, traceId: parent?.traceId, causationId: null });
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('traceparent', formatTraceparent(ctx));
    const started = process.hrtime.bigint();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';

    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : res.statusCode === 404 ? 'unmatched' : path;
      httpRequestDuration.observe({ method: req.method ?? 'GET', route, status: String(res.statusCode) }, seconds);
      if (QUIET_PATHS.has(path)) return;
      runWithContext(ctx, () => {
        const entry = {
          http: { method: req.method, path, status: res.statusCode, duration_ms: Math.round(seconds * 1000) },
        };
        if (res.statusCode >= 500) logger.error(entry, 'request failed');
        else logger.info(entry, 'request completed');
      });
    });

    runWithContext(ctx, next);
  };
}
