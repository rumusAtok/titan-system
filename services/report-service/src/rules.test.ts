import { describe, expect, it } from 'vitest';
import { columnsOf, csvCell, escapeHtml, nextDue, renderHtml, toCsv } from './rules.js';

describe('nextDue', () => {
  const wed = new Date('2026-11-18T10:00:00Z'); // a Wednesday

  it('never falls due without a schedule', () => {
    expect(nextDue('none', wed)).toBeNull();
  });

  it('daily: 06:00 UTC the next day once today has passed', () => {
    expect(nextDue('daily', wed)?.toISOString()).toBe('2026-11-19T06:00:00.000Z');
    expect(nextDue('daily', new Date('2026-11-18T05:00:00Z'))?.toISOString()).toBe('2026-11-18T06:00:00.000Z');
  });

  it('weekly: the next Monday', () => {
    expect(nextDue('weekly', wed)?.toISOString()).toBe('2026-11-23T06:00:00.000Z');
    expect(nextDue('weekly', new Date('2026-11-23T06:00:00Z'))?.toISOString()).toBe('2026-11-30T06:00:00.000Z');
  });

  it('monthly: the first of the next month, across a year end', () => {
    expect(nextDue('monthly', wed)?.toISOString()).toBe('2026-12-01T06:00:00.000Z');
    expect(nextDue('monthly', new Date('2026-12-15T00:00:00Z'))?.toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });
});

describe('CSV', () => {
  it('quotes separators, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
  });

  it('neutralises spreadsheet formulas but keeps negative numbers', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell(-5)).toBe('-5');
  });

  it('writes a header and one line per row', () => {
    expect(toCsv(['a', 'b'], [{ a: 1, b: 'x' }, { a: 2, b: null }])).toBe('a,b\r\n1,x\r\n2,\r\n');
  });
});

describe('HTML', () => {
  it('escapes every value so data cannot inject markup', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    const html = renderHtml({
      name: 'R <b>',
      description: 'd',
      generated_at: '2026-11-17T00:00:00Z',
      generated_by: 'analyst',
      sections: [{ title: 'S', dataset: 'incidents_by_severity', columns: ['severity'], rows: [{ severity: '<img src=x onerror=alert(1)>' }] }],
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('R &lt;b&gt;');
  });

  it('says so when a section has no rows', () => {
    const html = renderHtml({ name: 'R', description: '', generated_at: '', generated_by: '', sections: [{ title: 'S', dataset: 'd', columns: ['a'], rows: [] }] });
    expect(html).toContain('No rows for this tenant.');
  });

  it('takes columns from the first row when none are declared', () => {
    expect(columnsOf([{ x: 1, y: 2 }])).toEqual(['x', 'y']);
    expect(columnsOf([], ['a'])).toEqual(['a']);
    expect(columnsOf([])).toEqual([]);
  });
});
