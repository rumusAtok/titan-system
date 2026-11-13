'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, Columns3, Inbox, Lock, PlugZap, RefreshCw } from 'lucide-react';
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { titleCase } from '@/lib/format';

// --- layout primitives ---------------------------------------------------------

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, actions, children, className = '', padded = true }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  const headingId = useId();
  return (
    <section aria-labelledby={title ? headingId : undefined} className={`rounded-lg border border-line bg-surface shadow-sm ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            {title && (
              <h2 id={headingId} className="text-sm font-semibold text-ink">
                {title}
              </h2>
            )}
            {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';

const TONE: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-300',
  ok: 'bg-green-50 text-green-800 ring-green-300',
  warn: 'bg-amber-50 text-amber-900 ring-amber-300',
  danger: 'bg-red-50 text-red-800 ring-red-300',
  info: 'bg-sky-50 text-sky-800 ring-sky-300',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<string, Tone> = {
  // cases / workflow
  draft: 'neutral', submitted: 'info', in_review: 'info', returned: 'warn', approved: 'ok', rejected: 'danger', cancelled: 'neutral',
  running: 'info', pending: 'warn', completed: 'ok', approve: 'ok', reject: 'danger', return: 'warn',
  // incidents / alerts
  open: 'danger', acknowledged: 'warn', resolved: 'ok', closed: 'neutral', active: 'danger', cleared: 'ok',
  critical: 'danger', warning: 'warn', info: 'info',
  // devices / assets / services
  online: 'ok', offline: 'danger', registered: 'neutral', decommissioned: 'neutral',
  planned: 'neutral', under_maintenance: 'warn', retired: 'neutral', good: 'ok', fair: 'info', poor: 'warn',
  ok: 'ok', degraded: 'warn', unavailable: 'danger', unreachable: 'danger', sent: 'ok', failed: 'danger',
  succeeded: 'ok', executed: 'ok', expired: 'neutral',
};

/** Status shown as text plus colour, never colour alone. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge>—</Badge>;
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{titleCase(status)}</Badge>;
}

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  const styles = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 border-transparent',
    secondary: 'bg-white text-ink hover:bg-slate-50 border-line',
    danger: 'bg-red-700 text-white hover:bg-red-800 border-transparent',
    ghost: 'bg-transparent text-ink-muted hover:bg-slate-100 border-transparent',
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export function Stat({ label, value, hint, tone = 'neutral' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  const accent = { neutral: 'border-l-slate-300', ok: 'border-l-green-600', warn: 'border-l-amber-500', danger: 'border-l-red-600', info: 'border-l-sky-600' }[tone];
  return (
    <div className={`rounded-lg border border-line border-l-4 bg-surface p-4 shadow-sm ${accent}`}>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-1">
        <span className="block text-2xl font-semibold tabular-nums text-ink" data-stat-value>{value}</span>
        {hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
      </dd>
    </div>
  );
}

/** Marks a panel whose figures come from synthetic (simulated) data. */
export function SimulatedTag() {
  return (
    <span title="Generated by the sensor simulator; not real measurements" className="inline-flex items-center rounded border border-dashed border-violet-400 bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-800">
      Simulated data
    </span>
  );
}

// --- states ---------------------------------------------------------------------

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 p-4 text-sm text-ink-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
      <Inbox className="h-8 w-8 text-slate-400" aria-hidden="true" />
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="max-w-md text-sm text-ink-muted">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, what = 'This information' }: { error: unknown; onRetry?: () => void; what?: string }) {
  const e = error instanceof ApiError ? error : null;
  if (e?.isForbidden) {
    return (
      <div role="alert" data-state="unauthorized" className="flex flex-col items-center gap-1 px-4 py-10 text-center">
        <Lock className="h-8 w-8 text-slate-400" aria-hidden="true" />
        <p className="text-sm font-medium text-ink">Not authorised</p>
        <p className="max-w-md text-sm text-ink-muted">Your role does not include access to this. Ask a tenant administrator if you need it.</p>
      </div>
    );
  }
  if (e?.isUnavailable) {
    return (
      <div role="alert" data-state="degraded" className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <PlugZap className="h-8 w-8 text-amber-500" aria-hidden="true" />
        <p className="text-sm font-medium text-ink">Service unavailable</p>
        <p className="max-w-md text-sm text-ink-muted">{what} comes from a service that is not running or not reachable right now. The rest of the platform keeps working.</p>
        {onRetry && (
          <Button onClick={onRetry}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry
          </Button>
        )}
      </div>
    );
  }
  return (
    <div role="alert" data-state="error" className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <AlertTriangle className="h-8 w-8 text-red-500" aria-hidden="true" />
      <p className="text-sm font-medium text-ink">Something went wrong</p>
      <p className="max-w-md text-sm text-ink-muted">{error instanceof Error ? error.message : 'Unexpected error'}</p>
      {e?.correlationId && <p className="font-mono text-xs text-ink-muted">Reference: {e.correlationId}</p>}
      {onRetry && (
        <Button onClick={onRetry}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry
        </Button>
      )}
    </div>
  );
}

/** Renders loading / error / unauthorised / degraded states for a query, otherwise its data. */
export function QueryView<T>({ query, children, what, isEmpty, empty }: { query: UseQueryResult<T>; children: (data: T) => ReactNode; what?: string; isEmpty?: (data: T) => boolean; empty?: ReactNode }) {
  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} what={what} />;
  if (isEmpty?.(query.data)) return <>{empty ?? <EmptyState title="Nothing to show yet" />}</>;
  return <>{children(query.data)}</>;
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const details = Array.isArray(e?.details) ? (e!.details as Array<{ field?: string; path?: string; message: string }>) : [];
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p className="font-medium">{error instanceof Error ? error.message : 'Request failed'}</p>
      {details.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {details.map((d, i) => (
            <li key={i}>
              {(d.field ?? d.path) && <span className="font-medium">{titleCase(d.field ?? d.path)}: </span>}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- forms ----------------------------------------------------------------------

const INPUT = 'block w-full rounded-md border border-line bg-white px-3 py-1.5 text-sm text-ink shadow-sm placeholder:text-slate-400 disabled:bg-slate-50';

export function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: (props: { id: string; 'aria-describedby'?: string; required?: boolean }) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink">
        {label}
        {required && (
          <span className="text-red-700" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children({ id, 'aria-describedby': hint ? hintId : undefined, required })}
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-ink-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export const inputClass = INPUT;

// --- dialog ---------------------------------------------------------------------

/** Modal built on the native <dialog> element (focus trapping and Escape handling come with it). */
export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} onCancel={onClose} className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-line p-0 shadow-xl backdrop:bg-slate-900/50">
      <div className="border-b border-line px-5 py-3">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {title}
        </h2>
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-line bg-slate-50 px-5 py-3">{footer}</div>}
    </dialog>
  );
}

// --- data table -----------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Value used for sorting and for the text filter. Omit to make the column unsortable. */
  value?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right';
  /** Hidden until the user enables it in the column chooser. */
  defaultHidden?: boolean;
}

/**
 * Table with a text filter, sortable columns and a column chooser.
 * Rows are plain <tr>; when `onRowOpen` is given the first cell holds a real
 * button, so the row is reachable and operable from the keyboard.
 */
export function DataTable<T>({ caption, columns, rows, rowKey, onRowOpen, filterPlaceholder = 'Filter…', toolbar, emptyTitle = 'No matching records', pageSize = 25 }: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowOpen?: (row: T) => void;
  filterPlaceholder?: string;
  toolbar?: ReactNode;
  emptyTitle?: string;
  pageSize?: number;
}) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key)));
  const [page, setPage] = useState(0);
  const filterId = useId();

  const visible = columns.filter((c) => !hidden.has(c.key));
  const processed = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let out = needle ? rows.filter((r) => columns.some((c) => c.value && String(c.value(r) ?? '').toLowerCase().includes(needle))) : rows;
    const column = sort && columns.find((c) => c.key === sort.key);
    if (sort && column?.value) {
      out = [...out].sort((a, b) => {
        const x = column.value!(a) ?? '';
        const y = column.value!(b) ?? '';
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir;
      });
    }
    return out;
  }, [rows, columns, filter, sort]);

  const pages = Math.max(1, Math.ceil(processed.length / pageSize));
  const current = Math.min(page, pages - 1);
  const shown = processed.slice(current * pageSize, current * pageSize + pageSize);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <label htmlFor={filterId} className="sr-only">
          Filter {caption}
        </label>
        <input id={filterId} type="search" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} placeholder={filterPlaceholder} className={`${INPUT} max-w-xs`} />
        {toolbar}
        <details className="relative ml-auto">
          <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-line bg-white px-2.5 py-1.5 text-sm text-ink shadow-sm hover:bg-slate-50">
            <Columns3 className="h-4 w-4" aria-hidden="true" /> Columns
          </summary>
          <fieldset className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-line bg-white p-2 shadow-lg">
            <legend className="sr-only">Visible columns</legend>
            {columns.map((c) => (
              <label key={c.key} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={!hidden.has(c.key)}
                  disabled={!hidden.has(c.key) && visible.length === 1}
                  onChange={() => setHidden((prev) => { const next = new Set(prev); if (next.has(c.key)) next.delete(c.key); else next.add(c.key); return next; })}
                />
                {c.header}
              </label>
            ))}
          </fieldset>
        </details>
      </div>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Scrollable table">
        <table className="min-w-full divide-y divide-line text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-slate-50">
            <tr>
              {visible.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} scope="col" aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined} className={`whitespace-nowrap px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                    {c.value ? (
                      <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-ink" onClick={() => setSort(active ? (sort!.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}>
                        {c.header}
                        {active && (sort!.dir === 1 ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" />)}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((row) => (
              <tr key={rowKey(row)} className={onRowOpen ? 'hover:bg-brand-50' : undefined}>
                {visible.map((c, i) => (
                  <td key={c.key} className={`px-4 py-2 align-top ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                    {i === 0 && onRowOpen ? (
                      <button type="button" onClick={() => onRowOpen(row)} className="text-left font-medium text-brand-700 underline-offset-2 hover:underline">
                        {c.cell(row)}
                      </button>
                    ) : (
                      c.cell(row)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {processed.length === 0 && <EmptyState title={rows.length === 0 ? emptyTitle : 'No records match the filter'} />}
      <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-ink-muted">
        <span aria-live="polite">
          {processed.length} of {rows.length} record{rows.length === 1 ? '' : 's'}
        </span>
        {pages > 1 && (
          <span className="flex items-center gap-2">
            <Button variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
              Previous
            </Button>
            Page {current + 1} of {pages}
            <Button variant="ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              Next
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}

export function KeyValue({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{k}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
