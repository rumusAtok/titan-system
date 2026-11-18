'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { ActionButton, PackInactive, usePackActive } from '@/components/module-kit';
import { VideoPlayer } from '@/components/video-player';
import { Badge, Button, Card, type Column, DataTable, Dialog, Field, InlineError, KeyValue, PageHeader, QueryView, StatusBadge, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, dateTime, titleCase } from '@/lib/format';

const VIEWERS = ['security_operator', 'incident_commander', 'duty_officer', 'facility_manager', 'tenant_admin'];
const OPERATORS = ['security_operator', 'facility_manager', 'tenant_admin'];
const LOG_READERS = ['security_operator', 'tenant_admin', 'auditor'];
const NEXT: Record<string, string[]> = { online: ['offline', 'maintenance', 'decommissioned'], offline: ['online', 'maintenance', 'decommissioned'], maintenance: ['online', 'offline', 'decommissioned'], decommissioned: [] };
const KEYS = [['video']];

function ViewDialog({ camera, onClose }: { camera: any | null; onClose: () => void }) {
  const incidents = useQuery({ queryKey: ['video', 'incidents'], queryFn: () => api<any[]>('/api/video/incidents'), enabled: !!camera });
  const [purpose, setPurpose] = useState('');
  const [incidentId, setIncidentId] = useState('');
  const [session, setSession] = useState<any>(null);
  const client = useQueryClient();
  const start = useMutation({
    mutationFn: () => api<any>(`/api/video/cameras/${camera.id}/sessions`, { method: 'POST', body: { purpose, incident_id: incidentId || null } }),
    onSuccess: setSession,
  });
  const close = async () => {
    if (session) await api(`/api/video/sessions/${session.session_id}/end`, { method: 'POST' }).catch(() => undefined);
    await client.invalidateQueries({ queryKey: ['video'] });
    setSession(null);
    setPurpose('');
    onClose();
  };
  return (
    <Dialog open={!!camera} onClose={close} title={`View ${camera?.code ?? ''}`} footer={<><Button onClick={close}>{session ? 'End viewing' : 'Cancel'}</Button>{!session && <Button variant="primary" type="submit" form="view">Open stream</Button>}</>}>
      {session ? (
        <div className="space-y-2 text-sm">
          <p>Viewing session started {dateTime(session.started_at)} and logged with your purpose.</p>
          {/\.m3u8(\?|$)/.test(session.stream_url) ? (
            <VideoPlayer src={session.stream_url} label={`Live view of camera ${session.camera.code}`} />
          ) : (
            <p>This camera's stream is not playable in the browser; open it in your video player (TITAN does not relay or record video):</p>
          )}
          <code className="block break-all rounded bg-slate-100 p-2">{session.stream_url}</code>
          {session.camera.privacy_masking && <Badge tone="warn">Privacy masking applies to this camera</Badge>}
        </div>
      ) : (
        <form id="view" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); start.mutate(); }}>
          <Field label="Purpose" required hint="Recorded in the viewing log, which security and audit can read.">{(p) => <input {...p} className={inputClass} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} />}</Field>
          <Field label="Incident" hint="Optional.">
            {(p) => <select {...p} className={inputClass} value={incidentId} onChange={(e) => setIncidentId(e.target.value)}><option value="">None</option>{(incidents.data ?? []).map((i) => <option key={i.incident_id} value={i.incident_id}>{i.reference_no} · {i.title}</option>)}</select>}
          </Field>
          <InlineError error={start.error} />
        </form>
      )}
    </Dialog>
  );
}

