'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Radio } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chart } from '@/components/chart';
import { DecisionDialog, type WorkflowTask } from '@/components/decision';
import { Badge, Button, Card, type Column, DataTable, Dialog, EmptyState, InlineError, PageHeader, QueryView, SimulatedTag, Spinner, Stat, StatusBadge, inputClass } from '@/components/ui';
import { api, type LiveEvent, useEventStream } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, dateTime, number, timeOnly, titleCase } from '@/lib/format';

const MAX_POINTS = 600;

function IncidentDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { hasRole } = useAuth();
  const client = useQueryClient();
  const [deciding, setDeciding] = useState<WorkflowTask | null>(null);
  const incident = useQuery({ queryKey: ['incident', id], queryFn: () => api(`/api/incident/incidents/${id}`), enabled: !!id, refetchInterval: 5_000 });
  const tasks = useQuery({ queryKey: ['workflow', 'tasks', id], queryFn: () => api<any[]>(`/api/workflow/tasks?subject_id=${id}`), enabled: !!id, refetchInterval: 5_000, retry: false });
  const close = useMutation({
    mutationFn: () => api(`/api/incident/incidents/${id}/close`, { method: 'POST' }),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ['incident'] }), client.invalidateQueries({ queryKey: ['incidents'] })]),
  });
  const i = incident.data;
  return (
    <>
      <Dialog open={!!id && !deciding} onClose={onClose} title={i ? `${i.reference_no}: ${i.title}` : 'Incident'} footer={<Button onClick={onClose}>Close window</Button>}>
        {incident.isPending && <Spinner />}
        {i && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={i.severity} />
              <StatusBadge status={i.status} />
              <span className="text-xs text-ink-muted">Created {dateTime(i.created_at)}</span>
            </div>
            <p className="text-sm text-ink">{i.description || 'No description.'}</p>
            {i.acknowledged_by && <p className="text-sm text-ink-muted">Acknowledged by {i.acknowledged_by} at {dateTime(i.acknowledged_at)}.</p>}

            {tasks.data?.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-300 bg-sky-50 p-3">
                <p className="text-sm text-sky-900">
                  <span className="font-semibold">{t.stage_name}</span> is waiting for you ({titleCase(t.role)}).
                </p>
                <Button variant="primary" onClick={() => setDeciding(t)}>
                  {t.stage_key === 'acknowledge' ? 'Acknowledge' : 'Resolve'}
                </Button>
              </div>
            ))}
            {tasks.data?.length === 0 && (i.status === 'open' || i.status === 'acknowledged') && (
              <p className="text-sm text-ink-muted">The next response step is assigned to a role you do not hold.</p>
            )}
            {i.status === 'resolved' && hasRole('incident_commander') && (
              <Button onClick={() => close.mutate()} disabled={close.isPending}>
                Close incident
              </Button>
            )}
            <InlineError error={close.error} />

            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Timeline</h3>
              <ol className="max-h-56 space-y-2 overflow-y-auto border-l border-line pl-4" tabIndex={0} aria-label="Incident timeline">
                {i.timeline.map((t: any) => (
                  <li key={t.id} className="text-sm">
                    <span className="text-ink">{t.message}</span>
                    <span className="block text-xs text-ink-muted">{dateTime(t.occurred_at)}{t.actor_username ? ` · ${t.actor_username}` : ''}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </Dialog>
      <DecisionDialog task={deciding} onClose={() => setDeciding(null)} />
    </>
  );
}

export default function IotPage() {
  const { hasRole } = useAuth();
  const client = useQueryClient();
  const [deviceId, setDeviceId] = useState('');
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [livePoints, setLivePoints] = useState<Array<[string, number]>>([]);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const selected = useRef(deviceId);
  selected.current = deviceId;

  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<any[]>('/api/device/devices'), refetchInterval: 15_000 });
  const deviceSummary = useQuery({ queryKey: ['devices', 'summary'], queryFn: () => api('/api/device/devices/summary'), refetchInterval: 15_000 });
  const latest = useQuery({ queryKey: ['telemetry', 'latest'], queryFn: () => api<any[]>('/api/telemetry/latest'), refetchInterval: 5_000 });
  const rules = useQuery({ queryKey: ['alert', 'rules'], queryFn: () => api<any[]>('/api/alert/rules') });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api<any[]>('/api/alert/alerts?limit=100'), refetchInterval: 15_000 });
  const incidents = useQuery({ queryKey: ['incidents'], queryFn: () => api<any[]>('/api/incident/incidents?limit=100'), refetchInterval: 15_000 });
  const ingest = useQuery({ queryKey: ['telemetry', 'stats'], queryFn: () => api('/api/telemetry/ingest/stats'), refetchInterval: 30_000 });

  useEffect(() => {
    if (!deviceId && devices.data?.length) setDeviceId(devices.data.find((d) => d.status === 'online')?.id ?? devices.data[0]!.id);
  }, [devices.data, deviceId]);

  const series = useQuery({
    queryKey: ['telemetry', 'series', deviceId],
    queryFn: () => api(`/api/telemetry/series?device_id=${deviceId}&sensor_kind=water_level&bucket_seconds=15`),
    enabled: !!deviceId,
  });
  // New device or fresh history: live points start again after the history.
  useEffect(() => setLivePoints([]), [deviceId, series.dataUpdatedAt]);

  const onEvent = useCallback(
    (event: LiveEvent) => {
      setLastEventAt(event.occurred_at);
      if (event.type === 'telemetry.measurement.accepted.v1') {
        const p = event.payload;
        if (p.device_id === selected.current && p.sensor_kind === 'water_level' && p.quality === 'ok') {
          setLivePoints((prev) => [...prev.slice(-MAX_POINTS), [p.observed_at, p.value]]);
        }
        return;
      }
      // Alarms, incidents and device status changed: refresh those panels now instead of waiting for the poll.
      if (event.type.startsWith('alert.')) void client.invalidateQueries({ queryKey: ['alerts'] });
      if (event.type.startsWith('incident.') || event.type.startsWith('workflow.task.')) {
        void client.invalidateQueries({ queryKey: ['incidents'] });
        void client.invalidateQueries({ queryKey: ['incident'] });
        void client.invalidateQueries({ queryKey: ['workflow'] });
      }
      if (event.type.startsWith('device.')) void client.invalidateQueries({ queryKey: ['devices'] });
    },
    [client],
  );
  const stream = useEventStream(onEvent);

  const acknowledge = useMutation({ mutationFn: (id: string) => api(`/api/alert/alerts/${id}/acknowledge`, { method: 'POST' }), onSuccess: () => client.invalidateQueries({ queryKey: ['alerts'] }) });

  const chartOption = useMemo(() => {
    const history: Array<[string, number]> = (series.data?.points ?? []).map((p: any) => [p.bucket, p.avg]);
    const thresholds = (rules.data ?? []).filter((r) => r.enabled && r.sensor_kind === 'water_level' && (!r.device_id || r.device_id === deviceId));
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 44, right: 70, top: 16, bottom: 30 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'm', scale: true, max: (v: { max: number }) => Math.max(v.max, ...thresholds.map((t) => t.threshold)) + 0.3 },
      series: [
        {
          name: 'Water level',
          type: 'line',
          showSymbol: false,
          data: [...history, ...livePoints],
          areaStyle: { opacity: 0.08 },
          markLine: {
            symbol: 'none',
            silent: true,
            data: thresholds.map((t) => ({ yAxis: t.threshold, name: t.name, lineStyle: { color: t.severity === 'critical' ? '#b91c1c' : '#d97706', type: 'dashed' }, label: { formatter: `${t.severity} ${t.threshold} m`, position: 'end' } })),
          },
        },
      ],
    };
  }, [series.data, livePoints, rules.data, deviceId]);

  const tiles = useMemo(() => {
    const byDevice = new Map<string, any>();
    for (const row of latest.data ?? []) {
      const d = byDevice.get(row.device_id) ?? { device_id: row.device_id, name: row.device_name, serial_no: row.serial_no, readings: {} as Record<string, any> };
      d.readings[row.sensor_kind] = row;
      byDevice.set(row.device_id, d);
    }
    const status = new Map((devices.data ?? []).map((d) => [d.id, d.status]));
    return [...byDevice.values()].map((d) => ({ ...d, status: status.get(d.device_id) ?? 'registered' })).sort((a, b) => a.name.localeCompare(b.name));
  }, [latest.data, devices.data]);

  const canAcknowledge = hasRole('duty_officer', 'incident_commander', 'iot_operator');
  const alertColumns: Column<any>[] = [
    { key: 'rule', header: 'Alarm', value: (a) => a.rule_name, cell: (a) => a.rule_name },
    { key: 'device', header: 'Device', value: (a) => a.device_name ?? '', cell: (a) => a.device_name ?? '—' },
    { key: 'severity', header: 'Severity', value: (a) => a.severity, cell: (a) => <StatusBadge status={a.severity} /> },
    { key: 'status', header: 'Status', value: (a) => a.status, cell: (a) => <StatusBadge status={a.status} /> },
    { key: 'value', header: 'Trigger / last', align: 'right', value: (a) => a.trigger_value ?? 0, cell: (a) => (a.trigger_value === null ? '—' : `${a.trigger_value} / ${a.last_value}`) },
    { key: 'threshold', header: 'Threshold', align: 'right', value: (a) => a.threshold ?? 0, cell: (a) => (a.threshold === null ? '—' : `${a.operator} ${a.threshold}`), defaultHidden: true },
    { key: 'count', header: 'Readings', align: 'right', value: (a) => a.occurrences, cell: (a) => a.occurrences },
    { key: 'first', header: 'First triggered', value: (a) => a.first_triggered_at, cell: (a) => dateTime(a.first_triggered_at) },
    { key: 'cleared', header: 'Cleared', value: (a) => a.cleared_at ?? '', cell: (a) => dateTime(a.cleared_at), defaultHidden: true },
    {
      key: 'action', header: 'Action',
      cell: (a) => (a.status === 'active' && canAcknowledge ? <Button onClick={() => acknowledge.mutate(a.id)} disabled={acknowledge.isPending}>Acknowledge</Button> : a.acknowledged_by ? <span className="text-xs text-ink-muted">by {a.acknowledged_by}</span> : null),
    },
  ];
  const incidentColumns: Column<any>[] = [
    { key: 'reference', header: 'Reference', value: (i) => i.reference_no, cell: (i) => i.reference_no },
    { key: 'title', header: 'Title', value: (i) => i.title, cell: (i) => i.title },
    { key: 'severity', header: 'Severity', value: (i) => i.severity, cell: (i) => <StatusBadge status={i.severity} /> },
    { key: 'status', header: 'Status', value: (i) => i.status, cell: (i) => <StatusBadge status={i.status} /> },
    { key: 'created', header: 'Created', value: (i) => i.created_at, cell: (i) => dateTime(i.created_at) },
    { key: 'ack', header: 'Acknowledged by', value: (i) => i.acknowledged_by ?? '', cell: (i) => i.acknowledged_by ?? '—' },
    { key: 'source', header: 'Source', value: (i) => i.source_type, cell: (i) => titleCase(i.source_type), defaultHidden: true },
  ];

  const streamBadge = { live: <Badge tone="ok">Live</Badge>, connecting: <Badge>Connecting…</Badge>, reconnecting: <Badge tone="warn">Reconnecting…</Badge>, unavailable: <Badge tone="warn">Live updates unavailable</Badge> }[stream];
  const s = deviceSummary.data;

  return (
    <>
      <PageHeader
        title="IoT operations"
        description="Flood-monitoring sensors, alarms and incidents. Readings arrive over MQTT and are evaluated against threshold rules."
        actions={
          <span className="flex items-center gap-2" data-testid="stream-status">
            <Radio className="h-4 w-4 text-ink-muted" aria-hidden="true" />
            {streamBadge}
            {lastEventAt && <span className="text-xs text-ink-muted">last event {timeOnly(lastEventAt)}</span>}
          </span>
        }
      />

      <dl className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Sensors online" value={s ? `${s.online} / ${s.in_service}` : '—'} hint={s?.availability_pct !== null && s ? `${s.availability_pct}% reporting` : 'No device has reported yet'} tone={s && s.online < s.in_service ? 'warn' : 'ok'} />
        <Stat label="Open alarms" value={alerts.data ? alerts.data.filter((a) => a.status !== 'cleared').length : '—'} tone={alerts.data?.some((a) => a.status === 'active') ? 'danger' : 'ok'} />
        <Stat label="Active incidents" value={incidents.data ? incidents.data.filter((i) => i.status === 'open' || i.status === 'acknowledged').length : '—'} tone={incidents.data?.some((i) => i.status === 'open') ? 'danger' : 'ok'} />
        <Stat
          label="Readings, last hour"
          value={ingest.data ? number(ingest.data.readings_by_quality.reduce((n: number, r: any) => n + r.count, 0)) : '—'}
          hint={ingest.data ? `${ingest.data.readings_by_quality.filter((r: any) => r.quality !== 'ok').reduce((n: number, r: any) => n + r.count, 0)} flagged · ${ingest.data.rejected.reduce((n: number, r: any) => n + r.count, 0)} rejected · MQTT ${ingest.data.mqtt_connected ? 'connected' : 'disconnected'}` : undefined}
          tone={ingest.data && !ingest.data.mqtt_connected ? 'danger' : 'info'}
        />
      </dl>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card
          title="Water level, live"
          description="Last hour (15-second averages), then readings as they arrive"
          className="xl:col-span-2"
          actions={
            <>
              <SimulatedTag />
              <label htmlFor="device-select" className="sr-only">Sensor</label>
              <select id="device-select" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className={`${inputClass} w-auto`}>
                {(devices.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </>
          }
        >
          {!deviceId ? <EmptyState title="No sensors registered" /> : (
            <QueryView query={series} what="Sensor history">
              {() => <Chart option={chartOption} label="Live line chart of water level for the selected sensor, with alarm thresholds" height={320} />}
            </QueryView>
          )}
          <p className="mt-2 text-xs text-ink-muted" aria-live="polite">{livePoints.length} live reading{livePoints.length === 1 ? '' : 's'} received since this chart opened.</p>
        </Card>

        <Card title="Sensor health" description="Device status from device-service" padded={false}>
          <QueryView query={devices} what="Sensor health" isEmpty={(d) => d.length === 0} empty={<EmptyState title="No sensors registered" />}>
            {(rows) => (
              <ul className="max-h-[380px] divide-y divide-line overflow-y-auto" tabIndex={0} aria-label="Sensor health list">
                {rows.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{d.name}</p>
                      <p className="text-xs text-ink-muted">{d.serial_no} · last seen {ago(d.last_seen_at)}</p>
                    </div>
                    <StatusBadge status={d.status} />
                  </li>
                ))}
              </ul>
            )}
          </QueryView>
        </Card>
      </div>

      <section aria-label="Latest sensor measurements" className="mt-6">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">Latest measurements</h2>
          <SimulatedTag />
        </div>
        <QueryView query={latest} what="Latest measurements" isEmpty={() => tiles.length === 0} empty={<Card><EmptyState title="No measurements received yet">Start the sensor simulator to publish synthetic readings.</EmptyState></Card>}>
          {() => (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="sensor-tiles">
              {tiles.map((t) => {
                const level = t.readings.water_level;
                return (
                  <div key={t.device_id} className="rounded-lg border border-line bg-surface p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-medium text-ink" title={t.name}>{t.name}</p>
                      <StatusBadge status={t.status} />
                    </div>
                    <p className="mt-2 text-3xl font-semibold tabular-nums text-ink">
                      {level ? number(level.value, 2) : '—'} <span className="text-base font-normal text-ink-muted">m</span>
                    </p>
                    <p className="mt-1 text-xs text-ink-muted">
                      Rain {t.readings.rainfall ? `${number(t.readings.rainfall.value, 1)} mm/h` : '—'} · Battery {t.readings.battery ? `${number(t.readings.battery.value, 2)} V` : '—'}
                    </p>
                    <p className="mt-1 text-xs text-ink-muted">
                      Observed {ago(level?.observed_at)}{level && level.quality !== 'ok' && <> · <span className="font-medium text-amber-700">{titleCase(level.quality)}</span></>}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </QueryView>
      </section>

      <div className="mt-6 grid grid-cols-1 gap-6 2xl:grid-cols-2">
        <Card title="Incidents" description="Select an incident to see its timeline and respond" padded={false}>
          <QueryView query={incidents} what="Incidents">
            {(rows) => <DataTable caption="Incidents" columns={incidentColumns} rows={rows} rowKey={(i) => i.id} onRowOpen={(i) => setIncidentId(i.id)} emptyTitle="No incidents" pageSize={10} />}
          </QueryView>
        </Card>
        <Card title="Alarm history" padded={false}>
          <InlineError error={acknowledge.error} />
          <QueryView query={alerts} what="Alarm history">
            {(rows) => <DataTable caption="Alarm history" columns={alertColumns} rows={rows} rowKey={(a) => a.id} emptyTitle="No alarms" pageSize={10} />}
          </QueryView>
        </Card>
      </div>

      <IncidentDialog id={incidentId} onClose={() => setIncidentId(null)} />
    </>
  );
}
