'use client';

import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import type { MapFeature } from '@/components/map';
import { Button, Card, ErrorState, KeyValue, PageHeader, SimulatedTag, Spinner, StatusBadge, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, dateTime, titleCase } from '@/lib/format';

// MapLibre needs the browser (WebGL); load it only on the client.
const OperationsMap = dynamic(() => import('@/components/map').then((m) => m.OperationsMap), { ssr: false, loading: () => <Spinner label="Loading map…" /> });

type Kind = MapFeature['kind'];
const KIND_LABEL: Record<Kind, string> = { asset: 'Assets', sensor: 'Sensors', incident: 'Active incidents' };

export default function GisPage() {
  const [kinds, setKinds] = useState<Record<Kind, boolean>>({ asset: true, sensor: true, incident: true });
  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const assets = useQuery({ queryKey: ['assets', 'map'], queryFn: () => api<any[]>('/api/asset/assets?limit=500'), refetchInterval: 60_000 });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<any[]>('/api/device/devices'), refetchInterval: 15_000 });
  const incidents = useQuery({ queryKey: ['incidents', 'active'], queryFn: () => api<any[]>('/api/incident/incidents?status=active&limit=200'), refetchInterval: 15_000 });
  const latest = useQuery({ queryKey: ['telemetry', 'latest'], queryFn: () => api<any[]>('/api/telemetry/latest'), refetchInterval: 10_000, retry: false });

  const all = useMemo(() => {
    const out: Array<MapFeature & { record: any }> = [];
    for (const a of assets.data ?? []) if (a.latitude !== null) out.push({ id: `asset:${a.id}`, kind: 'asset', name: a.name, status: a.status, latitude: a.latitude, longitude: a.longitude, record: a });
    const deviceById = new Map((devices.data ?? []).map((d) => [d.id, d]));
    for (const d of devices.data ?? []) if (d.latitude !== null) out.push({ id: `sensor:${d.id}`, kind: 'sensor', name: d.name, status: d.status, latitude: d.latitude, longitude: d.longitude, record: d });
    // An incident is drawn at the location of the device that raised it.
    for (const i of incidents.data ?? []) {
      const d = i.device_id ? deviceById.get(i.device_id) : null;
      if (d?.latitude != null) out.push({ id: `incident:${i.id}`, kind: 'incident', name: `${i.reference_no}: ${i.title}`, status: i.status, latitude: d.latitude, longitude: d.longitude, record: i });
    }
    return out;
  }, [assets.data, devices.data, incidents.data]);

  const statuses = useMemo(() => [...new Set(all.map((f) => f.status))].sort(), [all]);
  const visible = all.filter((f) => kinds[f.kind] && (!status || f.status === status));
  const selected = all.find((f) => f.id === selectedId) ?? null;
  const loading = assets.isPending || devices.isPending;
  const failed = assets.isError && devices.isError;

  const readings = selected?.kind === 'sensor' ? (latest.data ?? []).filter((r) => r.device_id === selected.record.id) : [];

  return (
    <>
      <PageHeader title="GIS operations" description="Assets, sensors and active incidents by location. Every record on the map is also listed beside it." />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card
          title="Map"
          className="xl:col-span-2"
          padded={false}
          actions={
            <fieldset className="flex flex-wrap items-center gap-3">
              <legend className="sr-only">Map layers and filters</legend>
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-sm text-ink">
                  <input type="checkbox" checked={kinds[k]} onChange={(e) => setKinds((prev) => ({ ...prev, [k]: e.target.checked }))} />
                  {KIND_LABEL[k]}
                </label>
              ))}
              <label htmlFor="map-status" className="sr-only">Status</label>
              <select id="map-status" value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputClass} w-auto`}>
                <option value="">Any status</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>{titleCase(s)}</option>
                ))}
              </select>
            </fieldset>
          }
        >
          {loading ? <Spinner /> : failed ? <ErrorState error={assets.error} onRetry={() => { void assets.refetch(); void devices.refetch(); }} what="Map data" /> : (
            <div className="h-[520px]">
              <OperationsMap features={visible} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-xs text-ink-muted">
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-green-700" aria-hidden="true" />Online / active</span>
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-amber-600" aria-hidden="true" />Maintenance / acknowledged</span>
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-red-700" aria-hidden="true" />Offline / incident</span>
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-slate-500" aria-hidden="true" />Other</span>
            <span className="ml-auto">Locations are fictional. Base map © OpenStreetMap contributors.</span>
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Location detail" actions={selected ? <Button variant="ghost" onClick={() => setSelectedId(null)}>Clear</Button> : undefined}>
            {!selected ? (
              <p className="text-sm text-ink-muted">Select a marker on the map, or an entry in the list below.</p>
            ) : (
              <div className="space-y-3" data-testid="location-detail">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink">{selected.name}</h3>
                  <StatusBadge status={selected.status} />
                </div>
                {selected.kind === 'asset' && (
                  <KeyValue items={[['Code', selected.record.code], ['Category', selected.record.category_name], ['Condition', <StatusBadge key="c" status={selected.record.condition} />], ['Next maintenance', <span key="m" className={selected.record.maintenance_overdue ? 'font-medium text-red-700' : ''}>{dateTime(selected.record.next_maintenance_due)}{selected.record.maintenance_overdue ? ' (overdue)' : ''}</span>]]} />
                )}
                {selected.kind === 'sensor' && (
                  <>
                    <KeyValue items={[['Serial number', selected.record.serial_no], ['Last seen', ago(selected.record.last_seen_at)], ['Reporting interval', `${selected.record.expected_interval_seconds} s`], ['Type', titleCase(selected.record.device_type)]]} />
                    <div className="flex items-center gap-2"><h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Latest readings</h4><SimulatedTag /></div>
                    {readings.length === 0 ? <p className="text-sm text-ink-muted">No readings.</p> : (
                      <ul className="text-sm">
                        {readings.map((r) => (
                          <li key={r.sensor_kind} className="flex justify-between border-b border-line py-1 last:border-0">
                            <span>{titleCase(r.sensor_kind)}</span>
                            <span className="tabular-nums">{r.value} {r.unit} <span className="text-xs text-ink-muted">({ago(r.observed_at)})</span></span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                {selected.kind === 'incident' && (
                  <KeyValue items={[['Severity', <StatusBadge key="s" status={selected.record.severity} />], ['Created', dateTime(selected.record.created_at)], ['Acknowledged by', selected.record.acknowledged_by ?? '—'], ['Source', titleCase(selected.record.source_type)]]} />
                )}
                <p className="font-mono text-xs text-ink-muted">{selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}</p>
              </div>
            )}
          </Card>

          <Card title={`Records shown (${visible.length})`} padded={false}>
            <ul className="max-h-[300px] divide-y divide-line overflow-y-auto" aria-label="Records shown on the map">
              {visible.map((f) => (
                <li key={f.id}>
                  <button type="button" onClick={() => setSelectedId(f.id)} aria-pressed={f.id === selectedId} className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm hover:bg-brand-50 ${f.id === selectedId ? 'bg-brand-50' : ''}`}>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{f.name}</span>
                      <span className="text-xs text-ink-muted">{titleCase(f.kind)}</span>
                    </span>
                    <StatusBadge status={f.status} />
                  </button>
                </li>
              ))}
              {visible.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-muted">No records match the filters.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
