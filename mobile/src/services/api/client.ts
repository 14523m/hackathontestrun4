/**
 * Typed API client for the HK CoolPath AI backend.
 *
 * The base URL defaults to the iOS simulator convention (localhost) and can
 * be overridden for real devices via EXPO_PUBLIC_API_URL in .env (mobile/.env).
 */

import type {
  CoolingSpotOut,
  DataSourcesOut,
  DistrictOut,
  HeatMapOut,
  MapDataResponse,
  RoutePlanOut,
  RouteType,
  ScenarioComparison,
} from './types';

export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`API ${res.status} for ${path}`);
  }
  return (await res.json()) as T;
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status} for ${path}`);
  }
  return (await res.json()) as T;
}

// --------------------------------------------------------------------------- //

export const api = {
  districts: () => get<DistrictOut[]>('/districts'),
  mapData: (districtId: string) => get<MapDataResponse>(`/map-data?districtId=${districtId}`),
  heatmap: (districtId: string, hour: number) =>
    get<HeatMapOut>(`/heatmap?districtId=${districtId}&hour=${hour}`),
  routes: (params: {
    districtId: string;
    origin: GeoPointLite;
    destination: GeoPointLite;
    hour: number;
  }) =>
    get<RoutePlanOut>(
      `/routes?districtId=${params.districtId}` +
        `&originLat=${params.origin.lat}&originLon=${params.origin.lon}` +
        `&destLat=${params.destination.lat}&destLon=${params.destination.lon}` +
        `&hour=${params.hour}`,
    ),
  coolingSpots: (districtId: string) =>
    get<CoolingSpotOut[]>(`/cooling-spots?districtId=${districtId}`),
  plannerCompare: (districtId: string, interventions: string[], hour: number) =>
    post<ScenarioComparison>(`/planner/compare?hour=${hour}`, {
      districtId,
      interventions,
    }),
  plannerInterventions: () =>
    get<{ id: string; label: string }[]>('/planner/interventions'),
  northernMetropolis: (hour: number, interventions: string[]) => {
    const q = interventions.length ? `&interventions=${interventions.join(',')}` : '';
    return get<HeatMapOut>(`/planner/northern-metropolis?hour=${hour}${q}`);
  },
  dataSources: () => get<DataSourcesOut>('/config/data-sources'),
};

export interface GeoPointLite {
  lat: number;
  lon: number;
}

export type { RouteType };
