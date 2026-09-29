/**
 * Web API client. The contract mirrors backend/app/schemas.py — treat any
 * change there as a coordinated architecture change (see docs/development.md).
 *
 * Resolution order (section 17 demo resilience):
 *   1. LIVE API (Vite dev proxy /api, or same-origin when FastAPI serves us)
 *   2. OFFLINE IN-BROWSER ENGINE (offlineEngine.ts) — the SAME published
 *      equations evaluated per cell over the generated city skeleton (all 19
 *      districts). Anywhere in Hong Kong, no server needed. UI labels it
 *      "OFFLINE ENGINE".
 */

import { SNAPSHOTS } from '../features/heatmap/demoSnapshots';
import {
  coolingNearFrom,
  pointPrediction,
  viewportField,
} from '../features/heatmap/offlineEngine';

const BASE: string = import.meta.env.VITE_API_BASE ?? '/api';
const OFFLINE = `${import.meta.env.BASE_URL}demo`;

export type DataMode = 'live' | 'engine';

export const apiState: { mode: DataMode } = { mode: 'live' };

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface FactorContribution {
  factorId: string;
  label: string;
  delta: number;
  detail?: string;
}

export interface Provenance {
  sources: string[];
  observed: boolean;
  modelled: boolean;
  confidence: number;
  notes: string;
}

export interface HeatCell {
  cellId: string;
  center: GeoPoint;
  polygon: [number, number][]; // [lon, lat]
  heatScore: number;
  shadeScore: number;
  vegetationScore: number;
  buildingDensity: number;
  windScore: number;
  confidence: number;
  factors: FactorContribution[];
  sources: string[];
  isModelled: boolean;
  /** True when the cell lies inside the offline engine's city skeleton. */
  inCoverage?: boolean;
}

export interface HeatMapResponse {
  generatedAt: string;
  validFor: string;
  dataMode: string;
  isStale: boolean;
  districtId: string;
  cells: HeatCell[];
  legend: Record<string, string>;
  provenance: Provenance;
  scenarioLabel?: string | null;
}

export interface CoolingSpot {
  id: string;
  name: string;
  location: GeoPoint;
  type: string;
  coolingLevel: number;
  openingHours: string;
  capacityEstimate?: number | null;
  accessibility: boolean;
  simulated: boolean;
  distanceMeters?: number;
}

export interface District {
  id: string;
  name: string;
  nameZh?: string | null;
  kind: 'existing' | 'conceptual';
  isConceptual: boolean;
  center: GeoPoint;
  description: string;
  label: string;
}

