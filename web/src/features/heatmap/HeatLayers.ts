/**
 * HeatLayers: owns every MapLibre style layer/source for the Heat Map.
 * The map component stays declarative; this module is the single place that
 * knows about layer ids, so other features never touch them.
 *
 * Data always arrives from the API (HeatPredictionService output) — nothing
 * about heat values is decided here.
 */

import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import { TURBO_STOPS } from './colors';

/** MapLibre heatmap-color over density 0..1 using the turbo ramp. */
function turboExpressionDensity(densityExpr: unknown): unknown[] {
  const flat = TURBO_STOPS.flatMap(([v, c]) => [v / 100, c]);
  return ['interpolate', ['linear'], densityExpr, ...flat];
}

export const SRC = {
  heat: 'heat-src',
  heatPts: 'heat-pts-src',
  green: 'green-src',
  buildings: 'buildings-src',
  cooling: 'cooling-src',
} as const;

export const LYR = {
  heatSurface: 'heat-surface',
  heatCells: 'heat-cell-outlines',
  heatHit: 'heat-hit',
  green: 'green-fill',
  buildings: 'buildings-fill',
  coolingHalo: 'cooling-halo',
  coolingDots: 'cooling-dots',
  coolingIcons: 'cooling-icons',
  coolingLabels: 'cooling-labels',
} as const;

/** OpenFreeMap free vector basemap (no API key). HK detail included. */
export const BASEMAP_STYLE_URL =
  'https://tiles.openfreemap.org/styles/liberty';

let iconsAdded = false;

