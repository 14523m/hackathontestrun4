/**
 * Accurate walking geometry from the OpenStreetMap routing network.
 *
 * Provider: OSRM's public foot-profile server (routing.openstreetmap.de,
 * `routed-foot`). It routes on the SAME OpenStreetMap foot data the basemap
 * draws — real sidewalks, footbridges, stairs, park paths, piers — with
 * proper crossing/walkability handling. CORS is open and no key is needed
 * (HKeMobility's own routing API blocks programmatic access with 403, and
 * Google's directions may not be redrawn outside Google maps).
 *
 * Division of labour: OSRM owns GEOMETRY (how a human actually walks), our
 * heat field owns SCORES. Every vertex is scored with the continuous heat
 * field (see heatField.ts), minutes use the heat-aware pace model, and the
 * "coolest" candidate can also come from our own heat-aware street-graph
 * Dijkstra (coolRoute.ts). OSRM alternatives give extra real-world route
 * options to score — heat can pick between real ways, never invent one.
 */

import type { RouteSummary } from './coolRoute';
import type { RoutePoint } from './coolRoute';
import type { HeatSampler } from './osmStreets';

/** Overridable for self-hosting / offline mirrors; public FOSSGIS by default. */
const OSRM_BASE: string =
  (import.meta.env.VITE_OSRM_BASE as string | undefined) ??
  'https://routing.openstreetmap.de/routed-foot/route/v1/foot';

const TIMEOUT_MS = 12_000;

export interface OsrmRoute {
  /** [lon, lat] vertices along real streets (GeoJSON order). */
  line: [number, number][];
  /** OSRM's measured length along the geometry (metres) — authoritative. */
  distanceM: number;
  /** OSRM's reference walking duration (minutes). */
  durationMin: number;
  /** Turn-by-turn steps (bilingual street names from OSM). */
  steps: { name: string; distanceM: number; afterM: number; type: string }[];
  /** Metres on ferry legs (OSM route: ferry), else undefined. */
  ferryM?: number;
}

type RouteCacheVal = { at: number; routes: OsrmRoute[] | null };
const routeCache = new Map<string, RouteCacheVal>();
const NEG_TTL_MS = 60_000; // failures retry after a minute