export interface DataSourceInfo {
  id: string;
  name: string;
  role: string;
  status: string;
  url: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function snapshotJson<T>(key: string): T {
  const hit = SNAPSHOTS[key];
  if (hit === undefined) throw new Error(`no embedded snapshot for ${key}`);
  return hit as T;
}

async function withFallback<T>(live: () => Promise<T>, offline: () => Promise<T>): Promise<T> {
  try {
    const data = await live();
    apiState.mode = 'live';
    return data;
  } catch {
    const data = await offline();
    apiState.mode = 'engine';
    return data;
  }
}

// Hours embedded in the legacy flagship-district snapshots (kept for the
// district-oriented api.heatmap / api.coolingSpots paths only).
const SNAPSHOT_HOURS = [6, 9, 12, 15, 18, 21];

function nearestSnapshotHour(hour: number): number {
  return SNAPSHOT_HOURS.reduce((best, h) =>
    Math.abs(h - hour) < Math.abs(best - hour) ? h : best,
  );
}

export interface HeatPointResult {
  heatScore: number;
  temperatureC: number;
  apparentTemperatureShadeC: number;
  apparentTemperatureSunC: number;
  wetBulbC: number;
  wbgtShadeC: number;
  meanRadiantTempC: number;
  skyViewFactor: number;
  shadeScore: number;
  vegetationScore: number;
  buildingDensity: number;
  windScore: number;
  isDaytime: boolean;
  districtId: string | null;
  factors: FactorContribution[];
  confidence: number;
  isModelled: boolean;
  sources: string[];
  offlineApproximate?: boolean;
}

export interface ViewportField {
  generatedAt: string;
  validFor: string;
  dataMode: string;
  isStale: boolean;
  bounds: { south: number; west: number; north: number; east: number };
  cols: number;
  rows: number;
  cells: HeatCell[];
  legend: Record<string, string>;
  provenance: Provenance;
}

interface ViewportBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

// ---------------------------------------------------------------------------
// Offline ENGINE fallbacks: real physics per cell, anywhere in Hong Kong.
// ---------------------------------------------------------------------------

function engineViewport(b: ViewportBounds, hour: number, maxCells = 220): ViewportField {
  return viewportField(b, hour, maxCells) as ViewportField;
}

function enginePoint(lat: number, lon: number, hour: number): HeatPointResult {
  return pointPrediction(lat, lon, hour) as HeatPointResult;
}

function engineCoolingNear(
  lat: number,
  lon: number,
  maxM: number,
  limit: number,
): CoolingSpot[] {
  return coolingNearFrom(lat, lon, maxM, limit).map((s, i) => ({
    id: `eng-cool-${lat.toFixed(4)}-${lon.toFixed(4)}-${i}`,
    name: s.n,
    location: { lat: s.lat, lon: s.lon },
    type: s.t,
    coolingLevel: 3,
    openingHours: '07:00–23:00',
    accessibility: true,
    simulated: true,
    distanceMeters: Math.round(s.distanceMeters),
  }));
}

export const api = {
  heatmap: (districtId: string, hour: number, detail: 'standard' | 'high' = 'high') =>
    withFallback<HeatMapResponse>(
      () => getJson(`${BASE}/heatmap?districtId=${districtId}&hour=${hour}&detail=${detail}`),
      async () => {
        const h = nearestSnapshotHour(hour);
        return snapshotJson(`${districtId}|${h}`);
      },
    ),

  coolingSpots: (districtId: string) =>
    withFallback<CoolingSpot[]>(
      () => getJson(`${BASE}/cooling-spots?districtId=${districtId}`),
      async () => snapshotJson(`${districtId}|cooling`),
    ),

  heatPoint: (lat: number, lon: number, hour: number) =>
    withFallback<HeatPointResult>(
      () =>
        getJson(
          `${BASE}/heat/point?lat=${lat}&lon=${lon}&hour=${hour}`,
        ),
      async () => enginePoint(lat, lon, hour),
    ),

  viewport: (b: ViewportBounds, hour: number, maxCells = 220) =>
    withFallback<ViewportField>(
      () =>
        getJson(
          `${BASE}/heatmap/viewport?south=${b.south}&west=${b.west}` +
            `&north=${b.north}&east=${b.east}&hour=${hour}&maxCells=${maxCells}`,
        ),
      async () => engineViewport(b, hour, maxCells),
    ),

  /** Nearest cooling spots to a coordinate, with the engine as fallback. */
  coolingNear: (lat: number, lon: number, maxM = 500, limit = 4) =>
    withFallback<CoolingSpot[]>(
      () =>
        getJson<CoolingSpot[]>(
          `${BASE}/cooling-spots?lat=${lat}&lon=${lon}` +
            `&maxDistanceMeters=${maxM}&limit=${limit}`,
        ),
      async () => engineCoolingNear(lat, lon, maxM, limit),
    ),

  dataSources: () =>
    withFallback<{ dataMode: string; sources: DataSourceInfo[]; disclaimer: string }>(
      () => getJson(`${BASE}/config/data-sources`),
      async () => ({
        dataMode: 'engine',
        sources: [
          {
            id: 'hko',
            name: 'Hong Kong Observatory',
            role: 'Weather anchors (live when DATA_MODE=live)',
            status: 'demo hot-season diurnal cycle offline',
            url: 'https://www.hko.gov.hk/en/abouthko/opendata_intro.htm',
          },
        ],
        disclaimer:
          'OFFLINE ENGINE: the same published heat equations run in-browser ' +
          'over the generated city skeleton. All values are modelled estimates.',
      }),
    ),
};

/** Great-circle distance in metres (haversine). */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest cooling spots within maxM of a point (client-side, mode-agnostic). */
export function nearestCooling(
  spots: CoolingSpot[],
  point: GeoPoint,
  maxM = 500,
  limit = 4,
): CoolingSpot[] {
  return spots
    .map((s) => ({ ...s, distanceMeters: haversineM(point, s.location) }))
    .filter((s) => (s.distanceMeters ?? Infinity) <= maxM)
    .sort((x, y) => (x.distanceMeters ?? 0) - (y.distanceMeters ?? 0))
    .slice(0, limit);
}

export { OFFLINE };
