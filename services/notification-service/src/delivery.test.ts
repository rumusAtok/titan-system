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

  it('the mail-catcher adapter connects only to a local catcher', () => {
    expect(createEmailAdapter('mailpit', logger, {}).name).toBe('mailpit');
    expect(() => createEmailAdapter('mailpit', logger, { MAIL_CATCHER_HOST: 'smtp.gmail.com' })).toThrow(/not a local mail catcher/);
    expect(() => createEmailAdapter('mailpit', logger, { MAIL_CATCHER_HOST: 'relay.example.org' })).toThrow(/not a local mail catcher/);
  });

  it('speaks SMTP to a local server: envelope, headers and dot-stuffed body', async () => {
    const { createServer } = await import('node:net');
    const { smtpSend } = await import('./delivery.js');
    const seen: string[] = [];
    let data = '';
    const server = createServer((s) => {
      s.setEncoding('utf8');
      let inData = false;
      s.write('220 test\r\n');
      s.on('data', (chunk: string) => {
        if (inData) {
          data += chunk;
          if (data.endsWith('\r\n.\r\n')) {
            inData = false;
            s.write('250 queued\r\n');
          }
          return;
        }
        for (const line of chunk.split('\r\n').filter(Boolean)) {
          seen.push(line);
          if (line.startsWith('EHLO')) s.write('250-test\r\n250 OK\r\n');
          else if (line === 'DATA') {
            inData = true;
            s.write('354 go\r\n');
          } else if (line === 'QUIT') s.end('221 bye\r\n');
          else s.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    await smtpSend({ host: '127.0.0.1', port, from: 'no-reply@titan.example', to: 'alice@titan.example', subject: 'Line\r\nBcc: x', body: 'Hello\n.hidden\nend' });
    server.close();
    expect(seen).toContain('MAIL FROM:<no-reply@titan.example>');
    expect(seen).toContain('RCPT TO:<alice@titan.example>');
    expect(data).toContain('Subject: Line Bcc: x');
    expect(data).not.toMatch(/^Bcc:/m);
    expect(data).toContain('\r\n..hidden\r\n');
  });
});
