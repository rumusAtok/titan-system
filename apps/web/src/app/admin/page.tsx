'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Badge, Button, Card, type Column, DataTable, Dialog, EmptyState, Field, InlineError, KeyValue, PageHeader, QueryView, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, titleCase } from '@/lib/format';

const TABS = ['Organisation', 'Roles and members', 'Workflows', 'Audit records'] as const;
type Tab = (typeof TABS)[number];

function Organisation() {
  const client = useQueryClient();
  const { hasRole } = useAuth();
  const admin = hasRole('tenant_admin');
  const tenant = useQuery({ queryKey: ['tenant', 'current'], queryFn: () => api('/api/tenant/tenants/current') });
  const departments = useQuery({ queryKey: ['tenant', 'departments'], queryFn: () => api<any[]>('/api/tenant/departments') });
  const [settings, setSettings] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    if (tenant.data) setSettings(JSON.stringify(tenant.data.settings ?? {}, null, 2));
  }, [tenant.data]);

  const save = useMutation({
    mutationFn: (parsed: Record<string, unknown>) => api('/api/tenant/tenants/current/config', { method: 'PUT', body: { settings: parsed, expected_version: tenant.data.config_version } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['tenant'] }),
  });
  const addDepartment = useMutation({
    mutationFn: () => api('/api/tenant/departments', { method: 'POST', body: { code: code.trim().toUpperCase(), name: name.trim() } }),
    onSuccess: () => { setCode(''); setName(''); return client.invalidateQueries({ queryKey: ['tenant', 'departments'] }); },
  });

  function submitConfig(e: FormEvent) {
    e.preventDefault();
    try {
      const parsed = JSON.parse(settings);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Settings must be a JSON object.');
      setParseError(null);
      save.mutate(parsed);
    } catch (err) {
      setParseError((err as Error).message);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Card title="Tenant configuration">
        <QueryView query={tenant} what="Tenant configuration">
          {(t: any) => (
            <div className="space-y-4">
              <KeyValue items={[['Name', t.name], ['Identifier', t.slug], ['Status', titleCase(t.status)], ['Configuration version', String(t.config_version)]]} />
              <form onSubmit={submitConfig} className="space-y-3">
                <Field label="Settings (JSON)" hint="Saved with optimistic concurrency: if someone else saved first, you are asked to reload.">
                  {(props) => <textarea {...props} rows={8} value={settings} onChange={(e) => setSettings(e.target.value)} className={`${inputClass} font-mono`} spellCheck={false} readOnly={!admin} />}
                </Field>
                {parseError && <p role="alert" className="text-sm text-red-700">{parseError}</p>}
                <InlineError error={save.error} />
                {save.isSuccess && <p role="status" className="text-sm text-green-800">Configuration saved.</p>}
                {admin && <Button type="submit" variant="primary" disabled={save.isPending}>Save configuration</Button>}
              </form>
            </div>
          )}
        </QueryView>
      </Card>

      <Card title="Organisation structure" description="Departments of this tenant" padded={false}>
        <QueryView query={departments} what="Departments" isEmpty={(d) => d.length === 0} empty={<EmptyState title="No departments" />}>
          {(rows) => (
            <table className="min-w-full divide-y divide-line text-sm">
              <caption className="sr-only">Departments</caption>
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-ink-muted">
                <tr><th scope="col" className="px-4 py-2">Code</th><th scope="col" className="px-4 py-2">Name</th><th scope="col" className="px-4 py-2 text-right">Members</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((d) => (
                  <tr key={d.id}><td className="px-4 py-2 font-mono text-xs">{d.code}</td><td className="px-4 py-2">{d.name}</td><td className="px-4 py-2 text-right tabular-nums">{d.member_count}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryView>
        {admin && (
          <form onSubmit={(e) => { e.preventDefault(); addDepartment.mutate(); }} className="flex flex-wrap items-end gap-3 border-t border-line p-4">
            <Field label="Code">{(props) => <input {...props} value={code} onChange={(e) => setCode(e.target.value)} pattern="[A-Za-z0-9_]{2,32}" required className={`${inputClass} w-36 uppercase`} />}</Field>
            <Field label="Name">{(props) => <input {...props} value={name} onChange={(e) => setName(e.target.value)} minLength={2} required className={`${inputClass} w-64`} />}</Field>
            <Button type="submit" disabled={addDepartment.isPending}>Add department</Button>
            <div className="w-full"><InlineError error={addDepartment.error} /></div>
          </form>
        )}
      </Card>
    </div>
  );
}

function RolesAndMembers() {
  const roles = useQuery({ queryKey: ['tenant', 'roles'], queryFn: () => api<any[]>('/api/tenant/roles') });
  const members = useQuery({ queryKey: ['tenant', 'memberships'], queryFn: () => api<any[]>('/api/tenant/memberships') });
  const delegations = useQuery({ queryKey: ['workflow', 'delegations'], queryFn: () => api<any[]>('/api/workflow/delegations'), retry: false });
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Card title="Role catalogue" description="Roles are assigned in the identity provider (Keycloak); every service enforces them." padded={false}>
        <QueryView query={roles} what="The role catalogue">
          {(rows) => (
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <li key={r.role} className="flex items-start justify-between gap-3 px-4 py-2">
                  <div><p className="text-sm font-medium text-ink">{titleCase(r.role)}</p><p className="text-xs text-ink-muted">{r.description}</p></div>
                  <Badge tone={r.scope === 'platform' ? 'warn' : 'neutral'}>{titleCase(r.scope)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </Card>
      <div className="space-y-6">
        <Card title="Organisational memberships" padded={false}>
          <QueryView query={members} what="Memberships" isEmpty={(d) => d.length === 0} empty={<EmptyState title="No memberships recorded" />}>
            {(rows) => (
              <DataTable
                caption="Memberships"
                rows={rows}
                rowKey={(m) => m.id}
                pageSize={10}
                columns={[
                  { key: 'user', header: 'User', value: (m) => m.username, cell: (m) => m.username },
                  { key: 'title', header: 'Title', value: (m) => m.title ?? '', cell: (m) => m.title ?? '—' },
                  { key: 'department', header: 'Department', value: (m) => m.department_name ?? '', cell: (m) => m.department_name ?? '—' },
                ]}
              />
            )}
          </QueryView>
        </Card>
        <Card title="Delegations" description="Temporary delegation of a role's approval authority" padded={false}>
          <QueryView query={delegations} what="Delegations" isEmpty={(d) => d.length === 0} empty={<p className="p-4 text-sm text-ink-muted">No delegations.</p>}>
            {(rows) => (
              <ul className="divide-y divide-line">
                {rows.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span>{d.from_username} → {d.to_username} <span className="text-ink-muted">({titleCase(d.role)}, until {dateTime(d.valid_to)})</span></span>
                    <Badge tone={d.active ? 'ok' : 'neutral'}>{d.active ? 'Active' : d.revoked_at ? 'Revoked' : 'Expired'}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </QueryView>
        </Card>
      </div>
    </div>
  );
}

function Workflows() {
  const definitions = useQuery({ queryKey: ['workflow', 'definitions'], queryFn: () => api<any[]>('/api/workflow/definitions') });
  const forms = useQuery({ queryKey: ['forms'], queryFn: () => api<any[]>('/api/case/forms') });
  return (
    <QueryView query={definitions} what="Workflow definitions" isEmpty={(d) => d.length === 0} empty={<Card><EmptyState title="No workflows defined" /></Card>}>
      {(rows) => (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {rows.filter((d) => d.active).map((d) => {
            const versions = rows.filter((x) => x.key === d.key).length;
            const usedBy = (forms.data ?? []).filter((f) => f.workflow_key === d.key).map((f) => f.title);
            return (
              <Card key={d.id} title={d.name} description={`${d.key} · version ${d.version}${versions > 1 ? ` (${versions} versions published)` : ''} · ${titleCase(d.subject_type)} process`}>
                <ol className="space-y-2">
                  {d.definition.stages.map((s: any, i: number) => (
                    <li key={s.key} className="flex gap-3 rounded-md border border-line p-2.5">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">{i + 1}</span>
                      <div className="min-w-0 text-sm">
                        <p className="font-medium text-ink">{s.name}</p>
                        <p className="text-xs text-ink-muted">
                          {s.type === 'parallel' ? 'Parallel review by ' : 'Decided by '}
                          {s.roles.map(titleCase).join(' and ')}
                          {s.sla_hours ? ` · SLA ${s.sla_hours} h` : ''}
                          {s.escalate_to_role ? ` · escalates to ${titleCase(s.escalate_to_role)}` : ''}
                        </p>
                        {s.condition && <p className="text-xs text-violet-800">Only when {s.condition.field} {s.condition.op} {String(s.condition.value)}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 text-xs text-ink-muted">
                  Return for changes: {d.definition.allow_return ? 'allowed' : 'not allowed'} · Applicant notified on: {d.definition.applicant_notifications.join(', ') || 'nothing'}
                  {usedBy.length > 0 && <> · Used by form: {usedBy.join(', ')}</>}
                </p>
              </Card>
            );
          })}
        </div>
      )}
    </QueryView>
  );
}

function Audit() {
  const [category, setCategory] = useState('');
  const [actor, setActor] = useState('');
  const [applied, setApplied] = useState({ category: '', actor: '' });
  const [detail, setDetail] = useState<any | null>(null);
  const audit = useQuery({
    queryKey: ['audit', applied],
    queryFn: () => api<{ total: number; items: any[] }>(`/api/audit/audit?limit=200${applied.category ? `&category=${applied.category}` : ''}${applied.actor ? `&actor=${encodeURIComponent(applied.actor)}` : ''}`),
    refetchInterval: 30_000,
  });
  const columns: Column<any>[] = [
    { key: 'time', header: 'Occurred', value: (e) => e.occurred_at, cell: (e) => dateTime(e.occurred_at) },
    { key: 'type', header: 'Event', value: (e) => e.event_type, cell: (e) => <span className="font-mono text-xs">{e.event_type}</span> },
    { key: 'actor', header: 'Actor', value: (e) => e.actor_username ?? e.actor_id ?? '', cell: (e) => e.actor_username ?? e.actor_id ?? '—' },
    { key: 'producer', header: 'Recorded by', value: (e) => e.producer, cell: (e) => e.producer },
    { key: 'aggregate', header: 'Record', value: (e) => `${e.aggregate_type} ${e.aggregate_id}`, cell: (e) => <span className="font-mono text-xs">{e.aggregate_type}:{String(e.aggregate_id).slice(0, 8)}</span> },
    { key: 'correlation', header: 'Correlation', value: (e) => e.correlation_id, cell: (e) => <span className="font-mono text-xs">{String(e.correlation_id).slice(0, 8)}</span>, defaultHidden: true },
  ];
  return (
    <Card title="Audit records" description="Append-only record of business activity and security events" padded={false}>
      <form onSubmit={(e) => { e.preventDefault(); setApplied({ category, actor: actor.trim() }); }} className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <Field label="Category">
          {(props) => (
            <select {...props} value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputClass} w-44`}>
              <option value="">All</option>
              {['case', 'workflow', 'incident', 'alert', 'device', 'asset', 'tenant', 'notification', 'security', 'ai', 'pipeline'].map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
            </select>
          )}
        </Field>
        <Field label="Actor (username)">{(props) => <input {...props} value={actor} onChange={(e) => setActor(e.target.value)} className={`${inputClass} w-52`} />}</Field>
        <Button type="submit">Apply</Button>
        {audit.data && <p className="ml-auto text-xs text-ink-muted">{audit.data.total} matching record(s); showing the latest {audit.data.items.length}</p>}
      </form>
      <QueryView query={audit} what="Audit records">
        {(d) => <DataTable caption="Audit records" columns={columns} rows={d.items} rowKey={(e) => e.event_id} onRowOpen={setDetail} emptyTitle="No audit records" />}
      </QueryView>
      <Dialog open={detail !== null} onClose={() => setDetail(null)} title={detail?.event_type ?? ''} footer={<Button onClick={() => setDetail(null)}>Close</Button>}>
        {detail && (
          <div className="space-y-3">
            <KeyValue items={[['Occurred', dateTime(detail.occurred_at)], ['Actor', detail.actor_username ?? detail.actor_id ?? '—'], ['Event id', detail.event_id], ['Correlation id', detail.correlation_id], ['Caused by', detail.causation_id ?? '—'], ['Record', `${detail.aggregate_type}:${detail.aggregate_id}`]]} />
            <pre tabIndex={0} className="max-h-64 overflow-auto rounded bg-slate-50 p-3 font-mono text-xs">{JSON.stringify(detail.payload, null, 2)}</pre>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

export default function AdminPage() {
  const { hasRole } = useAuth();
  const available: Tab[] = hasRole('tenant_admin') ? [...TABS] : ['Workflows', 'Audit records'];
  const [tab, setTab] = useState<Tab>(available[0]!);
  return (
    <>
      <PageHeader title="Administration" description="Tenant configuration, organisation, roles, workflow definitions and the audit trail." />
      <div role="tablist" aria-label="Administration sections" className="mb-6 flex flex-wrap gap-1 border-b border-line">
        {available.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px rounded-t-md border-b-2 px-4 py-2 text-sm font-medium ${tab === t ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-muted hover:text-ink'}`}>
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab}>
        {tab === 'Organisation' && <Organisation />}
        {tab === 'Roles and members' && <RolesAndMembers />}
        {tab === 'Workflows' && <Workflows />}
        {tab === 'Audit records' && <Audit />}
      </div>
    </>
  );
}
