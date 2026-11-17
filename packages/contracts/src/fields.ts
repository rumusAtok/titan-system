import { z } from 'zod';

/**
 * Declarative field specification shared by everything that is configured
 * rather than coded: asset attribute schemas, pack configuration, request
 * details. It describes data; it is never executed.
 */
export const FieldSpec = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  label: z.string().min(1).max(200),
  type: z.enum(['text', 'textarea', 'number', 'date', 'select', 'boolean', 'email']),
  required: z.boolean().default(false),
  min: z.number().optional(),
  max: z.number().optional(),
  max_length: z.number().int().positive().max(10_000).optional(),
  options: z.array(z.string().min(1)).min(1).optional(),
  unit: z.string().max(16).optional(),
  help: z.string().max(500).optional(),
});
export type FieldSpec = z.infer<typeof FieldSpec>;

export const FieldSpecs = z
  .array(FieldSpec)
  .max(100)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      if (seen.has(f.name)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `duplicate field name '${f.name}'` });
      seen.add(f.name);
      if (f.type === 'select' && !f.options) ctx.addIssue({ code: 'custom', path: [i, 'options'], message: 'select fields need options' });
    });
  });

export interface FieldIssue {
  field: string;
  message: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

export interface ValidateOptions {
  /** Skip the required-field check (drafts, partial updates). */
  partial?: boolean;
  /** Accept keys the schema does not describe (schemas that only constrain known attributes). */
  allowUnknown?: boolean;
}

/** Validates a record of values against field specifications. Returns one issue per problem. */
export function validateFieldValues(fields: readonly FieldSpec[], data: Record<string, unknown>, options: ValidateOptions = {}): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const byName = new Map(fields.map((f) => [f.name, f]));

  if (!options.allowUnknown) {
    for (const key of Object.keys(data)) {
      if (!byName.has(key)) issues.push({ field: key, message: 'unknown field' });
    }
  }

  for (const field of fields) {
    const value = data[field.name];
    if (isEmpty(value)) {
      if (field.required && !options.partial) issues.push({ field: field.name, message: 'is required' });
      continue;
    }
    switch (field.type) {
      case 'text':
      case 'textarea': {
        if (typeof value !== 'string') {
          issues.push({ field: field.name, message: 'must be text' });
          break;
        }
        const limit = field.max_length ?? (field.type === 'text' ? 500 : 10_000);
        if (value.length > limit) issues.push({ field: field.name, message: `must be at most ${limit} characters` });
        break;
      }
      case 'email':
        if (typeof value !== 'string' || !EMAIL.test(value) || value.length > 254) issues.push({ field: field.name, message: 'must be an e-mail address' });
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          issues.push({ field: field.name, message: 'must be a number' });
          break;
        }
        if (field.min !== undefined && value < field.min) issues.push({ field: field.name, message: `must be at least ${field.min}` });
        if (field.max !== undefined && value > field.max) issues.push({ field: field.name, message: `must be at most ${field.max}` });
        break;
      case 'date':
        if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
          issues.push({ field: field.name, message: 'must be a date (YYYY-MM-DD)' });
        }
        break;
      case 'select':
        if (typeof value !== 'string' || !field.options?.includes(value)) issues.push({ field: field.name, message: 'must be one of the listed options' });
        break;
      case 'boolean':
        if (typeof value !== 'boolean') issues.push({ field: field.name, message: 'must be true or false' });
        break;
    }
  }
  return issues;
}
