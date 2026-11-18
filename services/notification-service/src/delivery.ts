import type { Logger } from '@titan/observability';

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  notificationId: string;
}

export interface EmailAdapter {
  readonly name: string;
  /** Resolves when the message was handed over; rejects on a delivery failure. */
  send(message: OutboundEmail): Promise<void>;
}

/**
 * Development adapter: records the message in the service log instead of
 * sending it. Nothing leaves the machine.
 *
 * Addresses in the reserved `fail.titan.example` domain simulate a transport
 * failure, so retry scheduling can be exercised without a mail server.
 */
export class LogEmailAdapter implements EmailAdapter {
  readonly name = 'log';

  constructor(private readonly logger: Logger) {}

  async send(message: OutboundEmail): Promise<void> {
    if (message.to.toLowerCase().endsWith('@fail.titan.example')) {
      throw new Error('simulated transport failure (reserved test domain)');
    }
    this.logger.info({ notification_id: message.notificationId, to: message.to, subject: message.subject }, 'email recorded by log adapter (not sent)');
  }
}

/** Hosts the mail-catcher adapter may connect to. A local catcher only, never a real relay. */
export const MAIL_CATCHER_HOSTS = ['mailpit', 'localhost', '127.0.0.1'];

/** Minimal SMTP dialogue (RFC 5321) for a local mail catcher: no TLS, no authentication. */
export async function smtpSend(opts: { host: string; port: number; from: string; to: string; subject: string; body: string; timeoutMs?: number }): Promise<void> {
  const { connect } = await import('node:net');
  const socket = connect({ host: opts.host, port: opts.port });
  socket.setEncoding('utf8');
  socket.setTimeout(opts.timeoutMs ?? 10_000);
  let buffer = '';
  const waiters: ((line: string) => void)[] = [];
  const failures: ((err: Error) => void)[] = [];
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    // A reply ends with a line whose 4th character is a space ("250 ok"); "250-..." lines continue it.
    let m: RegExpExecArray | null;
    while ((m = /^(\d{3}) [^\r\n]*\r?\n/m.exec(buffer))) {
      const end = m.index + m[0].length;
      const reply = buffer.slice(0, end);
      buffer = buffer.slice(end);
      waiters.shift()?.(reply);
    }
  });
  const fail = (err: Error) => failures.forEach((f) => f(err));
  socket.on('error', fail);
  socket.on('timeout', () => {
    fail(new Error('SMTP timeout'));
    socket.destroy();
  });
  const reply = () =>
    new Promise<string>((resolve, reject) => {
      waiters.push(resolve);
      failures.push(reject);
    });
  const expect = async (code: string, send?: string) => {
    const pending = reply();
    if (send !== undefined) socket.write(`${send}\r\n`);
    const r = await pending;
    if (!r.startsWith(code)) throw new Error(`SMTP: expected ${code}, got ${r.trim()}`);
  };
  const header = (s: string) => s.replace(/[\r\n]+/g, ' ');
  try {
    await expect('220');
    await expect('250', 'EHLO titan.local');
    await expect('250', `MAIL FROM:<${opts.from}>`);
    await expect('250', `RCPT TO:<${opts.to}>`);
    await expect('354', 'DATA');
    const body = opts.body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const message = [
      `From: TITAN <${opts.from}>`,
      `To: <${opts.to}>`,
      `Subject: ${header(opts.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
      '.',
    ].join('\r\n');
    await expect('250', message);
    await expect('221', 'QUIT').catch(() => undefined);
  } finally {
    socket.end();
  }
}

/**
 * Development adapter that really speaks SMTP, but only to a local mail catcher (Mailpit):
 * messages can be read in the catcher's web inbox and never leave the machine.
 */
export class MailCatcherAdapter implements EmailAdapter {
  readonly name = 'mailpit';

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly from: string,
  ) {
    if (!MAIL_CATCHER_HOSTS.includes(host)) throw new Error(`MAIL_CATCHER_HOST '${host}' is not a local mail catcher (allowed: ${MAIL_CATCHER_HOSTS.join(', ')})`);
  }

  async send(message: OutboundEmail): Promise<void> {
    if (message.to.toLowerCase().endsWith('@fail.titan.example')) throw new Error('simulated transport failure (reserved test domain)');
    await smtpSend({ host: this.host, port: this.port, from: this.from, to: message.to, subject: message.subject, body: `${message.body}\n\n-- \nTITAN development release (notification ${message.notificationId})` });
  }
}

export function createEmailAdapter(kind: string | undefined, logger: Logger, env: NodeJS.ProcessEnv = process.env): EmailAdapter {
  switch (kind ?? 'log') {
    case 'log':
      return new LogEmailAdapter(logger);
    case 'mailpit':
      return new MailCatcherAdapter(env.MAIL_CATCHER_HOST ?? 'mailpit', Number(env.MAIL_CATCHER_PORT ?? 1025), env.MAIL_FROM ?? 'no-reply@titan.example');
    default:
      // A real SMTP/API adapter is intentionally not wired up: sending real
      // external mail needs explicit authorisation and credentials.
      throw new Error(`unsupported EMAIL_ADAPTER '${kind}' (available: log, mailpit)`);
  }
}

/** Delay before delivery attempt `attempts + 1`: 30s, 60s, 120s ... capped at 15 minutes. */
export function retryDelayMs(attempts: number, baseMs = 30_000, capMs = 15 * 60_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

export type DeliveryOutcome = { status: 'sent' } | { status: 'pending'; retryInMs: number } | { status: 'failed' };

/** Decides what happens after a delivery attempt. `attempts` already includes the one just made. */
export function afterAttempt(succeeded: boolean, attempts: number, maxAttempts: number, baseMs?: number): DeliveryOutcome {
  if (succeeded) return { status: 'sent' };
  if (attempts >= maxAttempts) return { status: 'failed' };
  return { status: 'pending', retryInMs: retryDelayMs(attempts, baseMs) };
}
