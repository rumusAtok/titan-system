import { createLogger } from '@titan/observability';
import { describe, expect, it } from 'vitest';
import { afterAttempt, createEmailAdapter, LogEmailAdapter, retryDelayMs } from './delivery.js';

describe('retry scheduling', () => {
  it('backs off exponentially and caps the delay', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(20)).toBe(15 * 60_000);
  });

  it('marks a successful attempt as sent', () => {
    expect(afterAttempt(true, 1, 5)).toEqual({ status: 'sent' });
  });

  it('schedules another attempt while attempts remain', () => {
    expect(afterAttempt(false, 1, 5)).toEqual({ status: 'pending', retryInMs: 30_000 });
    expect(afterAttempt(false, 4, 5)).toEqual({ status: 'pending', retryInMs: 240_000 });
  });

  it('gives up after the last attempt (bounded retries)', () => {
    expect(afterAttempt(false, 5, 5)).toEqual({ status: 'failed' });
    expect(afterAttempt(false, 6, 5)).toEqual({ status: 'failed' });
  });
});

describe('email adapters', () => {
  const logger = createLogger('test');
  logger.level = 'silent';

  it('the log adapter accepts normal addresses without sending anything', async () => {
    await expect(new LogEmailAdapter(logger).send({ to: 'alice@titan.example', subject: 's', body: 'b', notificationId: 'n' })).resolves.toBeUndefined();
  });

  it('the reserved failure domain simulates a transport error', async () => {
    await expect(new LogEmailAdapter(logger).send({ to: 'x@fail.titan.example', subject: 's', body: 'b', notificationId: 'n' })).rejects.toThrow(/simulated/);
  });

  it('refuses to start with an adapter that would send real mail', () => {
    expect(() => createEmailAdapter('smtp', logger)).toThrow(/unsupported/);
    expect(createEmailAdapter(undefined, logger).name).toBe('log');
  });
});
