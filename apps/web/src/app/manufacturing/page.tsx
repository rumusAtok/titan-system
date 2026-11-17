'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo } from 'react';
import { WorkOrdersTable } from '@/components/maintenance';
import { Badge, Card, EmptyState, PageHeader, QueryView, SimulatedTag, StatusBadge } from '@/components/ui';
import { DashboardView } from '@/components/widgets';
import { api } from '@/lib/api';
import { ago, number, titleCase } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

const METRICS = ['vibration_rms', 'bearing_temperature', 'spindle_load'];

/** Industry page of the manufacturing pack: machines, their live condition, equipment incidents and repair work. */
export default function ManufacturingPage() {
  const { info, dashboards } = useWorkspace();
  const active = info?.packs.some((p) => p.id === 'manufacturing');
  const machines = useQuery({ queryKey: ['assets', 'list', 'manufacturing'], queryFn: () => api<any[]>('/api/asset/assets?pack=manufacturing&limit=500'), enabled: !!active });
  const devices = useQuery({ queryKey: ['devices', 'condition'], queryFn: () => api<any[]>('/api/device/devices?profile_key=machine-condition-monitor'), enabled: !!active });
  const latest = useQuery({ queryKey: ['telemetry', 'machine'], queryFn: () => api<any[]>(`/api/telemetry/latest?sensor_kind=${METRICS.join(',')}`), enabled: !!active, refetchInterval: 10_000 });
  const incidents = useQuery({ queryKey: ['incidents', 'equipment'], queryFn: () => api<any[]>('/api/incident/incidents?category=equipment&status=active'), enabled: !!active, refetchInterval: 15_000 });
  const rules = useQuery({ queryKey: ['alert', 'rules'], queryFn: () => api<any[]>('/api/alert/rules'), enabled: !!active });

  // Machine -> monitor -> latest value per metric.
  const rows = useMemo(() => {
    const byDevice = new Map<string, Record<string, any>>();
    for (const r of latest.data ?? []) byDevice.set(r.device_id, { ...(byDevice.get(r.device_id) ?? {}), [r.sensor_kind]: r });
    return (machines.data ?? [])
      .filter((a) => a.category_code !== 'PRODUCTION_LINE')
      .map((a) => {
        const monitor = (devices.data ?? []).find((d) => d.asset_id === a.id);
        return { asset: a, monitor, readings: monitor ? byDevice.get(monitor.id) ?? {} : {} };
      });
  }, [machines.data, devices.data, latest.data]);
  const limit = (name: string) => rules.data?.find((r) => r.name === name)?.threshold as number | undefined;
  const vibrationWarning = limit('High machine vibration');
  const temperatureLimit = limit('Bearing over-temperature');
  const dashboard = dashboards.find((d) => d.key === 'manufacturing');

  if (info && !active) {
    return (
      <>
        <PageHeader title="Production equipment" />
        <Card><EmptyState title="The manufacturing pack is not active for your organisation" /></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Production equipment" description="Machine condition, equipment incidents and corrective maintenance." actions={<SimulatedTag />} />
      <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Machines" description="Latest condition readings" className="xl:col-span-2" padded={false}>
          <QueryView query={machines} what="Machines" isEmpty={() => rows.length === 0} empty={<p className="p-4 text-sm text-ink-muted">No machines registered.</p>}>
            {() => (
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Machine condition table">
                <table className="min-w-full divide-y divide-line text-sm">
                  <caption className="sr-only">Machines and their latest condition readings</caption>
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-ink-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2">Machine</th>
                      <th scope="col" className="px-4 py-2">Status</th>
                      <th scope="col" className="px-4 py-2 text-right">Vibration (mm/s)</th>
                      <th scope="col" className="px-4 py-2 text-right">Bearing (°C)</th>
                      <th scope="col" className="px-4 py-2 text-right">Load (%)</th>
                      <th scope="col" className="px-4 py-2">Last reading</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map(({ asset, monitor, readings }) => {
                      const v = readings.vibration_rms?.value;
                      const t = readings.bearing_temperature?.value;
                      return (
                        <tr key={asset.id}>
                          <td className="px-4 py-2"><Link className="font-medium text-brand-700 hover:underline" href={`/assets/?id=${asset.id}`}>{asset.code}</Link> {asset.name}</td>
                          <td className="px-4 py-2"><StatusBadge status={asset.status} /></td>
                          <td className={`px-4 py-2 text-right tabular-nums ${vibrationWarning !== undefined && v > vibrationWarning ? 'font-semibold text-red-700' : ''}`}>{v === undefined ? '—' : number(v, 2)}</td>
                          <td className={`px-4 py-2 text-right tabular-nums ${temperatureLimit !== undefined && t > temperatureLimit ? 'font-semibold text-red-700' : ''}`}>{t === undefined ? '—' : number(t, 1)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{readings.spindle_load ? number(readings.spindle_load.value, 0) : '—'}</td>
                          <td className="px-4 py-2 text-ink-muted">{monitor ? (readings.vibration_rms ? ago(readings.vibration_rms.observed_at) : 'No reading yet') : 'No monitor'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </QueryView>
          {vibrationWarning !== undefined && <p className="px-4 py-2 text-xs text-ink-muted">Values above the configured warning levels (vibration {vibrationWarning} mm/s, bearing {temperatureLimit} °C) are highlighted.</p>}
        </Card>
        <Card title="Open equipment incidents" padded={false}>
          <QueryView query={incidents} what="Equipment incidents" isEmpty={(d) => d.length === 0} empty={<p className="p-4 text-sm text-ink-muted">No open equipment incidents.</p>}>
            {(list) => (
              <ul className="divide-y divide-line">
                {list.map((i) => (
                  <li key={i.id} className="px-4 py-2 text-sm">
                    <Link className="font-medium text-brand-700 hover:underline" href={`/incidents/?id=${i.id}`}>{i.reference_no}</Link> {i.title}
                    <div className="mt-0.5 flex gap-2"><Badge tone={i.severity === 'critical' ? 'danger' : 'warn'}>{titleCase(i.severity)}</Badge><StatusBadge status={i.status} />{i.response_overdue && <Badge tone="danger">Response overdue</Badge>}</div>
                  </li>
                ))}
              </ul>
            )}
          </QueryView>
        </Card>
      </div>
      <div className="mb-6">
        <WorkOrdersTable pack="manufacturing" title="Repair work orders" />
      </div>
      {dashboard && <DashboardView dashboard={dashboard} />}
    </>
  );
}
