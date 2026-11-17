'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { DecisionDialog, type WorkflowTask } from '@/components/decision';
import { Badge, Button, Card, type Column, DataTable, Dialog, Field, InlineError, KeyValue, PageHeader, QueryView, StatusBadge, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, dateTime, titleCase } from '@/lib/format';

const RESPONDERS = ['duty_officer', 'incident_commander', 'production_supervisor', 'facility_manager', 'maintenance_planner'];
const CLOSERS = ['incident_commander', 'production_supervisor', 'facility_manager'];
const SEVERITY_TONE: Record<string, 'danger' | 'warn' | 'info'> = { critical: 'danger', warning: 'warn', info: 'info' };

function ReportDialog({ open, onClose, categories }: { open: boolean; onClose: () => void; categories: any[] }) {
  const client = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('warning');
  const [category, setCategory] = useState('general');
  const [assetId, setAssetId] = useState('');
  const assets = useQuery({ queryKey: ['assets', 'list', ''], queryFn: () => api<any[]>('/api/asset/assets?limit=500'), enabled: open });
  const report = useMutation({
    mutationFn: () => api('/api/incident/incidents', { method: 'POST', body: { title, description, severity, category, asset_id: assetId || null } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['incidents'] });
      setTitle('');
      setDescription('');
      onClose();
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    report.mutate();
  }
  return (
    <Dialog open={open} onClose={onClose} title="Report an incident" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="report-incident">Report</Button></>}>
      <form id="report-incident" onSubmit={submit} className="space-y-3">
        <Field label="Title" required>{(p) => <input {...p} className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}</Field>
        <Field label="Category" hint="Decides who responds and how.">
          {(p) => (
            <select {...p} className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Severity">
          {(p) => (
            <select {...p} className={inputClass} value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {['info', 'warning', 'critical'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </select>
          )}
        </Field>
        <Field label="Asset" hint="Optional.">
          {(p) => (
            <select {...p} className={inputClass} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">None</option>
              {(assets.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.code}: {a.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Description">{(p) => <textarea {...p} className={inputClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />}</Field>
        <InlineError error={report.error} />
      </form>
    </Dialog>
  );
}

function IncidentDetail({ id }: { id: string }) {
  const router = useRouter();
  const client = useQueryClient();
  const { hasRole } = useAuth();
  const [deciding, setDeciding] = useState<WorkflowTask | null>(null);
  const [note, setNote] = useState('');
  const incident = useQuery({ queryKey: ['incident', id], queryFn: () => api(`/api/incident/incidents/${id}`), refetchInterval: 10_000 });
  const tasks = useQuery({ queryKey: ['workflow', 'incident-tasks', id], queryFn: () => api<any[]>(`/api/workflow/tasks?subject_id=${id}`), refetchInterval: 10_000 });
  const addNote = useMutation({
    mutationFn: () => api(`/api/incident/incidents/${id}/notes`, { method: 'POST', body: { message: note } }),
    onSuccess: async () => {
      setNote('');
      await client.invalidateQueries({ queryKey: ['incident', id] });
    },
  });
  const close = useMutation({
    mutationFn: () => api(`/api/incident/incidents/${id}/close`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['incident', id] }),
  });

  return (
    <>
      <PageHeader title="Incident" actions={<Button onClick={() => router.push('/incidents/')}>Back to incidents</Button>} />
      <QueryView query={incident} what="The incident">
        {(i: any) => (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card title={`${i.reference_no}: ${i.title}`} actions={i.response_overdue ? <Badge tone="danger">Response overdue</Badge> : undefined}>
              <KeyValue
                items={[
                  ['Category', i.category_name],
                  ['Severity', <Badge key="sev" tone={SEVERITY_TONE[i.severity]}>{titleCase(i.severity)}</Badge>],
                  ['Status', <StatusBadge key="st" status={i.status} />],
                  ['Origin', titleCase(i.source_type)],
                  ['Asset', i.asset_id ? <a key="a" className="text-brand-700 hover:underline" href={`/assets/?id=${i.asset_id}`}>Open asset</a> : '—'],
                  ['Created', dateTime(i.created_at)],
                  ['Acknowledged', i.acknowledged_at ? `${dateTime(i.acknowledged_at)} by ${i.acknowledged_by}` : '—'],
                  ['Resolved', i.resolved_at ? `${dateTime(i.resolved_at)} by ${i.resolved_by}` : '—'],
                ]}
              />
              {i.description && <p className="mt-3 text-sm text-ink">{i.description}</p>}
              {i.status === 'resolved' && hasRole(...CLOSERS) && (
                <div className="mt-4">
                  <Button variant="primary" onClick={() => close.mutate()} disabled={close.isPending}>Close incident</Button>
                  <InlineError error={close.error} />
                </div>
              )}
            </Card>
            <Card title="Response steps" description="Acknowledgment and resolution are decided in the response process of the incident's category.">
              <QueryView query={tasks} what="The response steps" isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-ink-muted">No step is waiting for a role you hold.</p>}>
                {(rows) => (
                  <ul className="space-y-2">
                    {rows.map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-3 text-sm">
                        <span>{t.stage_name} · {titleCase(t.role)}{t.overdue ? ' · overdue' : ''}</span>
                        <Button variant="primary" onClick={() => setDeciding(t)}>{t.stage_key === 'acknowledge' ? 'Acknowledge' : 'Resolve'}</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </QueryView>
            </Card>
            <Card title="Timeline" className="xl:col-span-2">
              <ol className="space-y-2 text-sm">
                {i.timeline.map((t: any) => (
                  <li key={t.id} className="flex gap-3">
                    <span className="w-40 shrink-0 text-ink-muted">{dateTime(t.occurred_at)}</span>
                    <span><Badge>{titleCase(t.entry_type)}</Badge> {t.message}{t.actor_username ? ` (${t.actor_username})` : ''}</span>
                  </li>
                ))}
              </ol>
              {hasRole(...RESPONDERS, 'iot_operator', 'maintenance_technician') && i.status !== 'closed' && (
                <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); addNote.mutate(); }}>
                  <label className="sr-only" htmlFor="incident-note">Add a note</label>
                  <input id="incident-note" className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to the timeline" maxLength={4000} />
                  <Button type="submit" disabled={!note.trim() || addNote.isPending}>Add note</Button>
                </form>
              )}
              <InlineError error={addNote.error} />
            </Card>
          </div>
        )}
      </QueryView>
      <DecisionDialog task={deciding} onClose={() => setDeciding(null)} />
    </>
  );
}

function IncidentList() {
  const router = useRouter();
  const { hasRole } = useAuth();
  const [status, setStatus] = useState('active');
  const [category, setCategory] = useState('');
  const [reporting, setReporting] = useState(false);
  const categories = useQuery({ queryKey: ['incidents', 'categories'], queryFn: () => api<any[]>('/api/incident/categories') });
  const incidents = useQuery({
    queryKey: ['incidents', 'list', status, category],
    queryFn: () => api<any[]>(`/api/incident/incidents?limit=200${status ? `&status=${status}` : ''}${category ? `&category=${category}` : ''}`),
    refetchInterval: 15_000,
  });
  const names = new Map((categories.data ?? []).map((c) => [c.key, c.name]));

  const columns: Column<any>[] = [
    { key: 'ref', header: 'Reference', value: (i) => i.reference_no, cell: (i) => <span className="font-medium">{i.reference_no}</span> },
    { key: 'title', header: 'Title', value: (i) => i.title, cell: (i) => i.title },
    { key: 'category', header: 'Category', value: (i) => i.category, cell: (i) => names.get(i.category) ?? titleCase(i.category) },
    { key: 'severity', header: 'Severity', value: (i) => i.severity, cell: (i) => <Badge tone={SEVERITY_TONE[i.severity]}>{titleCase(i.severity)}</Badge> },
    { key: 'status', header: 'Status', value: (i) => i.status, cell: (i) => <span><StatusBadge status={i.status} />{i.response_overdue && <span className="ml-1 text-xs font-medium text-red-700">overdue</span>}</span> },
    { key: 'origin', header: 'Origin', value: (i) => i.source_type, cell: (i) => titleCase(i.source_type), defaultHidden: true },
    { key: 'created', header: 'Created', value: (i) => i.created_at, cell: (i) => ago(i.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Incidents"
        description="Incidents of every category: raised by alarms, reported by staff, from inspections or work orders."
        actions={hasRole(...RESPONDERS) && <Button variant="primary" onClick={() => setReporting(true)}>Report incident</Button>}
      />
      <Card padded={false}>
        <QueryView query={incidents} what="Incidents">
          {(rows) => (
            <DataTable
              caption="Incidents"
              columns={columns}
              rows={rows}
              rowKey={(i) => i.id}
              onRowOpen={(i) => router.push(`/incidents/?id=${i.id}`)}
              emptyTitle="No incidents match"
              toolbar={
                <>
                  <label className="sr-only" htmlFor="incident-status">Status</label>
                  <select id="incident-status" value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputClass} w-auto`}>
                    <option value="active">Active</option>
                    <option value="">All</option>
                    {['open', 'acknowledged', 'resolved', 'closed'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
                  </select>
                  <label className="sr-only" htmlFor="incident-category">Category</label>
                  <select id="incident-category" value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputClass} w-auto`}>
                    <option value="">Every category</option>
                    {(categories.data ?? []).map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                  </select>
                </>
              }
            />
          )}
        </QueryView>
      </Card>
      <ReportDialog open={reporting} onClose={() => setReporting(false)} categories={categories.data ?? []} />
    </>
  );
}

function IncidentsRouter() {
  const id = useSearchParams().get('id');
  return id ? <IncidentDetail id={id} /> : <IncidentList />;
}

export default function IncidentsPage() {
  return (
    <Suspense>
      <IncidentsRouter />
    </Suspense>
  );
}
