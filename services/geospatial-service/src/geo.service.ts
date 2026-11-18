import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import type { EventEnvelope, EventPayload } from '@titan/contracts';
import { propagationHeaders } from '@titan/observability';
import { Db, DomainError, EventConsumers, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { approximateAreaM2, bbox, contains, haversine, radiusBox, ZoneGeometry } from './geometry.js';

export const ZONE_TYPES = ['flood_zone', 'catchment', 'site_boundary', 'restricted_area', 'service_area', 'other'] as const;

export const CreateZone = z
  .object({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/),
    name: z.string().min(2).max(200),
    zone_type: z.enum(ZONE_TYPES),
    description: z.string().max(2000).default(''),
    geometry: ZoneGeometry,
    watch_incidents: z.boolean().default(false),
    notify_role: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/).nullable().default(null),
  })
  .refine((z) => !z.watch_incidents || z.notify_role !== null, { message: 'a zone that watches incidents needs a notify_role', path: ['notify_role'] });

export const UpdateZone = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).optional(),
  geometry: ZoneGeometry.optional(),
  watch_incidents: z.boolean().optional(),
  notify_role: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/).nullable().optional(),
  expected_version: z.number().int().positive(),
});

export const PointQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

export const NearbyQuery = PointQuery.extend({
  radius_m: z.coerce.number().min(1).max(50_000).default(1000),
  feature_type: z.enum(['asset', 'device', 'camera']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface ZoneRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  zone_type: string;
  description: string;
  geometry: ZoneGeometry;
  area_m2: number;
  watch_incidents: boolean;
  notify_role: string | null;
  created_by: string;
  created_at: Date;
  version: number;
}

interface FeatureRow {
  feature_type: 'asset' | 'device' | 'camera';
  feature_id: string;
  code: string;
  name: string;
  category: string | null;
  asset_id: string | null;
  latitude: number;
  longitude: number;
}

const ZONE = 'id, tenant_id, code, name, zone_type, description, geometry, area_m2, watch_incidents, notify_role, created_by, created_at, version';
const FEATURE = 'feature_type, feature_id, code, name, category, asset_id, latitude, longitude';

/**
 * Zones and spatial queries over the positions other services announce. A position
 * is a projection: assets, devices and cameras stay owned by their services.
 */
@Injectable()
export class GeoService implements OnApplicationBootstrap {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({
      subjects: ['asset.created.v1', 'device.registered.v1', 'device.status_changed.v1', 'video.camera.registered.v1', 'incident.created.v1'],
      handler: (event, q) => this.onEvent(event, q),
    });
  }

  // --- zones -----------------------------------------------------------------

  listZones(user: Principal) {
    return this.db.tx(user.tenantId, (q) => q.query<ZoneRow>(`SELECT ${ZONE} FROM zones ORDER BY code`));
  }

  createZone(user: Principal, input: z.infer<typeof CreateZone>) {
    const box = bbox(input.geometry);
    return this.db.tx(user.tenantId, async (q) => {
      const zone = await q.one<ZoneRow>(
        `INSERT INTO zones (tenant_id, code, name, zone_type, description, geometry, min_lon, min_lat, max_lon, max_lat, area_m2, watch_incidents, notify_role, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${ZONE}`,
        [
          user.tenantId,
          input.code,
          input.name,
          input.zone_type,
          input.description,
          JSON.stringify(input.geometry),
          box.min_lon,
          box.min_lat,
          box.max_lon,
          box.max_lat,
          approximateAreaM2(input.geometry),
          input.watch_incidents,
          input.notify_role,
          user.username,
        ],
      );
      await this.outbox.emit(q, {
        type: 'geo.zone.created.v1',
        aggregateType: 'zone',
        aggregateId: zone.id,
        tenantId: user.tenantId,
        payload: { zone_id: zone.id, code: zone.code, name: zone.name, zone_type: zone.zone_type, notify_role: zone.notify_role },
      });
      return zone;
    });
  }

  updateZone(user: Principal, id: string, input: z.infer<typeof UpdateZone>) {
    return this.db.tx(user.tenantId, async (q) => {
      const zone = await q.maybeOne<ZoneRow>(`SELECT ${ZONE} FROM zones WHERE id = $1 FOR UPDATE`, [id]);
      if (!zone) throw DomainError.notFound('zone');
      if (zone.version !== input.expected_version) throw DomainError.conflict('stale_version', 'the zone was changed elsewhere; reload and retry');
      const geometry = input.geometry ?? zone.geometry;
      const watch = input.watch_incidents ?? zone.watch_incidents;
      const role = input.notify_role === undefined ? zone.notify_role : input.notify_role;
      if (watch && !role) throw DomainError.invalid('a zone that watches incidents needs a notify_role');
      const box = bbox(geometry);
      return q.one<ZoneRow>(
        `UPDATE zones SET name = $2, description = $3, geometry = $4, min_lon = $5, min_lat = $6, max_lon = $7, max_lat = $8, area_m2 = $9,
                watch_incidents = $10, notify_role = $11, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING ${ZONE}`,
        [id, input.name ?? zone.name, input.description ?? zone.description, JSON.stringify(geometry), box.min_lon, box.min_lat, box.max_lon, box.max_lat, approximateAreaM2(geometry), watch, role],
      );
    });
  }

  /** Zones whose bounding box contains the point, then the exact test. */
  private async zonesAt(q: Q, lat: number, lon: number): Promise<ZoneRow[]> {
    const candidates = await q.query<ZoneRow>(
      `SELECT ${ZONE} FROM zones WHERE min_lat <= $1 AND max_lat >= $1 AND min_lon <= $2 AND max_lon >= $2 ORDER BY code`,
      [lat, lon],
    );
    return candidates.filter((z) => contains(z.geometry, lon, lat));
  }

  locate(user: Principal, query: z.infer<typeof PointQuery>) {
    return this.db.tx(user.tenantId, async (q) => ({
      latitude: query.lat,
      longitude: query.lon,
      zones: (await this.zonesAt(q, query.lat, query.lon)).map(({ geometry: _g, ...z }) => z),
    }));
  }

  zoneFeatures(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const zone = await q.maybeOne<ZoneRow & { min_lat: number; max_lat: number; min_lon: number; max_lon: number }>(
        `SELECT ${ZONE}, min_lat, max_lat, min_lon, max_lon FROM zones WHERE id = $1`,
        [id],
      );
      if (!zone) throw DomainError.notFound('zone');
      const candidates = await q.query<FeatureRow>(
        `SELECT ${FEATURE} FROM located_features WHERE latitude BETWEEN $1 AND $2 AND longitude BETWEEN $3 AND $4 ORDER BY feature_type, code`,
        [zone.min_lat, zone.max_lat, zone.min_lon, zone.max_lon],
      );
      const incidents = await q.query('SELECT incident_id, reference_no, title, severity, latitude, longitude, created_at FROM incident_locations WHERE $1 = ANY(zone_ids) ORDER BY created_at DESC LIMIT 100', [id]);
      return { zone, features: candidates.filter((f) => contains(zone.geometry, f.longitude, f.latitude)), incidents };
    });
  }

  nearby(user: Principal, query: z.infer<typeof NearbyQuery>) {
    const box = radiusBox(query.lat, query.lon, query.radius_m);
    return this.db.tx(user.tenantId, async (q) => {
      const rows = await q.query<FeatureRow>(
        `SELECT ${FEATURE} FROM located_features
          WHERE latitude BETWEEN $1 AND $2 AND longitude BETWEEN $3 AND $4 AND ($5::text IS NULL OR feature_type = $5)`,
        [box.min_lat, box.max_lat, box.min_lon, box.max_lon, query.feature_type ?? null],
      );
      return rows
        .map((f) => ({ ...f, distance_m: Math.round(haversine(query.lat, query.lon, f.latitude, f.longitude)) }))
        .filter((f) => f.distance_m <= query.radius_m)
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, query.limit);
    });
  }

  /** Everything for the map, as one GeoJSON FeatureCollection. */
  layers(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => {
      const zones = await q.query<ZoneRow>(`SELECT ${ZONE} FROM zones ORDER BY code`);
      const features = await q.query<FeatureRow>(`SELECT ${FEATURE} FROM located_features ORDER BY feature_type, code`);
      const incidents = await q.query<{ incident_id: string; reference_no: string; title: string; severity: string; latitude: number; longitude: number }>(
        'SELECT incident_id, reference_no, title, severity, latitude, longitude FROM incident_locations ORDER BY created_at DESC LIMIT 500',
      );
      return {
        type: 'FeatureCollection',
        features: [
          ...zones.map((z) => ({ type: 'Feature', geometry: z.geometry, properties: { layer: 'zone', id: z.id, code: z.code, name: z.name, zone_type: z.zone_type, watch_incidents: z.watch_incidents } })),
          ...features.map((f) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.longitude, f.latitude] }, properties: { layer: f.feature_type, id: f.feature_id, code: f.code, name: f.name, category: f.category } })),
          ...incidents.map((i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [i.longitude, i.latitude] }, properties: { layer: 'incident', id: i.incident_id, code: i.reference_no, name: i.title, severity: i.severity } })),
        ],
      };
    });
  }

  locatedIncidents(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT l.incident_id, l.reference_no, l.title, l.severity, l.located_via, l.latitude, l.longitude, l.created_at,
                COALESCE((SELECT json_agg(json_build_object('id', z.id, 'code', z.code, 'name', z.name) ORDER BY z.code) FROM zones z WHERE z.id = ANY(l.zone_ids)), '[]') AS zones
           FROM incident_locations l ORDER BY l.created_at DESC LIMIT 200`,
      ),
    );
  }

  // --- projection ------------------------------------------------------------

  /** Reads a list from another service as the calling user (null when the service refuses or is unavailable). */
  private async fetchAs<T>(user: Principal, url: string): Promise<T[] | null> {
    try {
      const res = await fetch(url, { headers: { ...propagationHeaders(), authorization: `Bearer ${user.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      return (await res.json()) as T[];
    } catch {
      return null;
    }
  }

  /**
   * Fills the location projection from the asset, device and video services, with the caller's own
   * access. Needed for records older than the event stream retention (7 days) or when this
   * database is new. Idempotent: existing features are updated in place.
   */
  async backfill(user: Principal) {
    const base = (name: string, fallback: string) => (process.env[name] ?? fallback).replace(/\/+$/, '');
    const assets = await this.fetchAs<{ id: string; code: string; name: string; category_code: string | null; latitude: number | null; longitude: number | null; status: string }>(
      user,
      `${base('ASSET_URL', 'http://asset-service:3000')}/assets?limit=500`,
    );
    const devices = await this.fetchAs<{ id: string; serial_no: string; name: string; device_type: string; asset_id: string | null; latitude: number | null; longitude: number | null; status: string }>(
      user,
      `${base('DEVICE_URL', 'http://device-service:3000')}/devices?limit=500`,
    );
    const cameras = await this.fetchAs<{ id: string; code: string; name: string; asset_id: string | null; latitude: number | null; longitude: number | null; status: string }>(
      user,
      `${base('VIDEO_URL', 'http://video-service:3000')}/cameras`,
    );
    if (!assets) throw new DomainError(503, 'source_unavailable', 'the asset register could not be read');
    return this.db.tx(user.tenantId, async (q) => {
      const counts = { assets: 0, devices: 0, cameras: 0 };
      for (const a of assets) {
        if (a.latitude == null || a.longitude == null || a.status === 'retired') continue;
        await this.upsertFeature(q, user.tenantId, { feature_type: 'asset', feature_id: a.id, code: a.code, name: a.name, category: a.category_code, asset_id: a.id, latitude: a.latitude, longitude: a.longitude });
        counts.assets += 1;
      }
      for (const d of devices ?? []) {
        if (d.latitude == null || d.longitude == null || d.status === 'decommissioned') continue;
        await this.upsertFeature(q, user.tenantId, { feature_type: 'device', feature_id: d.id, code: d.serial_no, name: d.name, category: d.device_type, asset_id: d.asset_id, latitude: d.latitude, longitude: d.longitude });
        counts.devices += 1;
      }
      for (const c of cameras ?? []) {
        if (c.latitude == null || c.longitude == null || c.status === 'decommissioned') continue;
        await this.upsertFeature(q, user.tenantId, { feature_type: 'camera', feature_id: c.id, code: c.code, name: c.name, category: 'camera', asset_id: c.asset_id, latitude: c.latitude, longitude: c.longitude });
        counts.cameras += 1;
      }
      return { ...counts, sources: { assets: true, devices: devices !== null, cameras: cameras !== null } };
    });
  }

  private upsertFeature(q: Q, tenantId: string, f: Omit<FeatureRow, 'feature_type'> & { feature_type: FeatureRow['feature_type'] }) {
    return q.exec(
      `INSERT INTO located_features (feature_type, feature_id, tenant_id, code, name, category, asset_id, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (feature_type, feature_id) DO UPDATE
         SET code = EXCLUDED.code, name = EXCLUDED.name, category = EXCLUDED.category, asset_id = EXCLUDED.asset_id,
             latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, updated_at = now()`,
      [f.feature_type, f.feature_id, tenantId, f.code, f.name, f.category, f.asset_id, f.latitude, f.longitude],
    );
  }

  private async onEvent(event: EventEnvelope, q: Q): Promise<void> {
    switch (event.event_type) {
      case 'asset.created.v1': {
        const p = event.payload as EventPayload<'asset.created.v1'>;
        if (p.latitude === null || p.longitude === null) return;
        await this.upsertFeature(q, event.tenant_id, { feature_type: 'asset', feature_id: p.asset_id, code: p.code, name: p.name, category: p.category, asset_id: null, latitude: p.latitude, longitude: p.longitude });
        return;
      }
      case 'device.registered.v1': {
        const p = event.payload as EventPayload<'device.registered.v1'>;
        if (p.latitude === null || p.longitude === null) return;
        await this.upsertFeature(q, event.tenant_id, { feature_type: 'device', feature_id: p.device_id, code: p.serial_no, name: p.name, category: p.device_type, asset_id: p.asset_id, latitude: p.latitude, longitude: p.longitude });
        return;
      }
      case 'device.status_changed.v1': {
        const p = event.payload as EventPayload<'device.status_changed.v1'>;
        // A decommissioned device no longer appears on the map.
        if (p.to === 'decommissioned') await q.exec(`DELETE FROM located_features WHERE feature_type = 'device' AND feature_id = $1`, [p.device_id]);
        return;
      }
      case 'video.camera.registered.v1': {
        const p = event.payload as EventPayload<'video.camera.registered.v1'>;
        if (p.latitude === null || p.longitude === null) return;
        await this.upsertFeature(q, event.tenant_id, { feature_type: 'camera', feature_id: p.camera_id, code: p.code, name: p.name, category: 'camera', asset_id: p.asset_id, latitude: p.latitude, longitude: p.longitude });
        return;
      }
      case 'incident.created.v1':
        return this.locateIncident(event.tenant_id, event.payload as EventPayload<'incident.created.v1'>, q);
    }
  }

  /** Places an incident through its asset (preferred) or device, and announces the watched zones it falls in. */
  private async locateIncident(tenantId: string, p: EventPayload<'incident.created.v1'>, q: Q): Promise<void> {
    let position: { latitude: number; longitude: number; via: 'asset' | 'device' } | null = null;
    if (p.asset_id) {
      const f = await q.maybeOne<FeatureRow>(`SELECT ${FEATURE} FROM located_features WHERE feature_type = 'asset' AND feature_id = $1`, [p.asset_id]);
      if (f) position = { latitude: f.latitude, longitude: f.longitude, via: 'asset' };
    }
    if (!position && p.device_id) {
      const f = await q.maybeOne<FeatureRow>(`SELECT ${FEATURE} FROM located_features WHERE feature_type = 'device' AND feature_id = $1`, [p.device_id]);
      if (f) position = { latitude: f.latitude, longitude: f.longitude, via: 'device' };
    }
    if (!position) return;
    const zones = await this.zonesAt(q, position.latitude, position.longitude);
    const inserted = await q.exec(
      `INSERT INTO incident_locations (incident_id, tenant_id, reference_no, title, severity, located_via, latitude, longitude, zone_ids, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (incident_id) DO NOTHING`,
      [p.incident_id, tenantId, p.reference_no, p.title, p.severity, position.via, position.latitude, position.longitude, zones.map((z) => z.id), p.created_at],
    );
    if (!inserted) return;
    for (const zone of zones.filter((z) => z.watch_incidents)) {
      await this.outbox.emit(q, {
        type: 'geo.incident.in_zone.v1',
        aggregateType: 'zone',
        aggregateId: zone.id,
        tenantId,
        payload: { incident_id: p.incident_id, reference_no: p.reference_no, zone_id: zone.id, zone_code: zone.code, zone_name: zone.name, latitude: position.latitude, longitude: position.longitude },
      });
      await this.outbox.emit(q, {
        type: 'notification.requested.v1',
        aggregateType: 'zone',
        aggregateId: zone.id,
        tenantId,
        payload: {
          dedupe_key: `zone-incident:${zone.id}:${p.incident_id}`,
          channel: 'in_app',
          category: 'geo.incident_in_zone',
          external: false,
          recipient_user_id: null,
          recipient_role: zone.notify_role,
          recipient_address: null,
          subject: `${p.severity.toUpperCase()} incident ${p.reference_no} in ${zone.name}`,
          body: p.title,
          reference_type: 'incident',
          reference_id: p.incident_id,
        },
      });
    }
  }
}
