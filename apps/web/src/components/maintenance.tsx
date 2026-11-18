'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, dateTime, titleCase } from '@/lib/format';
import { SchemaFields } from './fields';
import { Badge, Button, Card, type Column, DataTable, Dialog, Field, InlineError, KeyValue, QueryView, StatusBadge, inputClass } from './ui';

export const PLANNING_ROLES = ['maintenance_planner', 'facility_manager', 'tenant_admin'];
const PRIORITY_TONE: Record<string, 'danger' | 'warn' | 'info' | 'neutral'> = { urgent: 'danger', high: 'warn', normal: 'info', low: 'neutral' };

export function PriorityBadge({ priority }: { priority: string }) {
  return <Badge tone={PRIORITY_TONE[priority] ?? 'neutral'}>{titleCase(priority)}</Badge>;
}

/** Raise a request of one of the types the tenant's packs installed, with that type's detail fields. */
export function RaiseRequestDialog({ open, onClose, pack }: { open: boolean; onClose: () => void; pack?: string }) {
  const client = useQueryClient();
  const types = useQuery({ queryKey: ['maintenance', 'types'], queryFn: () => api<any[]>('/api/maintenance/request-types'), enabled: open });
  const assets = useQuery({ queryKey: ['assets', 'list', pack ?? ''], queryFn: () => api<any[]>(`/api/asset/assets?limit=500${pack ? `&pack=${pack}` : ''}`), enabled: open, retry: false });
  const usable = (types.data ?? []).filter((t) => t.can_raise && (!pack || t.pack_id === pack));
  const [typeKey, setTypeKey] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('');
  const [assetId, setAssetId] = useState('');
  const [details, setDetails] = useState<Record<string, unknown>>({});
  const type = usable.find((t) => t.key === typeKey) ?? usable[0];

  const raise = useMutation({
    mutationFn: () =>
      api('/api/maintenance/requests', {
        method: 'POST',
        body: { request_type: type.key, title, description, ...(priority ? { priority } : {}), asset_id: assetId || null, details },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['maintenance'] });
      setTitle('');
      setDescription('');
      setDetails({});
      setAssetId('');
      onClose();
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    raise.mutate();
  }

  return (
    <Dialog open={open} onClose={onClose} title="Raise a request" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="raise-request" disabled={!type}>Submit request</Button></>}>
      {types.isSuccess && usable.length === 0 ? (
        <p className="text-sm text-ink-muted">Your roles cannot raise any type of request.</p>
      ) : (
        <form id="raise-request" onSubmit={submit} className="space-y-3">
          <Field label="Type of request" required>
            {(p) => (
              <select {...p} className={inputClass} value={type?.key ?? ''} onChange={(e) => { setTypeKey(e.target.value); setDetails({}); }}>
                {usable.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
              </select>
            )}
          </Field>
          {type?.description && <p className="text-xs text-ink-muted">{type.description}</p>}
          <Field label="Title" required>{(p) => <input {...p} className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}</Field>
          <Field label="Description">{(p) => <textarea {...p} className={inputClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />}</Field>
          <Field label="Priority" hint={type ? `Default: ${type.default_priority}` : undefined}>
            {(p) => (
              <select {...p} className={inputClass} value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="">Default</option>
                {['low', 'normal', 'high', 'urgent'].map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
              </select>
            )}
          </Field>
          {assets.isSuccess && (
            <Field label="Asset" hint="Optional.">
              {(p) => (
                <select {...p} className={inputClass} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                  <option value="">None</option>
                  {assets.data.filter((a) => a.status !== 'retired').map((a) => <option key={a.id} value={a.id}>{a.code}: {a.name}</option>)}
                </select>
              )}
            </Field>
          )}
          {type?.detail_fields?.length > 0 && <SchemaFields fields={type.detail_fields} values={details} onChange={setDetails} />}
          <InlineError error={raise.error} />
        </form>
      )}
    </Dialog>
  );
}

export function RequestsTable({ pack, title = 'Requests' }: { pack?: string; title?: string }) {
  const requests = useQuery({ queryKey: ['maintenance', 'requests', pack ?? ''], queryFn: () => api<any[]>(`/api/maintenance/requests?limit=200${pack ? `&pack=${pack}` : ''}`), refetchInterval: 15_000 });
  const columns: Column<any>[] = [
    { key: 'ref', header: 'Reference', value: (r) => r.reference_no, cell: (r) => <Link className="font-medium text-brand-700 hover:underline" href={`/maintenance/request/?id=${r.id}`}>{r.reference_no}</Link> },
    { key: 'title', header: 'Title', value: (r) => r.title, cell: (r) => r.title },
    { key: 'type', header: 'Type', value: (r) => r.request_type, cell: (r) => titleCase(r.request_type) },
    { key: 'priority', header: 'Priority', value: (r) => r.priority, cell: (r) => <PriorityBadge priority={r.priority} /> },
    { key: 'status', header: 'Status', value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'asset', header: 'Asset', value: (r) => r.asset_code ?? '', cell: (r) => r.asset_code ?? '—' },
    { key: 'origin', header: 'Raised by', value: (r) => r.requested_by_username ?? r.origin_type, cell: (r) => r.requested_by_username ?? (r.origin_type === 'incident' ? 'Incident (automatic)' : '—') },
    { key: 'wo', header: 'Work order', value: (r) => r.work_order_reference ?? '', cell: (r) => (r.work_order_id ? <Link className="text-brand-700 hover:underline" href={`/maintenance/order/?id=${r.work_order_id}`}>{r.work_order_reference} · {titleCase(r.work_order_status)}</Link> : '—') },
    { key: 'submitted', header: 'Submitted', value: (r) => r.submitted_at, cell: (r) => ago(r.submitted_at) },
  ];
  return (
    <Card title={title} padded={false}>
      <QueryView query={requests} what="Requests">
        {(rows) => <DataTable caption={title} columns={columns} rows={rows} rowKey={(r) => r.id} emptyTitle="No requests" />}
      </QueryView>
    </Card>
  );
}

export function WorkOrdersTable({ pack, mine = false, title = 'Work orders' }: { pack?: string; mine?: boolean; title?: string }) {
  const [status, setStatus] = useState('active');
  const orders = useQuery({
    queryKey: ['maintenance', 'work-orders', pack ?? '', mine, status],
    queryFn: () => api<any[]>(`/api/maintenance/work-orders?limit=200${status ? `&status=${status}` : ''}${pack ? `&pack=${pack}` : ''}${mine ? '&mine=true' : ''}`),
    refetchInterval: 15_000,
  });
  const columns: Column<any>[] = [
    { key: 'ref', header: 'Reference', value: (w) => w.reference_no, cell: (w) => <Link className="font-medium text-brand-700 hover:underline" href={`/maintenance/order/?id=${w.id}`}>{w.reference_no}</Link> },
    { key: 'title', header: 'Title', value: (w) => w.title, cell: (w) => w.title },
    { key: 'priority', header: 'Priority', value: (w) => w.priority, cell: (w) => <PriorityBadge priority={w.priority} /> },
    { key: 'status', header: 'Status', value: (w) => w.status, cell: (w) => <StatusBadge status={w.status} /> },
    { key: 'asset', header: 'Asset', value: (w) => w.asset_code ?? '', cell: (w) => w.asset_code ?? '—' },
    { key: 'assignee', header: 'Assigned to', value: (w) => w.assignee_username ?? '', cell: (w) => w.assignee_username ?? 'Not assigned' },
    { key: 'industry', header: 'Industry', value: (w) => w.pack_id, cell: (w) => titleCase(w.pack_id), defaultHidden: !!pack },
    { key: 'created', header: 'Created', value: (w) => w.created_at, cell: (w) => ago(w.created_at) },
  ];
  const selectId = `wo-status-${pack ?? 'all'}-${mine ? 'mine' : 'any'}`;
  return (
    <Card title={title} padded={false}>
      <QueryView query={orders} what="Work orders">
        {(rows) => (
          <DataTable
            caption={title}
            columns={columns}
            rows={rows}
            rowKey={(w) => w.id}
            emptyTitle="No work orders"
            toolbar={
              <>
                <label className="sr-only" htmlFor={selectId}>Status</label>
                <select id={selectId} value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputClass} w-auto`}>
                  <option value="active">Not completed</option>
                  <option value="">All</option>
                  {['open', 'assigned', 'in_progress', 'completed', 'cancelled'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
                </select>
              </>
            }
          />
        )}
      </QueryView>
    </Card>
  );
}

/** Work order with the actions the caller's role and the order's state allow. The service checks both again. */
export function WorkOrderDetail({ id }: { id: string }) {
  const client = useQueryClient();
  const { user, hasRole } = useAuth();
  const order = useQuery({ queryKey: ['maintenance', 'order', id], queryFn: () => api(`/api/maintenance/work-orders/${id}`), refetchInterval: 15_000 });
  const members = useQuery({ queryKey: ['tenant', 'memberships'], queryFn: () => api<any[]>('/api/tenant/memberships'), enabled: hasRole('tenant_admin'), retry: false });
  const [assignee, setAssignee] = useState('');
  const [assigneeName, setAssigneeName] = useState('');
  const [summary, setSummary] = useState('');
  const [hours, setHours] = useState('');
  const [condition, setCondition] = useState('');
  const [parts, setParts] = useState<{ sku: string; quantity: string }[]>([]);
  const items = useQuery({ queryKey: ['procurement', 'items'], queryFn: () => api<any[]>('/api/procurement/items'), retry: false });
  const refresh = () => Promise.all(['maintenance', 'assets', 'incident'].map((k) => client.invalidateQueries({ queryKey: [k] })));
  const act = useMutation({ mutationFn: (args: { path: string; body?: unknown }) => api(`/api/maintenance/work-orders/${id}/${args.path}`, { method: 'POST', body: args.body }), onSuccess: refresh });
  const planner = hasRole(...PLANNING_ROLES);

  return (
    <QueryView query={order} what="The work order">
      {(w: any) => {
        const mine = w.assignee_id === user.id;
        return (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card title={`${w.reference_no}: ${w.title}`}>
              <KeyValue
                items={[
                  ['Status', <StatusBadge key="s" status={w.status} />],
                  ['Priority', <PriorityBadge key="p" priority={w.priority} />],
                  ['Request', <Link key="r" className="text-brand-700 hover:underline" href={`/maintenance/request/?id=${w.request.id}`}>{w.request.reference_no} ({titleCase(w.request_type)})</Link>],
                  ['Asset', w.asset ? <Link key="a" className="text-brand-700 hover:underline" href={`/assets/?id=${w.asset.id}`}>{w.asset.code}: {w.asset.name}</Link> : '—'],
                  ['Origin', w.origin_type === 'incident' && w.origin_id ? <Link key="o" className="text-brand-700 hover:underline" href={`/incidents/?id=${w.origin_id}`}>Incident</Link> : titleCase(w.origin_type)],
                  ['Assigned to', w.assignee_username ?? 'Not assigned'],
                  ['Started', dateTime(w.started_at)],
                  ['Completed', dateTime(w.completed_at)],
                  ['Repair time', w.repair_hours === null ? '—' : `${w.repair_hours} h`],
                  ['Labour', w.labor_hours === null ? '—' : `${w.labor_hours} h`],
                  ['Condition after', w.condition_after ? titleCase(w.condition_after) : '—'],
                  ['Estimated', w.estimated_hours === null ? '—' : `${w.estimated_hours} h`],
                  ['Labour cost', w.labor_cost === null ? '—' : `${Number(w.labor_cost).toFixed(2)} ${w.cost_currency} (${w.labor_rate}/h)`],
                  ['Parts cost', w.parts.length ? `${Number(w.parts_cost).toFixed(2)} ${w.cost_currency ?? ''}` : '—'],
                ]}
              />
              {w.checklist.length > 0 && (
                <div className="mt-3"><h3 className="text-sm font-semibold">Checklist (preventive plan)</h3><ul className="list-disc pl-5 text-sm">{w.checklist.map((c: string) => <li key={c}>{c}</li>)}</ul></div>
              )}
              {w.parts.length > 0 && (
                <div className="mt-3"><h3 className="text-sm font-semibold">Parts used</h3><ul className="text-sm">{w.parts.map((x: any, n: number) => <li key={n}>{x.quantity} x {x.sku} from {x.location} · {x.booked ? <Badge tone="ok">Booked out{x.unit_cost !== undefined ? ` at ${x.unit_cost}` : ''}</Badge> : x.error ? <Badge tone="danger">Not booked: {x.error}</Badge> : <Badge>Waiting for stores</Badge>}</li>)}</ul></div>
              )}
              {w.completion_summary && <p className="mt-3 text-sm text-ink">{w.completion_summary}</p>}
            </Card>
            <Card title="Actions">
              <div className="space-y-4">
                {planner && ['open', 'assigned'].includes(w.status) && (
                  <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); act.mutate({ path: 'assign', body: { assignee_id: assignee, assignee_username: assigneeName } }); }}>
                    {members.isSuccess ? (
                      <Field label="Assign to">
                        {(p) => (
                          <select {...p} className={inputClass} value={assignee} onChange={(e) => { setAssignee(e.target.value); setAssigneeName(members.data.find((m) => m.user_id === e.target.value)?.username ?? ''); }}>
                            <option value="">Choose…</option>
                            {members.data.map((m) => <option key={m.user_id} value={m.user_id}>{m.username}{m.title ? ` (${m.title})` : ''}</option>)}
                          </select>
                        )}
                      </Field>
                    ) : (
                      <>
                        <Field label="Technician user id">{(p) => <input {...p} className={inputClass} value={assignee} onChange={(e) => setAssignee(e.target.value)} />}</Field>
                        <Field label="Technician username">{(p) => <input {...p} className={inputClass} value={assigneeName} onChange={(e) => setAssigneeName(e.target.value)} />}</Field>
                      </>
                    )}
                    <Button type="submit" variant="primary" disabled={!assignee || !assigneeName || act.isPending}>{w.status === 'open' ? 'Assign' : 'Re-assign'}</Button>
                  </form>
                )}
                {w.status === 'assigned' && (mine || planner) && <Button variant="primary" onClick={() => act.mutate({ path: 'start' })} disabled={act.isPending}>Start work</Button>}
                {w.status === 'in_progress' && (mine || planner) && (
                  <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); act.mutate({ path: 'complete', body: { summary, labor_hours: hours === '' ? null : Number(hours), condition_after: condition || null, parts: parts.filter((x) => x.sku && Number(x.quantity) > 0).map((x) => ({ sku: x.sku, quantity: Number(x.quantity) })) } }); }}>
                    <Field label="What was done" required>{(p) => <textarea {...p} className={inputClass} rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={4000} />}</Field>
                    <Field label="Labour hours">{(p) => <input {...p} className={inputClass} type="number" min={0} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} />}</Field>
                    <fieldset className="space-y-1">
                      <legend className="text-sm font-medium">Parts used</legend>
                      {items.isError && <p className="text-xs text-ink-muted">Stores are not available for your organisation; parts can still be listed by SKU.</p>}
                      {parts.map((x, i) => (
                        <div key={i} className="flex gap-2">
                          <input aria-label={`Part ${i + 1} SKU`} list="skus" className={inputClass} value={x.sku} placeholder="SKU" onChange={(e) => setParts(parts.map((y, j) => (j === i ? { ...y, sku: e.target.value.toUpperCase() } : y)))} />
                          <input aria-label={`Part ${i + 1} quantity`} type="number" min={0} step="any" className={`${inputClass} w-24`} value={x.quantity} onChange={(e) => setParts(parts.map((y, j) => (j === i ? { ...y, quantity: e.target.value } : y)))} />
                        </div>
                      ))}
                      <datalist id="skus">{(items.data ?? []).map((it) => <option key={it.sku} value={it.sku}>{it.name} ({it.on_hand} on hand)</option>)}</datalist>
                      <Button type="button" onClick={() => setParts([...parts, { sku: '', quantity: '1' }])}>Add part</Button>
                    </fieldset>
                    {w.asset && (
                      <Field label="Asset condition afterwards">
                        {(p) => (
                          <select {...p} className={inputClass} value={condition} onChange={(e) => setCondition(e.target.value)}>
                            <option value="">Unchanged</option>
                            {['good', 'fair', 'poor', 'critical'].map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
                          </select>
                        )}
                      </Field>
                    )}
                    <Button type="submit" variant="primary" disabled={summary.trim().length < 3 || act.isPending}>Complete work order</Button>
                  </form>
                )}
                {planner && ['open', 'assigned', 'in_progress'].includes(w.status) && (
                  <Button variant="danger" onClick={() => { const reason = window.prompt('Reason for cancelling this work order'); if (reason && reason.trim().length >= 3) act.mutate({ path: 'cancel', body: { reason } }); }} disabled={act.isPending}>
                    Cancel work order
                  </Button>
                )}
                {['completed', 'cancelled'].includes(w.status) && <p className="text-sm text-ink-muted">This work order is {w.status}; no further action is possible.</p>}
                {w.status === 'assigned' && !mine && !planner && <p className="text-sm text-ink-muted">Only the assigned technician or a planner can start this work.</p>}
                <InlineError error={act.error} />
              </div>
            </Card>
            <Card title="History" className="xl:col-span-2">
              <ol className="space-y-1 text-sm">
                {w.events.map((e: any, n: number) => (
                  <li key={n}>{dateTime(e.occurred_at)} · <Badge>{titleCase(e.entry_type)}</Badge> {e.message}{e.actor_username ? ` (${e.actor_username})` : ''}</li>
                ))}
              </ol>
            </Card>
          </div>
        );
      }}
    </QueryView>
  );
}

export function RequestDetail({ id }: { id: string }) {
  const client = useQueryClient();
  const { user, hasRole } = useAuth();
  const request = useQuery({ queryKey: ['maintenance', 'request', id], queryFn: () => api(`/api/maintenance/requests/${id}`), refetchInterval: 15_000 });
  const process = useQuery({ queryKey: ['workflow', 'subject', id], queryFn: async () => {
    const r = await api(`/api/maintenance/requests/${id}`);
    return api(`/api/workflow/instances/by-subject/${r.subject_type}/${id}`);
  }, retry: false });
  const cancel = useMutation({ mutationFn: () => api(`/api/maintenance/requests/${id}/cancel`, { method: 'POST' }), onSuccess: () => client.invalidateQueries({ queryKey: ['maintenance'] }) });

  return (
    <QueryView query={request} what="The request">
      {(r: any) => (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title={`${r.reference_no}: ${r.title}`}>
            <KeyValue
              items={[
                ['Type', titleCase(r.request_type)],
                ['Status', <StatusBadge key="s" status={r.status} />],
                ['Priority', <PriorityBadge key="p" priority={r.priority} />],
                ['Raised by', r.requested_by_username ?? (r.origin_type === 'incident' ? 'Automatically, from an incident' : '—')],
                ['Origin', r.origin_type === 'incident' && r.origin_id ? <Link key="o" className="text-brand-700 hover:underline" href={`/incidents/?id=${r.origin_id}`}>Incident</Link> : 'Raised manually'],
                ['Asset', r.asset ? `${r.asset.code}: ${r.asset.name}` : '—'],
                ['Submitted', dateTime(r.submitted_at)],
                ['Decided', dateTime(r.decided_at)],
                ['Work order', r.work_order ? <Link key="w" className="text-brand-700 hover:underline" href={`/maintenance/order/?id=${r.work_order.id}`}>{r.work_order.reference_no} · {titleCase(r.work_order.status)}</Link> : '—'],
                ...Object.entries(r.details ?? {}).map(([k, v]) => [titleCase(k), String(v)] as [string, string]),
              ]}
            />
            {r.description && <p className="mt-3 text-sm text-ink">{r.description}</p>}
            {r.status === 'submitted' && (r.requested_by === user.id || hasRole(...PLANNING_ROLES)) && (
              <div className="mt-4">
                <Button variant="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Withdraw request</Button>
                <InlineError error={cancel.error} />
              </div>
            )}
          </Card>
          <Card title="Approval" description="Decided in the approval process the request type names.">
            {process.isError && <p className="text-sm text-ink-muted">The approval process is not visible to you.</p>}
            {process.data && (
              <ol className="space-y-2 text-sm">
                {process.data.stages.map((s: any) => {
                  const done = process.data.tasks.filter((t: any) => t.stage_key === s.key);
                  const last = done[done.length - 1];
                  return (
                    <li key={s.key} className="flex items-center justify-between gap-2">
                      <span>{s.name} · {titleCase(s.roles.join(', '))}</span>
                      <span>{last ? <StatusBadge status={last.decision ?? last.status} /> : <span className="text-ink-muted">Not reached</span>}{last?.decided_by_username ? ` ${last.decided_by_username}` : ''}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>
      )}
    </QueryView>
  );
}
