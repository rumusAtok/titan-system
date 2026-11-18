import { describe, expect, it } from 'vitest';
import { checkDestination, classifyStatus, newSecret, parseAllowList, retryDelay, sealer, sign, verifySignature } from './rules.js';

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = Buffer.from('{"title":"Pump trip"}');
  const now = 1_800_000_000;

  it('accepts a correctly signed, recent request', () => {
    expect(verifySignature(secret, { signature: sign(secret, now, body), timestamp: String(now) }, body, now + 10)).toEqual({ ok: true });
  });

  it('refuses a wrong secret, a changed body, or a missing header', () => {
    expect(verifySignature(secret, { signature: sign('other', now, body), timestamp: String(now) }, body, now).ok).toBe(false);
    expect(verifySignature(secret, { signature: sign(secret, now, body), timestamp: String(now) }, Buffer.from('{"title":"x"}'), now).ok).toBe(false);
    expect(verifySignature(secret, { timestamp: String(now) }, body, now).ok).toBe(false);
  });

  it('refuses replays outside the time window, and a timestamp not covered by the signature', () => {
    expect(verifySignature(secret, { signature: sign(secret, now, body), timestamp: String(now) }, body, now + 301)).toEqual({ ok: false, reason: 'timestamp outside the accepted window' });
    expect(verifySignature(secret, { signature: sign(secret, now, body), timestamp: String(now + 5) }, body, now).ok).toBe(false);
    expect(verifySignature(secret, { signature: sign(secret, now, body), timestamp: 'abc' }, body, now).ok).toBe(false);
  });

  it('generates distinct secrets', () => {
    expect(newSecret()).not.toBe(newSecret());
    expect(newSecret()).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  });
});

describe('sealed secrets', () => {
  it('round-trips and detects tampering or a different key', () => {
    const a = sealer('development-only-key-1234');
    const sealed = a.seal('whsec_abc');
    expect(sealed).not.toContain('whsec_abc');
    expect(a.open(sealed)).toBe('whsec_abc');
    expect(() => sealer('another-key-entirely-5678').open(sealed)).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => a.open(parts.join('.'))).toThrow();
  });

  it('requires a key', () => {
    expect(() => sealer('')).toThrow();
  });
});

describe('destination allow-list', () => {
  const allowed = parseAllowList(' webhook-sink, hooks.example.test ');

  it('accepts listed hosts only', () => {
    expect(checkDestination('http://webhook-sink:8080/in', allowed).ok).toBe(true);
    expect(checkDestination('https://hooks.example.test/x', allowed).ok).toBe(true);
    expect(checkDestination('https://evil.example/x', allowed).ok).toBe(false);
    expect(checkDestination('http://169.254.169.254/latest/meta-data', allowed).ok).toBe(false);
  });

  it('refuses other schemes, credentials and garbage', () => {
    expect(checkDestination('file:///etc/passwd', allowed).ok).toBe(false);
    expect(checkDestination('http://user:pw@webhook-sink/x', allowed).ok).toBe(false);
    expect(checkDestination('not a url', allowed).ok).toBe(false);
  });

  it('is empty when nothing is configured', () => {
    expect(parseAllowList(undefined).size).toBe(0);
  });
});

describe('delivery outcome', () => {
  it('classifies answers', () => {
    expect(classifyStatus(204)).toBe('delivered');
    expect(classifyStatus(503)).toBe('retry');
    expect(classifyStatus(429)).toBe('retry');
    expect(classifyStatus(400)).toBe('rejected');
    expect(classifyStatus(301)).toBe('rejected');
  });

  it('backs off, then gives up', () => {
    expect(retryDelay(1)).toBe(5);
    expect(retryDelay(5)).toBe(1800);
    expect(retryDelay(6)).toBeNull();
  });
});
