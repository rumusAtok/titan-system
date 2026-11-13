'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { Chart } from '@/components/chart';
import { Badge, Card, ErrorState, PageHeader, QueryView, SimulatedTag, Spinner, Stat, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { STAFF_ROLES, useAuth } from '@/lib/auth';
import { ago, dateTime, duration, number, titleCase } from '@/lib/format';

export default function DashboardPage() {
  const { hasRole } = useAuth();
  const router = useRouter();
  const isStaff = hasRole(...STAFF_ROLES);

  // People without a staff role have no dashboard: send them to their own area.
  useEffect(() => {
    if (isStaff) return;
    router.replace(hasRole('applicant') ? '/government/' : '/dr/');
  }, [isStaff, hasRole, router]);

  const summary = useQuery({ queryKey: ['kpi', 'summary'], queryFn: () => api('/api/analytics/kpis/summary'), enabled: isStaff, refetchInterval: 30_000 });
  const turnaround = useQuery({ queryKey: ['kpi', 'turnaround'], queryFn: () => api('/api/analytics/kpis/approval-turnaround'), enabled: isStaff });
  const trend = useQuery({ queryKey: ['kpi', 'trend'], queryFn: () => api('/api/analytics/kpis/water-level-trend'), enabled: isStaff, refetchInterval: 60_000 });
  const incidents = useQuery({ queryKey: ['incident', 'summary'], queryFn: () => api('/api/incident/incidents/summary'), enabled: isStaff, refetchInterval: 15_000 });
  const workflow = useQuery({ queryKey: ['workflow', 'stats'], queryFn: () => api('/api/workflow/stats'), enabled: isStaff, refetchInterval: 15_000 });
  const assets = useQuery({ queryKey: ['asset', 'summary'], queryFn: () => api('/api/asset/assets/summary'), enabled: isStaff });

  const trendOption = useMemo(() => {
    const rows: any[] = trend.data?.rows ?? [];
    const devices = [...new Map(rows.map((r) => [r.device_id, r.device_name ?? r.device_id])).entries()].slice(0, 8);
    return {
      tooltip: { trigger: 'axis' },
      legend: { type: 'scroll', bottom: 0 },
      grid: { left: 44, right: 16, top: 16, bottom: 48 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'm', scale: true },
      series: devices.map(([id, name]) => ({
        name,
        type: 'line',
        showSymbol: false,
        smooth: true,
        data: rows.filter((r) => r.device_id === id).map((r) => [r.bucket, r.avg_level]),
        markLine: undefined,
      })),
    };
  }, [trend.data]);

  const severityOption = useMemo(() => {
    const active: any[] = incidents.data?.active_by_severity ?? [];
    const all: any[] = incidents.data?.by_severity ?? [];
    const order = ['critical', 'warning', 'info'];
    const count = (rows: any[], s: string) => rows.find((r) => r.severity === s)?.count ?? 0;
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0 },
      grid: { left: 40, right: 16, top: 16, bottom: 40 },
      xAxis: { type: 'category', data: order.map(titleCase) },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        { name: 'Active', type: 'bar', data: order.map((s) => count(active, s)), itemStyle: { color: '#b91c1c' } },
        { name: 'All time', type: 'bar', data: order.map((s) => count(all, s)), itemStyle: { color: '#94a3b8' } },
      ],
    };
  }, [incidents.data]);

  const pendingOption = useMemo(() => {
    const rows: any[] = workflow.data?.pending_by_role ?? [];
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0 },
      grid: { left: 150, right: 16, top: 8, bottom: 40 },
      xAxis: { type: 'value', minInterval: 1 },
      yAxis: { type: 'category', data: rows.map((r) => titleCase(r.role)) },
      series: [
        { name: 'Pending', type: 'bar', stack: 'a', data: rows.map((r) => r.pending - r.overdue), itemStyle: { color: '#0369a1' } },
        { name: 'Overdue', type: 'bar', stack: 'a', data: rows.map((r) => r.overdue), itemStyle: { color: '#b45309' } },
      ],
    };
  }, [workflow.data]);

  const assetOption = useMemo(() => {
    const rows: any[] = assets.data?.by_status ?? [];
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0 },
      series: [{ type: 'pie', radius: ['45%', '70%'], center: ['50%', '44%'], label: { formatter: '{b}: {c}' }, data: rows.map((r) => ({ name: titleCase(r.status), value: r.count })) }],
    };
  }, [assets.data]);

  if (!isStaff) return <Spinner label="Opening your workspace…" />;

  const s = summary.data;
  return (
    <>
      <PageHeader
        title="Executive dashboard"
        description="Indicators are calculated by the data pipeline from stored records. Live panels read the owning services directly."
        actions={s?.freshness?.computed_at ? <Badge tone="info">KPIs computed {ago(s.freshness.computed_at)}</Badge> : undefined}
      />

      <section aria-label="Key performance indicators" className="mb-6">
        {summary.isPending && <Spinner label="Loading indicators…" />}
        {summary.isError && (
          <Card>
            <ErrorState error={summary.error} onRetry={() => void summary.refetch()} what="The KPI summary (analytics profile)" />
          </Card>
        )}
        {s && s.freshness?.status !== 'loaded' && (
          <Card>
            <p className="text-sm text-ink-muted">The analytical datasets have not been computed yet. They appear after the first pipeline run.</p>
          </Card>
        )}
        {s && s.freshness?.status === 'loaded' && (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5" data-testid="kpi-cards">
            <Stat label="Approvals completed" value={number(s.approvals.completed)} hint={`${s.approvals.approved} approved · ${s.approvals.rejected} rejected`} tone="info" />
            <Stat label="Average turnaround" value={duration(s.approvals.avg_turnaround_hours)} hint="Submission to final decision" />
            <Stat label="Pending case tasks" value={number(s.workflow_tasks.pending)} hint={`${s.workflow_tasks.overdue} past their SLA`} tone={s.workflow_tasks.overdue > 0 ? 'warn' : 'ok'} />
            <Stat label="Active incidents" value={number(s.incidents.open + s.incidents.acknowledged)} hint={`${s.incidents.active_critical} critical · ${s.incidents.open} unacknowledged`} tone={s.incidents.open > 0 ? 'danger' : 'ok'} />
            <Stat
              label="Sensor availability"
              value={s.sensors.avg_availability_pct === null ? '—' : `${number(s.sensors.avg_availability_pct, 1)}%`}
              hint={`${s.sensors.online} of ${s.sensors.devices} sensors online`}
              tone={s.sensors.devices > 0 && s.sensors.online < s.sensors.devices ? 'warn' : 'ok'}
            />
          </dl>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Water-level trend" description="5-minute averages, trailing 24 hours" actions={<SimulatedTag />} className="xl:col-span-2">
          <QueryView query={trend} what="The water-level trend" isEmpty={(d: any) => d.rows.length === 0} empty={<p className="p-4 text-sm text-ink-muted">No readings in the last 24 hours.</p>}>
            {() => <Chart option={trendOption} label="Line chart of average water level per sensor over the last 24 hours" height={300} />}
          </QueryView>
        </Card>

        <Card title="Incidents by severity" description="Live from incident-service">
          <QueryView query={incidents} what="The incident summary">
            {(d: any) => (
              <>
                <Chart option={severityOption} label="Bar chart of incidents by severity, active and all time" height={220} />
                <p className="mt-2 text-xs text-ink-muted">
                  Average time to acknowledge: {d.response.avg_seconds_to_acknowledge === null ? '—' : `${number(d.response.avg_seconds_to_acknowledge)} s`} ({d.response.acknowledged} acknowledged)
                </p>
              </>
            )}
          </QueryView>
        </Card>

        <Card title="Workflow tasks waiting" description="Pending tasks by reviewing role, live from workflow-service">
          <QueryView query={workflow} what="Workflow statistics" isEmpty={(d: any) => d.pending_by_role.length === 0} empty={<p className="p-4 text-sm text-ink-muted">No tasks are waiting.</p>}>
            {() => <Chart option={pendingOption} label="Stacked bar chart of pending and overdue workflow tasks by role" height={240} />}
          </QueryView>
        </Card>

        <Card title="Approval turnaround" description="By form and outcome" padded={false}>
          <QueryView query={turnaround} what="Approval turnaround" isEmpty={(d: any) => d.rows.length === 0} empty={<p className="p-4 text-sm text-ink-muted">No completed approvals yet.</p>}>
            {(d: any) => (
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Scrollable table">
                <table className="min-w-full divide-y divide-line text-sm">
                  <caption className="sr-only">Approval turnaround by form and outcome</caption>
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-ink-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2">Form</th>
                      <th scope="col" className="px-4 py-2">Outcome</th>
                      <th scope="col" className="px-4 py-2 text-right">Cases</th>
                      <th scope="col" className="px-4 py-2 text-right">Average</th>
                      <th scope="col" className="px-4 py-2 text-right">90th pct</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {d.rows.map((r: any) => (
                      <tr key={`${r.form_key}-${r.outcome}`}>
                        <td className="px-4 py-2">{titleCase(r.form_key)}</td>
                        <td className="px-4 py-2"><StatusBadge status={r.outcome} /></td>
                        <td className="px-4 py-2 text-right tabular-nums">{r.cases}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{duration(r.avg_hours)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{duration(r.p90_hours)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryView>
        </Card>

        <Card title="Assets" description="Lifecycle status, live from asset-service">
          <QueryView query={assets} what="The asset summary">
            {(d: any) => (
              <>
                <Chart option={assetOption} label="Donut chart of assets by lifecycle status" height={220} />
                <p className="mt-2 text-xs text-ink-muted">
                  {d.maintenance.overdue} with overdue maintenance · {d.maintenance.due_within_30_days} due within 30 days · {d.maintenance.unscheduled} unscheduled
                </p>
              </>
            )}
          </QueryView>
        </Card>
      </div>

      {s?.freshness?.computed_at && (
        <p className="mt-6 text-xs text-ink-muted">
          KPI source: {s.freshness.source}. Last computed {dateTime(s.freshness.computed_at)}.
        </p>
      )}
    </>
  );
}
