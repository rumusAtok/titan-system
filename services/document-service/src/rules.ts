/** Pure document rules (no I/O). */

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export interface RetentionClass {
  key: string;
  name: string;
  /** Years after which the document may be disposed of; null = keep permanently. */
  years: number | null;
}

/**
 * Retention classes. The periods are illustrative defaults for a demonstration,
 * not legal advice: an organisation sets them from its own records schedule.
 */
export const RETENTION_CLASSES: readonly RetentionClass[] = [
  { key: 'transitory', name: 'Transitory (may be disposed of when no longer needed)', years: 0 },
  { key: 'operational-3y', name: 'Operational record, 3 years', years: 3 },
  { key: 'regulatory-7y', name: 'Regulatory record, 7 years', years: 7 },
  { key: 'permanent', name: 'Permanent', years: null },
];

export function retentionClass(key: string): RetentionClass | undefined {
  return RETENTION_CLASSES.find((r) => r.key === key);
}

/** Earliest disposal date (YYYY-MM-DD) for a record kept from `from`; null = never. */
export function retainUntil(key: string, from: Date): string | null {
  const rc = retentionClass(key);
  if (!rc || rc.years === null) return null;
  const d = new Date(Date.UTC(from.getUTCFullYear() + rc.years, from.getUTCMonth(), from.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

export type DisposalBlock = 'legal_hold' | 'retention_not_expired' | 'permanent' | 'already_disposed' | null;

/** Why a document may not be disposed of today, or null when it may. */
export function disposalBlock(doc: { status: string; legal_hold: boolean; retention_class: string; retain_until: string | null }, today: Date): DisposalBlock {
  if (doc.status === 'disposed') return 'already_disposed';
  if (doc.legal_hold) return 'legal_hold';
  if (retentionClass(doc.retention_class)?.years === null) return 'permanent';
  if (doc.retain_until && doc.retain_until > today.toISOString().slice(0, 10)) return 'retention_not_expired';
  return null;
}

// --- content checks ------------------------------------------------------------

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'text/plain': (b) => !b.includes(0),
  'text/csv': (b) => !b.includes(0),
};

export const ALLOWED_CONTENT_TYPES = Object.keys(SIGNATURES);

// The industry-standard anti-malware TEST string (EICAR). It is harmless; every scanner
// reports it, which makes it the conventional way to prove a scanning hook works.
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export type ScanResult = { ok: true; result: string } | { ok: false; reason: string };

/**
 * The scanning hook. This build checks size, declared type against the content's
 * signature, and the EICAR test signature. A deployment plugs a real scanner in here.
 */
export function scanContent(contentType: string, content: Buffer): ScanResult {
  if (content.length === 0) return { ok: false, reason: 'file is empty' };
  if (content.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: `file exceeds ${MAX_DOCUMENT_BYTES} bytes` };
  const matches = SIGNATURES[contentType];
  if (!matches) return { ok: false, reason: `content type '${contentType}' is not allowed` };
  if (!matches(content)) return { ok: false, reason: 'file content does not match its declared type' };
  if (content.includes(Buffer.from(EICAR, 'latin1'))) return { ok: false, reason: 'malware signature detected (EICAR test file)' };
  return { ok: true, result: 'clean: type signature and malware test signature checked' };
}

export function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || 'document';
}

// --- access --------------------------------------------------------------------

export interface Reader {
  roles: string[];
  staff: boolean;
}

/** Records managers and tenant administrators read everything of their tenant. */
export const RECORDS_ROLES = ['records_manager', 'tenant_admin'];

export function canRead(doc: { classification: string; allowed_roles: string[] }, reader: Reader): boolean {
  if (reader.roles.some((r) => RECORDS_ROLES.includes(r))) return true;
  if (doc.classification === 'public') return true;
  if (!reader.staff) return false;
  if (doc.classification === 'internal') return true;
  return doc.allowed_roles.some((r) => reader.roles.includes(r));
}
