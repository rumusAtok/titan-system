/**
 * JSON text with object keys in a fixed order, so equal content always gives
 * equal text. Used for checksums and for deciding whether a template that a
 * pack installs differs from the one already in place.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Marks who created a record on behalf of a pack, e.g. `pack:manufacturing@1.1.0`. */
export function packActor(packId: string, version: string): string {
  return `pack:${packId}@${version}`;
}
