'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ActionButton, money, PackInactive, usePackActive } from '@/components/module-kit';
import { Badge, Button, Card, type Column, DataTable, Dialog, Field, InlineError, PageHeader, QueryView, StatusBadge, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime } from '@/lib/format';

const BUYERS = ['procurement_officer', 'tenant_admin'];
const BUDGET_SETTERS = ['tenant_admin', 'department_head'];
const KEYS = [['sourcing'], ['procurement']];

function NewRfq({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const items = useQuery({ queryKey: ['procurement', 'items'], queryFn: () => api<any[]>('/api/procurement/items'), enabled: open });
  const suppliers = useQuery({ queryKey: ['procurement', 'suppliers'], queryFn: () => api<any[]>('/api/procurement/suppliers'), enabled: open });
  const centres = useQuery({ queryKey: ['sourcing', 'centres'], queryFn: () => api<any[]>('/api/procurement/cost-centres'), enabled: open });
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('MAIN-STORE');
  const [centre, setCentre] = useState('');
  const [respondBy, setRespondBy] = useState(new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10));
  const [lines, setLines] = useState([{ sku: '', quantity: '1' }]);
  const [invited, setInvited] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () =>
      api('/api/procurement/rfqs', {
        method: 'POST',
        body: { title, delivery_location: location, cost_centre_code: centre || null, respond_by: respondBy, lines: lines.filter((l) => l.sku).map((l) => ({ sku: l.sku, quantity: Number(l.quantity) })), supplier_codes: invited },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['sourcing'] });
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="New request for quotation" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="rfq">Create</Button></>}>
      <form id="rfq" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <p className="text-xs text-ink-muted">TITAN does not contact suppliers: send the request yourself and record the quotations you receive.</p>
        <Field label="Title" required>{(p) => <input {...p} className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Deliver to">{(p) => <input {...p} className={inputClass} value={location} onChange={(e) => setLocation(e.target.value.toUpperCase())} />}</Field>
          <Field label="Cost centre">{(p) => <select {...p} className={inputClass} value={centre} onChange={(e) => setCentre(e.target.value)}><option value="">None</option>{(centres.data ?? []).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select>}</Field>
          <Field label="Answers by">{(p) => <input {...p} type="date" className={inputClass} value={respondBy} onChange={(e) => setRespondBy(e.target.value)} />}</Field>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_6rem] gap-2">
            <Field label={`Item ${i + 1}`}>{(p) => <select {...p} className={inputClass} value={l.sku} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))}><option value="">Choose…</option>{(items.data ?? []).map((it) => <option key={it.sku} value={it.sku}>{it.sku} · {it.name}</option>)}</select>}</Field>
            <Field label="Quantity">{(p) => <input {...p} type="number" min="0" step="any" className={inputClass} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />}</Field>
          </div>
        ))}
        <Button type="button" onClick={() => setLines([...lines, { sku: '', quantity: '1' }])}>Add line</Button>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Invite suppliers</legend>
          {(suppliers.data ?? []).map((s) => (
            <label key={s.code} className="mr-4 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={invited.includes(s.code)} onChange={(e) => setInvited(e.target.checked ? [...invited, s.code] : invited.filter((x) => x !== s.code))} /> {s.code}</label>
          ))}
        </fieldset>
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

