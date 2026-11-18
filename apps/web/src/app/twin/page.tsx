'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { type ReactNode, useMemo, useState } from 'react';
import { Badge, Card, EmptyState, KeyValue, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { ago, dateTime, titleCase } from '@/lib/format';

/** A list from a module the tenant may not have: a refusal (capability off) is shown as "not available", not as an error. */
async function optional<T>(path: string): Promise<T[] | null> {
  try {
    return await api<T[]>(path);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404 || err.status === 503)) return null;
    throw err;
  }
}

type Health = 'critical' | 'warning' | 'attention' | 'ok' | 'inactive';
const HEALTH_COLOUR: Record<Health, string> = { critical: '#b91c1c', warning: '#d97706', attention: '#ca8a04', ok: '#15803d', inactive: '#94a3b8' };
const HEALTH_LABEL: Record<Health, string> = { critical: 'Critical incident', warning: 'Alarm or incident', attention: 'Needs attention', ok: 'Normal', inactive: 'Not in service' };
const RANK: Health[] = ['critical', 'warning', 'attention', 'ok', 'inactive'];

interface Node {
  asset: any;
  depth: number;
  children: Node[];
}

function buildTree(assets: any[]): Node[] {
  const byId = new Map(assets.map((a) => [a.id, { asset: a, depth: 0, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const parent = n.asset.parent_id ? byId.get(n.asset.parent_id) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const setDepth = (n: Node, d: number) => {
    n.depth = d;
    n.children.sort((a, b) => a.asset.code.localeCompare(b.asset.code));
    n.children.forEach((c) => setDepth(c, d + 1));
  };
  roots.sort((a, b) => a.asset.code.localeCompare(b.asset.code)).forEach((r) => setDepth(r, 0));
  return roots;
}

/** Schematic: one column per hierarchy level, one row per leaf, lines from parent to child. */
function Schematic({ roots, health, selected, onSelect }: { roots: Node[]; health: (id: string) => Health; selected: string | null; onSelect: (id: string) => void }) {
  const placed: { node: Node; x: number; y: number }[] = [];
  let row = 0;
  const place = (n: Node): number => {
    let y: number;
    if (!n.children.length) y = row++;
    else {
      const ys = n.children.map(place);
      y = (ys[0]! + ys[ys.length - 1]!) / 2;
    }
    placed.push({ node: n, x: n.depth, y });
    return y;
  };
  roots.forEach(place);
  const W = 190;
  const H = 46;
  const pos = new Map(placed.map((p) => [p.node.asset.id, p]));
  const width = (Math.max(0, ...placed.map((p) => p.x)) + 1) * W + 20;
  const height = Math.max(1, row) * H + 20;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ minHeight: Math.min(height, 520) }} role="group" aria-label="Asset hierarchy schematic. Each asset is also listed in the panel beside it.">
      {placed.filter((p) => p.node.asset.parent_id && pos.has(p.node.asset.parent_id)).map((p) => {
        const parent = pos.get(p.node.asset.parent_id)!;
        return <path key={`l-${p.node.asset.id}`} d={`M ${parent.x * W + 170} ${parent.y * H + 30} C ${parent.x * W + 185} ${parent.y * H + 30}, ${p.x * W + 5} ${p.y * H + 30}, ${p.x * W + 20} ${p.y * H + 30}`} fill="none" stroke="#94a3b8" />;
      })}
      {placed.map((p) => {
        const h = health(p.node.asset.id);
        const isSel = selected === p.node.asset.id;
        return (
          <g key={p.node.asset.id} transform={`translate(${p.x * W + 20} ${p.y * H + 12})`} onClick={() => onSelect(p.node.asset.id)} style={{ cursor: 'pointer' }}>
            <title>{`${p.node.asset.code}: ${p.node.asset.name} (${HEALTH_LABEL[h]})`}</title>
            <rect width="150" height="36" rx="6" fill="#ffffff" stroke={isSel ? '#0f172a' : HEALTH_COLOUR[h]} strokeWidth={isSel ? 3 : 2} />
            <circle cx="14" cy="18" r="6" fill={HEALTH_COLOUR[h]} />
            <text x="26" y="15" fontSize="10" fontWeight="600" fill="#0f172a">{p.node.asset.code.slice(0, 18)}</text>
            <text x="26" y="28" fontSize="9" fill="#475569">{p.node.asset.category_name?.slice(0, 22) ?? ''}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Panel({ title, rows, empty, children }: { title: string; rows: unknown[] | null | undefined; empty: string; children: (rows: any[]) => ReactNode }) {
  return (
    <section className="rounded border border-line p-3">
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      {rows === undefined ? <Spinner /> : rows === null ? <p className="text-xs text-ink-muted">Not available for your organisation or role.</p> : rows.length === 0 ? <p className="text-xs text-ink-muted">{empty}</p> : children(rows as any[])}
    </section>
  );
}

export default function TwinPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const live = { refetchInterval: 5_000, retry: false } as const;
  const assets = useQuery({ queryKey: ['twin', 'assets'], queryFn: () => api<any[]>('/api/asset/assets?limit=500'), refetchInterval: 30_000 });
  const devices = useQuery({ queryKey: ['twin', 'devices'], queryFn: () => optional<any>('/api/device/devices?limit=500'), refetchInterval: 30_000, retry: false });
  const latest = useQuery({ queryKey: ['twin', 'latest'], queryFn: () => optional<any>('/api/telemetry/latest'), ...live });
  const alerts = useQuery({ queryKey: ['twin', 'alerts'], queryFn: () => optional<any>('/api/alert/alerts?status=open'), ...live });
  const incidents = useQuery({ queryKey: ['twin', 'incidents'], queryFn: () => optional<any>('/api/incident/incidents?status=active&limit=500'), ...live });
  const orders = useQuery({ queryKey: ['twin', 'orders'], queryFn: () => optional<any>('/api/maintenance/work-orders?status=active&limit=500'), refetchInterval: 15_000, retry: false });

  const deviceAsset = useMemo(() => new Map((devices.data ?? []).map((d: any) => [d.id, d.asset_id])), [devices.data]);
  const health = useMemo(() => {
    const map = new Map<string, Health>();
    const worse = (id: string | null | undefined, h: Health) => {
      if (!id) return;
      const cur = map.get(id);
      if (!cur || RANK.indexOf(h) < RANK.indexOf(cur)) map.set(id, h);
    };
    for (const a of assets.data ?? []) {
      if (['retired', 'planned'].includes(a.status)) worse(a.id, 'inactive');
      else if (a.condition === 'critical') worse(a.id, 'warning');
      else if (a.condition === 'poor' || a.maintenance_overdue || a.status === 'under_maintenance') worse(a.id, 'attention');
      else worse(a.id, 'ok');
    }
    for (const i of incidents.data ?? []) worse(i.asset_id ?? deviceAsset.get(i.device_id), i.severity === 'critical' ? 'critical' : 'warning');
    for (const al of alerts.data ?? []) worse(deviceAsset.get(al.device_id), al.severity === 'critical' ? 'critical' : 'warning');
    // A problem on a component is shown on everything above it.
    const byId = new Map((assets.data ?? []).map((a: any) => [a.id, a]));
    for (const a of assets.data ?? []) {
      let p = a.parent_id;
      const h = map.get(a.id)!;
      while (p && byId.has(p)) {
        if (['critical', 'warning'].includes(h)) worse(p, h);
        p = byId.get(p).parent_id;
      }
    }
    return (id: string) => map.get(id) ?? 'ok';
  }, [assets.data, incidents.data, alerts.data, deviceAsset]);

  const roots = useMemo(() => buildTree(assets.data ?? []), [assets.data]);
  const asset = (assets.data ?? []).find((a: any) => a.id === selected) ?? null;
  const assetDevices = (devices.data ?? []).filter((d: any) => d.asset_id === selected);
  const readings = latest.data === null ? null : (latest.data ?? []).filter((r: any) => assetDevices.some((d: any) => d.id === r.device_id));
  const assetAlerts = alerts.data === null ? null : (alerts.data ?? []).filter((a: any) => deviceAsset.get(a.device_id) === selected);
  const assetIncidents = incidents.data === null ? null : (incidents.data ?? []).filter((i: any) => i.asset_id === selected || (i.device_id && deviceAsset.get(i.device_id) === selected));
  const assetOrders = orders.data === null ? null : (orders.data ?? []).filter((w: any) => w.asset_id === selected);
  const docs = useQuery({ queryKey: ['twin', 'docs', selected], queryFn: () => optional<any>(`/api/document/documents?subject_type=asset&subject_id=${selected}`), enabled: !!selected, retry: false });
  const cameras = useQuery({ queryKey: ['twin', 'cameras'], queryFn: () => optional<any>('/api/video/cameras'), retry: false });
  const plans = useQuery({ queryKey: ['twin', 'plans'], queryFn: () => optional<any>('/api/maintenance/planning/pm-plans'), retry: false });
  const zones = useQuery({
    queryKey: ['twin', 'zones', selected],
    queryFn: async () => (asset?.latitude == null ? [] : ((await api<any>(`/api/geo/locate?lat=${asset.latitude}&lon=${asset.longitude}`)).zones as any[])),
    enabled: !!asset,
    retry: false,
  });

  return (
    <>
      <PageHeader title="Digital twin" description="The asset hierarchy as a live schematic: each asset is coloured by its worst current state (incidents, alarms, condition, maintenance), and every panel reads from the service that owns the data. It is a model of records and readings, not a physical simulation." />
      <div className="mb-3 flex flex-wrap gap-3 text-xs" aria-label="Legend">
        {RANK.map((h) => <span key={h} className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full" style={{ background: HEALTH_COLOUR[h] }} />{HEALTH_LABEL[h]}</span>)}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <Card title="Asset hierarchy" className="overflow-x-auto xl:col-span-3">
          {assets.isPending ? <Spinner /> : roots.length === 0 ? <EmptyState title="No assets registered" /> : <Schematic roots={roots} health={health} selected={selected} onSelect={setSelected} />}
          <ul className="mt-3 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2" aria-label="Assets">
            {(assets.data ?? []).map((a: any) => (
              <li key={a.id}>
                <button className={`flex items-center gap-2 hover:underline ${selected === a.id ? 'font-semibold' : ''}`} onClick={() => setSelected(a.id)}>
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: HEALTH_COLOUR[health(a.id)] }} aria-hidden="true" />
                  {a.code} <span className="text-ink-muted">({HEALTH_LABEL[health(a.id)]})</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={asset ? `${asset.code}: ${asset.name}` : 'Select an asset'} className="xl:col-span-2">
          {!asset ? (
            <p className="text-sm text-ink-muted">Select an asset in the schematic or the list.</p>
          ) : (
            <div className="space-y-3">
              <KeyValue items={[
                ['Category', asset.category_name],
                ['Status', <StatusBadge key="s" status={asset.status} />],
                ['Condition', titleCase(asset.condition)],
                ['Next maintenance', asset.next_maintenance_due ? `${dateTime(asset.next_maintenance_due)}${asset.maintenance_overdue ? ' (overdue)' : ''}` : '—'],
                ['Location', asset.latitude == null ? '—' : `${asset.latitude.toFixed(5)}, ${asset.longitude.toFixed(5)}`],
              ]} />
              {Object.keys(asset.attributes ?? {}).length > 0 && (
                <details className="text-xs"><summary className="cursor-pointer text-sm font-medium">Attributes</summary><KeyValue items={Object.entries(asset.attributes).map(([k, v]) => [titleCase(k), String(v)] as [string, string])} /></details>
              )}
              <Panel title="Live readings" rows={readings} empty="No sensors on this asset.">
                {(rows) => <ul className="text-sm">{rows.map((r) => <li key={`${r.device_id}:${r.sensor_kind}`}>{titleCase(r.sensor_kind)}: <strong>{r.value}</strong> {r.unit} <span className="text-xs text-ink-muted">({r.device_name}, {ago(r.observed_at)})</span></li>)}</ul>}
              </Panel>
              <Panel title="Alarms" rows={assetAlerts} empty="No open alarms.">
                {(rows) => <ul className="text-sm">{rows.map((a) => <li key={a.id}><Badge tone={a.severity === 'critical' ? 'danger' : 'warn'}>{titleCase(a.severity)}</Badge> {a.rule_name} · {a.status} · {ago(a.first_triggered_at)}</li>)}</ul>}
              </Panel>
              <Panel title="Incidents" rows={assetIncidents} empty="No active incidents.">
                {(rows) => <ul className="text-sm">{rows.map((i) => <li key={i.id}><Link className="text-brand-700 hover:underline" href={`/incidents/?id=${i.id}`}>{i.reference_no}</Link> {i.title} · <StatusBadge status={i.status} /></li>)}</ul>}
              </Panel>
              <Panel title="Open work" rows={assetOrders} empty="No open work orders.">
                {(rows) => <ul className="text-sm">{rows.map((w) => <li key={w.id}><Link className="text-brand-700 hover:underline" href={`/maintenance/order/?id=${w.id}`}>{w.reference_no}</Link> {w.title} · <StatusBadge status={w.status} /></li>)}</ul>}
              </Panel>
              <Panel title="Preventive plans" rows={plans.data === undefined ? undefined : plans.data === null ? null : plans.data.filter((p: any) => p.asset_id === selected)} empty="No preventive plans.">
                {(rows) => <ul className="text-sm">{rows.map((p) => <li key={p.id}>{p.code}: {p.name} · next {p.next_due_on}</li>)}</ul>}
              </Panel>
              <Panel title="Documents" rows={docs.data} empty="No documents linked.">
                {(rows) => <ul className="text-sm">{rows.map((d) => <li key={d.id}><Link className="text-brand-700 hover:underline" href={`/documents/?id=${d.id}`}>{d.reference_no}</Link> {d.title}</li>)}</ul>}
              </Panel>
              <Panel title="Cameras" rows={cameras.data === undefined ? undefined : cameras.data === null ? null : cameras.data.filter((c: any) => c.asset_id === selected)} empty="No cameras on this asset.">
                {(rows) => <ul className="text-sm">{rows.map((c) => <li key={c.id}><Link className="text-brand-700 hover:underline" href={`/video/?id=${c.id}`}>{c.code}</Link> {c.name} · <StatusBadge status={c.status} /></li>)}</ul>}
              </Panel>
              <Panel title="Zones" rows={zones.isError ? null : zones.data} empty="Not inside any zone.">
                {(rows) => <ul className="text-sm">{rows.map((z) => <li key={z.id}>{z.code}: {z.name} ({titleCase(z.zone_type)})</li>)}</ul>}
              </Panel>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
