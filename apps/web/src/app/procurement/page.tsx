'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { ActionButton, money, PackInactive, usePackActive } from '@/components/module-kit';
import { Badge, Button, Card, type Column, DataTable, Dialog, Field, InlineError, KeyValue, PageHeader, QueryView, Stat, StatusBadge, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, dateTime, titleCase } from '@/lib/format';

const BUYERS = ['procurement_officer', 'tenant_admin'];
const STORES = ['storekeeper', 'procurement_officer', 'tenant_admin'];
const REQUESTERS = ['procurement_officer', 'storekeeper', 'maintenance_planner', 'facility_manager', 'tenant_admin'];
const KEYS = [['procurement']];

function RequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const suppliers = useQuery({ queryKey: ['procurement', 'suppliers'], queryFn: () => api<any[]>('/api/procurement/suppliers'), enabled: open });
  const items = useQuery({ queryKey: ['procurement', 'items'], queryFn: () => api<any[]>('/api/procurement/items'), enabled: open });
  const [form, setForm] = useState({ title: '', justification: '', supplier_code: '', delivery_location: 'MAIN-STORE' });
  const [lines, setLines] = useState([{ sku: '', quantity: '1' }]);
  const create = useMutation({
    mutationFn: () =>
      api('/api/procurement/purchase-requests', {
        method: 'POST',
        body: { ...form, supplier_code: form.supplier_code || suppliers.data?.[0]?.code, lines: lines.filter((l) => l.sku).map((l) => ({ sku: l.sku, quantity: Number(l.quantity) })) },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['procurement'] });
      setLines([{ sku: '', quantity: '1' }]);
      onClose();
    },
  });
  const total = lines.reduce((sum, l) => sum + Number(l.quantity || 0) * Number(items.data?.find((i) => i.sku === l.sku)?.unit_cost ?? 0), 0);
  return (
    <Dialog open={open} onClose={onClose} title="New purchase request" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-pr" disabled={create.isPending}>Submit for approval</Button></>}>
      <form id="new-pr" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <Field label="Title" required>{(p) => <input {...p} className={inputClass} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}</Field>
        <Field label="Justification">{(p) => <textarea {...p} rows={2} className={inputClass} value={form.justification} onChange={(e) => setForm({ ...form, justification: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Supplier" required>
            {(p) => <select {...p} className={inputClass} value={form.supplier_code} onChange={(e) => setForm({ ...form, supplier_code: e.target.value })}>{(suppliers.data ?? []).map((s) => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}</select>}
          </Field>
          <Field label="Deliver to (store)" required>{(p) => <input {...p} className={inputClass} value={form.delivery_location} onChange={(e) => setForm({ ...form, delivery_location: e.target.value.toUpperCase() })} />}</Field>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_6rem] gap-2">
            <Field label={`Item ${i + 1}`}>
              {(p) => (
                <select {...p} className={inputClass} value={l.sku} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))}>
                  <option value="">Choose…</option>
                  {(items.data ?? []).map((it) => <option key={it.sku} value={it.sku}>{it.sku} · {it.name} ({money(it.unit_cost, it.currency)}/{it.unit})</option>)}
                </select>
              )}
            </Field>
            <Field label="Quantity">{(p) => <input {...p} type="number" min="0" step="any" className={inputClass} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />}</Field>
          </div>
        ))}
        <div className="flex items-center justify-between text-sm">
          <Button type="button" onClick={() => setLines([...lines, { sku: '', quantity: '1' }])}>Add line</Button>
          <span>Estimated total <strong>{money(total)}</strong>{total >= 5000 ? ' · needs budget approval' : ''}</span>
        </div>
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

