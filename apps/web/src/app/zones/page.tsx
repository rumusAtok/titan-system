'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { type FormEvent, useState } from 'react';
import { ActionButton } from '@/components/module-kit';
import { Badge, Button, Card, type Column, DataTable, Dialog, Field, InlineError, PageHeader, QueryView, Spinner, inputClass } from '@/components/ui';
import type { LayerCollection } from '@/components/zone-map';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, number, titleCase } from '@/lib/format';

const ZoneMap = dynamic(() => import('@/components/zone-map').then((m) => m.ZoneMap), { ssr: false, loading: () => <Spinner label="Loading map…" /> });

const ZONE_TYPES = ['flood_zone', 'catchment', 'site_boundary', 'restricted_area', 'service_area', 'other'];
const WRITERS = ['tenant_admin', 'asset_manager', 'facility_manager', 'incident_commander'];

/** A zone is drawn as a rectangle from two corners, or pasted as GeoJSON (Polygon / MultiPolygon). */
function NewZoneDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [form, setForm] = useState({ code: '', name: '', zone_type: 'flood_zone', description: '', watch_incidents: false, notify_role: 'duty_officer' });
  const [mode, setMode] = useState<'box' | 'geojson'>('box');
  const [box, setBox] = useState({ south: '', west: '', north: '', east: '' });
  const [geojson, setGeojson] = useState('');
  const create = useMutation({
    mutationFn: () => {
      let geometry: unknown;
      if (mode === 'box') {
        const [s, w, n, e] = [box.south, box.west, box.north, box.east].map(Number);
        geometry = { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
      } else {
        try {
          geometry = JSON.parse(geojson);
        } catch {
          throw new Error('The GeoJSON is not valid JSON');
        }
      }
      return api('/api/geo/zones', { method: 'POST', body: { ...form, notify_role: form.watch_incidents ? form.notify_role : null, geometry } });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['geo'] });
      onClose();
    },
  });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Dialog open={open} onClose={onClose} title="New zone" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-zone" disabled={create.isPending}>Create zone</Button></>}>
      <form id="new-zone" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" required hint="Capitals, digits, - and _">{(p) => <input {...p} className={inputClass} value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} />}</Field>
          <Field label="Type">{(p) => <select {...p} className={inputClass} value={form.zone_type} onChange={(e) => set('zone_type', e.target.value)}>{ZONE_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</select>}</Field>
        </div>
        <Field label="Name" required>{(p) => <input {...p} className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} />}</Field>
        <fieldset className="flex gap-4 text-sm">
          <legend className="mb-1 text-sm font-medium">Shape</legend>
          <label className="flex items-center gap-1"><input type="radio" checked={mode === 'box'} onChange={() => setMode('box')} /> Rectangle</label>
          <label className="flex items-center gap-1"><input type="radio" checked={mode === 'geojson'} onChange={() => setMode('geojson')} /> GeoJSON polygon</label>
        </fieldset>
        {mode === 'box' ? (
          <div className="grid grid-cols-2 gap-3">
            {(['south', 'north', 'west', 'east'] as const).map((k) => (
              <Field key={k} label={`${titleCase(k)} (${k === 'south' || k === 'north' ? 'latitude' : 'longitude'})`} required>
                {(p) => <input {...p} type="number" step="any" className={inputClass} value={box[k]} onChange={(e) => setBox((b) => ({ ...b, [k]: e.target.value }))} />}
              </Field>
            ))}
          </div>
        ) : (
          <Field label="Geometry" hint='{"type":"Polygon","coordinates":[[[lon,lat],…,[lon,lat]]]} — the ring must be closed.'>
            {(p) => <textarea {...p} className={`${inputClass} font-mono text-xs`} rows={5} value={geojson} onChange={(e) => setGeojson(e.target.value)} />}
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.watch_incidents} onChange={(e) => set('watch_incidents', e.target.checked)} /> Tell a role when an incident is located in this zone</label>
        {form.watch_incidents && <Field label="Role to notify">{(p) => <input {...p} className={inputClass} value={form.notify_role} onChange={(e) => set('notify_role', e.target.value)} />}</Field>}
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

export default function ZonesPage() {
  const { hasRole } = useAuth();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshed, setRefreshed] = useState<string | null>(null);
  const layers = useQuery({ queryKey: ['geo', 'layers'], queryFn: () => api<LayerCollection>('/api/geo/layers'), refetchInterval: 30_000 });
  const zones = useQuery({ queryKey: ['geo', 'zones'], queryFn: () => api<any[]>('/api/geo/zones') });
  const incidents = useQuery({ queryKey: ['geo', 'incidents'], queryFn: () => api<any[]>('/api/geo/incidents'), refetchInterval: 15_000 });
  const zoneColumns: Column<any>[] = [
    { key: 'code', header: 'Code', value: (z) => z.code, cell: (z) => <span className={selected === z.code ? 'font-semibold text-brand-700' : 'font-medium'}>{z.code}</span> },
    { key: 'name', header: 'Name', value: (z) => z.name, cell: (z) => z.name },
    { key: 'type', header: 'Type', value: (z) => z.zone_type, cell: (z) => titleCase(z.zone_type) },
    { key: 'area', header: 'Area', value: (z) => Number(z.area_m2), cell: (z) => `${number(Number(z.area_m2) / 1e6, 2)} km²`, align: 'right' },
    { key: 'watch', header: 'Watches incidents', value: (z) => (z.watch_incidents ? z.notify_role : ''), cell: (z) => (z.watch_incidents ? <Badge tone="info">Notifies {titleCase(z.notify_role)}</Badge> : '—') },
  ];
  const incidentColumns: Column<any>[] = [
    { key: 'ref', header: 'Incident', value: (i) => i.reference_no, cell: (i) => <a className="font-medium text-brand-700 hover:underline" href={`/incidents/?id=${i.incident_id}`}>{i.reference_no}</a> },
    { key: 'title', header: 'Title', value: (i) => i.title, cell: (i) => i.title },
    { key: 'severity', header: 'Severity', value: (i) => i.severity, cell: (i) => <Badge tone={i.severity === 'critical' ? 'danger' : i.severity === 'warning' ? 'warn' : 'info'}>{titleCase(i.severity)}</Badge> },
    { key: 'via', header: 'Located by', value: (i) => i.located_via, cell: (i) => titleCase(i.located_via) },
    { key: 'zones', header: 'Zones', value: (i) => i.zones.map((z: any) => z.code).join(' '), cell: (i) => (i.zones.length ? i.zones.map((z: any) => z.code).join(', ') : 'Outside every zone') },
    { key: 'when', header: 'Reported', value: (i) => i.created_at, cell: (i) => ago(i.created_at) },
  ];
  return (
    <>
      <PageHeader
        title="Zones and map"
        description="Flood zones, catchments, site boundaries and service areas, with the assets, devices, cameras and incidents inside them. Incidents are located through their asset or device."
        actions={hasRole(...WRITERS) && <span className="flex gap-2"><ActionButton invalidate={[['geo']]} run={() => api('/api/geo/backfill', { method: 'POST' })} onDone={(r: any) => setRefreshed(`${r.assets} assets, ${r.devices} devices, ${r.cameras} cameras located`)}>Refresh locations</ActionButton><Button variant="primary" onClick={() => setCreating(true)}>New zone</Button></span>}
      />
      {refreshed && <p role="status" className="mb-3 text-sm text-ink-muted">{refreshed}.</p>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Map" className="xl:col-span-2" padded={false}>
          <ZoneMap layers={layers.data} onSelect={setSelected} />
        </Card>
        <Card title="Selected">
          {selected ? (
            <div className="space-y-1 text-sm">
              {(layers.data?.features ?? []).filter((f) => f.properties?.code === selected).map((f, i) => (
                <p key={i}><span className="font-medium">{selected}</span> · {f.properties?.name} · {titleCase(f.properties?.layer)}</p>
              ))}
            </div>
          ) : <p className="text-sm text-ink-muted">Select a zone or a point on the map.</p>}
        </Card>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Zones" padded={false}>
          <QueryView query={zones} what="Zones">{(rows) => <DataTable caption="Zones" columns={zoneColumns} rows={rows} rowKey={(z) => z.id} onRowOpen={(z) => setSelected(z.code)} emptyTitle="No zones yet" />}</QueryView>
        </Card>
        <Card title="Located incidents" padded={false}>
          <QueryView query={incidents} what="Located incidents">{(rows) => <DataTable caption="Located incidents" columns={incidentColumns} rows={rows} rowKey={(i) => i.incident_id} emptyTitle="No located incidents" />}</QueryView>
        </Card>
      </div>
      <NewZoneDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
