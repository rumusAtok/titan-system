'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ActionButton } from '@/components/module-kit';
import { Badge, Button, Card, type Column, DataTable, Dialog, Field, InlineError, PageHeader, QueryView, StatusBadge, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, titleCase } from '@/lib/format';

const PLANNERS = ['maintenance_planner', 'facility_manager', 'tenant_admin'];
const KEYS = [['planning'], ['maintenance']];
const today = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function NewPmPlan({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const assets = useQuery({ queryKey: ['assets', 'list', ''], queryFn: () => api<any[]>('/api/asset/assets?limit=500'), enabled: open });
  const types = useQuery({ queryKey: ['maintenance', 'types'], queryFn: () => api<any[]>('/api/maintenance/request-types'), enabled: open });
  const [f, setF] = useState({ code: '', name: '', asset_id: '', request_type: '', priority: 'normal', interval_days: '30', lead_days: '3', next_due_on: today(7), estimated_hours: '', checklist: '' });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const create = useMutation({
    mutationFn: () =>
      api('/api/maintenance/planning/pm-plans', {
        method: 'POST',
        body: {
          code: f.code, name: f.name, asset_id: f.asset_id, request_type: f.request_type || types.data?.[0]?.key, priority: f.priority,
          interval_days: Number(f.interval_days), lead_days: Number(f.lead_days), next_due_on: f.next_due_on,
          estimated_hours: f.estimated_hours === '' ? null : Number(f.estimated_hours), checklist: f.checklist.split('\n').map((l) => l.trim()).filter(Boolean),
        },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['planning'] });
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="New preventive plan" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="pm">Create plan</Button></>}>
      <form id="pm" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" required>{(p) => <input {...p} className={inputClass} value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} />}</Field>
          <Field label="Priority">{(p) => <select {...p} className={inputClass} value={f.priority} onChange={(e) => set('priority', e.target.value)}>{['low', 'normal', 'high', 'urgent'].map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}</select>}</Field>
        </div>
        <Field label="Name" required>{(p) => <input {...p} className={inputClass} value={f.name} onChange={(e) => set('name', e.target.value)} />}</Field>
        <Field label="Asset" required>{(p) => <select {...p} className={inputClass} value={f.asset_id} onChange={(e) => set('asset_id', e.target.value)}><option value="">Choose…</option>{(assets.data ?? []).filter((a) => a.status !== 'retired').map((a) => <option key={a.id} value={a.id}>{a.code}: {a.name}</option>)}</select>}</Field>
        <Field label="Request type" hint="Categorises the work (installed by your industry packs).">{(p) => <select {...p} className={inputClass} value={f.request_type} onChange={(e) => set('request_type', e.target.value)}>{(types.data ?? []).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select>}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Every (days)" required>{(p) => <input {...p} type="number" min={1} className={inputClass} value={f.interval_days} onChange={(e) => set('interval_days', e.target.value)} />}</Field>
          <Field label="Open days before">{(p) => <input {...p} type="number" min={0} className={inputClass} value={f.lead_days} onChange={(e) => set('lead_days', e.target.value)} />}</Field>
          <Field label="Estimated hours">{(p) => <input {...p} type="number" min={0} step="0.25" className={inputClass} value={f.estimated_hours} onChange={(e) => set('estimated_hours', e.target.value)} />}</Field>
        </div>
        <Field label="First due on" required>{(p) => <input {...p} type="date" className={inputClass} value={f.next_due_on} onChange={(e) => set('next_due_on', e.target.value)} />}</Field>
        <Field label="Checklist" hint="One task per line.">{(p) => <textarea {...p} rows={3} className={inputClass} value={f.checklist} onChange={(e) => set('checklist', e.target.value)} />}</Field>
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

function RoundDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const client = useQueryClient();
  const round = useQuery({ queryKey: ['planning', 'round', id], queryFn: () => api<any>(`/api/maintenance/planning/rounds/${id}`), enabled: !!id });
  const [answers, setAnswers] = useState<Record<string, boolean | number | ''>>({});
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState<any>(null);
  const done = useMutation({
    mutationFn: () => api<any>(`/api/maintenance/planning/rounds/${id}/complete`, { method: 'POST', body: { results: Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== '')), notes } }),
    onSuccess: async (r) => {
      setResult(r);
      await Promise.all(KEYS.map((k) => client.invalidateQueries({ queryKey: k })));
    },
  });
  const close = () => {
    setAnswers({});
    setNotes('');
    setResult(null);
    onClose();
  };
  const r = round.data;
  return (
    <Dialog open={!!id} onClose={close} title={r ? `${r.reference_no}: ${r.plan_name}` : 'Inspection'} footer={<><Button onClick={close}>Close</Button>{r?.status === 'due' && !result && <Button variant="primary" type="submit" form="round">Record results</Button>}</>}>
      {r && (
        <form id="round" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); done.mutate(); }}>
          <p className="text-sm text-ink-muted">Due {r.due_on}{r.asset_code ? ` · ${r.asset_code}` : ''}{r.location ? ` · ${r.location}` : ''} · for {titleCase(r.assigned_role)}</p>
          {r.checklist.map((item: any) => (
            <div key={item.key}>
              {item.kind === 'pass_fail' ? (
                <fieldset disabled={r.status !== 'due' || !!result}>
                  <legend className="text-sm">{item.question}</legend>
                  <label className="mr-4 text-sm"><input type="radio" name={item.key} checked={(r.results?.[item.key] ?? answers[item.key]) === true} onChange={() => setAnswers({ ...answers, [item.key]: true })} /> Pass</label>
                  <label className="text-sm"><input type="radio" name={item.key} checked={(r.results?.[item.key] ?? answers[item.key]) === false} onChange={() => setAnswers({ ...answers, [item.key]: false })} /> Fail</label>
                </fieldset>
              ) : (
                <Field label={`${item.question}${item.unit ? ` (${item.unit})` : ''}`} hint={`Acceptable: ${item.min ?? '−∞'} to ${item.max ?? '∞'}`}>
                  {(p) => <input {...p} type="number" step="any" disabled={r.status !== 'due' || !!result} className={inputClass} value={String(r.results?.[item.key] ?? answers[item.key] ?? '')} onChange={(e) => setAnswers({ ...answers, [item.key]: e.target.value === '' ? '' : Number(e.target.value) })} />}
                </Field>
              )}
            </div>
          ))}
          {r.status === 'due' && !result && <Field label="Notes">{(p) => <textarea {...p} rows={2} className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>}
          <InlineError error={done.error} />
          {(result || r.status === 'completed') && (
            <div role="status" className="rounded bg-slate-50 p-2 text-sm">
              {result ? (result.findings.length ? `${result.findings.length} finding(s): requests ${result.finding_requests.join(', ')} raised for approval.` : 'All items passed.') : `Completed by ${r.performed_by} ${dateTime(r.completed_at)}; ${r.findings} finding(s).`}
              {r.finding_requests?.length > 0 && <ul>{r.finding_requests.map((x: any) => <li key={x.id}><a className="text-brand-700 hover:underline" href={`/maintenance/request/?id=${x.id}`}>{x.reference_no}</a> {x.title} · {x.status}</li>)}</ul>}
            </div>
          )}
        </form>
      )}
    </Dialog>
  );
}

