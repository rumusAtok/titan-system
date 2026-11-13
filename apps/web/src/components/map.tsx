'use client';

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { getConfig } from '@/lib/config';

export interface MapFeature {
  id: string;
  kind: 'asset' | 'sensor' | 'incident';
  name: string;
  status: string;
  latitude: number;
  longitude: number;
}

const COLOR: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'tone'],
  'ok', '#15803d',
  'warn', '#d97706',
  'danger', '#b91c1c',
  'info', '#0369a1',
  '#64748b',
];

export function toneOf(f: MapFeature): string {
  if (f.kind === 'incident') return 'danger';
  if (['online', 'active', 'good'].includes(f.status)) return 'ok';
  if (['offline', 'critical'].includes(f.status)) return 'danger';
  if (['under_maintenance', 'poor', 'acknowledged'].includes(f.status)) return 'warn';
  return 'neutral';
}

/**
 * MapLibre GL map of assets, sensors and incidents.
 * The base map is an external raster tile service (configurable, and can be
 * switched off). Without tiles the markers are drawn on a plain background.
 */
export function OperationsMap({ features, selectedId, onSelect }: { features: MapFeature[]; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const fitted = useRef(false);

  useEffect(() => {
    if (!container.current) return;
    // An empty tile URL means "no base map": nothing is requested from outside the platform.
    const tileUrl = getConfig().mapTileUrl;
    const sources: maplibregl.StyleSpecification['sources'] = {
      features: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    };
    const baseLayers: maplibregl.LayerSpecification[] = [];
    if (tileUrl) {
      const attribution = tileUrl.includes('openstreetmap.org') ? '© OpenStreetMap contributors' : undefined;
      sources.base = { type: 'raster', tiles: [tileUrl], tileSize: 256, maxzoom: 19, ...(attribution ? { attribution } : {}) };
      baseLayers.push({ id: 'base', type: 'raster', source: 'base' });
    }
    const instance = new maplibregl.Map({
      container: container.current,
      style: {
        version: 8,
        sources,
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#e8edf3' } },
          ...baseLayers,
          {
            id: 'incident-halo', type: 'circle', source: 'features', filter: ['==', ['get', 'kind'], 'incident'],
            paint: { 'circle-radius': 20, 'circle-color': '#b91c1c', 'circle-opacity': 0.22, 'circle-stroke-color': '#b91c1c', 'circle-stroke-width': 1.5 },
          },
          {
            id: 'points', type: 'circle', source: 'features', filter: ['!=', ['get', 'kind'], 'incident'],
            paint: {
              'circle-radius': ['case', ['get', 'selected'], 11, ['==', ['get', 'kind'], 'sensor'], 7, 8],
              'circle-color': COLOR,
              'circle-stroke-color': ['case', ['get', 'selected'], '#0f172a', '#ffffff'],
              'circle-stroke-width': ['case', ['get', 'selected'], 3, 2],
            },
          },
          {
            id: 'sensor-dot', type: 'circle', source: 'features', filter: ['==', ['get', 'kind'], 'sensor'],
            paint: { 'circle-radius': 2.5, 'circle-color': '#ffffff' },
          },
        ],
      },
      center: [101.52, 3.07],
      zoom: 11,
      attributionControl: { compact: true },
    });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    for (const layer of ['points', 'incident-halo']) {
      instance.on('click', layer, (e) => select.current((e.features?.[0]?.properties?.id as string) ?? null));
      instance.on('mouseenter', layer, () => (instance.getCanvas().style.cursor = 'pointer'));
      instance.on('mouseleave', layer, () => (instance.getCanvas().style.cursor = ''));
    }
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const apply = () => {
      const source = instance.getSource('features') as maplibregl.GeoJSONSource | undefined;
      if (!source) return;
      source.setData({
        type: 'FeatureCollection',
        features: features.map((f) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [f.longitude, f.latitude] },
          properties: { id: f.id, kind: f.kind, tone: toneOf(f), selected: f.id === selectedId },
        })),
      });
      if (!fitted.current && features.length > 0) {
        const bounds = new maplibregl.LngLatBounds();
        features.forEach((f) => bounds.extend([f.longitude, f.latitude]));
        instance.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 0 });
        fitted.current = true;
      }
    };
    if (instance.isStyleLoaded()) apply();
    else instance.once('load', apply);
  }, [features, selectedId]);

  return <div ref={container} className="h-full min-h-[420px] w-full rounded-b-lg" role="application" aria-label="Map of assets, sensors and incidents. The same records are listed in the table beside the map." />;
}
