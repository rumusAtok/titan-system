import { describe, expect, it } from 'vitest';
import { canRead, disposalBlock, retainUntil, sanitizeFilename, scanContent } from './rules.js';

const pdf = Buffer.from('%PDF-1.7\nsynthetic');

describe('scanContent', () => {
  it('accepts content whose signature matches its declared type', () => {
    expect(scanContent('application/pdf', pdf).ok).toBe(true);
    expect(scanContent('text/plain', Buffer.from('hello')).ok).toBe(true);
  });

  it('refuses mismatched, unknown, empty and oversized content', () => {
    expect(scanContent('application/pdf', Buffer.from('not a pdf')).ok).toBe(false);
    expect(scanContent('application/x-msdownload', Buffer.from('MZ')).ok).toBe(false);
    expect(scanContent('text/plain', Buffer.alloc(0)).ok).toBe(false);
    expect(scanContent('text/plain', Buffer.alloc(6 * 1024 * 1024, 65)).ok).toBe(false);
    expect(scanContent('text/plain', Buffer.from([65, 0, 66])).ok).toBe(false);
  });

  it('detects the EICAR anti-malware test signature', () => {
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const result = scanContent('text/plain', Buffer.from(`notes\n${eicar}\n`, 'latin1'));
    expect(result).toEqual({ ok: false, reason: 'malware signature detected (EICAR test file)' });
  });
});

describe('retention', () => {
  it('computes the earliest disposal date from the class', () => {
    expect(retainUntil('operational-3y', new Date('2026-11-17T10:00:00Z'))).toBe('2029-11-17');
    expect(retainUntil('transitory', new Date('2026-11-17T10:00:00Z'))).toBe('2026-11-17');
    expect(retainUntil('permanent', new Date())).toBeNull();
  });

  it('blocks disposal under legal hold, before expiry, for permanent records and twice', () => {
    const today = new Date('2026-11-17T00:00:00Z');
    const base = { status: 'active', legal_hold: false, retention_class: 'operational-3y', retain_until: '2026-11-17' };
    expect(disposalBlock(base, today)).toBeNull();
    expect(disposalBlock({ ...base, legal_hold: true }, today)).toBe('legal_hold');
    expect(disposalBlock({ ...base, retain_until: '2029-11-17' }, today)).toBe('retention_not_expired');
    expect(disposalBlock({ ...base, retention_class: 'permanent', retain_until: null }, today)).toBe('permanent');
    expect(disposalBlock({ ...base, status: 'disposed' }, today)).toBe('already_disposed');
  });
});

describe('access', () => {
  const staff = { roles: ['maintenance_technician'], staff: true };
  const occupant = { roles: ['service_requester'], staff: false };
  it('lets everyone in the tenant read public documents, only staff internal ones', () => {
    expect(canRead({ classification: 'public', allowed_roles: [] }, occupant)).toBe(true);
    expect(canRead({ classification: 'internal', allowed_roles: [] }, occupant)).toBe(false);
    expect(canRead({ classification: 'internal', allowed_roles: [] }, staff)).toBe(true);
  });

  it('restricts restricted documents to their roles, records managers and administrators', () => {
    const doc = { classification: 'restricted', allowed_roles: ['facility_manager'] };
    expect(canRead(doc, staff)).toBe(false);
    expect(canRead(doc, { roles: ['facility_manager'], staff: true })).toBe(true);
    expect(canRead(doc, { roles: ['records_manager'], staff: true })).toBe(true);
  });
});

describe('sanitizeFilename', () => {
  it('strips paths and unsafe characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\x\\Plan "A".pdf')).toBe('Plan _A_.pdf');
    expect(sanitizeFilename('...')).toBe('document');
  });
});