function pairKey(a: RoutePoint, b: RoutePoint): string {
  return `${a.lat.toFixed(5)},${a.lon.toFixed(5)}|${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;
}

async function fetchRoutes(a: RoutePoint, b: RoutePoint): Promise<OsrmRoute[] | null> {
  const url =
    `${OSRM_BASE}/${a.lon},${a.lat};${b.lon},${b.lat}` +
    `?overview=full&geometries=geojson&alternatives=true&steps=true`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      code?: string;
      routes?: {
        geometry?: { coordinates?: [number, number][] };
        distance?: number;
        duration?: number;
        legs?: {
          steps?: {
            geometry?: { coordinates?: [number, number][] };
            name?: string;
            distance?: number;
            maneuver?: { type?: string; modifier?: string };
          }[];
        }[];
      }[];
    };
    if (json.code !== 'Ok' || !Array.isArray(json.routes)) return null;
    const routes: OsrmRoute[] = [];
    for (const r of json.routes) {
      const line = r.geometry?.coordinates;
      if (!line || line.length < 2) continue;
      // Walk the steps, accumulating distance so the UI can show real
      // turn-by-turn; ferry steps (maneuver type 'ferry') are flagged.
      const steps: OsrmRoute['steps'] = [];
      let afterM = 0;
      let ferryM = 0;
      for (const leg of r.legs ?? []) {
        for (const s of leg.steps ?? []) {
          steps.push({
            name: s.name ?? '',
            distanceM: s.distance ?? 0,
            afterM,
            type: s.maneuver?.type ?? '',
          });
          afterM += s.distance ?? 0;
          // Ferry legs: OSRM foot profile doesn't set maneuver type 'ferry',
          // but the step NAME is the OSM ferry-route name — em/en dash
          // between pier names (中環—尖沙咀), or an explicit ferry word.
          const nm = s.name ?? '';
          const isFerryStep =
            s.maneuver?.type === 'ferry' ||
            ((s.distance ?? 0) > 300 && /[—–]|\s-\s|ferry|渡輪/i.test(nm));
          if (isFerryStep) ferryM += s.distance ?? 0;
        }
      }
      routes.push({
        line,
        distanceM: typeof r.distance === 'number' ? r.distance : 0,
        durationMin: typeof r.duration === 'number' ? r.duration / 60 : 0,
        steps,
        ferryM: ferryM > 0 ? ferryM : undefined,
      });
    }
    return routes.length > 0 ? routes : null;
  } catch {
    return null; // offline / blocked: caller falls back to the street graph
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walking routes between two points on the real OSM foot network. First
 * entry is OSRM's best (shortest) route; any extras are alternatives.
 * Resolves null when unreachable (e.g. across the harbour) or offline.
 */
export async function osrmRoutes(a: RoutePoint, b: RoutePoint): Promise<OsrmRoute[] | null> {
  const k = pairKey(a, b);
  const hit = routeCache.get(k);
  if (hit && (hit.routes !== null || Date.now() - hit.at < NEG_TTL_MS)) return hit.routes;
  const routes = await fetchRoutes(a, b);
  routeCache.set(k, { at: Date.now(), routes });
  if (routeCache.size > 64) {
    const oldest = routeCache.keys().next().value;
    if (oldest !== undefined && oldest !== k) routeCache.delete(oldest);
  }
  return routes;
}

/**
 * Score a real-street line with OUR heat model: continuous-field sampling at
 * every vertex, minutes from the heat-aware pace model. `distanceM` overrides
 * the haversine sum when a routing engine already measured the path.
 */
export function summarizeLine(
  line: [number, number][],
  sampler: HeatSampler | null,
  heatPaceMinPerM: (score: number) => number,
  fastPaceMinPerM: number,
  distanceM?: number,
  ferryM?: number,
  shadeSampler?: ((lat: number, lon: number) => number | null) | null,
): RouteSummary {
  const scoreAt = (lat: number, lon: number): number => sampler?.(lat, lon) ?? 55;
  const FERRY_MIN_PER_M = (7.5 + 2.5) / 1000; // ~8 km/h cruise + avg wait
  let dist = 0;
  let hotMin = 0;
  let fastMin = 0;
  let scoreSum = 0;
  let scoreMax = 0;
  // Ferry metres (when OSRM told us) are still un-distributed here; we
  // remove them from the walking total at the end via a second pass below.
  const segM: number[] = [];
  for (let i = 1; i < line.length; i++) {
    const [lon, lat] = line[i];
    const [pLon, pLat] = line[i - 1];
    const dLat = ((lat - pLat) * Math.PI) / 180;
    const dLon = ((lon - pLon) * Math.PI) / 180;
    const m =
      2 *
      6_371_000 *
      Math.asin(
        Math.sqrt(
          Math.sin(dLat / 2) ** 2 +
            Math.cos((pLat * Math.PI) / 180) *
              Math.cos((lat * Math.PI) / 180) *
              Math.sin(dLon / 2) ** 2,
        ),
      );
    segM.push(m);
    dist += m;
  }
  // Over-water runs (no heat data on both ends) longer than 300 m are also
  // ferry — covers cases where OSRM's step data is unavailable.
  const segWater: boolean[] = segM.map((_m, k) => {
    const [lon1, lat1] = line[k];
    const [lon2, lat2] = line[k + 1];
    return sampler?.(lat2, lon2) === null && sampler?.(lat1, lon1) === null;
  });
  const isFerrySeg: boolean[] = segM.map(() => false);
  if (ferryM === undefined) {
    let i = 0;
    while (i < segM.length) {
      if (!segWater[i]) {
        i++;
        continue;
      }
      let j = i;
      let run = 0;
      while (j < segM.length && segWater[j]) {
        run += segM[j];
        j++;
      }
      if (run > 300) {
        for (let k = i; k < j; k++) isFerrySeg[k] = true;
      }
      i = j;
    }
  }
  // Distribute OSRM's ferry metres across the line when provided: mark the
  // longest contiguous runs until ferryM is consumed.
  if (ferryM !== undefined && ferryM > 0) {
    let remaining = ferryM;
    const order = segM
      .map((mm, k) => [k, mm] as const)
      .sort((x, y) => y[1] - x[1]);
    for (const [k, m] of order) {
      if (remaining <= 0) break;
      if (m > 30 && segWater[k]) {
        isFerrySeg[k] = true;
        remaining -= m;
      }
    }
  }
  let shadedM = 0;
  for (let k = 0; k < line.length; k++) {
    const [lon, lat] = line[k];
    const sc = scoreAt(lat, lon);
    scoreSum += sc;
    scoreMax = Math.max(scoreMax, sc);
    if (k > 0) {
      const m = segM[k - 1];
      if (isFerrySeg[k - 1]) {
        hotMin += m * FERRY_MIN_PER_M;
        fastMin += m * FERRY_MIN_PER_M;
      } else {
        hotMin += m * heatPaceMinPerM((sc + scoreAt(line[k - 1][1], line[k - 1][0])) / 2);
        fastMin += m * fastPaceMinPerM;
        // Shaded-metre stat: both vertices at least half shaded.
        if (shadeSampler) {
          const s1 = shadeSampler(lat, lon);
          const s0 = shadeSampler(line[k - 1][1], line[k - 1][0]);
          if (s1 !== null && s0 !== null && (s1 + s0) / 2 >= 0.5) shadedM += m;
        }
      }
    }
  }
  return {
    line,
    distanceM: distanceM ?? dist,
    minutesHotPace: hotMin,
    minutesFastPace: fastMin,
    meanHeat: line.length ? scoreSum / line.length : 0,
    maxHeat: scoreMax,
    shadedM: shadeSampler && shadedM > 0 ? shadedM : undefined,
    ferryM: ferryM && ferryM > 0 ? ferryM : undefined,
  };
}
