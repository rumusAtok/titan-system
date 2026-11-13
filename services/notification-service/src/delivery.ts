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

export function createEmailAdapter(kind: string | undefined, logger: Logger): EmailAdapter {
  switch (kind ?? 'log') {
    case 'log':
      return new LogEmailAdapter(logger);
    default:
      // A real SMTP/API adapter is intentionally not wired up: sending real
      // external mail needs explicit authorisation and credentials.
      throw new Error(`unsupported EMAIL_ADAPTER '${kind}' (available: log)`);
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
