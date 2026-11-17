'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import { ago, dateTime, number, titleCase } from '@/lib/format';
import type { DashboardDef, Widget } from '@/lib/workspace';
import { Chart } from './chart';
import { Badge, Card, ErrorState, Spinner } from './ui';

interface DatasetResult {
  dataset: string;
  rows: Record<string, any>[];
  row_count: number;
  freshness: { computed_at: string | null } | null;
}

/** Applies a widget's aggregation to the rows of its dataset. */
export function aggregate(rows: Record<string, any>[], column: string, agg: NonNullable<Widget['value']>['agg']): number | null {
  if (agg === 'count') return rows.length;
  const values = rows.map((r) => r[column]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return agg === 'sum' ? 0 : null;
  switch (agg) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return number(value, Number.isInteger(value) ? 0 : 2);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return dateTime(value);
  return titleCase(String(value));
}

/**
 * One dashboard widget. It reads a REGISTERED dataset through analytics-service,
 * which checks the tenant's capabilities and binds the query to the tenant; the
 * widget definition can only choose the dataset and equality filters on declared columns.
 */
export function WidgetView({ widget }: { widget: Widget }) {
  const query = useQuery({
    queryKey: ['analytics', 'dataset', widget.dataset, widget.filters],
    queryFn: () => api<DatasetResult>(`/api/analytics/datasets/${widget.dataset}/query`, { method: 'POST', body: { filters: widget.filters } }),
    refetchInterval: 60_000,
  });

  const option = useMemo(() => {
    const rows = query.data?.rows ?? [];
    if (widget.type === 'timeseries' && widget.x && widget.y) {
      const key = widget.series;
      const groups = key ? [...new Set(rows.map((r) => String(r[key])))].slice(0, 8) : ['value'];
      return {
        tooltip: { trigger: 'axis' },
        legend: { type: 'scroll', bottom: 0 },
        grid: { left: 48, right: 16, top: 16, bottom: 48 },
        xAxis: { type: 'time' },
        yAxis: { type: 'value', name: widget.unit, scale: true },
        series: groups.map((g) => ({
          name: g,
          type: 'line',
          showSymbol: false,
          data: rows.filter((r) => !key || String(r[key]) === g).map((r) => [r[widget.x!], r[widget.y!]]),
        })),
      };
    }
    if (widget.type === 'bar' && widget.category && widget.value) {
      const categories = [...new Set(rows.map((r) => String(r[widget.category!])))].sort();
      return {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 48, right: 16, top: 16, bottom: 40 },
        xAxis: { type: 'category', data: categories.map(titleCase) },
        yAxis: { type: 'value', minInterval: 1 },
        series: [{ type: 'bar', data: categories.map((c) => aggregate(rows.filter((r) => String(r[widget.category!]) === c), widget.value!.column, widget.value!.agg) ?? 0) }],
      };
    }
    return null;
  }, [query.data, widget]);

  const span = widget.span >= 3 ? 'xl:col-span-3' : widget.span === 2 ? 'xl:col-span-2' : '';
  const computed = query.data?.freshness?.computed_at;

  return (
    <Card title={widget.title} description={widget.description || undefined} className={span} actions={computed ? <Badge tone="info">{ago(computed)}</Badge> : undefined}>
      <div data-testid={`widget-${widget.id}`}>
        {query.isPending && <Spinner label="Loading…" />}
        {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} what={widget.title} />}
        {query.data && !computed && <p className="text-sm text-ink-muted">Not computed yet: the figures appear after the next data pipeline run.</p>}
        {query.data && computed && widget.type === 'stat' && widget.value && (
          <p className="text-3xl font-semibold tabular-nums text-ink" data-stat-value>
            {(() => {
              const v = aggregate(query.data.rows, widget.value.column, widget.value.agg);
              return v === null ? '—' : `${number(v, widget.value.agg === 'avg' ? 1 : 0)}${widget.unit ? ` ${widget.unit}` : ''}`;
            })()}
          </p>
        )}
        {query.data && computed && option && (query.data.rows.length ? <Chart option={option} label={`${widget.title}: chart of ${query.data.rows.length} data points`} height={240} /> : <p className="text-sm text-ink-muted">No data yet.</p>)}
        {query.data && computed && widget.type === 'table' && widget.columns && (
          query.data.rows.length === 0 ? (
            <p className="text-sm text-ink-muted">No rows.</p>
          ) : (
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`${widget.title} table`}>
              <table className="min-w-full divide-y divide-line text-sm">
                <caption className="sr-only">{widget.title}</caption>
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-ink-muted">
                  <tr>
                    {widget.columns.map((c) => (
                      <th key={c.column} scope="col" className="px-3 py-2">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {query.data.rows.slice(0, 25).map((r, i) => (
                    <tr key={i}>
                      {widget.columns!.map((c) => (
                        <td key={c.column} className="px-3 py-1.5 tabular-nums">
                          {cellText(r[c.column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </Card>
  );
}

export function DashboardView({ dashboard }: { dashboard: DashboardDef }) {
  return (
    <section aria-labelledby={`dashboard-${dashboard.key}`} className="mb-8">
      <h2 id={`dashboard-${dashboard.key}`} className="text-lg font-semibold text-ink">
        {dashboard.title}
      </h2>
      {dashboard.description && <p className="mb-3 text-sm text-ink-muted">{dashboard.description}</p>}
      {dashboard.widgets.length === 0 ? (
        <p className="text-sm text-ink-muted">Every widget of this dashboard has been hidden by your administrator.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {dashboard.widgets.map((w) => (
            <WidgetView key={w.id} widget={w} />
          ))}
        </div>
      )}
    </section>
  );
}