function CameraDetail({ id }: { id: string }) {
  const { hasRole } = useAuth();
  const camera = useQuery({ queryKey: ['video', 'camera', id], queryFn: () => api<any>(`/api/video/cameras/${id}`) });
  const incidents = useQuery({ queryKey: ['video', 'incidents'], queryFn: () => api<any[]>('/api/video/incidents') });
  const [viewing, setViewing] = useState<any>(null);
  const [marker, setMarker] = useState({ label: '', incident_id: '', recording_id: '', at: '' });
  const [rec, setRec] = useState({ started_at: '', ended_at: '', storage_ref: '' });
  const iso = (local: string) => (local ? new Date(local).toISOString() : new Date().toISOString());
  return (
    <Card title="Camera">
      <QueryView query={camera} what="The camera">
        {(c) => (
          <div className="space-y-4 text-sm">
            <h2 className="text-base font-semibold">{c.code} · {c.name} <StatusBadge status={c.status} /> {c.privacy_masking && <Badge tone="warn">Privacy masking</Badge>}</h2>
            <KeyValue items={[
              ['Location', c.location_note || '—'],
              ['Coordinates', c.latitude === null ? '—' : `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`],
              ['Stream', c.has_stream ? 'Configured (shown only in a logged viewing session)' : 'None'],
              ['Recording retention', `${c.retention_days} days`],
              ['Last online', c.last_seen_at ? ago(c.last_seen_at) : '—'],
            ]} />
            <div className="flex flex-wrap gap-2">
              {hasRole(...VIEWERS) && c.status === 'online' && c.has_stream && <Button variant="primary" onClick={() => setViewing(c)}>View</Button>}
              {hasRole(...OPERATORS) && NEXT[c.status]!.map((s) => (
                <ActionButton key={s} variant={s === 'decommissioned' ? 'danger' : 'secondary'} invalidate={KEYS} confirm={s === 'decommissioned' ? 'Decommission this camera? This cannot be undone.' : undefined} run={() => api(`/api/video/cameras/${id}/status`, { method: 'POST', body: { status: s } })}>
                  Set {titleCase(s)}
                </ActionButton>
              ))}
            </div>
            <section>
              <h3 className="mb-1 font-semibold">Recordings (held by the video management system)</h3>
              {c.recordings.length === 0 ? <p className="text-ink-muted">None registered.</p> : (
                <ul className="divide-y divide-line">{c.recordings.map((r: any) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-1">
                    {dateTime(r.started_at)} – {dateTime(r.ended_at)} · <StatusBadge status={r.status} /> · kept until {r.retain_until.slice(0, 10)} {r.legal_hold && <Badge tone="danger">Legal hold</Badge>}
                    {hasRole(...OPERATORS) && r.status === 'available' && <ActionButton invalidate={KEYS} run={() => api(`/api/video/recordings/${r.id}/legal-hold`, { method: 'POST', body: { legal_hold: !r.legal_hold } })}>{r.legal_hold ? 'Release hold' : 'Legal hold'}</ActionButton>}
                  </li>
                ))}</ul>
              )}
              {hasRole(...OPERATORS) && c.status !== 'decommissioned' && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Field label="Start">{(p) => <input {...p} type="datetime-local" className={inputClass} value={rec.started_at} onChange={(e) => setRec({ ...rec, started_at: e.target.value })} />}</Field>
                  <Field label="End">{(p) => <input {...p} type="datetime-local" className={inputClass} value={rec.ended_at} onChange={(e) => setRec({ ...rec, ended_at: e.target.value })} />}</Field>
                  <Field label="VMS reference">{(p) => <input {...p} className={inputClass} value={rec.storage_ref} onChange={(e) => setRec({ ...rec, storage_ref: e.target.value })} />}</Field>
                  <ActionButton disabled={!rec.started_at || !rec.ended_at} invalidate={KEYS} run={() => api(`/api/video/cameras/${id}/recordings`, { method: 'POST', body: { started_at: iso(rec.started_at), ended_at: iso(rec.ended_at), storage_ref: rec.storage_ref || null } })} onDone={() => setRec({ started_at: '', ended_at: '', storage_ref: '' })}>Register recording</ActionButton>
                </div>
              )}
            </section>
            <section>
              <h3 className="mb-1 font-semibold">Markers</h3>
              {c.markers.length === 0 ? <p className="text-ink-muted">None.</p> : (
                <ul>{c.markers.map((m: any) => <li key={m.id}>{dateTime(m.at)} · {m.label}{m.incident_reference ? ` · ${m.incident_reference}` : ''} · {m.created_by}</li>)}</ul>
              )}
              {hasRole(...VIEWERS) && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Field label="Label">{(p) => <input {...p} className={inputClass} value={marker.label} onChange={(e) => setMarker({ ...marker, label: e.target.value })} />}</Field>
                  <Field label="When" hint="Empty = now">{(p) => <input {...p} type="datetime-local" className={inputClass} value={marker.at} onChange={(e) => setMarker({ ...marker, at: e.target.value })} />}</Field>
                  <Field label="Incident">{(p) => <select {...p} className={inputClass} value={marker.incident_id} onChange={(e) => setMarker({ ...marker, incident_id: e.target.value })}><option value="">None</option>{(incidents.data ?? []).map((i) => <option key={i.incident_id} value={i.incident_id}>{i.reference_no}</option>)}</select>}</Field>
                  <Field label="Recording">{(p) => <select {...p} className={inputClass} value={marker.recording_id} onChange={(e) => setMarker({ ...marker, recording_id: e.target.value })}><option value="">None</option>{c.recordings.filter((r: any) => r.status === 'available').map((r: any) => <option key={r.id} value={r.id}>{dateTime(r.started_at)}</option>)}</select>}</Field>
                  <ActionButton disabled={marker.label.trim().length < 2} invalidate={KEYS} run={() => api(`/api/video/cameras/${id}/markers`, { method: 'POST', body: { label: marker.label, at: iso(marker.at), incident_id: marker.incident_id || null, recording_id: marker.recording_id || null } })} onDone={() => setMarker({ label: '', incident_id: '', recording_id: '', at: '' })}>Add marker</ActionButton>
                </div>
              )}
            </section>
            <section>
              <h3 className="mb-1 font-semibold">Recent viewing</h3>
              {c.sessions.length === 0 ? <p className="text-ink-muted">Nobody has viewed this camera.</p> : <ul>{c.sessions.map((s: any) => <li key={s.id}>{dateTime(s.started_at)} · {s.viewer_username} · {s.purpose}</li>)}</ul>}
            </section>
          </div>
        )}
      </QueryView>
      <ViewDialog camera={viewing} onClose={() => setViewing(null)} />
    </Card>
  );
}

function RegisterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [form, setForm] = useState({ code: '', name: '', location_note: '', stream_url: '', latitude: '', longitude: '', retention_days: '30', privacy_masking: false });
  const create = useMutation({
    mutationFn: () =>
      api('/api/video/cameras', {
        method: 'POST',
        body: { ...form, stream_url: form.stream_url || null, latitude: form.latitude === '' ? null : Number(form.latitude), longitude: form.longitude === '' ? null : Number(form.longitude), retention_days: Number(form.retention_days) },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['video'] });
      onClose();
    },
  });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Dialog open={open} onClose={onClose} title="Register camera" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="cam">Register</Button></>}>
      <form id="cam" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" required>{(p) => <input {...p} className={inputClass} value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} />}</Field>
          <Field label="Name" required>{(p) => <input {...p} className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} />}</Field>
          <Field label="Latitude">{(p) => <input {...p} type="number" step="any" className={inputClass} value={form.latitude} onChange={(e) => set('latitude', e.target.value)} />}</Field>
          <Field label="Longitude">{(p) => <input {...p} type="number" step="any" className={inputClass} value={form.longitude} onChange={(e) => set('longitude', e.target.value)} />}</Field>
        </div>
        <Field label="Location">{(p) => <input {...p} className={inputClass} value={form.location_note} onChange={(e) => set('location_note', e.target.value)} />}</Field>
        <Field label="Stream URL" hint="rtsp, rtsps, https or http, without credentials.">{(p) => <input {...p} className={inputClass} value={form.stream_url} onChange={(e) => set('stream_url', e.target.value)} />}</Field>
        <Field label="Recording retention (days)">{(p) => <input {...p} type="number" min="1" className={inputClass} value={form.retention_days} onChange={(e) => set('retention_days', e.target.value)} />}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.privacy_masking} onChange={(e) => set('privacy_masking', e.target.checked)} /> Privacy masking applies</label>
        <InlineError error={create.error} />
      </form>
    </Dialog>
  );
}

function Content() {
  const active = usePackActive('video-monitoring');
  const router = useRouter();
  const id = useSearchParams().get('id');
  const { hasRole } = useAuth();
  const [registering, setRegistering] = useState(false);
  const cameras = useQuery({ queryKey: ['video', 'cameras'], queryFn: () => api<any[]>('/api/video/cameras'), enabled: active === true, refetchInterval: 15_000 });
  const log = useQuery({ queryKey: ['video', 'sessions'], queryFn: () => api<any[]>('/api/video/sessions'), enabled: active === true && hasRole(...LOG_READERS) });
  if (active === false) return <PackInactive title="Cameras" pack="video monitoring" />;
  const columns: Column<any>[] = [
    { key: 'code', header: 'Camera', value: (c) => c.code, cell: (c) => <button className="font-medium text-brand-700 hover:underline" onClick={() => router.replace(`/video/?id=${c.id}`)}>{c.code}</button> },
    { key: 'name', header: 'Name', value: (c) => c.name, cell: (c) => c.name },
    { key: 'status', header: 'Status', value: (c) => c.status, cell: (c) => <StatusBadge status={c.status} /> },
    { key: 'rec', header: 'Recordings', value: (c) => c.recordings, cell: (c) => c.recordings, align: 'right' },
    { key: 'viewed', header: 'Last viewed', value: (c) => c.last_viewed_at ?? '', cell: (c) => (c.last_viewed_at ? ago(c.last_viewed_at) : '—') },
  ];
  return (
    <>
      <PageHeader
        title="Cameras"
        description="Camera register, audited viewing, recording references and incident markers. TITAN does not store, stream or analyse video."
        actions={hasRole(...OPERATORS) && <Button variant="primary" onClick={() => setRegistering(true)}>Register camera</Button>}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Card title="Camera register" padded={false}><QueryView query={cameras} what="Cameras">{(rows) => <DataTable caption="Cameras" columns={columns} rows={rows} rowKey={(c) => c.id} emptyTitle="No cameras" />}</QueryView></Card>
          {hasRole(...LOG_READERS) && (
            <Card title="Viewing log" padded={false}>
              <QueryView query={log} what="The viewing log" isEmpty={(d) => d.length === 0} empty={<p className="p-3 text-sm text-ink-muted">No viewing yet.</p>}>
                {(rows) => <ul className="divide-y divide-line text-sm">{rows.slice(0, 50).map((s) => <li key={s.id} className="px-3 py-1.5">{dateTime(s.started_at)} · {s.camera_code} · {s.viewer_username} · {s.purpose}{s.ended_at ? '' : ' · open'}</li>)}</ul>}
              </QueryView>
            </Card>
          )}
        </div>
        {id ? <CameraDetail id={id} /> : <Card><p className="text-sm text-ink-muted">Select a camera.</p></Card>}
      </div>
      <RegisterDialog open={registering} onClose={() => setRegistering(false)} />
    </>
  );
}

export default function VideoPage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}
