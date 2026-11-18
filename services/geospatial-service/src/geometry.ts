import { z } from 'zod';

/**
 * Plain geometry over WGS84 longitude/latitude. Adequate for zones of a few
 * kilometres; a production deployment would use PostGIS (see the geospatial
 * section of docs/architecture/industry-packs.md).
 */

export type Position = [number, number]; // [longitude, latitude]
export type Ring = Position[];

const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const ring = z
  .array(position)
  .min(4)
  .max(2000)
  .refine((r) => r[0]![0] === r[r.length - 1]![0] && r[0]![1] === r[r.length - 1]![1], { message: 'a ring must be closed (first and last position equal)' });

export const PolygonGeometry = z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1).max(50) });
export const MultiPolygonGeometry = z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1).max(50)).min(1).max(50) });
export const ZoneGeometry = z.union([PolygonGeometry, MultiPolygonGeometry]);
export type ZoneGeometry = z.infer<typeof ZoneGeometry>;

function polygons(g: ZoneGeometry): Ring[][] {
  return g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
}

/** Ray casting. A point exactly on an edge may count as inside or outside. */
export function pointInRing(lon: number, lat: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]!;
    const [xj, yj] = r[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring of some polygon and outside all of that polygon's holes. */
export function contains(g: ZoneGeometry, lon: number, lat: number): boolean {
  return polygons(g).some(([outer, ...holes]) => pointInRing(lon, lat, outer!) && !holes.some((h) => pointInRing(lon, lat, h)));
}

export interface BBox {
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
}

export function bbox(g: ZoneGeometry): BBox {
  const all = polygons(g).flatMap((p) => p[0]!);
  return {
    min_lon: Math.min(...all.map((p) => p[0])),
    min_lat: Math.min(...all.map((p) => p[1])),
    max_lon: Math.max(...all.map((p) => p[0])),
    max_lat: Math.max(...all.map((p) => p[1])),
  };
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A bounding box that contains every point within `radiusM` of the centre (for prefiltering). */
export function radiusBox(lat: number, lon: number, radiusM: number): BBox {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  return { min_lat: lat - dLat, max_lat: lat + dLat, min_lon: lon - dLon, max_lon: lon + dLon };
}

/** Planar area estimate in square metres (shoelace on an equirectangular projection), for display only. */
export function approximateAreaM2(g: ZoneGeometry): number {
  const ringArea = (r: Ring) => {
    const lat0 = r.reduce((s, p) => s + p[1], 0) / r.length;
    const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110_574;
    let sum = 0;
    for (let i = 0; i < r.length - 1; i++) sum += r[i]![0] * kx * (r[i + 1]![1] * ky) - r[i + 1]![0] * kx * (r[i]![1] * ky);
    return Math.abs(sum) / 2;
  };
  return Math.round(polygons(g).reduce((s, [outer, ...holes]) => s + ringArea(outer!) - holes.reduce((h, r) => h + ringArea(r), 0), 0));
}
