import { describe, expect, it } from 'vitest';
import { pdfText, sheetNames, toPdf, toXlsx, zip } from './formats.js';

const sections = [
  { title: 'Incidents', dataset: 'incidents_by_severity', columns: ['severity', 'incidents'], rows: [{ severity: 'critical', incidents: 3 }, { severity: '=cmd|"/c calc"!A0', incidents: 1 }] },
  { title: 'Empty: [x]', dataset: 'pending_tasks', columns: ['stage'], rows: [] },
];

/** Reads the names of a zip's entries from its central directory. */
function entries(buf: Buffer): string[] {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const len = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    names.push(buf.subarray(p + 46, p + 46 + len).toString('utf8'));
    p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return names;
}

describe('xlsx', () => {
  it('is a zip with the workbook parts and one sheet per section', () => {
    const file = toXlsx(sections);
    expect(file.subarray(0, 2).toString()).toBe('PK');
    expect(entries(file)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
  });

  it('writes numbers as numbers and text as inline strings, never as formulas', () => {
    const text = toXlsx(sections).toString('utf8');
    expect(text).toContain('<c r="B2" s="0"><v>3</v></c>');
    expect(text).toContain('=cmd|&quot;/c calc&quot;!A0');
    expect(text).not.toContain('<f>');
  });

  it('makes valid, unique sheet names', () => {
    expect(sheetNames(['A/B', 'a/b', 'x'.repeat(40)])).toEqual(['A B', 'a b 2', 'x'.repeat(28)]);
  });

  it('stores entries with correct sizes', () => {
    const z = zip([{ name: 'a.txt', data: Buffer.from('hello') }]);
    expect(z.readUInt32LE(18)).toBe(5);
    expect(entries(z)).toEqual(['a.txt']);
  });
});

describe('pdf', () => {
  it('is a well-formed PDF whose cross-reference table points at its objects', () => {
    const pdf = toPdf({ name: 'Weekly (test)', description: 'd', generated_at: '2026-11-18T00:00:00Z', generated_by: 'anna', sections });
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(text.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
    expect(text).toContain('(Weekly \\(test\\)) Tj');
    expect(text).toContain('No rows for this tenant.');
  });

  it('breaks long reports into pages', () => {
    const many = [{ title: 'Many', dataset: 'd', columns: ['n'], rows: Array.from({ length: 200 }, (_, n) => ({ n })) }];
    const text = toPdf({ name: 'R', description: '', generated_at: '', generated_by: '', sections: many }).toString('latin1');
    expect(Number(/\/Count (\d+)/.exec(text)![1])).toBeGreaterThan(3);
  });

  it('escapes PDF string syntax and replaces characters it cannot encode', () => {
    expect(pdfText('a(b)c\\')).toBe('a\\(b\\)c\\\\');
    expect(pdfText('日本 ok')).toBe('?? ok');
  });
});
