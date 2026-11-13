import { z } from 'zod';

/** One input of a configurable application form. */
export const FormField = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  label: z.string().min(1).max(200),
  type: z.enum(['text', 'textarea', 'number', 'date', 'select', 'boolean', 'email']),
  required: z.boolean().default(false),
  min: z.number().optional(),
  max: z.number().optional(),
  max_length: z.number().int().positive().max(10_000).optional(),
  options: z.array(z.string().min(1)).min(1).optional(),
  help: z.string().max(500).optional(),
});
export type FormField = z.infer<typeof FormField>;

export const FormFields = z
  .array(FormField)
  .min(1)
  .max(100)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      if (seen.has(f.name)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `duplicate field name '${f.name}'` });
      seen.add(f.name);
      if (f.type === 'select' && !f.options) ctx.addIssue({ code: 'custom', path: [i, 'options'], message: 'select fields need options' });
    });
  });

export interface FieldError {
  field: string;
  message: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Validates submitted form data against the form definition.
 * `partial` (drafts) skips the required-field check but still rejects
 * unknown fields and wrongly typed values.
 */
export function validateFormData(fields: FormField[], data: Record<string, unknown>, options: { partial?: boolean } = {}): FieldError[] {
  const errors: FieldError[] = [];
  const byName = new Map(fields.map((f) => [f.name, f]));

  for (const key of Object.keys(data)) {
    if (!byName.has(key)) errors.push({ field: key, message: 'unknown field' });
  }

  for (const field of fields) {
    const value = data[field.name];
    if (isEmpty(value)) {
      if (field.required && !options.partial) errors.push({ field: field.name, message: 'is required' });
      continue;
    }
    switch (field.type) {
      case 'text':
      case 'textarea': {
        if (typeof value !== 'string') {
          errors.push({ field: field.name, message: 'must be text' });
          break;
        }
        const limit = field.max_length ?? (field.type === 'text' ? 500 : 10_000);
        if (value.length > limit) errors.push({ field: field.name, message: `must be at most ${limit} characters` });
        break;
      }
      case 'email':
        if (typeof value !== 'string' || !EMAIL.test(value) || value.length > 254) errors.push({ field: field.name, message: 'must be an e-mail address' });
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push({ field: field.name, message: 'must be a number' });
          break;
        }
        if (field.min !== undefined && value < field.min) errors.push({ field: field.name, message: `must be at least ${field.min}` });
        if (field.max !== undefined && value > field.max) errors.push({ field: field.name, message: `must be at most ${field.max}` });
        break;
      case 'date':
        if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
          errors.push({ field: field.name, message: 'must be a date (YYYY-MM-DD)' });
        }
        break;
      case 'select':
        if (typeof value !== 'string' || !field.options?.includes(value)) errors.push({ field: field.name, message: 'must be one of the listed options' });
        break;
      case 'boolean':
        if (typeof value !== 'boolean') errors.push({ field: field.name, message: 'must be true or false' });
        break;
    }
  }
  return errors;
}

// --- attachments -------------------------------------------------------------

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  // Plain text: reject content with NUL bytes (binary disguised as text).
  'text/plain': (b) => !b.includes(0),
};

export const ALLOWED_ATTACHMENT_TYPES = Object.keys(SIGNATURES);

/** Returns a reason when the upload must be refused, otherwise null. */
export function checkAttachment(contentType: string, content: Buffer): string | null {
  if (content.length === 0) return 'file is empty';
  if (content.length > MAX_ATTACHMENT_BYTES) return `file exceeds ${MAX_ATTACHMENT_BYTES} bytes`;
  const matches = SIGNATURES[contentType];
  if (!matches) return `content type '${contentType}' is not allowed`;
  if (!matches(content)) return 'file content does not match its declared type';
  return null;
}

/** Strips path components and characters that are unsafe in a file name or header. */
export function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'attachment';
}
