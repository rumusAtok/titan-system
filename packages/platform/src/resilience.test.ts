import { describe, expect, it, vi } from 'vitest';
import { Bulkhead, BulkheadFullError, CircuitBreaker, CircuitOpenError, retry, TimeoutError, withTimeout } from './resilience.js';

const fail = () => Promise.reject(new Error('boom'));
const ok = () => Promise.resolve('ok');

describe('CircuitBreaker', () => {
  it('opens after the configured number of consecutive failures and then fails fast', async () => {
    const breaker = new CircuitBreaker('svc', { failureThreshold: 3, resetTimeoutMs: 1000, now: () => 0 });
    for (let i = 0; i < 3; i++) await expect(breaker.run(fail)).rejects.toThrow('boom');
    expect(breaker.status).toBe('open');
    const fn = vi.fn(ok);
    await expect(breaker.run(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a success resets the failure count', async () => {
    const breaker = new CircuitBreaker('svc', { failureThreshold: 3, now: () => 0 });
    await expect(breaker.run(fail)).rejects.toThrow();
    await expect(breaker.run(fail)).rejects.toThrow();
    await breaker.run(ok);
    await expect(breaker.run(fail)).rejects.toThrow();
    expect(breaker.status).toBe('closed');
  });

  it('allows one trial call after the reset timeout and closes on success', async () => {
    let now = 0;
    const breaker = new CircuitBreaker('svc', { failureThreshold: 1, resetTimeoutMs: 1000, now: () => now });
    await expect(breaker.run(fail)).rejects.toThrow();
    now = 999;
    expect(breaker.status).toBe('open');
    now = 1000;
    expect(breaker.status).toBe('half_open');
    await expect(breaker.run(ok)).resolves.toBe('ok');
    expect(breaker.status).toBe('closed');
  });

  it('re-opens when the trial call fails, and admits only one trial at a time', async () => {
    let now = 0;
    const breaker = new CircuitBreaker('svc', { failureThreshold: 1, resetTimeoutMs: 1000, now: () => now });
    await expect(breaker.run(fail)).rejects.toThrow();
    now = 1000;
    let release!: () => void;
    const slow = breaker.run(() => new Promise<string>((_, reject) => (release = () => reject(new Error('still down')))));
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await expect(slow).rejects.toThrow('still down');
    expect(breaker.status).toBe('open');
  });
});

describe('Bulkhead', () => {
  it('rejects calls beyond the concurrency limit and frees capacity afterwards', async () => {
    const bulkhead = new Bulkhead('svc', 2);
    const releases: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => releases.push(resolve));
    const a = bulkhead.run(hold);
    const b = bulkhead.run(hold);
    await expect(bulkhead.run(ok)).rejects.toBeInstanceOf(BulkheadFullError);
    expect(bulkhead.active).toBe(2);
    releases.forEach((r) => r());
    await Promise.all([a, b]);
    await expect(bulkhead.run(ok)).resolves.toBe('ok');
  });

  it('frees capacity when a call fails', async () => {
    const bulkhead = new Bulkhead('svc', 1);
    await expect(bulkhead.run(fail)).rejects.toThrow();
    expect(bulkhead.active).toBe(0);
  });
});

describe('retry', () => {
  const noSleep = () => Promise.resolve();

  it('retries up to the attempt limit and then gives up (no infinite retries)', async () => {
    const fn = vi.fn(fail);
    await expect(retry(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns as soon as an attempt succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('ok');
    await expect(retry(fn, { attempts: 5, sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry errors marked non-retryable, nor an open circuit', async () => {
    const fn = vi.fn(fail);
    await expect(retry(fn, { attempts: 5, sleep: noSleep, retryable: () => false })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    const open = vi.fn(() => Promise.reject(new CircuitOpenError('svc')));
    await expect(retry(open, { attempts: 5, sleep: noSleep })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('withTimeout', () => {
  it('rejects with TimeoutError and aborts the operation', async () => {
    let aborted = false;
    const slow = (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => (aborted = true));
        setTimeout(() => resolve('late'), 500);
      });
    await expect(withTimeout(slow, 20)).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });

  it('passes the result through when the operation is fast enough', async () => {
    await expect(withTimeout(() => Promise.resolve(42), 1000)).resolves.toBe(42);
  });
});
