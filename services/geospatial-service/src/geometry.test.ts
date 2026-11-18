import { describe, expect, it } from 'vitest';
import { approximateAreaM2, bbox, contains, haversine, radiusBox, ZoneGeometry } from './geometry.js';

// A 1 km x 1 km square near the equator, with a hole in the middle.
const square: ZoneGeometry = {
  type: 'Polygon',
  coordinates: [
    [[101.5, 3.0], [101.509, 3.0], [101.509, 3.009], [101.5, 3.009], [101.5, 3.0]],
    [[101.503, 3.003], [101.506, 3.003], [101.506, 3.006], [101.503, 3.006], [101.503, 3.003]],
  ],
};

describe('contains', () => {
  it('finds points inside the outer ring and outside its holes', () => {
    expect(contains(square, 101.501, 3.001)).toBe(true);
    expect(contains(square, 101.6, 3.001)).toBe(false);
    expect(contains(square, 101.5045, 3.0045)).toBe(false); // in the hole
  });

  it('handles multipolygons and concave shapes', () => {
    const multi: ZoneGeometry = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]],
      ],
    };
    expect(contains(multi, 5.5, 5.5)).toBe(true);
    expect(contains(multi, 3, 3)).toBe(false);
    const u: ZoneGeometry = { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3], [0, 0]]] };
    expect(contains(u, 1.5, 2)).toBe(false); // the notch of the U
    expect(contains(u, 0.5, 2)).toBe(true);
  });
});

describe('validation', () => {
  it('refuses open rings, too few positions and out-of-range coordinates', () => {
    expect(ZoneGeometry.safeParse({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }).success).toBe(false);
    expect(ZoneGeometry.safeParse({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] }).success).toBe(false);
    expect(ZoneGeometry.safeParse({ type: 'Polygon', coordinates: [[[0, 0], [200, 0], [1, 1], [0, 0]]] }).success).toBe(false);
    expect(ZoneGeometry.safeParse(square).success).toBe(true);
  });
});

describe('distances and boxes', () => {
  it('measures great-circle distance', () => {
    // One degree of latitude is about 111 km.
    expect(haversine(3, 101.5, 4, 101.5)).toBeGreaterThan(110_000);
    expect(haversine(3, 101.5, 4, 101.5)).toBeLessThan(112_000);
    expect(haversine(3, 101.5, 3, 101.5)).toBe(0);
  });

  it('builds boxes that contain the zone and every point within a radius', () => {
    expect(bbox(square)).toEqual({ min_lon: 101.5, min_lat: 3.0, max_lon: 101.509, max_lat: 3.009 });
    const box = radiusBox(3, 101.5, 1000);
    expect(haversine(3, 101.5, box.max_lat, 101.5)).toBeGreaterThanOrEqual(999);
    expect(haversine(3, 101.5, 3, box.max_lon)).toBeGreaterThanOrEqual(999);
  });

  it('estimates the area of a zone with a hole', () => {
    const area = approximateAreaM2(square);
    // About 1 km2 minus about 0.11 km2.
    expect(area).toBeGreaterThan(850_000);
    expect(area).toBeLessThan(1_000_000);
  });
});
