'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { Badge, Button, Card, type Column, DataTable, Dialog, Field, InlineError, KeyValue, PageHeader, QueryView, StatusBadge, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, titleCase } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { SchemaFields } from '@/components/fields';

function NewAssetDialog({ open, onClose, categories }: { open: boolean; onClose: () => void; categories: any[] }) {
  const client = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [attributes, setAttributes] = useState<Record<string, unknown>>({});
  const selected = categories.find((c) => c.code === category);
  const create = useMutation({
    mutationFn: () => api('/api/asset/assets', { method: 'POST', body: { code, name, category_code: category, status: 'active', attributes } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['assets'] });
      setCode('');
      setName('');
      setAttributes({});
      onClose();
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }
  return (
    <Dialog open={open} onClose={onClose} title="Register an asset" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-asset">Register</Button></>}>
      <form id="new-asset" onSubmit={submit} className="space-y-3">
        <Field label="Code" required>{(p) => <input {...p} className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
        <Field label="Name" required>{(p) => <input {...p} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Category" required>
          {(p) => (
            <select {...p} className={inputClass} value={category} onChange={(e) => { setCategory(e.target.value); setAttributes({}); }}>
              <option value="">Choose…</option>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>{c.name}{c.pack_id ? ` (${titleCase(c.pack_id)})` : ''}</option>
              ))}
            </select>
          )}
        </Field>
        {selected?.attribute_fields && (
          <fieldset className="space-y-3 rounded-md border border-line p-3">
            <legend className="px-1 text-xs text-ink-muted">Attributes (schema version {selected.attribute_schema_version})</legend>
            <SchemaFields fields={selected.attribute_fields} values={attributes} onChange={setAttributes} />
          </fieldset>
        )}
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

function AssetDetail({ id }: { id: string }) {
  const router = useRouter();
  const asset = useQuery({ queryKey: ['assets', id], queryFn: () => api(`/api/asset/assets/${id}`) });
  const incidents = useQuery({ queryKey: ['incidents', 'asset', id], queryFn: () => api<any[]>(`/api/incident/incidents?asset_id=${id}&limit=20`) });
  const { hasCapability } = useWorkspace();
  const orders = useQuery({ queryKey: ['maintenance', 'asset', id], queryFn: () => api<any[]>(`/api/maintenance/work-orders?asset_id=${id}&limit=20`), enabled: hasCapability('maintenance') });
  return (
    <>
      <PageHeader title="Asset" actions={<Button onClick={() => router.push('/assets/')}>Back to assets</Button>} />
      <QueryView query={asset} what="The asset">
        {(a: any) => (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card title={`${a.code}: ${a.name}`}>
              <KeyValue
                items={[
                  ['Category', `${a.category.name}${a.category.pack_id ? ` · ${titleCase(a.category.pack_id)} pack` : ''}`],
                  ['Status', <StatusBadge key="s" status={a.status} />],
                  ['Condition', titleCase(a.condition)],
                  ['Last maintained', dateTime(a.last_maintained_at)],
                  ['Next maintenance', dateTime(a.next_maintenance_due)],
                  ['Hierarchy', a.ancestors.map((x: any) => x.code).concat(a.code).join(' › ')],
                ]}
              />
            </Card>
            <Card title="Attributes" description={a.attribute_schema_version ? `Validated against attribute schema version ${a.attribute_schema_version}` : 'This category has no attribute schema'}>
              <KeyValue items={Object.entries(a.attributes ?? {}).map(([k, v]) => [titleCase(k), String(v)] as [string, string])} />
            </Card>
            <Card title="Incidents" padded={false}>
              <QueryView query={incidents} what="Incidents of the asset" isEmpty={(d) => d.length === 0} empty={<p className="p-4 text-sm text-ink-muted">No incidents recorded for this asset.</p>}>
                {(rows) => (
                  <ul className="divide-y divide-line">
                    {rows.map((i) => (
                      <li key={i.id} className="flex items-center justify-between px-4 py-2 text-sm">
                        <a className="text-brand-700 hover:underline" href={`/incidents/?id=${i.id}`}>{i.reference_no}: {i.title}</a>
                        <StatusBadge status={i.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </QueryView>
            </Card>
            {hasCapability('maintenance') && (
              <Card title="Work orders" padded={false}>
                <QueryView query={orders} what="Work orders of the asset" isEmpty={(d) => d.length === 0} empty={<p className="p-4 text-sm text-ink-muted">No work orders for this asset.</p>}>
                  {(rows) => (
                    <ul className="divide-y divide-line">
                      {rows.map((w) => (
                        <li key={w.id} className="flex items-center justify-between px-4 py-2 text-sm">
                          <a className="text-brand-700 hover:underline" href={`/maintenance/order/?id=${w.id}`}>{w.reference_no}: {w.title}</a>
                          <StatusBadge status={w.status} />
                        </li>
                      ))}
                    </ul>
                  )}
                </QueryView>
              </Card>
            )}
            <Card title="Status history" className="xl:col-span-2">
              <ul className="space-y-1 text-sm">
                {a.history.map((h: any, n: number) => (
                  <li key={n}>{dateTime(h.changed_at)}: {h.from_status ? `${titleCase(h.from_status)} → ` : ''}{titleCase(h.to_status)} ({h.changed_by}){h.note ? ` · ${h.note}` : ''}</li>
                ))}
              </ul>
            </Card>
          </div>
        )}
      </QueryView>
    </>
  );
}

function AssetList() {
  const router = useRouter();
  const { hasRole } = useAuth();
  const { info, selected } = useWorkspace();
  const [pack, setPack] = useState('');
  const [creating, setCreating] = useState(false);
  // In an industry workspace the list starts filtered to that industry.
  const effectivePack = pack || (selected !== 'all' ? selected : '');
  const assets = useQuery({ queryKey: ['assets', 'list', effectivePack], queryFn: () => api<any[]>(`/api/asset/assets?limit=500${effectivePack ? `&pack=${effectivePack}` : ''}`) });
  const categories = useQuery({ queryKey: ['assets', 'categories'], queryFn: () => api<any[]>('/api/asset/categories') });
  const canWrite = hasRole('asset_manager', 'tenant_admin', 'facility_manager');

  const columns: Column<any>[] = [
    { key: 'code', header: 'Code', value: (a) => a.code, cell: (a) => <span className="font-medium">{a.code}</span> },
    { key: 'name', header: 'Name', value: (a) => a.name, cell: (a) => a.name },
    { key: 'category', header: 'Category', value: (a) => a.category_name, cell: (a) => a.category_name },
    { key: 'industry', header: 'Industry', value: (a) => a.pack_id ?? '', cell: (a) => (a.pack_id ? <Badge>{titleCase(a.pack_id)}</Badge> : '—') },
    { key: 'status', header: 'Status', value: (a) => a.status, cell: (a) => <StatusBadge status={a.status} /> },
    { key: 'condition', header: 'Condition', value: (a) => a.condition, cell: (a) => titleCase(a.condition) },
    { key: 'due', header: 'Next maintenance', value: (a) => a.next_maintenance_due ?? '', cell: (a) => <span className={a.maintenance_overdue ? 'font-medium text-red-700' : ''}>{dateTime(a.next_maintenance_due)}{a.maintenance_overdue ? ' (overdue)' : ''}</span> },
  ];

  return (
    <>
      <PageHeader title="Assets" description="Every asset of your organisation, whatever the industry: infrastructure, machines, buildings and their systems." actions={canWrite && <Button variant="primary" onClick={() => setCreating(true)}>Register asset</Button>} />
      <Card padded={false}>
        <QueryView query={assets} what="The asset register">
          {(rows) => (
            <DataTable
              caption="Assets"
              columns={columns}
              rows={rows}
              rowKey={(a) => a.id}
              onRowOpen={(a) => router.push(`/assets/?id=${a.id}`)}
              filterPlaceholder="Filter by code, name, category…"
              toolbar={
                <>
                  <label className="sr-only" htmlFor="asset-pack">Industry</label>
                  <select id="asset-pack" value={effectivePack} onChange={(e) => setPack(e.target.value)} className={`${inputClass} w-auto`}>
                    <option value="">Every industry</option>
                    {info?.packs.filter((p) => !p.core).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </>
              }
            />
          )}
        </QueryView>
      </Card>
      <NewAssetDialog open={creating} onClose={() => setCreating(false)} categories={categories.data ?? []} />
    </>
  );
}

function AssetsRouter() {
  const id = useSearchParams().get('id');
  return id ? <AssetDetail id={id} /> : <AssetList />;
}

export default function AssetsPage() {
  return (
    <Suspense>
      <AssetsRouter />
    </Suspense>
  );
}
