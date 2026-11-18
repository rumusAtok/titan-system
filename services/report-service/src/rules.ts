/** Pure report rules: schedules, CSV and printable HTML rendering. No I/O. */

export type Schedule = 'none' | 'daily' | 'weekly' | 'monthly';

/** Next time a scheduled report falls due, at 06:00 UTC. `none` never falls due. */
export function nextDue(schedule: Schedule, from: Date): Date | null {
  if (schedule === 'none') return null;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 6, 0, 0));
  if (schedule === 'daily') {
    if (d <= from) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  if (schedule === 'weekly') {
    // Mondays.
    const add = (8 - d.getUTCDay()) % 7;
    d.setUTCDate(d.getUTCDate() + add);
    if (d <= from) d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }
  // monthly: the 1st.
  d.setUTCDate(1);
  if (d <= from) d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export interface Section {
  title: string;
  dataset: string;
  columns: string[];
  rows: Record<string, unknown>[];
  freshness?: unknown;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * One CSV cell. Text that a spreadsheet would treat as a formula (=, +, -, @, tab, CR)
 * is prefixed with an apostrophe (CSV injection); numbers are left as they are.
 */
export function csvCell(value: unknown): string {
  let text = cellText(value);
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function escapeHtml(value: unknown): string {
  return cellText(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Columns of a section: the declared ones, else those of the first row. */
export function columnsOf(rows: Record<string, unknown>[], declared?: string[]): string[] {
  if (declared && declared.length) return declared;
  return rows.length ? Object.keys(rows[0]!) : [];
}

/**
 * Self-contained printable HTML. Every value is escaped; the page has no scripts and is
 * served with a CSP that forbids them.
 */
export function renderHtml(report: { name: string; description: string; generated_at: string; generated_by: string; tenant_name?: string; sections: Section[] }): string {
  const sections = report.sections
    .map((s) => {
      const head = s.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
      const body = s.rows.length
        ? s.rows.map((r) => `<tr>${s.columns.map((c) => `<td>${escapeHtml(r[c])}</td>`).join('')}</tr>`).join('\n')
        : `<tr><td colspan="${Math.max(1, s.columns.length)}" class="empty">No rows for this tenant.</td></tr>`;
      return `<section><h2>${escapeHtml(s.title)}</h2><p class="meta">Dataset <code>${escapeHtml(s.dataset)}</code> · ${s.rows.length} row(s)</p>
<table><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table></section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(report.name)}</title>
<style>
body{font:13px/1.45 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 4px}
.meta{color:#555;margin:0 0 8px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:3px 6px;text-align:left;vertical-align:top}
th{background:#f2f2f2}.empty{color:#777;font-style:italic}footer{margin-top:24px;color:#555;font-size:11px}
</style></head><body>
<h1>${escapeHtml(report.name)}</h1>
<p class="meta">${escapeHtml(report.description)}</p>
<p class="meta">Generated ${escapeHtml(report.generated_at)} by ${escapeHtml(report.generated_by)}. Figures come from the TITAN analytics read model and are as fresh as its last load.</p>
${sections}
<footer>TITAN development release: a locally generated report, not an official or certified record.</footer>
</body></html>
`;
}
