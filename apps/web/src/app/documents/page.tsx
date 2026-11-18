'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useState } from 'react';
import { ActionButton, fileToBase64 } from '@/components/module-kit';
import { Badge, Button, Card, type Column, DataTable, Dialog, Field, InlineError, KeyValue, PageHeader, QueryView, StatusBadge, inputClass } from '@/components/ui';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, dateTime, titleCase } from '@/lib/format';

const TYPES = ['procedure', 'drawing', 'certificate', 'inspection_report', 'contract', 'manual', 'record', 'other'];
const RECORDS_ROLES = ['records_manager', 'tenant_admin'];
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.txt,.csv';
const CLASS_TONE: Record<string, 'info' | 'warn' | 'danger'> = { public: 'info', internal: 'warn', restricted: 'danger' };

function NewDocumentDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const client = useQueryClient();
  const classes = useQuery({ queryKey: ['documents', 'retention'], queryFn: () => api<any[]>('/api/document/retention-classes'), enabled: open });
  const [form, setForm] = useState({ title: '', description: '', document_type: 'procedure', classification: 'internal', allowed_roles: '', retention_class: 'operational-3y', requires_review: true });
  const [file, setFile] = useState<File | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a file');
      const doc = await api<any>('/api/document/documents', {
        method: 'POST',
        body: {
          ...form,
          allowed_roles: form.classification === 'restricted' ? form.allowed_roles.split(',').map((r) => r.trim()).filter(Boolean) : [],
          filename: file.name,
          content_type: file.type || 'application/octet-stream',
          content_base64: await fileToBase64(file),
          change_note: 'Initial version',
        },
      });
      return doc;
    },
    onSuccess: async (doc) => {
      await client.invalidateQueries({ queryKey: ['documents'] });
      onClose();
      onCreated(doc.id);
    },
  });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Dialog open={open} onClose={onClose} title="New document" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-doc" disabled={create.isPending}>Upload</Button></>}>
      <form id="new-doc" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <Field label="Title" required>{(p) => <input {...p} className={inputClass} value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={200} />}</Field>
        <Field label="Description">{(p) => <textarea {...p} className={inputClass} rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{(p) => <select {...p} className={inputClass} value={form.document_type} onChange={(e) => set('document_type', e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</select>}</Field>
          <Field label="Classification">{(p) => <select {...p} className={inputClass} value={form.classification} onChange={(e) => set('classification', e.target.value)}>{['public', 'internal', 'restricted'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</select>}</Field>
        </div>
        {form.classification === 'restricted' && (
          <Field label="Roles that may read it" hint="Comma-separated role names, e.g. incident_commander. Records managers always can.">
            {(p) => <input {...p} className={inputClass} value={form.allowed_roles} onChange={(e) => set('allowed_roles', e.target.value)} />}
          </Field>
        )}
        <Field label="Retention class" hint="Illustrative periods, not legal advice.">
          {(p) => (
            <select {...p} className={inputClass} value={form.retention_class} onChange={(e) => set('retention_class', e.target.value)}>
              {(classes.data ?? [{ key: form.retention_class, name: form.retention_class }]).map((c: any) => <option key={c.key} value={c.key}>{c.name ?? c.key}</option>)}
            </select>
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requires_review} onChange={(e) => set('requires_review', e.target.checked)} /> Published versions need review by a records manager</label>
        <Field label="File" required hint="PDF, PNG, JPEG, text or CSV; at most 5 MB. Every upload is scanned.">
          {(p) => <input {...p} type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
        </Field>
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

function DocumentDetail({ id }: { id: string }) {
  const { hasRole, user } = useAuth();
  const records = hasRole(...RECORDS_ROLES);
  const doc = useQuery({ queryKey: ['documents', 'one', id], queryFn: () => api<any>(`/api/document/documents/${id}`) });
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [holdReason, setHoldReason] = useState('');
  const keys = [['documents']];
  return (
    <Card title="Document" padded>
      <QueryView query={doc} what="The document">
        {(d) => (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{d.reference_no} · {d.title}</h2>
              <Badge tone={CLASS_TONE[d.classification]}>{titleCase(d.classification)}</Badge>
              <StatusBadge status={d.status} />
              {d.legal_hold && <Badge tone="danger">Legal hold</Badge>}
            </div>
            <KeyValue
              items={[
                ['Type', titleCase(d.document_type)],
                ['Retention', `${d.retention_class}${d.retain_until ? ` (until ${d.retain_until.slice(0, 10)})` : ''}`],
                ['Review required', d.requires_review ? 'Yes' : 'No'],
                ['Readable by', d.classification === 'restricted' ? (d.allowed_roles.join(', ') || 'records managers only') : d.classification === 'internal' ? 'All staff' : 'Everyone in the organisation'],
                ['Disposal', d.disposal_block ? `Blocked: ${titleCase(d.disposal_block)}` : 'Allowed'],
              ]}
            />
            <div>
              <h3 className="mb-2 text-sm font-semibold">Versions</h3>
              <ul className="divide-y divide-line rounded border border-line">
                {d.versions.map((v: any) => (
                  <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span>
                      v{v.version} · {v.filename} · {(v.size_bytes / 1024).toFixed(1)} KB · <StatusBadge status={v.status} /> · {v.uploaded_by} {ago(v.uploaded_at)}
                      {v.change_note ? <span className="text-ink-muted"> · {v.change_note}</span> : null}
                    </span>
                    <span className="flex gap-2">
                      {v.status !== 'disposed' && <Button onClick={() => download(`/api/document/documents/${id}/versions/${v.version}/content`, v.filename)}>Download</Button>}
                      {v.status === 'draft' && (v.uploaded_by === user?.username || records) && (
                        <ActionButton variant="primary" invalidate={keys} run={() => api(`/api/document/documents/${id}/versions/${v.version}/submit`, { method: 'POST' })}>
                          {d.requires_review ? 'Submit for review' : 'Publish'}
                        </ActionButton>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {d.status === 'active' && (
              <div className="flex flex-wrap items-end gap-2 rounded border border-line p-3">
                <Field label="New version">{(p) => <input {...p} type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
                <Field label="What changed">{(p) => <input {...p} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}</Field>
                <ActionButton
                  disabled={!file}
                  invalidate={keys}
                  run={async () => api(`/api/document/documents/${id}/versions`, { method: 'POST', body: { filename: file!.name, content_type: file!.type || 'application/octet-stream', content_base64: await fileToBase64(file!), change_note: note } })}
                  onDone={() => { setFile(null); setNote(''); }}
                >
                  Upload draft
                </ActionButton>
              </div>
            )}
            <div>
              <h3 className="mb-2 text-sm font-semibold">Linked records</h3>
              {d.links.length === 0 ? <p className="text-sm text-ink-muted">None.</p> : (
                <ul className="text-sm">{d.links.map((l: any) => <li key={`${l.subject_type}:${l.subject_id}`}>{titleCase(l.subject_type)} <code className="text-xs">{l.subject_id}</code></li>)}</ul>
              )}
            </div>
            {records && d.status === 'active' && (
              <div className="flex flex-wrap items-end gap-2 rounded border border-line p-3">
                <Field label={d.legal_hold ? 'Reason for releasing the hold' : 'Reason for the legal hold'}>{(p) => <input {...p} className={inputClass} value={holdReason} onChange={(e) => setHoldReason(e.target.value)} />}</Field>
                <ActionButton invalidate={keys} disabled={holdReason.trim().length < 3} run={() => api(`/api/document/documents/${id}/legal-hold`, { method: 'POST', body: { legal_hold: !d.legal_hold, reason: holdReason } })} onDone={() => setHoldReason('')}>
                  {d.legal_hold ? 'Release legal hold' : 'Place legal hold'}
                </ActionButton>
                <ActionButton variant="danger" invalidate={keys} disabled={!!d.disposal_block} confirm="Dispose of this document? Its content is removed permanently; the record of it is kept." run={() => api(`/api/document/documents/${id}/dispose`, { method: 'POST' })}>
                  Dispose
                </ActionButton>
              </div>
            )}
            <div>
              <h3 className="mb-2 text-sm font-semibold">History</h3>
              <ol className="space-y-1 text-sm">{d.events.map((e: any, i: number) => <li key={i}><span className="text-ink-muted">{dateTime(e.occurred_at)}</span> · {e.message}{e.actor ? ` (${e.actor})` : ''}</li>)}</ol>
            </div>
          </div>
        )}
      </QueryView>
    </Card>
  );
}

function Content() {
  const router = useRouter();
  const params = useSearchParams();
  const { hasRole } = useAuth();
  const [q, setQ] = useState('');
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const versionId = params.get('version');
  const [id, setId] = useState<string | null>(params.get('id'));
  const fromVersion = useQuery({ queryKey: ['documents', 'version', versionId], queryFn: () => api<any>(`/api/document/versions/${versionId}`), enabled: !!versionId });
  useEffect(() => {
    if (fromVersion.data) setId(fromVersion.data.document_id);
  }, [fromVersion.data]);
  const list = useQuery({
    queryKey: ['documents', 'list', q, text],
    queryFn: () => api<any[]>(`/api/document/documents?limit=500${q ? `&q=${encodeURIComponent(q)}` : ''}${text.trim().length >= 2 ? `&text=${encodeURIComponent(text.trim())}` : ''}`),
  });
  const open = (docId: string) => {
    setId(docId);
    router.replace(`/documents/?id=${docId}`);
  };
  const columns: Column<any>[] = [
    { key: 'ref', header: 'Reference', value: (d) => d.reference_no, cell: (d) => <button className="font-medium text-brand-700 hover:underline" onClick={() => open(d.id)}>{d.reference_no}</button> },
    { key: 'title', header: 'Title', value: (d) => d.title, cell: (d) => <span>{d.title}{d.snippet && <span className="block text-xs text-ink-muted">…{d.snippet}…</span>}</span> },
    { key: 'type', header: 'Type', value: (d) => d.document_type, cell: (d) => titleCase(d.document_type) },
    { key: 'class', header: 'Classification', value: (d) => d.classification, cell: (d) => <Badge tone={CLASS_TONE[d.classification]}>{titleCase(d.classification)}</Badge> },
    { key: 'current', header: 'Published', value: (d) => d.current_version ?? 0, cell: (d) => (d.current_version ? `v${d.current_version}` : 'Not yet') },
    { key: 'latest', header: 'Latest version', value: (d) => d.latest_status, cell: (d) => <span>v{d.latest_version} <StatusBadge status={d.latest_status} /></span> },
    { key: 'hold', header: 'Hold', value: (d) => (d.legal_hold ? 'hold' : ''), cell: (d) => (d.legal_hold ? <Badge tone="danger">Legal hold</Badge> : '—') },
  ];
  return (
    <>
      <PageHeader
        title="Documents"
        description="Controlled documents with versions, review, retention and legal hold. You see only documents your roles may read."
        actions={hasRole('records_manager', 'tenant_admin', 'asset_manager', 'facility_manager', 'maintenance_planner', 'incident_commander', 'procurement_officer', 'duty_officer', 'production_supervisor', 'analyst') && <Button variant="primary" onClick={() => setCreating(true)}>New document</Button>}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Register" padded={false}>
          <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2">
            <input type="search" aria-label="Search titles and references" placeholder="Title or reference" className={`${inputClass} max-w-xs`} value={q} onChange={(e) => setQ(e.target.value)} />
            <input type="search" aria-label="Search the text of published documents" placeholder="Words in published documents" className={`${inputClass} max-w-xs`} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <QueryView query={list} what="Documents">{(rows) => <DataTable caption="Documents" columns={columns} rows={rows} rowKey={(d) => d.id} emptyTitle="No documents" />}</QueryView>
        </Card>
        {id ? <DocumentDetail id={id} /> : <Card><p className="text-sm text-ink-muted">Select a document to see its versions, links and history.</p></Card>}
      </div>
      <NewDocumentDialog open={creating} onClose={() => setCreating(false)} onCreated={open} />
    </>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}