export default function PlanningPage() {
  const { hasRole } = useAuth();
  const planner = hasRole(...PLANNERS);
  const [newPm, setNewPm] = useState(false);
  const [roundId, setRoundId] = useState<string | null>(null);
  const [rate, setRate] = useState('');
  const pm = useQuery({ queryKey: ['planning', 'pm'], queryFn: () => api<any[]>('/api/maintenance/planning/pm-plans') });
  const ins = useQuery({ queryKey: ['planning', 'inspections'], queryFn: () => api<any[]>('/api/maintenance/planning/inspection-plans') });
  const rounds = useQuery({ queryKey: ['planning', 'rounds'], queryFn: () => api<any[]>('/api/maintenance/planning/rounds'), refetchInterval: 15_000 });
  const settings = useQuery({ queryKey: ['planning', 'settings'], queryFn: () => api<any>('/api/maintenance/settings') });
  const pmColumns: Column<any>[] = [
    { key: 'code', header: 'Plan', value: (p) => p.code, cell: (p) => <span><span className="font-medium">{p.code}</span><br /><span className="text-xs text-ink-muted">{p.name}</span></span> },
    { key: 'asset', header: 'Asset', value: (p) => p.asset_code ?? '', cell: (p) => p.asset_code ?? '—' },
    { key: 'every', header: 'Every', value: (p) => p.interval_days, cell: (p) => `${p.interval_days} days` },
    { key: 'due', header: 'Next due', value: (p) => p.next_due_on, cell: (p) => p.next_due_on },
    { key: 'last', header: 'Last work order', value: (p) => p.last_work_order ?? '', cell: (p) => p.last_work_order ?? '—' },
    { key: 'state', header: 'State', value: (p) => (p.active ? 'active' : 'inactive'), cell: (p) => <StatusBadge status={p.active ? 'active' : 'inactive'} /> },
    ...(planner ? [{ key: 'act', header: '', cell: (p: any) => <span className="flex gap-1">{p.active && <ActionButton invalidate={KEYS} run={() => api(`/api/maintenance/planning/pm-plans/${p.id}/generate`, { method: 'POST' })}>Open next now</ActionButton>}<ActionButton invalidate={KEYS} run={() => api(`/api/maintenance/planning/pm-plans/${p.id}`, { method: 'PATCH', body: { active: !p.active } })}>{p.active ? 'Pause' : 'Resume'}</ActionButton></span> }] : []),
  ];
  const insColumns: Column<any>[] = [
    { key: 'code', header: 'Inspection', value: (p) => p.code, cell: (p) => <span><span className="font-medium">{p.code}</span><br /><span className="text-xs text-ink-muted">{p.name}</span></span> },
    { key: 'where', header: 'Where', value: (p) => p.asset_code ?? p.location, cell: (p) => p.asset_code ?? p.location ?? '—' },
    { key: 'items', header: 'Items', value: (p) => p.checklist.length, cell: (p) => p.checklist.length, align: 'right' },
    { key: 'every', header: 'Every', value: (p) => p.interval_days, cell: (p) => `${p.interval_days} days` },
    { key: 'due', header: 'Next due', value: (p) => p.next_due_on, cell: (p) => p.next_due_on },
    { key: 'who', header: 'By', value: (p) => p.assigned_role, cell: (p) => titleCase(p.assigned_role) },
    { key: 'findings', header: 'Findings so far', value: (p) => p.findings, cell: (p) => p.findings, align: 'right' },
    ...(planner ? [{ key: 'act', header: '', cell: (p: any) => p.active && <ActionButton invalidate={KEYS} run={() => api(`/api/maintenance/planning/inspection-plans/${p.id}/generate`, { method: 'POST' })}>Make next round due</ActionButton> }] : []),
  ];
  const roundColumns: Column<any>[] = [
    { key: 'ref', header: 'Round', value: (r) => r.reference_no, cell: (r) => <button className="font-medium text-brand-700 hover:underline" onClick={() => setRoundId(r.id)}>{r.reference_no}</button> },
    { key: 'plan', header: 'Inspection', value: (r) => r.plan_name, cell: (r) => r.plan_name },
    { key: 'due', header: 'Due', value: (r) => r.due_on, cell: (r) => r.due_on },
    { key: 'status', header: 'Status', value: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'findings', header: 'Findings', value: (r) => r.findings, cell: (r) => (r.status === 'completed' ? (r.findings ? <Badge tone="warn">{r.findings}</Badge> : <Badge tone="ok">None</Badge>) : '—') },
    { key: 'by', header: 'Done by', value: (r) => r.performed_by ?? '', cell: (r) => r.performed_by ?? '—' },
  ];
  return (
    <>
      <PageHeader
        title="Maintenance planning"
        description="Preventive plans open work orders before they are due; inspection rounds become due on their interval, and every failed item raises a request for approval."
        actions={planner && <Button variant="primary" onClick={() => setNewPm(true)}>New preventive plan</Button>}
      />
      <div className="space-y-6">
        <Card title="Inspection rounds" padded={false}><QueryView query={rounds} what="Rounds">{(rows) => <DataTable caption="Inspection rounds" columns={roundColumns} rows={rows} rowKey={(r) => r.id} emptyTitle="No rounds yet" />}</QueryView></Card>
        <Card title="Preventive plans" padded={false}><QueryView query={pm} what="Plans">{(rows) => <DataTable caption="Preventive plans" columns={pmColumns} rows={rows} rowKey={(p) => p.id} emptyTitle="No preventive plans" />}</QueryView></Card>
        <Card title="Inspection plans" padded={false}><QueryView query={ins} what="Inspection plans">{(rows) => <DataTable caption="Inspection plans" columns={insColumns} rows={rows} rowKey={(p) => p.id} emptyTitle="No inspection plans" />}</QueryView></Card>
        <Card title="Labour rate">
          <QueryView query={settings} what="Settings">
            {(s) => (
              <div className="flex flex-wrap items-end gap-2 text-sm">
                <p>Work orders are costed at <strong>{s.labor_rate_per_hour} {s.currency}</strong> per hour; parts come from store <strong>{s.parts_store}</strong> unless named.</p>
                {planner && (
                  <>
                    <Field label="New rate per hour">{(p) => <input {...p} type="number" min={0} step="0.5" className={`${inputClass} w-28`} value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>
                    <ActionButton disabled={rate === ''} invalidate={[['planning']]} run={() => api('/api/maintenance/settings', { method: 'PUT', body: { ...s, labor_rate_per_hour: Number(rate) } })} onDone={() => setRate('')}>Save rate</ActionButton>
                  </>
                )}
              </div>
            )}
          </QueryView>
        </Card>
      </div>
      <NewPmPlan open={newPm} onClose={() => setNewPm(false)} />
      <RoundDialog id={roundId} onClose={() => setRoundId(null)} />
    </>
  );
}
