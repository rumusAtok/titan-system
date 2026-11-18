/** Pure video rules. No I/O. */

export type CameraStatus = 'online' | 'offline' | 'maintenance' | 'decommissioned';

const TRANSITIONS: Record<CameraStatus, CameraStatus[]> = {
  online: ['offline', 'maintenance', 'decommissioned'],
  offline: ['online', 'maintenance', 'decommissioned'],
  maintenance: ['online', 'offline', 'decommissioned'],
  decommissioned: [],
};

export function canTransition(from: CameraStatus, to: CameraStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * A stream URL is metadata handed to an authorised viewer's player. It must not carry
 * credentials (they would be shown to every viewer and logged); the VMS authenticates instead.
 */
export function checkStreamUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (!['rtsp:', 'rtsps:', 'https:', 'http:'].includes(url.protocol)) return { ok: false, reason: 'stream URLs must use rtsp, rtsps, https or http' };
  if (url.username || url.password) return { ok: false, reason: 'credentials must not be embedded in the stream URL' };
  return { ok: true };
}

/** Maximum length of one registered recording segment. */
export const MAX_SEGMENT_HOURS = 24;

export function checkSegment(startedAt: Date, endedAt: Date, now = new Date()): { ok: true } | { ok: false; reason: string } {
  if (!(endedAt > startedAt)) return { ok: false, reason: 'a recording must end after it starts' };
  if (endedAt.getTime() - startedAt.getTime() > MAX_SEGMENT_HOURS * 3_600_000) return { ok: false, reason: `a recording segment may be at most ${MAX_SEGMENT_HOURS} hours` };
  if (endedAt.getTime() > now.getTime() + 60_000) return { ok: false, reason: 'a recording cannot end in the future' };
  return { ok: true };
}

/** Last day a recording is kept: its end date plus the camera's retention period. */
export function retainUntil(endedAt: Date, retentionDays: number): string {
  const d = new Date(Date.UTC(endedAt.getUTCFullYear(), endedAt.getUTCMonth(), endedAt.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + retentionDays);
  return d.toISOString().slice(0, 10);
}

/** A marker must fall inside its recording, when it names one. */
export function markerInside(at: Date, recording: { started_at: Date; ended_at: Date } | null): boolean {
  return !recording || (at >= recording.started_at && at <= recording.ended_at);
}
