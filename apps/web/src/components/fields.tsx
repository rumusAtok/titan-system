'use client';

import { titleCase } from '@/lib/format';
import { Field, inputClass } from './ui';

export interface FieldSpec {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'boolean' | 'email';
  required?: boolean;
  options?: string[];
  unit?: string;
  min?: number;
  max?: number;
}

/** Inputs for a category's attribute schema; the server validates the same schema again. */
export function SchemaFields({ fields, values, onChange }: { fields: FieldSpec[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const set = (name: string, value: unknown) => onChange({ ...values, [name]: value });
  return (
    <>
      {fields.map((f) => (
        <Field key={f.name} label={`${f.label}${f.unit ? ` (${f.unit})` : ''}`} required={f.required}>
          {(props) =>
            f.type === 'boolean' ? (
              <input {...props} type="checkbox" checked={values[f.name] === true} onChange={(e) => set(f.name, e.target.checked)} />
            ) : f.type === 'select' ? (
              <select {...props} className={inputClass} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value || undefined)}>
                <option value="">—</option>
                {f.options?.map((o) => (
                  <option key={o} value={o}>{titleCase(o)}</option>
                ))}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea {...props} className={inputClass} rows={3} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value || undefined)} />
            ) : (
              <input
                {...props}
                className={inputClass}
                type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                min={f.min}
                max={f.max}
                value={values[f.name] === undefined ? '' : String(values[f.name])}
                onChange={(e) => set(f.name, e.target.value === '' ? undefined : f.type === 'number' ? Number(e.target.value) : e.target.value)}
              />
            )
          }
        </Field>
      ))}
    </>
  );
}
