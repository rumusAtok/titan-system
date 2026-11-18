'use client';

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { getConfig } from '@/lib/config';

/**
 * Map of the geospatial layers (GeoJSON from /api/geo/layers): zones as shaded areas,
 * assets, devices and cameras as points, located incidents as red rings.
 * Every item drawn is also listed in the tables beside the map.
 */
export interface LayerCollection {
  type: 'FeatureCollection';
  features: Array<{ type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: Record<string, any> }>;
}

export function ZoneMap({ layers, onSelect }: { layers: LayerCollection | undefined; onSelect: (code: string | null) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const fitted = useRef(false);
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    if (!container.current) return;
    const tileUrl = getConfig().mapTileUrl;
    const sources: maplibregl.StyleSpecification['sources'] = { layers: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } };
    const base: maplibregl.LayerSpecification[] = [];
    if (tileUrl) {
      sources.base = { type: 'raster', tiles: [tileUrl], tileSize: 256, maxzoom: 19, ...(tileUrl.includes('openstreetmap.org') ? { attribution: '© OpenStreetMap contributors' } : {}) };
      base.push({ id: 'base', type: 'raster', source: 'base' });
    }
    const instance = new maplibregl.Map({
      container: container.current,
      style: {
        version: 8,
        sources,
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#e8edf3' } },
          ...base,
          { id: 'zones-fill', type: 'fill', source: 'layers', filter: ['==', ['get', 'layer'], 'zone'], paint: { 'fill-color': ['case', ['get', 'watch_incidents'], '#0369a1', '#64748b'], 'fill-opacity': 0.18 } },
          { id: 'zones-line', type: 'line', source: 'layers', filter: ['==', ['get', 'layer'], 'zone'], paint: { 'line-color': '#0369a1', 'line-width': 2 } },
          {
            id: 'points', type: 'circle', source: 'layers', filter: ['in', ['get', 'layer'], ['literal', ['asset', 'device', 'camera']]],
            paint: {
              'circle-radius': 6,
              'circle-color': ['match', ['get', 'layer'], 'asset', '#15803d', 'device', '#7c3aed', 'camera', '#0f172a', '#64748b'],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
          },
          { id: 'incidents', type: 'circle', source: 'layers', filter: ['==', ['get', 'layer'], 'incident'], paint: { 'circle-radius': 14, 'circle-color': '#b91c1c', 'circle-opacity': 0.25, 'circle-stroke-color': '#b91c1c', 'circle-stroke-width': 1.5 } },
        ],
      },
      center: [101.52, 3.07],
      zoom: 11,
      attributionControl: { compact: true },
    });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    for (const layer of ['zones-fill', 'points', 'incidents']) {
      instance.on('click', layer, (e) => select.current((e.features?.[0]?.properties?.code as string) ?? null));
    }
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !layers) return;
    const apply = () => {
      (instance.getSource('layers') as maplibregl.GeoJSONSource | undefined)?.setData(layers as unknown as Parameters<maplibregl.GeoJSONSource['setData']>[0]);
      if (!fitted.current && layers.features.length) {
        const bounds = new maplibregl.LngLatBounds();
        const add = (c: unknown): void => {
          if (Array.isArray(c) && typeof c[0] === 'number') bounds.extend(c as [number, number]);
          else if (Array.isArray(c)) c.forEach(add);
        };
        layers.features.forEach((f) => add(f.geometry.coordinates));
        instance.fitBounds(bounds, { padding: 50, maxZoom: 15, duration: 0 });
        fitted.current = true;
      }
    };
    if (instance.isStyleLoaded()) apply();
    else instance.once('load', apply);
  }, [layers]);

  return <div ref={container} className="h-full min-h-[440px] w-full rounded-b-lg" role="application" aria-label="Map of zones, assets, devices, cameras and located incidents. The same records are listed beside the map." />;
}