function RfqDetail({ id }: { id: string }) {
  const { hasRole } = useAuth();
  const buyer = hasRole(...BUYERS);
  const rfq = useQuery({ queryKey: ['sourcing', 'rfq', id], queryFn: () => api<any>(`/api/procurement/rfqs/${id}`) });
  const [supplier, setSupplier] = useState('');
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [lead, setLead] = useState('');
  const [reason, setReason] = useState('');
  const [awarded, setAwarded] = useState<any>(null);
  return (
    <Card title="Request for quotation">
      <QueryView query={rfq} what="The request for quotation">
        {(r) => (
          <div className="space-y-4 text-sm">
            <h2 className="text-base font-semibold">{r.reference_no} · {r.title} <StatusBadge status={r.status} /></h2>
            <p className="text-ink-muted">Deliver to {r.delivery_location} · answers by {r.respond_by} · invited: {r.invited.map((s: any) => s.code).join(', ')}</p>
            <table className="w-full text-left">
              <thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Catalogue price</th>{r.quotations.map((q: any) => <th key={q.id}>{q.supplier_code}{q.lowest ? ' (lowest)' : ''}</th>)}</tr></thead>
              <tbody>
                {r.lines.map((l: any) => (
                  <tr key={l.line_no}>
                    <td>{l.line_no}</td><td>{l.sku} · {l.name}</td><td>{l.quantity} {l.unit}</td><td>{money(l.unit_cost, l.currency)}</td>
                    {r.quotations.map((q: any) => <td key={q.id}>{money(q.lines.find((x: any) => x.line_no === l.line_no)?.unit_cost, q.currency)}</td>)}
                  </tr>
                ))}
                <tr className="font-semibold"><td colSpan={4}>Total</td>{r.quotations.map((q: any) => <td key={q.id}>{money(q.total_amount, q.currency)}{q.lead_time_days !== null ? ` · ${q.lead_time_days} d` : ''}</td>)}</tr>
              </tbody>
            </table>
            {r.status === 'open' && buyer && (
              <>
                <fieldset className="space-y-2 rounded border border-line p-3">
                  <legend className="px-1 font-medium">Record a quotation</legend>
                  <Field label="Supplier">{(p) => <select {...p} className={inputClass} value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">Choose…</option>{r.invited.map((s: any) => <option key={s.code} value={s.code}>{s.code}</option>)}</select>}</Field>
                  {r.lines.map((l: any) => (
                    <Field key={l.line_no} label={`Unit price, line ${l.line_no} (${l.sku})`}>{(p) => <input {...p} type="number" min="0" step="0.01" className={inputClass} value={prices[l.line_no] ?? ''} onChange={(e) => setPrices({ ...prices, [l.line_no]: e.target.value })} />}</Field>
                  ))}
                  <Field label="Lead time (days)">{(p) => <input {...p} type="number" min="0" className={inputClass} value={lead} onChange={(e) => setLead(e.target.value)} />}</Field>
                  <ActionButton
                    disabled={!supplier}
                    invalidate={KEYS}
                    run={() => api(`/api/procurement/rfqs/${id}/quotations`, { method: 'POST', body: { supplier_code: supplier, currency: 'USD', lead_time_days: lead === '' ? null : Number(lead), lines: r.lines.map((l: any) => ({ line_no: l.line_no, unit_cost: Number(prices[l.line_no]) })) } })}
                    onDone={() => setPrices({})}
                  >
                    Save quotation
                  </ActionButton>
                </fieldset>
                {r.quotations.length > 0 && (
                  <fieldset className="space-y-2 rounded border border-line p-3">
                    <legend className="px-1 font-medium">Award</legend>
                    <Field label="Reason (needed when not awarding the lowest)">{(p) => <input {...p} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
                    <div className="flex flex-wrap gap-2">
                      {r.quotations.map((q: any) => (
                        <ActionButton key={q.id} variant={q.lowest ? 'primary' : 'secondary'} invalidate={KEYS} run={() => api(`/api/procurement/rfqs/${id}/award`, { method: 'POST', body: { quotation_id: q.id, reason } })} onDone={setAwarded}>
                          Award {q.supplier_code} ({money(q.total_amount, q.currency)})
                        </ActionButton>
                      ))}
                    </div>
                  </fieldset>
                )}
              </>
            )}
            {awarded && <p role="status" className="rounded bg-slate-50 p-2">Purchase request {awarded.purchase_request.reference_no} raised for {money(awarded.purchase_request.total_amount)}{awarded.purchase_request.over_budget ? '; it exceeds the cost centre budget and needs the over-budget approval' : ''}.</p>}
            {r.award?.purchase_request_id && <p><a className="text-brand-700 hover:underline" href={`/procurement/?request=${r.award.purchase_request_id}`}>Open the purchase request</a></p>}
          </div>
        )}
      </QueryView>
    </Card>
  );
}

export default function SourcingPage() {
  const active = usePackActive('procurement-inventory');
  const { hasRole } = useAuth();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [budget, setBudget] = useState<Record<string, string>>({});
  const enabled = active === true;
  const rfqs = useQuery({ queryKey: ['sourcing', 'rfqs'], queryFn: () => api<any[]>('/api/procurement/rfqs'), enabled });
  const centres = useQuery({ queryKey: ['sourcing', 'centres'], queryFn: () => api<any[]>('/api/procurement/cost-centres'), enabled });
  if (active === false) return <PackInactive title="Sourcing and budgets" pack="procurement and stores" />;
  const rfqColumns: Column<any>[] = [
    { key: 'ref', header: 'Request for quotation', value: (r) => r.reference_no, cell: (r) => <button className="font-medium text-brand-700 hover:underline" onClick={() => setOpen(r.id)}>{r.reference_no}</button> },
    { key: 'title', header: 'Title', value: (r) => r.title, cell: (r) => r.title },
    { key: 'status', header: 'Status', value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'quotes', header: 'Quotations', value: (r) => r.quotations, cell: (r) => `${r.quotations} of ${r.invited}` },
    { key: 'lowest', header: 'Lowest', value: (r) => Number(r.lowest_total ?? 0), cell: (r) => money(r.lowest_total), align: 'right' },
    { key: 'pr', header: 'Purchase request', value: (r) => r.purchase_request_reference ?? '', cell: (r) => r.purchase_request_reference ?? '—' },
    { key: 'when', header: 'Created', value: (r) => r.created_at, cell: (r) => dateTime(r.created_at) },
  ];
  const ccColumns: Column<any>[] = [
    { key: 'code', header: 'Cost centre', value: (c) => c.code, cell: (c) => <span><span className="font-medium">{c.code}</span> {c.name}</span> },
    { key: 'budget', header: `Budget ${new Date().getUTCFullYear()}`, value: (c) => Number(c.budget ?? -1), cell: (c) => (c.budget === null ? 'Not set' : money(c.budget, c.currency)), align: 'right' },
    { key: 'committed', header: 'Committed', value: (c) => Number(c.committed), cell: (c) => money(c.committed, c.currency ?? 'USD'), align: 'right' },
    { key: 'left', header: 'Available', value: (c) => Number(c.available ?? 0), cell: (c) => (c.available === null ? '—' : <Badge tone={c.available < 0 ? 'danger' : c.available < c.budget * 0.1 ? 'warn' : 'ok'}>{money(c.available, c.currency)}</Badge>), align: 'right' },
    ...(hasRole(...BUDGET_SETTERS)
      ? [{
          key: 'set', header: 'Set budget', cell: (c: any) => (
            <span className="flex gap-1">
              <input aria-label={`New budget for ${c.code}`} type="number" min="0" className={`${inputClass} w-28`} value={budget[c.code] ?? ''} onChange={(e) => setBudget({ ...budget, [c.code]: e.target.value })} />
              <ActionButton disabled={!budget[c.code]} invalidate={KEYS} run={() => api(`/api/procurement/cost-centres/${c.code}/budget`, { method: 'PUT', body: { year: new Date().getUTCFullYear(), amount: Number(budget[c.code]), currency: 'USD' } })}>Save</ActionButton>
            </span>
          ),
        }]
      : []),
  ];
  return (
    <>
      <PageHeader
        title="Sourcing and budgets"
        description="Compare quotations and award the best one; the award becomes a purchase request charged to its cost centre. A request that would exceed the budget needs an extra approval."
        actions={hasRole(...BUYERS) && <Button variant="primary" onClick={() => setCreating(true)}>New request for quotation</Button>}
      />
      <div className="space-y-6">
        {open && <RfqDetail id={open} />}
        <Card title="Requests for quotation" padded={false}><QueryView query={rfqs} what="Requests for quotation">{(rows) => <DataTable caption="Requests for quotation" columns={rfqColumns} rows={rows} rowKey={(r) => r.id} emptyTitle="None yet" />}</QueryView></Card>
        <Card title="Cost centres and budgets" padded={false}><QueryView query={centres} what="Cost centres">{(rows) => <DataTable caption="Cost centres" columns={ccColumns} rows={rows} rowKey={(c) => c.id} emptyTitle="No cost centres" />}</QueryView></Card>
      </div>
      <NewRfq open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
