'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ActionButton, PackInactive, usePackActive } from '@/components/module-kit';
import { Badge, Button, Card, type Column, DataTable, Dialog, Field, InlineError, PageHeader, QueryView, StatusBadge, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { ago, dateTime, titleCase } from '@/lib/format';

const KEYS = [['integrations']];

/** Shows a signing secret exactly once, right after it was created or rotated. */
function SecretNotice({ secret, onClose }: { secret: { label: string; value: string; path?: string } | null; onClose: () => void }) {
  return (
    <Dialog open={!!secret} onClose={onClose} title="Signing secret" footer={<Button variant="primary" onClick={onClose}>I have stored it</Button>}>
      <div className="space-y-2 text-sm">
        <p>Secret for <strong>{secret?.label}</strong>. It is shown only now; afterwards it can only be rotated.</p>
        <code className="block break-all rounded bg-slate-100 p-2">{secret?.value}</code>
        {secret?.path && <p>Senders post to <code className="break-all">{getConfig().gatewayUrl}{secret.path}</code> with the headers <code>x-titan-timestamp</code>, <code>x-titan-event-id</code> and <code>x-titan-signature</code>.</p>}
      </div>
    </Dialog>
  );
}

function NewEndpoint({ open, onClose, onSecret }: { open: boolean; onClose: () => void; onSecret: (s: { label: string; value: string; path?: string }) => void }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [severity, setSeverity] = useState('warning');
  const [category, setCategory] = useState('');
  const create = useMutation({
    mutationFn: () => api<any>('/api/integration/endpoints', { method: 'POST', body: { name, default_severity: severity, default_category: category || null } }),
    onSuccess: async (e) => {
      await client.invalidateQueries({ queryKey: ['integrations'] });
      onClose();
      onSecret({ label: e.name, value: e.secret, path: e.path });
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="New inbound endpoint" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-ep">Create</Button></>}>
      <form id="new-ep" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <p className="text-sm text-ink-muted">An external system reports incidents to this endpoint. Every request must be signed with the endpoint secret.</p>
        <Field label="Name" required>{(p) => <input {...p} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Default severity">{(p) => <select {...p} className={inputClass} value={severity} onChange={(e) => setSeverity(e.target.value)}>{['info', 'warning', 'critical'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select>}</Field>
        <Field label="Default incident category" hint="Optional; unknown categories fall back to General.">{(p) => <input {...p} className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)} />}</Field>
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

function NewSubscription({ open, onClose, onSecret, catalogue }: { open: boolean; onClose: () => void; onSecret: (s: { label: string; value: string }) => void; catalogue: any }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () => api<any>('/api/integration/subscriptions', { method: 'POST', body: { name, target_url: url, event_types: types } }),
    onSuccess: async (s) => {
      await client.invalidateQueries({ queryKey: ['integrations'] });
      onClose();
      onSecret({ label: s.name, value: s.secret });
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="New outbound subscription" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-sub">Create</Button></>}>
      <form id="new-sub" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <Field label="Name" required>{(p) => <input {...p} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Destination URL" required hint={`Allowed hosts: ${(catalogue?.allowed_hosts ?? []).join(', ') || 'none configured'}`}>{(p) => <input {...p} className={inputClass} value={url} placeholder="http://webhook-sink:8080/my-system" onChange={(e) => setUrl(e.target.value)} />}</Field>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Events</legend>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {(catalogue?.event_types ?? []).map((t: string) => (
              <label key={t} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))} /> <code className="text-xs">{t}</code></label>
            ))}
          </div>
        </fieldset>
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

function Log({ kind, id }: { kind: 'endpoint' | 'subscription'; id: string }) {
  const { hasRole } = useAuth();
  const q = useQuery({
    queryKey: ['integrations', kind, id],
    queryFn: () => api<any[]>(kind === 'endpoint' ? `/api/integration/endpoints/${id}/messages` : `/api/integration/subscriptions/${id}/deliveries`),
    refetchInterval: 5_000,
  });
  return (
    <QueryView query={q} what="The log" isEmpty={(d) => d.length === 0} empty={<p className="p-3 text-sm text-ink-muted">Nothing yet.</p>}>
      {(rows) => (
        <ul className="divide-y divide-line text-sm">
          {rows.slice(0, 50).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              <StatusBadge status={r.status} />
              {kind === 'endpoint' ? (
                <span>{dateTime(r.received_at)} · event {r.event_id ?? '—'}{r.external_id ? ` · external ${r.external_id}` : ''}{r.reason ? ` · ${r.reason}` : ''}</span>
              ) : (
                <span>{dateTime(r.created_at)} · <code className="text-xs">{r.event_type}</code> · {r.attempts} attempt(s){r.last_status_code ? ` · HTTP ${r.last_status_code}` : ''}{r.last_error ? ` · ${r.last_error}` : ''}</span>
              )}
              {kind === 'subscription' && r.status === 'failed' && hasRole('tenant_admin') && (
                <ActionButton invalidate={KEYS} run={() => api(`/api/integration/deliveries/${r.id}/retry`, { method: 'POST' })}>Retry</ActionButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </QueryView>
  );
}

export default function IntegrationsPage() {
  const active = usePackActive('integration-hub');
  const { hasRole } = useAuth();
  const admin = hasRole('tenant_admin');
  const [newEndpoint, setNewEndpoint] = useState(false);
  const [newSub, setNewSub] = useState(false);
  const [secret, setSecret] = useState<{ label: string; value: string; path?: string } | null>(null);
  const [open, setOpen] = useState<{ kind: 'endpoint' | 'subscription'; id: string } | null>(null);
  const enabled = active === true;
  const catalogue = useQuery({ queryKey: ['integrations', 'catalogue'], queryFn: () => api<any>('/api/integration/catalogue'), enabled });
  const endpoints = useQuery({ queryKey: ['integrations', 'endpoints'], queryFn: () => api<any[]>('/api/integration/endpoints'), enabled, refetchInterval: 10_000 });
  const subs = useQuery({ queryKey: ['integrations', 'subscriptions'], queryFn: () => api<any[]>('/api/integration/subscriptions'), enabled, refetchInterval: 10_000 });
  if (active === false) return <PackInactive title="Integrations" pack="integration hub" />;
  const epColumns: Column<any>[] = [
    { key: 'name', header: 'Endpoint', value: (e) => e.name, cell: (e) => <button className="font-medium text-brand-700 hover:underline" onClick={() => setOpen({ kind: 'endpoint', id: e.id })}>{e.name}</button> },
    { key: 'path', header: 'Path', value: (e) => e.path, cell: (e) => <code className="text-xs">{e.path}</code> },
    { key: 'active', header: 'State', value: (e) => (e.active ? 'active' : 'inactive'), cell: (e) => <StatusBadge status={e.active ? 'active' : 'inactive'} /> },
    { key: 'counts', header: 'Accepted / refused', value: (e) => e.accepted, cell: (e) => `${e.accepted} / ${e.rejected}` },
    { key: 'last', header: 'Last report', value: (e) => e.last_received_at ?? '', cell: (e) => (e.last_received_at ? ago(e.last_received_at) : 'Never') },
    ...(admin
      ? [{
          key: 'act', header: '', cell: (e: any) => (
            <span className="flex gap-1">
              <ActionButton invalidate={KEYS} confirm="Rotate the secret? The sender must use the new secret immediately." run={() => api<any>(`/api/integration/endpoints/${e.id}/rotate-secret`, { method: 'POST' })} onDone={(r) => setSecret({ label: e.name, value: r.secret, path: e.path })}>Rotate secret</ActionButton>
              <ActionButton invalidate={KEYS} run={() => api(`/api/integration/endpoints/${e.id}`, { method: 'PATCH', body: { active: !e.active } })}>{e.active ? 'Deactivate' : 'Activate'}</ActionButton>
            </span>
          ),
        }]
      : []),
  ];
  const subColumns: Column<any>[] = [
    { key: 'name', header: 'Subscription', value: (s) => s.name, cell: (s) => <button className="font-medium text-brand-700 hover:underline" onClick={() => setOpen({ kind: 'subscription', id: s.id })}>{s.name}</button> },
    { key: 'url', header: 'Destination', value: (s) => s.target_url, cell: (s) => <code className="text-xs">{s.target_url}</code> },
    { key: 'events', header: 'Events', value: (s) => s.event_types.join(' '), cell: (s) => s.event_types.map((t: string) => <Badge key={t} tone="info">{t}</Badge>) },
    { key: 'counts', header: 'Delivered / pending / failed', value: (s) => s.delivered, cell: (s) => `${s.delivered} / ${s.pending} / ${s.failed}` },
    { key: 'active', header: 'State', value: (s) => (s.active ? 'active' : 'inactive'), cell: (s) => <StatusBadge status={s.active ? 'active' : 'inactive'} /> },
    ...(admin ? [{ key: 'act', header: '', cell: (s: any) => <ActionButton invalidate={KEYS} run={() => api(`/api/integration/subscriptions/${s.id}`, { method: 'PATCH', body: { active: !s.active, expected_version: s.version } })}>{s.active ? 'Pause' : 'Resume'}</ActionButton> }] : []),
  ];
  return (
    <>
      <PageHeader title="Integrations" description="Signed webhooks in (external systems report incidents) and out (selected events, to allow-listed destinations only). Every request and delivery is logged." />
      <div className="space-y-6">
        <Card title="Inbound endpoints" padded={false} actions={admin && <Button variant="primary" onClick={() => setNewEndpoint(true)}>New endpoint</Button>}>
          <QueryView query={endpoints} what="Endpoints">{(rows) => <DataTable caption="Inbound endpoints" columns={epColumns} rows={rows} rowKey={(e) => e.id} emptyTitle="No endpoints" />}</QueryView>
        </Card>
        <Card title="Outbound subscriptions" padded={false} actions={admin && <Button variant="primary" onClick={() => setNewSub(true)}>New subscription</Button>}>
          <QueryView query={subs} what="Subscriptions">{(rows) => <DataTable caption="Outbound subscriptions" columns={subColumns} rows={rows} rowKey={(s) => s.id} emptyTitle="No subscriptions" />}</QueryView>
        </Card>
        {open && <Card title={open.kind === 'endpoint' ? 'Requests received' : 'Deliveries'} padded={false} actions={<Button onClick={() => setOpen(null)}>Close</Button>}><Log kind={open.kind} id={open.id} /></Card>}
      </div>
      <NewEndpoint open={newEndpoint} onClose={() => setNewEndpoint(false)} onSecret={setSecret} />
      <NewSubscription open={newSub} onClose={() => setNewSub(false)} onSecret={setSecret} catalogue={catalogue.data} />
      <SecretNotice secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}
