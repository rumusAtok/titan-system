import { describe, expect, it } from 'vitest';
import { checkAttachment, FormFields, sanitizeFilename, validateFormData } from './forms.js';

const fields = FormFields.parse([
  { name: 'applicant_name', label: 'Name', type: 'text', required: true, max_length: 50 },
  { name: 'project_type', label: 'Type', type: 'select', required: true, options: ['residential', 'commercial'] },
  { name: 'floor_area_m2', label: 'Area', type: 'number', required: true, min: 1, max: 1000 },
  { name: 'start_date', label: 'Start', type: 'date' },
  { name: 'contact', label: 'Contact', type: 'email' },
  { name: 'declaration', label: 'Declaration', type: 'boolean', required: true },
]);

const valid = { applicant_name: 'Alice', project_type: 'residential', floor_area_m2: 120, start_date: '2027-01-15', contact: 'a@example.test', declaration: true };

describe('form definition', () => {
  it('rejects duplicate field names and select fields without options', () => {
    expect(() => FormFields.parse([{ name: 'a', label: 'A', type: 'text' }, { name: 'a', label: 'B', type: 'text' }])).toThrow();
    expect(() => FormFields.parse([{ name: 'a', label: 'A', type: 'select' }])).toThrow();
  });
});

describe('form data validation', () => {
  it('accepts valid data', () => {
    expect(validateFormData(fields, valid)).toEqual([]);
  });

  it('reports every missing required field on submission', () => {
    const errors = validateFormData(fields, {});
    expect(errors.map((e) => e.field).sort()).toEqual(['applicant_name', 'declaration', 'floor_area_m2', 'project_type']);
  });

  it('lets a draft be incomplete but not wrong', () => {
    expect(validateFormData(fields, { applicant_name: 'Alice' }, { partial: true })).toEqual([]);
    expect(validateFormData(fields, { floor_area_m2: 'big' }, { partial: true })).toHaveLength(1);
  });

  it('rejects unknown fields (no silent mass assignment)', () => {
    expect(validateFormData(fields, { ...valid, status: 'approved' })).toEqual([{ field: 'status', message: 'unknown field' }]);
  });

  it('enforces types, ranges, options and formats', () => {
    const errors = validateFormData(fields, {
      applicant_name: 'x'.repeat(51),
      project_type: 'castle',
      floor_area_m2: 0,
      start_date: '15/01/2027',
      contact: 'not-an-email',
      declaration: 'yes',
    });
    expect(errors.map((e) => e.field).sort()).toEqual(['applicant_name', 'contact', 'declaration', 'floor_area_m2', 'project_type', 'start_date']);
  });

  it('treats whitespace-only text as empty', () => {
    expect(validateFormData(fields, { ...valid, applicant_name: '   ' }).map((e) => e.field)).toEqual(['applicant_name']);
  });
});

describe('attachment checks', () => {
  const pdf = Buffer.from('%PDF-1.7\nfake body');

  it('accepts an allowed type whose content matches', () => {
    expect(checkAttachment('application/pdf', pdf)).toBeNull();
    expect(checkAttachment('text/plain', Buffer.from('hello'))).toBeNull();
  });

  it('refuses a disallowed content type', () => {
    expect(checkAttachment('application/x-msdownload', Buffer.from('MZ'))).toMatch(/not allowed/);
    expect(checkAttachment('text/html', Buffer.from('<script>'))).toMatch(/not allowed/);
  });

  it('refuses content that does not match its declared type', () => {
    expect(checkAttachment('application/pdf', Buffer.from('MZ\x90\x00 executable'))).toMatch(/does not match/);
    expect(checkAttachment('image/png', pdf)).toMatch(/does not match/);
    expect(checkAttachment('text/plain', Buffer.from([0x41, 0x00, 0x42]))).toMatch(/does not match/);
  });

  it('refuses empty and oversized files', () => {
    expect(checkAttachment('text/plain', Buffer.alloc(0))).toMatch(/empty/);
    expect(checkAttachment('text/plain', Buffer.alloc(2 * 1024 * 1024 + 1, 0x41))).toMatch(/exceeds/);
  });

  it('strips directories and unsafe characters from file names', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\plan.pdf')).toBe('plan.pdf');
    expect(sanitizeFilename('a"b\r\nc.pdf')).toBe('a_b_c.pdf');
    expect(sanitizeFilename('...')).toBe('attachment');
  });
});
