import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { JwtVerifier, Principal } from '@titan/authentication';
import { circuitState, currentContext, type Logger, propagationHeaders, upstreamRequests } from '@titan/observability';
import { BulkheadFullError, CircuitOpenError, retry, TimeoutError } from '@titan/platform';
import type { TokenBucketLimiter } from './rate-limit.js';
import type { Upstream } from './upstreams.js';

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const FORWARDED_REQUEST_HEADERS = ['authorization', 'content-type', 'accept', 'accept-language', 'idempotency-key', 'if-match', 'if-none-match'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'cache-control', 'etag', 'location', 'retry-after', 'x-total-count'];
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const OPERATIONAL_PATH = /^\/(metrics|health)(\/|$)/;

/** The upstream answered, but with a status that means "I am not available". */
class UpstreamUnavailable extends Error {
  constructor(public readonly response: Response) {
    super(`upstream responded ${response.status}`);
  }
}

class BodyTooLarge extends Error {}

function sendProblem(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify({ error: { status, code, message, correlation_id: currentContext()?.correlationId } }));
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return size ? Buffer.concat(chunks) : undefined;
}

export interface ProxyDeps {
  upstreams: Map<string, Upstream>;
  verifier: JwtVerifier;
  limiter: TokenBucketLimiter;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Reverse proxy for `/api/<service-key>/...`.
 *
 * The gateway authenticates and rate-limits at the edge, then forwards the
 * caller's token unchanged. It makes no authorisation decisions about
 * business data: each service verifies the token and enforces its own rules.
 */
export function createProxy(deps: ProxyDeps) {
  const doFetch = deps.fetchImpl ?? fetch;

  return async (req: IncomingMessage & { url?: string }, res: ServerResponse, next: () => void): Promise<void> => {
    // Mounted at /api, so req.url is "/<key>/<rest>?<query>".
    const match = /^\/([a-z-]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? '');
    const upstream = match ? deps.upstreams.get(match[1]!) : undefined;
    if (!match || !upstream) return next();
    if (req.method === 'OPTIONS') return next();
    // Operational endpoints are for the cluster (probes, Prometheus), not for API clients.
    if (OPERATIONAL_PATH.test(match[2] ?? '')) return sendProblem(res, 404, 'not_found', 'not found');

    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
      return sendProblem(res, 401, 'unauthenticated', 'missing bearer token', { 'www-authenticate': 'Bearer' });
    }
    let principal: Principal;
    try {
      principal = await deps.verifier.verify(header.slice(7).trim());
    } catch {
      return sendProblem(res, 401, 'unauthenticated', 'invalid or expired token', { 'www-authenticate': 'Bearer error="invalid_token"' });
    }

    const rate = deps.limiter.take(principal.userId);
    res.setHeader('x-ratelimit-remaining', String(rate.remaining));
    if (!rate.allowed) {
      return sendProblem(res, 429, 'rate_limited', 'too many requests', { 'retry-after': String(rate.retryAfterSeconds) });
    }

    const method = (req.method ?? 'GET').toUpperCase();
    let body: Buffer | undefined;
    try {
      if (!IDEMPOTENT.has(method)) body = await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLarge) return sendProblem(res, 413, 'payload_too_large', 'request body too large');
      return sendProblem(res, 400, 'bad_request', 'could not read request body');
    }

    const headers: Record<string, string> = { ...propagationHeaders() };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const forwardedFor = req.socket.remoteAddress;
    if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;

    const target = `${upstream.baseUrl}${match[2] ?? '/'}${match[3] ?? ''}`;

    const attempt = () =>
      upstream.bulkhead.run(() =>
        upstream.breaker.run(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), upstream.timeoutMs);
          // If the client goes away, stop the upstream call too.
          const onClose = () => {
            if (!res.writableEnded) controller.abort();
          };
          res.once('close', onClose);
          try {
            const response = await doFetch(target, { method, headers, body, signal: controller.signal, redirect: 'manual' });
            // Only "not available" statuses count against the breaker; a 4xx/500 is an answer.
            if (response.status === 502 || response.status === 503 || response.status === 504) throw new UpstreamUnavailable(response);
            return response;
          } catch (err) {
            if (controller.signal.aborted && !(err instanceof UpstreamUnavailable)) throw new TimeoutError(`${upstream.service} did not respond in time`);
            throw err;
          } finally {
            clearTimeout(timer);
            res.off('close', onClose);
          }
        }),
      );

    let response: Response;
    try {
      // Retry once, and only requests that are safe to repeat.
      response = await retry(attempt, {
        attempts: IDEMPOTENT.has(method) ? 2 : 1,
        baseDelayMs: 100,
        retryable: (err) => !(err instanceof TimeoutError),
      });
      upstreamRequests.inc({ upstream: upstream.service, outcome: 'ok' });
    } catch (err) {
      circuitState.set({ upstream: upstream.service }, upstream.breaker.status === 'closed' ? 0 : 1);
      if (err instanceof UpstreamUnavailable) {
        upstreamRequests.inc({ upstream: upstream.service, outcome: 'error' });
        response = err.response;
      } else if (err instanceof CircuitOpenError) {
        upstreamRequests.inc({ upstream: upstream.service, outcome: 'circuit_open' });
        return sendProblem(res, 503, 'upstream_unavailable', `${upstream.service} is temporarily unavailable`, { 'retry-after': '10' });
      } else if (err instanceof BulkheadFullError) {
        upstreamRequests.inc({ upstream: upstream.service, outcome: 'rejected' });
        return sendProblem(res, 503, 'upstream_overloaded', `${upstream.service} is overloaded`, { 'retry-after': '2' });
      } else if (err instanceof TimeoutError) {
        upstreamRequests.inc({ upstream: upstream.service, outcome: 'timeout' });
        return sendProblem(res, 504, 'upstream_timeout', `${upstream.service} did not respond in time`);
      } else {
        upstreamRequests.inc({ upstream: upstream.service, outcome: 'error' });
        deps.logger.warn({ upstream: upstream.service, error: (err as Error).message }, 'upstream call failed');
        return sendProblem(res, 502, 'upstream_unreachable', `${upstream.service} could not be reached`);
      }
    }
    circuitState.set({ upstream: upstream.service }, upstream.breaker.status === 'closed' ? 0 : 1);

    res.statusCode = response.status;
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!response.body) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body as unknown as WebReadableStream)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}