function addCoolingIcons(map: maplibregl.Map): void {
  if (iconsAdded) return;
  const svg = (paths: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40">` +
        `<path d="M15 1C8 1 3 6 3 13c0 8 9 16 12 25 3-9 12-17 12-25C27 6 22 1 15 1z" fill="#ffffff" stroke="#1b3a4b" stroke-width="1.2"/>` +
        `${paths}</svg>`,
    )}`;
  const icons: Record<string, string> = {
    'ic-library': svg('<circle cx="15" cy="13" r="5" fill="#0b5c8f"/><rect x="10" y="10" width="10" height="6" rx="1" fill="#fff"/>'),
    'ic-community': svg('<circle cx="15" cy="13" r="5" fill="#0b5c8f"/><circle cx="12.5" cy="12" r="1.6" fill="#fff"/><circle cx="17.5" cy="12" r="1.6" fill="#fff"/><path d="M11 17h8" stroke="#fff" stroke-width="1.6"/>'),
    'ic-sports': svg('<circle cx="15" cy="13" r="5" fill="#0b5c8f"/><circle cx="15" cy="13" r="3.2" fill="none" stroke="#fff" stroke-width="1.4"/>'),
    'ic-market': svg('<circle cx="15" cy="13" r="5" fill="#0b5c8f"/><path d="M10.5 11.5h9l-1.2 5h-6.6z" fill="#fff"/>'),
    'ic-mtr': svg('<circle cx="15" cy="13" r="5" fill="#0b5c8f"/><rect x="11.4" y="9.5" width="7.2" height="5" rx="1.2" fill="#fff"/><path d="M12.4 16.4l-1.2 1.4M17.6 16.4l1.2 1.4" stroke="#fff" stroke-width="1.3"/>'),
    'ic-park': svg('<circle cx="15" cy="13" r="5" fill="#0b5c8f"/><path d="M15 8.8l2.4 3h-1.5l2 2.6h-5.8l2-2.6h-1.5z" fill="#fff"/><rect x="14.4" y="14.4" width="1.2" height="2.2" fill="#fff"/>'),
    'ic-cultural': svg('<circle cx="15" cy="13" r="5" fill="#0b5c8f"/><path d="M10.5 16.5h9M15 9.5l4 3.4h-8z" stroke="#fff" stroke-width="1.4" fill="none"/>'),
  };
  for (const [name, url] of Object.entries(icons)) {
    map.loadImage(url).then((img) => {
      if (!map.hasImage(name)) map.addImage(name, img.data);
    });
  }
  iconsAdded = true;
}

export function addHeatSourcesAndLayers(map: maplibregl.Map): void {
  addCoolingIcons(map);

  const sources: Record<string, SourceSpecification> = {
    [SRC.heat]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as never },
    [SRC.heatPts]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as never },
    [SRC.green]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as never },
    [SRC.buildings]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as never },
    [SRC.cooling]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as never },
  };

  const layers: LayerSpecification[] = [
    {
      id: LYR.green,
      type: 'fill',
      source: SRC.green,
      paint: { 'fill-color': '#1a9641', 'fill-opacity': 0.35 },
    },
    {
      id: LYR.buildings,
      type: 'fill',
      source: SRC.buildings,
      paint: { 'fill-color': '#8f9aa8', 'fill-opacity': 0.35 },
    },
    {
      // The continuous heat surface. The physics grid is deliberately coarse
      // (real per-cell evaluations); the page densifies it bilinearly into an
      // evenly spaced point field so the kernels MERGE into ONE field —
      // never separate blobs. Calibration: with kernel radius = 3× point
      // spacing, a plateau of score S integrates to density ≈ S/100, so the
      // turbo ramp reads the true score (weight = score/942, intensity 1).
      // heatmap-density runs 0..1 — turbo stops must be fractional.
      id: LYR.heatSurface,
      type: 'heatmap',
      source: SRC.heatPts,
      paint: {
        'heatmap-weight': [
          'interpolate', ['linear'], ['get', 'heatScore'], 0, 0.0, 100, 0.106,
        ] as never,
        'heatmap-intensity': 1.0,
        'heatmap-radius': 26,
        'heatmap-color': turboExpressionDensity(['heatmap-density']) as never,
        'heatmap-opacity': 0.75,
      },
    },
    {
      // Invisible cell polygons on the physics grid: reliable click target
      // (heatmap layers cannot be queryRenderedFeatures'd).
      id: LYR.heatHit,
      type: 'fill',
      source: SRC.heat,
      paint: { 'fill-opacity': 0 },
    },
    {
      id: LYR.coolingHalo,
      type: 'circle',
      source: SRC.cooling,
      paint: {
        'circle-radius': 13,
        'circle-color': '#38bdf8',
        'circle-opacity': 0.25,
        'circle-stroke-color': '#38bdf8',
        'circle-stroke-width': 1,
      },
    },
    {
      id: LYR.coolingDots,
      type: 'circle',
      source: SRC.cooling,
      paint: {
        'circle-radius': 5,
        'circle-color': '#0ea5e9',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    },
    {
      id: LYR.coolingIcons,
      type: 'symbol',
      source: SRC.cooling,
      layout: {
        'icon-image': [
          'match', ['get', 'type'],
          'library', 'ic-library',
          'community_centre', 'ic-community',
          'sports_centre', 'ic-sports',
          'market', 'ic-market',
          'mtr_station', 'ic-mtr',
          'park', 'ic-park',
          'cultural_venue', 'ic-cultural',
          'ic-community',
        ] as never,
        'icon-size': 0.85,
        'icon-allow-overlap': false,
      },
    },
    {
      id: LYR.coolingLabels,
      type: 'symbol',
      source: SRC.cooling,
      minzoom: 13.5,
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
      },
      paint: {
        'text-color': '#e6edf3',
        'text-halo-color': '#0d1117',
        'text-halo-width': 1.5,
      },
    },
  ];

  for (const [id, spec] of Object.entries(sources)) {
    if (!map.getSource(id)) map.addSource(id, spec);
  }
  for (const layer of layers) {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  }
}

export function setHeatData(
  map: maplibregl.Map,
  fc: GeoJSON.FeatureCollection,
): void {
  (map.getSource(SRC.heat) as unknown as GeoJSONSourceLike | null)?.setData(fc);
}

export function setOverlayData(
  map: maplibregl.Map,
  id: string,
  fc: GeoJSON.FeatureCollection,
): void {
  (map.getSource(id) as unknown as GeoJSONSourceLike | null)?.setData(fc);
}

export function setLayerVisible(map: maplibregl.Map, id: string, visible: boolean): void {
  if (map.getLayer(id)) {
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

export function setHeatOpacity(map: maplibregl.Map, opacity: number): void {
  if (map.getLayer(LYR.heatSurface)) {
    map.setPaintProperty(LYR.heatSurface, 'heatmap-opacity', opacity);
  }
}

/**
 * Track the zoom: keep the kernel radius at 3x the current on-screen point
 * spacing so the surface stays one continuous field at every zoom level -
 * call after every viewport reload. Radius is in screen pixels.
 */
export function setHeatRadiusForSpacing(map: maplibregl.Map, spacingPx: number): void {
  if (map.getLayer(LYR.heatSurface)) {
    map.setPaintProperty(LYR.heatSurface, 'heatmap-radius', Math.max(12, 3 * spacingPx));
  }
}

export function setHeatPoints(map: maplibregl.Map, fc: GeoJSON.FeatureCollection): void {
  (map.getSource(SRC.heatPts) as unknown as GeoJSONSourceLike | null)?.setData(fc);
}

export function setHeatRadius(map: maplibregl.Map, radius: number): void {
  if (map.getLayer(LYR.heatSurface)) {
    map.setPaintProperty(LYR.heatSurface, 'heatmap-radius', radius);
  }
}

interface GeoJSONSourceLike {
  setData(data: GeoJSON.FeatureCollection): void;
}
