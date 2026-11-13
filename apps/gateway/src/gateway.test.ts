import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { JwtVerifier, Principal } from '@titan/authentication';
import { createLogger } from '@titan/observability';
import { describe, expect, it, vi } from 'vitest';
import { createProxy } from './proxy.js';
import { TokenBucketLimiter } from './rate-limit.js';
import { buildUpstreams } from './upstreams.js';

describe('TokenBucketLimiter', () => {
  it('allows a burst, then throttles, then refills over time', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(60, 5, () => now);
    for (let i = 0; i < 5; i++) expect(limiter.take('u').allowed).toBe(true);
    const denied = limiter.take('u');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    now += 1000; // 60/min = one token per second
    expect(limiter.take('u').allowed).toBe(true);
    expect(limiter.take('u').allowed).toBe(false);
  });

  it('tracks callers independently', () => {
    const limiter = new TokenBucketLimiter(60, 1, () => 0);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    expect(limiter.take('b').allowed).toBe(true);
  });

  it('forgets idle callers', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(60, 2, () => now);
    limiter.take('a');
    now += 10 * 60_000;
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });
});

// --- proxy ---------------------------------------------------------------------

const principal: Principal = { userId: 'u1', username: 'alice', email: null, tenantId: 't', roles: [], department: null, isService: false, token: 'good' };
const verifier = { verify: async (t: string) => (t === 'good' ? principal : Promise.reject(new Error('bad'))) } as unknown as JwtVerifier;

function request(method: string, url: string, headers: Record<string, string> = {}, body?: string): IncomingMessage {
  const req = Readable.from(body ? [Buffer.from(body)] : []) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '10.0.0.9' } });
  return req;
}

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writableEnded = false;
  setHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = String(v);
  }
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }
  write(chunk: Buffer | string) {
    this.body += chunk.toString();
    return true;
  }
  end(chunk?: Buffer | string) {
    if (chunk) this.body += chunk.toString();
    this.writableEnded = true;
    this.emit('finish');
    return this;
  }
  destroy() {
    this.end();
  }
}

function setup(fetchImpl: typeof fetch, perMinute = 600) {
  const upstreams = buildUpstreams({});
  const handler = createProxy({ upstreams, verifier, limiter: new TokenBucketLimiter(perMinute, perMinute), logger: createLogger('test'), fetchImpl });
  const call = async (req: IncomingMessage) => {
    const res = new FakeResponse();
    const next = vi.fn();
    const finished = new Promise<void>((resolve) => res.once('finish', () => resolve()));
    await handler(req, res as unknown as ServerResponse, next);
    if (!next.mock.calls.length) await finished;
    return { res, next };
  };
  return { call, upstreams };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('gateway proxy', () => {
  it('rejects a request without a token before contacting any service', async () => {
    const fetchImpl = vi.fn();
    const { call } = setup(fetchImpl as unknown as typeof fetch);
    const { res } = await call(request('GET', '/case/cases'));
    expect(res.statusCode).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an invalid token', async () => {
    const fetchImpl = vi.fn();
    const { call } = setup(fetchImpl as unknown as typeof fetch);
    const { res } = await call(request('GET', '/case/cases', { authorization: 'Bearer forged' }));
    expect(res.statusCode).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('routes to the owning service, forwards the token and returns the response', async () => {
    const fetchImpl = vi.fn(async () => json(200, [{ id: 1 }]));
    const { call } = setup(fetchImpl as unknown as typeof fetch);
    const { res } = await call(request('GET', '/case/cases?status=draft', { authorization: 'Bearer good' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ id: 1 }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://case-service:3000/cases?status=draft');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer good');
  });

  it('does not forward client-supplied identity headers', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const { call } = setup(fetchImpl as unknown as typeof fetch);
    await call(request('GET', '/case/cases', { authorization: 'Bearer good', 'x-tenant-id': 'someone-else', 'x-user-roles': 'tenant_admin' }));
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const forwarded = Object.keys(init.headers as Record<string, string>);
    expect(forwarded).not.toContain('x-tenant-id');
    expect(forwarded).not.toContain('x-user-roles');
  });

  it('passes unknown route keys to the next handler', async () => {
    const { call } = setup(vi.fn() as unknown as typeof fetch);
    const { next } = await call(request('GET', '/platform/health', { authorization: 'Bearer good' }));
    expect(next).toHaveBeenCalled();
  });

  it('enforces the per-caller rate limit', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const { call } = setup(fetchImpl as unknown as typeof fetch, 2);
    await call(request('GET', '/case/cases', { authorization: 'Bearer good' }));
    await call(request('GET', '/case/cases', { authorization: 'Bearer good' }));
    const { res } = await call(request('GET', '/case/cases', { authorization: 'Bearer good' }));
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('retries a failed read once but never a write', async () => {
    const failing = vi.fn(async () => Promise.reject(new Error('ECONNREFUSED')));
    const { call } = setup(failing as unknown as typeof fetch);
    const get = await call(request('GET', '/asset/assets', { authorization: 'Bearer good' }));
    expect(get.res.statusCode).toBe(502);
    expect(failing).toHaveBeenCalledTimes(2);
    failing.mockClear();
    const post = await call(request('POST', '/asset/assets', { authorization: 'Bearer good', 'content-type': 'application/json' }, '{}'));
    expect(post.res.statusCode).toBe(502);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('opens the circuit for a failing service without affecting other services', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (String(url).includes('audit-service') ? Promise.reject(new Error('down')) : json(200, { ok: true })));
    const { call } = setup(fetchImpl as unknown as typeof fetch);
    for (let i = 0; i < 5; i++) await call(request('POST', '/audit/x', { authorization: 'Bearer good' }));
    fetchImpl.mockClear();
    const blocked = await call(request('POST', '/audit/x', { authorization: 'Bearer good' }));
    expect(blocked.res.statusCode).toBe(503);
    expect(JSON.parse(blocked.res.body).error.code).toBe('upstream_unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
    const healthy = await call(request('GET', '/case/cases', { authorization: 'Bearer good' }));
    expect(healthy.res.statusCode).toBe(200);
  });

  it('refuses an oversized request body', async () => {
    const { call } = setup(vi.fn() as unknown as typeof fetch);
    const { res } = await call(request('POST', '/case/cases', { authorization: 'Bearer good' }, 'x'.repeat(7 * 1024 * 1024)));
    expect(res.statusCode).toBe(413);
  });
});
