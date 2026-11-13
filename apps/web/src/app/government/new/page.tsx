'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Card, Field, InlineError, PageHeader, QueryView, inputClass } from '@/components/ui';
import { api } from '@/lib/api';

interface FormField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'boolean' | 'email';
  required?: boolean;
  min?: number;
  max?: number;
  max_length?: number;
  options?: string[];
  help?: string;
}

interface FormDefinition {
  id: string;
  key: string;
  title: string;
  description: string;
  fields: FormField[];
}

/** Converts the inputs to the typed values the form definition expects; empty inputs are left out. */
function toData(fields: FormField[], values: Record<string, string | boolean>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.type === 'boolean') {
      if (v === true) data[f.name] = true;
    } else if (typeof v === 'string' && v.trim() !== '') {
      data[f.name] = f.type === 'number' ? Number(v) : v.trim();
    }
  }
  return data;
}

export default function NewApplicationPage() {
  const router = useRouter();
  const client = useQueryClient();
  const forms = useQuery({ queryKey: ['forms'], queryFn: () => api<FormDefinition[]>('/api/case/forms') });
  const [formKey, setFormKey] = useState('');
  const [title, setTitle] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const form = forms.data?.find((f) => f.key === formKey);

  useEffect(() => {
    if (!formKey && forms.data?.length) setFormKey(forms.data[0]!.key);
  }, [forms.data, formKey]);

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const draft = await api('/api/case/cases', { method: 'POST', body: { form_key: formKey, title: title.trim(), data: toData(form!.fields, values) } });
      // Saving and submitting are separate steps on the server: if submission is
      // refused (e.g. a required field is missing) the draft is kept.
      if (!submit) return { id: draft.id, submitted: false, error: null as unknown };
      try {
        await api(`/api/case/cases/${draft.id}/submit`, { method: 'POST' });
        return { id: draft.id, submitted: true, error: null as unknown };
      } catch (error) {
        return { id: draft.id, submitted: false, error };
      }
    },
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['cases'] });
      if (!result.error) router.push(`/government/case/?id=${result.id}`);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate(true);
  }

  const keptDraft = save.data?.error ? save.data : null;

  return (
    <>
      <PageHeader title="New application" description="Choose a form, fill it in, then save it as a draft or submit it for review." />
      <QueryView query={forms} what="The list of forms" isEmpty={(d) => d.length === 0} empty={<Card><p className="text-sm text-ink-muted">No application forms have been published for your organisation.</p></Card>}>
        {(list) => (
          <form onSubmit={onSubmit} className="max-w-3xl space-y-6" noValidate={false}>
            <Card title="Application">
              <div className="space-y-4">
                <Field label="Form" required>
                  {(props) => (
                    <select {...props} value={formKey} onChange={(e) => { setFormKey(e.target.value); setValues({}); }} className={inputClass}>
                      {list.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.title}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {form?.description && <p className="text-sm text-ink-muted">{form.description}</p>}
                <Field label="Title" required hint="A short name for this application, for example the address or event name.">
                  {(props) => <input {...props} type="text" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} className={inputClass} />}
                </Field>
              </div>
            </Card>

            {form && (
              <Card title={form.title}>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {form.fields.map((f) => {
                    const set = (v: string | boolean) => setValues((prev) => ({ ...prev, [f.name]: v }));
                    const value = values[f.name];
                    if (f.type === 'boolean') {
                      return (
                        <div key={f.name} className="sm:col-span-2">
                          <label className="flex items-start gap-2 text-sm text-ink">
                            <input type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} required={f.required} className="mt-0.5" />
                            <span>
                              {f.label}
                              {f.required && <span className="text-red-700" aria-hidden="true"> *</span>}
                            </span>
                          </label>
                        </div>
                      );
                    }
                    return (
                      <div key={f.name} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                        <Field label={f.label} required={f.required} hint={f.help}>
                          {(props) =>
                            f.type === 'textarea' ? (
                              <textarea {...props} rows={3} value={(value as string) ?? ''} onChange={(e) => set(e.target.value)} maxLength={f.max_length ?? 10000} className={inputClass} />
                            ) : f.type === 'select' ? (
                              <select {...props} value={(value as string) ?? ''} onChange={(e) => set(e.target.value)} className={inputClass}>
                                <option value="">Select…</option>
                                {f.options?.map((o) => (
                                  <option key={o} value={o}>
                                    {o.replace(/^\w/, (c) => c.toUpperCase())}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                {...props}
                                type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'}
                                value={(value as string) ?? ''}
                                onChange={(e) => set(e.target.value)}
                                min={f.min}
                                max={f.max}
                                step={f.type === 'number' ? 'any' : undefined}
                                maxLength={f.type === 'text' ? (f.max_length ?? 500) : undefined}
                                className={inputClass}
                              />
                            )
                          }
                        </Field>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            <InlineError error={save.error ?? keptDraft?.error} />
            {keptDraft && (
              <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Your entries were saved as a draft, but it could not be submitted.{' '}
                <button type="button" className="font-medium underline" onClick={() => router.push(`/government/case/?id=${keptDraft.id}`)}>
                  Open the draft
                </button>{' '}
                to complete it.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" disabled={save.isPending || !form || !!keptDraft}>
                {save.isPending ? 'Saving…' : 'Submit application'}
              </Button>
              <Button onClick={() => save.mutate(false)} disabled={save.isPending || !form || title.trim().length < 3 || !!keptDraft}>
                Save as draft
              </Button>
              <Button variant="ghost" onClick={() => router.push('/government/')}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </QueryView>
    </>
  );
}
