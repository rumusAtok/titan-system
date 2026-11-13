'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Circle, Clock, Download, Paperclip } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { DecisionDialog, type WorkflowTask } from '@/components/decision';
import { Button, Card, EmptyState, ErrorState, InlineError, KeyValue, PageHeader, QueryView, Spinner, StatusBadge } from '@/components/ui';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, titleCase } from '@/lib/format';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

function CaseDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { user, hasRole } = useAuth();
  const client = useQueryClient();
  const [deciding, setDeciding] = useState<WorkflowTask | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const record = useQuery({ queryKey: ['case', id], queryFn: () => api(`/api/case/cases/${id}`), enabled: !!id, refetchInterval: 10_000 });
  const history = useQuery({ queryKey: ['case', id, 'history'], queryFn: () => api<any[]>(`/api/case/cases/${id}/history`), enabled: !!id, refetchInterval: 10_000 });
  const submitted = record.data && record.data.status !== 'draft';
  const workflow = useQuery({
    queryKey: ['workflow', 'instance', id],
    queryFn: () => api(`/api/workflow/instances/by-subject/case/${id}`),
    enabled: !!id && !!submitted,
    refetchInterval: 10_000,
    retry: false,
  });
  const isStaff = !hasRole('applicant') || user.roles.length > 1;
  const myTasks = useQuery({
    queryKey: ['workflow', 'tasks', id],
    queryFn: () => api<any[]>(`/api/workflow/tasks?subject_id=${id}`),
    enabled: !!id && isStaff && !!submitted,
    refetchInterval: 10_000,
    retry: false,
  });

  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['case', id] }), client.invalidateQueries({ queryKey: ['cases'] }), client.invalidateQueries({ queryKey: ['workflow'] })]);
  const action = useMutation({ mutationFn: (name: 'submit' | 'cancel') => api(`/api/case/cases/${id}/${name}`, { method: 'POST' }), onSuccess: refresh });
  const upload = useMutation({
    mutationFn: async (file: File) => api(`/api/case/cases/${id}/attachments`, { method: 'POST', body: { filename: file.name, content_type: file.type || 'application/octet-stream', content_base64: await fileToBase64(file) } }),
    onSuccess: refresh,
  });

  if (!id) return <EmptyState title="No application selected">Open an application from the list.</EmptyState>;
  if (record.isPending) return <Spinner />;
  if (record.isError) return <ErrorState error={record.error} onRetry={() => void record.refetch()} what="This application" />;

  const c = record.data;
  const isOwner = c.applicant_id === user.id;
  const editable = isOwner && (c.status === 'draft' || c.status === 'returned');
  const cancellable = (isOwner || hasRole('tenant_admin')) && !['approved', 'rejected', 'cancelled'].includes(c.status);
  const labelOf = (name: string) => c.form.fields.find((f: any) => f.name === name)?.label ?? titleCase(name);
  const stages: any[] = workflow.data?.stages ?? [];
  const tasks: any[] = workflow.data?.tasks ?? [];
  const cycle = workflow.data?.cycle;

  return (
    <>
      <PageHeader
        title={c.title}
        description={`${c.reference_no} · ${c.form.title}`}
        actions={
          <>
            <StatusBadge status={c.status} />
            {editable && (
              <Button variant="primary" onClick={() => action.mutate('submit')} disabled={action.isPending}>
                {c.status === 'returned' ? 'Resubmit' : 'Submit for review'}
              </Button>
            )}
            {cancellable && (
              <Button onClick={() => { if (window.confirm('Cancel this application? This cannot be undone.')) action.mutate('cancel'); }} disabled={action.isPending}>
                Cancel application
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4"><InlineError error={action.error} /></div>

      {myTasks.data && myTasks.data.length > 0 && (
        <div className="mb-6 rounded-lg border border-sky-300 bg-sky-50 p-4" role="region" aria-label="Your pending decision">
          {myTasks.data.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-sky-900">
                <span className="font-semibold">{t.stage_name}</span> is waiting for your decision as {titleCase(t.role)}
                {t.due_at && <> (due {dateTime(t.due_at)})</>}.
              </p>
              <Button variant="primary" onClick={() => setDeciding(t)}>
                Record decision
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Application details">
            <KeyValue
              items={[
                ['Applicant', c.applicant_username],
                ['Channel', titleCase(c.channel)],
                ['Submitted', dateTime(c.submitted_at)],
                ['Decided', dateTime(c.decided_at)],
                ...Object.entries(c.data as Record<string, unknown>).map(([k, v]): [string, string] => [labelOf(k), typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)]),
              ]}
            />
            {Object.keys(c.data).length === 0 && <p className="mt-3 text-sm text-ink-muted">No form fields have been filled in yet.</p>}
          </Card>

          <Card
            title="Attachments"
            actions={
              editable ? (
                <>
                  <input ref={fileInput} type="file" className="sr-only" aria-label="Choose a file to attach" accept=".pdf,.png,.jpg,.jpeg,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
                  <Button onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
                    <Paperclip className="h-4 w-4" aria-hidden="true" /> {upload.isPending ? 'Uploading…' : 'Attach file'}
                  </Button>
                </>
              ) : undefined
            }
          >
            <InlineError error={upload.error} />
            {c.attachments.length === 0 ? (
              <p className="text-sm text-ink-muted">No attachments. PDF, PNG, JPEG or plain text, up to 2 MB.</p>
            ) : (
              <ul className="divide-y divide-line">
                {c.attachments.map((a: any) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      {a.filename} <span className="text-ink-muted">· {(a.size_bytes / 1024).toFixed(1)} kB · {dateTime(a.uploaded_at)}</span>
                    </span>
                    <Button variant="ghost" onClick={() => void download(`/api/case/cases/${id}/attachments/${a.id}/download`, a.filename)} aria-label={`Download ${a.filename}`}>
                      <Download className="h-4 w-4" aria-hidden="true" /> Download
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Approval history" description="Every decision recorded for this application">
            {!submitted ? (
              <p className="text-sm text-ink-muted">The approval process starts when the application is submitted.</p>
            ) : (
              <QueryView query={workflow} what="The approval history" isEmpty={(d: any) => d.decisions.length === 0} empty={<p className="text-sm text-ink-muted">No decisions have been recorded yet.</p>}>
                {(d: any) => (
                  <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Scrollable table">
                    <table className="min-w-full divide-y divide-line text-sm">
                      <caption className="sr-only">Decisions</caption>
                      <thead className="text-left text-xs uppercase tracking-wide text-ink-muted">
                        <tr>
                          <th scope="col" className="py-2 pr-4">Stage</th>
                          <th scope="col" className="py-2 pr-4">Decision</th>
                          <th scope="col" className="py-2 pr-4">By</th>
                          <th scope="col" className="py-2 pr-4">When</th>
                          <th scope="col" className="py-2">Comment</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {d.decisions.map((x: any) => (
                          <tr key={x.id}>
                            <td className="py-2 pr-4">{titleCase(x.stage_key)}</td>
                            <td className="py-2 pr-4"><StatusBadge status={x.decision} /></td>
                            <td className="py-2 pr-4">{x.decided_by_username}{x.on_behalf_of && <span className="text-ink-muted"> (delegated)</span>}</td>
                            <td className="py-2 pr-4 whitespace-nowrap">{dateTime(x.decided_at)}</td>
                            <td className="py-2">{x.comment ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </QueryView>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Approval progress">
            {!submitted && <p className="text-sm text-ink-muted">Not submitted yet.</p>}
            {submitted && workflow.isPending && <Spinner />}
            {submitted && workflow.isError && <p className="text-sm text-ink-muted">The approval process has not started yet, or workflow information is unavailable.</p>}
            {stages.length > 0 && (
              <ol className="space-y-3">
                {stages.map((s) => {
                  const stageTasks = tasks.filter((t) => t.stage_key === s.key && t.cycle === cycle);
                  const done = stageTasks.length > 0 && stageTasks.every((t) => t.status === 'completed' && t.decision === 'approve');
                  const current = stageTasks.some((t) => t.status === 'pending');
                  return (
                    <li key={s.key} className="flex gap-3" aria-current={current ? 'step' : undefined}>
                      <span className="mt-0.5">
                        {done ? <Check className="h-5 w-5 text-green-700" aria-hidden="true" /> : current ? <Clock className="h-5 w-5 text-sky-700" aria-hidden="true" /> : <Circle className="h-5 w-5 text-slate-300" aria-hidden="true" />}
                      </span>
                      <div>
                        <p className={`text-sm ${current ? 'font-semibold text-ink' : 'text-ink'}`}>
                          {s.name} <span className="sr-only">({done ? 'completed' : current ? 'in progress' : 'not started'})</span>
                        </p>
                        <p className="text-xs text-ink-muted">
                          {s.roles.map(titleCase).join(' and ')}
                          {s.sla_hours ? ` · SLA ${s.sla_hours} h` : ''}
                          {s.type === 'parallel' ? ' · all must approve' : ''}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          <Card title="Status timeline">
            <QueryView query={history} what="The status timeline">
              {(rows) => (
                <ol className="space-y-3 border-l border-line pl-4">
                  {rows.map((h) => (
                    <li key={h.id} className="relative">
                      <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-brand-600" aria-hidden="true" />
                      <p className="text-sm"><StatusBadge status={h.to_status} /></p>
                      {h.note && <p className="mt-0.5 text-sm text-ink">{h.note}</p>}
                      <p className="text-xs text-ink-muted">{dateTime(h.occurred_at)}{h.actor_username ? ` · ${h.actor_username}` : ''}</p>
                    </li>
                  ))}
                </ol>
              )}
            </QueryView>
          </Card>
        </div>
      </div>

      <p className="mt-6 text-sm">
        <Link href="/government/" className="text-brand-700 underline-offset-2 hover:underline">
          Back to applications
        </Link>
      </p>
      <DecisionDialog task={deciding} onClose={() => setDeciding(null)} />
    </>
  );
}

export default function CasePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <CaseDetail />
    </Suspense>
  );
}
