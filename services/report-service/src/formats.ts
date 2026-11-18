/**
 * Report output formats without third-party libraries:
 *  - XLSX: an Office Open XML workbook (a zip of XML parts), one sheet per section.
 *  - PDF: a plain text document (PDF 1.4, standard Courier/Helvetica fonts), A4 landscape.
 * Values are written as text or numbers only: no formulas are ever produced.
 */
import { crc32 } from 'node:zlib';
import type { Section } from './rules.js';

// --- zip (stored entries) ------------------------------------------------------------

function u16(n: number) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** A zip archive with uncompressed entries (valid for Office Open XML). */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), name]);
    parts.push(local, f.data);
    central.push(
      Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]),
    );
    offset += local.length + f.data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(dir.length), u32(offset), u16(0)]);
  return Buffer.concat([...parts, dir, end]);
}

// --- xlsx ------------------------------------------------------------------------------

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function columnName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cell(ref: string, value: unknown, style = 0): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Inline strings are never interpreted as formulas.
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(text.slice(0, 32_000))}</t></is></c>`;
}

/** Sheet names: at most 31 characters, none of : \ / ? * [ ], unique. */
export function sheetNames(titles: string[]): string[] {
  const used = new Set<string>();
  return titles.map((t, i) => {
    let base = t.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 28) || `Sheet ${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 26)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export function toXlsx(sections: Section[]): Buffer {
  const names = sheetNames(sections.map((s) => s.title));
  const sheets = sections.map((s) => {
    const rows = [`<row r="1">${s.columns.map((c, i) => cell(`${columnName(i)}1`, c, 1)).join('')}</row>`];
    s.rows.forEach((r, n) => rows.push(`<row r="${n + 2}">${s.columns.map((c, i) => cell(`${columnName(i)}${n + 2}`, r[c])).join('')}</row>`));
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  });
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    },
    ...sheets.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })));
}

// --- pdf -------------------------------------------------------------------------------

/** Text for a PDF string literal in WinAnsi: escapes, and characters outside Latin-1 become '?'. */
export function pdfText(s: string): string {
  return s
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .replace(/[\\()]/g, (c) => `\\${c}`);
}

function fit(value: unknown, width: number): string {
  const s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return s.length > width ? `${s.slice(0, Math.max(1, width - 1))}~` : s.padEnd(width);
}

/** Plain-text PDF: a title block, then each section as a fixed-width table, with page numbers. */
export function toPdf(report: { name: string; description: string; generated_at: string; generated_by: string; sections: Section[] }): Buffer {
  const PAGE_W = 842;
  const PAGE_H = 595;
  const MARGIN = 36;
  const LINE = 11;
  const CHARS = 132; // Courier 8 pt across the usable width
  type Line = { text: string; font: 'F1' | 'F2' | 'F3'; size: number };
  const lines: Line[] = [
    { text: report.name, font: 'F2', size: 14 },
    { text: report.description, font: 'F3', size: 9 },
    { text: `Generated ${report.generated_at} by ${report.generated_by}. Figures come from the TITAN analytics read model.`, font: 'F3', size: 8 },
    { text: '', font: 'F1', size: 8 },
  ];
  for (const s of report.sections) {
    lines.push({ text: `${s.title}  (${s.dataset}, ${s.rows.length} row(s))`, font: 'F2', size: 10 });
    const cols = s.columns.length || 1;
    const width = Math.max(6, Math.floor((CHARS - cols) / cols));
    lines.push({ text: s.columns.map((c) => fit(c, width)).join(' '), font: 'F1', size: 8 });
    lines.push({ text: '-'.repeat(Math.min(CHARS, cols * (width + 1))), font: 'F1', size: 8 });
    if (!s.rows.length) lines.push({ text: 'No rows for this tenant.', font: 'F3', size: 8 });
    for (const r of s.rows) lines.push({ text: s.columns.map((c) => fit(r[c], width)).join(' '), font: 'F1', size: 8 });
    lines.push({ text: '', font: 'F1', size: 8 });
  }
  const perPage = Math.floor((PAGE_H - 2 * MARGIN - 20) / LINE);
  const pages: Line[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));

  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length;
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const f3 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  pages.forEach((page, p) => {
    let y = PAGE_H - MARGIN;
    const ops = ['BT'];
    for (const l of page) {
      ops.push(`/${l.font} ${l.size} Tf 1 0 0 1 ${MARGIN} ${y} Tm (${pdfText(l.text)}) Tj`);
      y -= l.size > 9 ? LINE + 4 : LINE;
    }
    ops.push(`/F3 7 Tf 1 0 0 1 ${MARGIN} ${MARGIN - 12} Tm (${pdfText(`TITAN development release - not an official record - page ${p + 1} of ${pages.length}`)}) Tj`, 'ET');
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
