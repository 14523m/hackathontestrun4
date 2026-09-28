/**
 * Web API client. The contract mirrors backend/app/schemas.py — treat any
 * change there as a coordinated architecture change (see docs/development.md).
 *
 * Resolution order (section 17 demo resilience):
 *   1. LIVE API (Vite dev proxy /api, or same-origin when FastAPI serves us)
 *   2. EMBEDDED OFFLINE SNAPSHOT (generated TS module) — static render of the
 *      SAME HeatPredictionService pipeline; the UI labels it "OFFLINE SNAPSHOT".
 */

import { SNAPSHOTS } from '../features/heatmap/demoSnapshots';

const BASE: string = import.meta.env.VITE_API_BASE ?? '/api';
const OFFLINE = `${import.meta.env.BASE_URL}demo`;

export type DataMode = 'live' | 'snapshot';

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

async function withFallback<T>(live: () => Promise<T>, snapshot: () => Promise<T>): Promise<T> {
  try {
    const data = await live();
    apiState.mode = 'live';
    return data;
  } catch {
    const data = await snapshot();
    apiState.mode = 'snapshot';
    return data;
  }
}

// Hours available in the bundled offline snapshot (backend/app/tools/export_demo_snapshot.py).
const SNAPSHOT_HOURS = [6, 9, 12, 15, 18, 21];

function nearestSnapshotHour(hour: number): number {
  return SNAPSHOT_HOURS.reduce((best, h) =>
    Math.abs(h - hour) < Math.abs(best - hour) ? h : best,
  );
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

  dataSources: () =>
    withFallback<{ dataMode: string; sources: DataSourceInfo[]; disclaimer: string }>(
      () => getJson(`${BASE}/config/data-sources`),
      async () => ({
        dataMode: 'snapshot',
        sources: [
          {
            id: 'hko',
            name: 'Hong Kong Observatory',
            role: 'Weather anchors (live when DATA_MODE=live)',
            status: 'simulated in this snapshot',
            url: 'https://www.hko.gov.hk/en/abouthko/opendata_intro.htm',
          },
        ],
        disclaimer:
          'OFFLINE SNAPSHOT: static render of the simulated heat pipeline. All values are modelled estimates.',
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