function StockDialog({ item, mode, onClose }: { item: any | null; mode: 'issue' | 'adjust'; onClose: () => void }) {
  const client = useQueryClient();
  const [location, setLocation] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<any>(null);
  const run = useMutation({
    mutationFn: () =>
      mode === 'issue'
        ? api('/api/procurement/stock/issue', { method: 'POST', body: { sku: item.sku, location, quantity: Number(quantity), reference_type: reference ? 'work_order' : 'other', reference_id: reference || null, note } })
        : api('/api/procurement/stock/adjust', { method: 'POST', body: { sku: item.sku, location, counted: Number(quantity), note } }),
    onSuccess: async (r) => {
      setResult(r);
      await client.invalidateQueries({ queryKey: ['procurement'] });
    },
  });
  const close = () => {
    setResult(null);
    setQuantity('');
    onClose();
  };
  return (
    <Dialog open={!!item} onClose={close} title={`${mode === 'issue' ? 'Issue' : 'Count'} ${item?.sku ?? ''}`} footer={<><Button onClick={close}>Close</Button><Button variant="primary" type="submit" form="stock" disabled={run.isPending || !!result}>{mode === 'issue' ? 'Issue stock' : 'Record count'}</Button></>}>
      <form id="stock" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }}>
        <Field label="Store" required>
          {(p) => (
            <>
              <input {...p} list="stores" className={inputClass} value={location} onChange={(e) => setLocation(e.target.value.toUpperCase())} />
              <datalist id="stores">{(item?.locations ?? []).map((l: any) => <option key={l.location} value={l.location}>{l.on_hand} on hand</option>)}</datalist>
            </>
          )}
        </Field>
        <Field label={mode === 'issue' ? `Quantity (${item?.unit})` : `Counted quantity (${item?.unit})`} required>{(p) => <input {...p} type="number" min="0" step="any" className={inputClass} value={quantity} onChange={(e) => setQuantity(e.target.value)} />}</Field>
        {mode === 'issue' && <Field label="Work order reference" hint="Optional.">{(p) => <input {...p} className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>}
        <Field label="Note" required={mode === 'adjust'}>{(p) => <input {...p} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <InlineError error={run.error} />
        {result && (
          <p className="rounded bg-slate-50 p-2 text-sm" role="status">
            {result.sku} at {result.location}: {result.on_hand} on hand.{result.replenishment_request ? ` Replenishment request ${result.replenishment_request} raised automatically.` : ''}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function RequestDetail({ id }: { id: string }) {
  const pr = useQuery({ queryKey: ['procurement', 'request', id], queryFn: () => api<any>(`/api/procurement/purchase-requests/${id}`), refetchInterval: 10_000 });
  const { user, hasRole } = useAuth();
  return (
    <Card title="Purchase request">
      <QueryView query={pr} what="The request">
        {(r) => (
          <div className="space-y-3 text-sm">
            <h2 className="text-base font-semibold">{r.reference_no} · {r.title} <StatusBadge status={r.status} /></h2>
            <KeyValue items={[
              ['Supplier', `${r.supplier.code} · ${r.supplier.name}`],
              ['Total', money(r.total_amount, r.currency)],
              ['Deliver to', r.delivery_location],
              ['Raised', `${r.requested_by_username ?? (r.origin_type === 'low_stock' ? 'Automatically (low stock)' : 'System')} · ${dateTime(r.submitted_at)}`],
              ['Decided', r.decided_at ? dateTime(r.decided_at) : 'Waiting for approval (see the work inbox)'],
              ['Purchase order', r.purchase_order ? `${r.purchase_order.reference_no} · ${titleCase(r.purchase_order.status)}` : '—'],
            ]} />
            {r.justification && <p className="text-ink-muted">{r.justification}</p>}
            <table className="w-full text-left"><thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Unit cost</th><th>Line total</th></tr></thead>
              <tbody>{r.lines.map((l: any) => <tr key={l.line_no}><td>{l.line_no}</td><td>{l.sku} · {l.name}</td><td>{l.quantity} {l.unit}</td><td>{money(l.unit_cost, r.currency)}</td><td>{money(l.line_total, r.currency)}</td></tr>)}</tbody>
            </table>
            {r.status === 'submitted' && (r.requested_by === user?.id || hasRole(...BUYERS)) && (
              <ActionButton variant="danger" invalidate={KEYS} confirm="Cancel this purchase request?" run={() => api(`/api/procurement/purchase-requests/${id}/cancel`, { method: 'POST' })}>Cancel request</ActionButton>
            )}
          </div>
        )}
      </QueryView>
    </Card>
  );
}

function OrderDetail({ id }: { id: string }) {
  const { hasRole } = useAuth();
  const order = useQuery({ queryKey: ['procurement', 'order', id], queryFn: () => api<any>(`/api/procurement/purchase-orders/${id}`) });
  const [qty, setQty] = useState<Record<number, string>>({});
  return (
    <Card title="Purchase order">
      <QueryView query={order} what="The order">
        {(o) => (
          <div className="space-y-3 text-sm">
            <h2 className="text-base font-semibold">{o.reference_no} · {o.title} <StatusBadge status={o.status} /></h2>
            <p className="text-ink-muted">Internal record: TITAN does not send orders to suppliers. {o.supplier_code} · {o.supplier_name} · deliver to {o.delivery_location} · {money(o.total_amount, o.currency)}</p>
            <table className="w-full text-left"><thead><tr><th>#</th><th>Item</th><th>Ordered</th><th>Received</th>{o.status !== 'received' && hasRole(...STORES) && <th>Receive now</th>}</tr></thead>
              <tbody>
                {o.lines.map((l: any) => (
                  <tr key={l.line_no}>
                    <td>{l.line_no}</td><td>{l.sku} · {l.name}</td><td>{l.quantity_ordered}</td><td>{l.quantity_received}</td>
                    {o.status !== 'received' && hasRole(...STORES) && (
                      <td><input aria-label={`Receive quantity for line ${l.line_no}`} type="number" min="0" step="any" className={`${inputClass} w-24`} value={qty[l.line_no] ?? ''} onChange={(e) => setQty({ ...qty, [l.line_no]: e.target.value })} /></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {o.status !== 'received' && o.status !== 'cancelled' && hasRole(...STORES) && (
              <ActionButton
                variant="primary"
                invalidate={KEYS}
                disabled={!Object.values(qty).some((v) => Number(v) > 0)}
                run={() => api(`/api/procurement/purchase-orders/${id}/receive`, { method: 'POST', body: { lines: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([k, v]) => ({ line_no: Number(k), quantity: Number(v) })) } })}
                onDone={() => setQty({})}
              >
                Record goods receipt
              </ActionButton>
            )}
            {o.receipts.length > 0 && <ul>{o.receipts.map((r: any) => <li key={r.id}>{r.reference_no} · {dateTime(r.received_at)} · {r.received_by}{r.note ? ` · ${r.note}` : ''}</li>)}</ul>}
          </div>
        )}
      </QueryView>
    </Card>
  );
}

function Content() {
  const active = usePackActive('procurement-inventory');
  const router = useRouter();
  const params = useSearchParams();
  const { hasRole } = useAuth();
  const [raising, setRaising] = useState(false);
  const [stock, setStock] = useState<{ item: any; mode: 'issue' | 'adjust' } | null>(null);
  const requestId = params.get('request');
  const orderId = params.get('order');
  const enabled = active === true;
  const summary = useQuery({ queryKey: ['procurement', 'summary'], queryFn: () => api<any>('/api/procurement/summary'), enabled, refetchInterval: 30_000 });
  const items = useQuery({ queryKey: ['procurement', 'items'], queryFn: () => api<any[]>('/api/procurement/items'), enabled });
  const requests = useQuery({ queryKey: ['procurement', 'requests'], queryFn: () => api<any[]>('/api/procurement/purchase-requests'), enabled, refetchInterval: 15_000 });
  const orders = useQuery({ queryKey: ['procurement', 'orders'], queryFn: () => api<any[]>('/api/procurement/purchase-orders'), enabled });
  if (active === false) return <PackInactive title="Procurement and stores" pack="procurement and stores" />;

  const itemColumns: Column<any>[] = [
    { key: 'sku', header: 'SKU', value: (i) => i.sku, cell: (i) => <span className="font-medium">{i.sku}</span> },
    { key: 'name', header: 'Item', value: (i) => i.name, cell: (i) => i.name },
    { key: 'onhand', header: 'On hand', value: (i) => Number(i.on_hand), cell: (i) => `${i.on_hand} ${i.unit}`, align: 'right' },
    { key: 'stores', header: 'By store', value: (i) => i.locations.map((l: any) => l.location).join(' '), cell: (i) => i.locations.map((l: any) => <span key={l.location} className="mr-2">{l.location}: {l.on_hand}{Number(i.reorder_level) > 0 && Number(l.on_hand) <= Number(i.reorder_level) ? <Badge tone="warn">low</Badge> : null}</span>) },
    { key: 'reorder', header: 'Reorder at', value: (i) => Number(i.reorder_level), cell: (i) => (Number(i.reorder_level) > 0 ? `${i.reorder_level} → +${i.reorder_quantity}` : '—') },
    { key: 'cost', header: 'Unit cost', value: (i) => Number(i.unit_cost), cell: (i) => money(i.unit_cost, i.currency), align: 'right' },
    ...(hasRole(...STORES)
      ? [{ key: 'act', header: 'Stock', cell: (i: any) => <span className="flex gap-1"><Button onClick={() => setStock({ item: i, mode: 'issue' })}>Issue</Button><Button onClick={() => setStock({ item: i, mode: 'adjust' })}>Count</Button></span> }]
      : []),
  ];
  const requestColumns: Column<any>[] = [
    { key: 'ref', header: 'Request', value: (r) => r.reference_no, cell: (r) => <button className="font-medium text-brand-700 hover:underline" onClick={() => router.replace(`/procurement/?request=${r.id}`)}>{r.reference_no}</button> },
    { key: 'title', header: 'Title', value: (r) => r.title, cell: (r) => r.title },
    { key: 'total', header: 'Total', value: (r) => Number(r.total_amount), cell: (r) => money(r.total_amount, r.currency), align: 'right' },
    { key: 'status', header: 'Status', value: (r) => r.status, cell: (r) => <span><StatusBadge status={r.status} />{r.over_budget ? <Badge tone="danger">Over budget</Badge> : null}</span> },
    { key: 'cc', header: 'Cost centre', value: (r) => r.cost_centre_code ?? '', cell: (r) => r.cost_centre_code ?? '—' },
    { key: 'origin', header: 'Raised by', value: (r) => r.requested_by_username ?? r.origin_type, cell: (r) => r.requested_by_username ?? (r.origin_type === 'low_stock' ? <Badge tone="info">Low stock (automatic)</Badge> : '—') },
    { key: 'po', header: 'Order', value: (r) => r.purchase_order_reference ?? '', cell: (r) => (r.purchase_order_id ? <button className="text-brand-700 hover:underline" onClick={() => router.replace(`/procurement/?order=${r.purchase_order_id}`)}>{r.purchase_order_reference}</button> : '—') },
    { key: 'when', header: 'Submitted', value: (r) => r.submitted_at, cell: (r) => ago(r.submitted_at) },
  ];
  const orderColumns: Column<any>[] = [
    { key: 'ref', header: 'Order', value: (o) => o.reference_no, cell: (o) => <button className="font-medium text-brand-700 hover:underline" onClick={() => router.replace(`/procurement/?order=${o.id}`)}>{o.reference_no}</button> },
    { key: 'title', header: 'Title', value: (o) => o.title, cell: (o) => o.title },
    { key: 'supplier', header: 'Supplier', value: (o) => o.supplier_code, cell: (o) => o.supplier_code },
    { key: 'status', header: 'Status', value: (o) => o.status, cell: (o) => <StatusBadge status={o.status} /> },
    { key: 'total', header: 'Total', value: (o) => Number(o.total_amount), cell: (o) => money(o.total_amount, o.currency), align: 'right' },
    { key: 'issued', header: 'Issued', value: (o) => o.issued_at, cell: (o) => ago(o.issued_at) },
  ];
  const waiting = (summary.data?.requests ?? []).find((r: any) => r.status === 'submitted');
  return (
    <>
      <PageHeader
        title="Procurement and stores"
        description="Stock per store, purchase requests and their approval, purchase orders (internal records) and goods receipts. Stock at or below its reorder level raises a replenishment request automatically."
        actions={<span className="flex gap-2"><a className="rounded-md border border-line bg-white px-3 py-1.5 text-sm shadow-sm hover:bg-slate-50" href="/procurement/sourcing/">Sourcing and budgets</a>{hasRole(...REQUESTERS) && <Button variant="primary" onClick={() => setRaising(true)}>New purchase request</Button>}</span>}
      />
      <dl className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Requests awaiting approval" value={waiting?.count ?? 0} hint={waiting ? money(waiting.total) : undefined} />
        <Stat label="Open orders" value={(summary.data?.orders ?? []).filter((o: any) => o.status !== 'received' && o.status !== 'cancelled').reduce((n: number, o: any) => n + o.count, 0)} />
        <Stat label="Low stock lines" value={summary.data?.low_stock?.length ?? 0} tone={summary.data?.low_stock?.length ? 'warn' : 'neutral'} />
        <Stat label="Stock value" value={money(summary.data?.stock_value)} />
      </dl>
      {(requestId || orderId) && <div className="mb-6">{requestId ? <RequestDetail id={requestId} /> : <OrderDetail id={orderId!} />}</div>}
      <div className="space-y-6">
        <Card title="Purchase requests" padded={false}><QueryView query={requests} what="Requests">{(rows) => <DataTable caption="Purchase requests" columns={requestColumns} rows={rows} rowKey={(r) => r.id} emptyTitle="No requests" />}</QueryView></Card>
        <Card title="Purchase orders" padded={false}><QueryView query={orders} what="Orders">{(rows) => <DataTable caption="Purchase orders" columns={orderColumns} rows={rows} rowKey={(o) => o.id} emptyTitle="No orders yet" />}</QueryView></Card>
        <Card title="Items and stock" padded={false}><QueryView query={items} what="Items">{(rows) => <DataTable caption="Items" columns={itemColumns} rows={rows} rowKey={(i) => i.id} emptyTitle="No items" />}</QueryView></Card>
      </div>
      <RequestDialog open={raising} onClose={() => setRaising(false)} />
      <StockDialog item={stock?.item ?? null} mode={stock?.mode ?? 'issue'} onClose={() => setStock(null)} />
    </>
  );
}

export default function ProcurementPage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}
