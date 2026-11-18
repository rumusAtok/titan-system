/** Pure integration rules: webhook signatures, secret sealing, destination allow-list, retry schedule. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Accepted clock difference between a sender's timestamp and ours. */
export const MAX_SKEW_SECONDS = 300;

/**
 * Signature of a webhook: HMAC-SHA256 over "<unix seconds>.<raw body>", hex, prefixed "sha256=".
 * The same scheme is used inbound (we verify) and outbound (we sign).
 */
export function sign(secret: string, timestamp: number | string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifySignature(secret: string, headers: { signature?: string; timestamp?: string }, body: Buffer, nowSeconds = Math.floor(Date.now() / 1000)): VerifyResult {
  if (!headers.signature || !headers.timestamp) return { ok: false, reason: 'missing signature or timestamp header' };
  if (!/^\d{9,11}$/.test(headers.timestamp)) return { ok: false, reason: 'malformed timestamp' };
  if (Math.abs(nowSeconds - Number(headers.timestamp)) > MAX_SKEW_SECONDS) return { ok: false, reason: 'timestamp outside the accepted window' };
  const expected = Buffer.from(sign(secret, headers.timestamp, body));
  const given = Buffer.from(headers.signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature does not match' };
  return { ok: true };
}

export function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * Webhook secrets are stored sealed (AES-256-GCM) with a key from the environment, so a copy of
 * the database alone does not reveal them. The key itself is a deployment secret.
 */
export function sealer(key: string) {
  if (!key || key.length < 16) throw new Error('INTEGRATION_SECRET_KEY must be set (at least 16 characters)');
  const k = createHash('sha256').update(key).digest();
  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', k, iv);
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
    },
    open(sealed: string): string {
      const [v, iv, tag, data] = sealed.split('.');
      if (v !== 'v1' || !iv || !tag || !data) throw new Error('unrecognised sealed secret');
      const d = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
    },
  };
}

/** Hosts outbound webhooks may go to. Anything else is refused, at subscription time and again at delivery. */
export function parseAllowList(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
}

export type DestinationCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkDestination(raw: string, allowed: Set<string>): DestinationCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'only http and https destinations are supported' };
  if (url.username || url.password) return { ok: false, reason: 'credentials in the URL are not allowed; the request is signed instead' };
  if (!allowed.has(url.hostname.toLowerCase())) return { ok: false, reason: `host '${url.hostname}' is not on the destination allow-list` };
  return { ok: true, url };
}

/** Delay before attempt n+1 after n failed attempts; null when no attempt remains. */
export const RETRY_DELAYS_SECONDS = [5, 30, 120, 600, 1800];
export function retryDelay(failedAttempts: number): number | null {
  return RETRY_DELAYS_SECONDS[failedAttempts - 1] ?? null;
}

/** 2xx is delivered; 408, 425, 429 and 5xx are worth retrying; any other answer is final. */
export function classifyStatus(status: number): 'delivered' | 'retry' | 'rejected' {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry';
  return 'rejected';
}
