import { describe, expect, it } from 'vitest';
import { canTransition, checkSegment, checkStreamUrl, markerInside, retainUntil } from './rules.js';

describe('camera status', () => {
  it('allows operational changes and never leaves decommissioned', () => {
    expect(canTransition('online', 'offline')).toBe(true);
    expect(canTransition('offline', 'online')).toBe(true);
    expect(canTransition('online', 'decommissioned')).toBe(true);
    expect(canTransition('decommissioned', 'online')).toBe(false);
    expect(canTransition('online', 'online')).toBe(false);
  });
});

describe('stream URL', () => {
  it('accepts streaming schemes without credentials', () => {
    expect(checkStreamUrl('rtsp://vms.example.test:554/cam/12').ok).toBe(true);
    expect(checkStreamUrl('https://vms.example.test/hls/12.m3u8').ok).toBe(true);
  });

  it('refuses embedded credentials, other schemes and garbage', () => {
    expect(checkStreamUrl('rtsp://admin:admin@10.0.0.5/live').ok).toBe(false);
    expect(checkStreamUrl('file:///dev/video0').ok).toBe(false);
    expect(checkStreamUrl('javascript:alert(1)').ok).toBe(false);
    expect(checkStreamUrl('nope').ok).toBe(false);
  });
});

describe('recording segments', () => {
  const now = new Date('2026-11-17T12:00:00Z');

  it('accepts a past segment up to 24 hours', () => {
    expect(checkSegment(new Date('2026-11-17T08:00:00Z'), new Date('2026-11-17T09:00:00Z'), now).ok).toBe(true);
  });

  it('refuses reversed, overlong and future segments', () => {
    expect(checkSegment(new Date('2026-11-17T09:00:00Z'), new Date('2026-11-17T08:00:00Z'), now).ok).toBe(false);
    expect(checkSegment(new Date('2026-11-15T08:00:00Z'), new Date('2026-11-16T09:00:00Z'), now).ok).toBe(false);
    expect(checkSegment(new Date('2026-11-17T11:00:00Z'), new Date('2026-11-17T13:00:00Z'), now).ok).toBe(false);
  });

  it('keeps a recording for the camera retention period after it ends', () => {
    expect(retainUntil(new Date('2026-11-17T23:30:00Z'), 30)).toBe('2026-12-17');
    expect(retainUntil(new Date('2026-12-20T00:00:00Z'), 14)).toBe('2027-01-03');
  });

  it('places markers inside their recording', () => {
    const rec = { started_at: new Date('2026-11-17T08:00:00Z'), ended_at: new Date('2026-11-17T09:00:00Z') };
    expect(markerInside(new Date('2026-11-17T08:30:00Z'), rec)).toBe(true);
    expect(markerInside(new Date('2026-11-17T09:30:00Z'), rec)).toBe(false);
    expect(markerInside(new Date('2026-11-17T09:30:00Z'), null)).toBe(true);
  });
});
