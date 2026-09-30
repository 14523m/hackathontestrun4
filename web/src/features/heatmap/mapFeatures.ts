/**
 * Real map features from the basemap's own vector tiles (OpenFreeMap /
 * OpenMapTiles) — the same trick as the street router in osmStreets.ts:
 * the data is already in memory, so these layers cost zero extra requests.
 *
 *  - parks/forest/water-green landuse polygons → the "Parks & trees" layer
 *    (real boundaries: Kowloon Park is a park shape, not a grid of squares)
 *  - building footprints with heights → the "Tall buildings" layer, shaded
 *    by real height so the canyon effect is visible
 *
 * `querySourceFeatures` only returns tiles that are LOADED (i.e. what the
 * current viewport has drawn), which is exactly the area the user is
 * looking at; callers should re-extract on 'moveend'.
 */

import type { Map as MLMap } from 'maplibre-gl';

const TILE_SOURCE = 'openmaptiles';

/** OpenMapTiles landuse classes that count as cooling greenery. */
const GREEN_CLASSES = new Set([
  'park',
  'forest',
  'grass',
  'garden',
  'cemetery',
  'village_green',
  'recreation_ground',
  'wood',
  'nature_reserve',
]);

export interface GreenPolygon {
  ring: [number, number][];
  kind: string;
  name?: string;
}

export interface BuildingPolygon {
  ring: [number, number][];
  height: number | null;
}

function ringArea(ring: [number, number][]): number {
  // Shoelace, in deg^2 — only used to drop degenerate slivers.
  let a = 0;
  for (let i = 1; i < ring.length; i++) {
    a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  }
  return Math.abs(a / 2);
}

/** Extract green-space polygons currently loaded on the map. */
export function collectGreenFromMap(map: MLMap): GreenPolygon[] {
  const out: GreenPolygon[] = [];
  const seen = new Set<string>();
  let feats;
  try {
    feats = map.querySourceFeatures(TILE_SOURCE, { sourceLayer: 'landuse' });
  } catch {
    return out;
  }
  for (const f of feats) {
    const cls = String(f.properties?.class ?? '');
    if (!GREEN_CLASSES.has(cls)) continue;
    const g = f.geometry;
    if (!g) continue;
    const polys: [number, number][][][] =
      g.type === 'Polygon'
        ? [g.coordinates as [number, number][][]]
        : g.type === 'MultiPolygon'
          ? (g.coordinates as [number, number][][][])
          : [];
    for (const poly of polys) {
      if (!poly[0] || poly[0].length < 4) continue;
      const ring = poly[0];
      // Tiles duplicate boundary features; dedup on first vertex + size.
      const k = `${cls}:${ring[0][0].toFixed(6)}:${ring[0][1].toFixed(6)}:${ringArea(ring).toFixed(8)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ring, kind: cls, name: f.properties?.name });
    }
  }
  return out;
}

/** Extract building footprints (with heights) currently loaded on the map. */
export function collectBuildingsFromMap(map: MLMap): BuildingPolygon[] {
  const out: BuildingPolygon[] = [];
  const seen = new Set<string>();
  let feats;
  try {
    feats = map.querySourceFeatures(TILE_SOURCE, { sourceLayer: 'building' });
  } catch {
    return out;
  }
  for (const f of feats) {
    const g = f.geometry;
    if (!g) continue;
    const polys: [number, number][][][] =
      g.type === 'Polygon'
        ? [g.coordinates as [number, number][][]]
        : g.type === 'MultiPolygon'
          ? (g.coordinates as [number, number][][][])
          : [];
    const height =
      typeof f.properties?.render_height === 'number'
        ? (f.properties.render_height as number)
        : typeof f.properties?.height === 'number'
          ? (f.properties.height as number)
          : null;
    for (const poly of polys) {
      if (!poly[0] || poly[0].length < 4) continue;
      const ring = poly[0];
      const k = `b:${ring[0][0].toFixed(6)}:${ring[0][1].toFixed(6)}:${ringArea(ring).toFixed(8)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ring, height });
    }
  }
  return out;
}

export function greenToFC(ps: GreenPolygon[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: ps.map((p, i) => ({
      type: 'Feature' as const,
      id: `gr-${i}`,
      properties: { kind: p.kind, name: p.name ?? '' },
      geometry: { type: 'Polygon' as const, coordinates: [p.ring] },
    })),
  };
}

export function buildingsToFC(ps: BuildingPolygon[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: ps.map((p, i) => ({
      type: 'Feature' as const,
      id: `bd-${i}`,
      properties: { renderHeight: p.height ?? 0 },
      geometry: { type: 'Polygon' as const, coordinates: [p.ring] },
    })),
  };
}
