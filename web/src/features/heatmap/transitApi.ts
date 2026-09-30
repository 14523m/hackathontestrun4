/**
 * Transit itineraries (MTR + KMB bus) — typed client for /api/transit/plan.
 *
 * Vehicles are air-conditioned: heat does NOT slow a train or bus, so
 * transit minutes are the planner's honest estimates (wait + ride + the
 * walk to/from stops, which IS heat-scored client-side). Fares are adult
 * Octopus-equivalent published values, modelled by the backend.
 */

import type { RoutePoint } from './coolRoute';

export interface TransitLeg {
  mode: 'mtr' | 'bus';
  line: string;
  fromStation: string;
  toStation: string;
  fromId?: string;
  toId?: string;
  stationsCount?: number;
  distanceM?: number | null;
  minutes: number;
  fare: number;
  coords: [number, number][];
}

export interface TransitItinerary {
  mode: 'mtr' | 'bus';
  label: string;
  totalMin: number;
  fare: number;
  transfers: number;
  walkInM: number;
  walkOutM: number;
  legs: TransitLeg[];
}

export interface TransitPlan {
  from: RoutePoint;
  to: RoutePoint;
  modes: string[];
  itineraries: TransitItinerary[];
}

const BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

const cache = new Map<string, Promise<TransitPlan | null>>();

function key(a: RoutePoint, b: RoutePoint, modes: string): string {
  return `${a.lat.toFixed(5)},${a.lon.toFixed(5)}|${b.lat.toFixed(5)},${b.lon.toFixed(5)}|${modes}`;
}

/**
 * Fetch transit itineraries for an origin/destination. Resolves null when
 * the backend is unreachable or offers nothing (caller shows walk-only).
 */
export function fetchTransitPlan(
  a: RoutePoint,
  b: RoutePoint,
  modes: ('mtr' | 'bus')[],
): Promise<TransitPlan | null> {
  const k = key(a, b, modes.join(','));
  const hit = cache.get(k);
  if (hit) return hit;
  const p = fetch(
    `${BASE}/transit/plan?fromLat=${a.lat}&fromLon=${a.lon}&toLat=${b.lat}&toLon=${b.lon}&modes=${modes.join(',')}`,
  )
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d: TransitPlan) => d)
    .catch(() => null);
  cache.set(k, p);
  if (cache.size > 48) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined && oldest !== k) cache.delete(oldest);
  }
  return p;
}
