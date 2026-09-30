/**
 * Real-street routing for CoolRoute — OpenStreetMap data via the map's own
 * vector tiles (OpenFreeMap / OpenMapTiles; attribution is shown in the UI).
 *
 * Why this source? Google's Directions/Routes responses are licensed for
 * display inside Google's own map components only; storing, redrawing or
 * deriving values from them in a MapLibre app breaks the Google Maps Platform
 * Terms, so that geometry can't legally be combined with our heat model.
 * The basemap tiles ALREADY contain the pedestrian network (footpaths,
 * crossings, sidewalks, ordinary streets) as OpenStreetMap data, so we read
 * the loaded tiles with querySourceFeatures and route on real streets with
 * zero extra requests and no third-party rate limits. Overpass remains as a
 * fallback for the rare view whose tiles don't cover a pick point.
 *
 * Failure is always honest: callers fall back to the physics-grid estimate
 * in coolRoute.ts whenever no street network can be built.
 */

import type { Map as MLMap } from 'maplibre-gl';
import type { HeatCell } from '../../api/client';
import { buildFieldFrame, makeContinuousSampler } from './heatField';

/** [south, west, north, east] — Overpass argument order. */
export type BBox = [number, number, number, number];

export interface RoutePoint {
  lat: number;
  lon: number;
}

/** Same shape as coolRoute's RouteSummary (structurally assignable). */
export interface StreetRouteSummary {
  line: [number, number][]; // [lon, lat] vertices along real streets
  distanceM: number;
  minutesHotPace: number;
  minutesFastPace: number;
  meanHeat: number;
  maxHeat: number;
}

interface NetNode {
  lat: number;
  lon: number;
  adj: Map<string, number>; // neighbour key -> metres
}

export interface StreetNet {
  nodes: Map<string, NetNode>;
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_MS = 15_000;
const M_PER_DEG_LAT = 111_320;
const SNAP_RADIUS_M = 300;

/** OpenMapTiles source/layer the basemap draws streets from. */
const TILE_SOURCE = 'openmaptiles';
const TRANSPORT_LAYER = 'transportation';

/** Tile classes that are NOT walkable (rail, construction, motorways). */
const EXCLUDED_CLASS_RE = /(^|_)(construction|rail|transit|motorway|trunk|aeroway|ferry)($|_)/;
/** Rough walkability weight per class (1 = normal street pace). */
const CLASS_SPEED: Record<string, number> = {
  path: 0.85,
  track: 0.9,
  bridge: 1.0,
  pier: 1.0,
  minor: 1.0,
  service: 0.95,
  tertiary: 0.9,
  secondary: 0.85,
  primary: 0.8,
};

function walkSpeed(cls: string | undefined): number {
  if (!cls || EXCLUDED_CLASS_RE.test(cls)) return 0;
  return CLASS_SPEED[cls] ?? 0;
}

// --- heat sampling -----------------------------------------------------------

export type HeatSampler = (lat: number, lon: number) => number | null;

/**
 * Continuous heat sampler for the routers: bilinear interpolation over the
 * physics grid (see heatField.ts), so street nodes are scored at their real
 * position instead of the value of whichever coarse cell they fall in.
 * Returns null where the field has no data at all.
 */
export function makeSampler(cells: HeatCell[]): HeatSampler | null {
  const frame = buildFieldFrame(cells);
  return frame ? makeContinuousSampler(frame) : null;
}

/** Viewport bounds (padded ~90 m) of a heat field, as an Overpass bbox. */
export function boundsOfCells(cells: HeatCell[]): BBox {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const c of cells) {
    for (const [lon, lat] of c.polygon) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
    }
  }
  const pad = 0.0008;
  return [south - pad, west - pad, north + pad, east + pad];
}

// --- graph building ----------------------------------------------------------

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}

function newNet(): StreetNet {
  return { nodes: new Map() };
}

const key = (lat: number, lon: number) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

function touch(net: StreetNet, lat: number, lon: number): string {
  const k = key(lat, lon);
  let n = net.nodes.get(k);
  if (!n) {
    n = { lat, lon, adj: new Map() };
    net.nodes.set(k, n);
  }
  return k;
}

function addSegment(net: StreetNet, latA: number, lonA: number, latB: number, lonB: number): void {
  const ka = touch(net, latA, lonA);
  const kb = touch(net, latB, lonB);
  if (ka === kb) return;
  const na = net.nodes.get(ka)!;
  const nb = net.nodes.get(kb)!;
  const len = haversineM(latA, lonA, latB, lonB);
  if (!(len > 0)) return;
  na.adj.set(kb, len);
  nb.adj.set(ka, len);
}

type LineSource = { coordinates: [number, number][]; speed: number };

/** Collect walkable line geometries from the map's loaded vector tiles. */
function collectLinesFromMap(map: MLMap): LineSource[] {
  const out: LineSource[] = [];
  const seen = new Set<string>();
  let feats;
  try {
    feats = map.querySourceFeatures(TILE_SOURCE, { sourceLayer: TRANSPORT_LAYER });
  } catch {
    return out;
  }
  for (const f of feats) {
    const speed = walkSpeed(f.properties && f.properties.class);
    if (speed <= 0) continue;
    if (!f.geometry || f.geometry.type !== 'LineString') continue;
    const coords = f.geometry.coordinates as [number, number][];
    if (coords.length < 2) continue;
    // Tiles duplicate features at boundaries; dedup on a stable geometric key.
    const k = `${coords.length}:${coords[0][0].toFixed(6)},${coords[0][1].toFixed(6)}:${coords[coords.length - 1][0].toFixed(6)},${coords[coords.length - 1][1].toFixed(6)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ coordinates: coords, speed });
  }
  return out;
}

function buildNet(lines: LineSource[]): StreetNet {
  const net = newNet();
  const KEEP_M = 8; // drop vertices closer than this to the previous kept one
  for (const line of lines) {
    const coords = line.coordinates;
    let prev: [number, number] | null = null; // [lon, lat]
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      if (prev) {
        const step = haversineM(
          prev[1], prev[0],
          c[1], c[0],
        );
        const isLast = i === coords.length - 1;
        if (step < KEEP_M && !isLast) continue; // simplify; keep corners/ends
      }
      if (prev) addSegment(net, prev[1], prev[0], c[1], c[0]);
      prev = [c[0], c[1]];
    }
  }
  return net;
}

// --- Overpass fallback -------------------------------------------------------

interface OverpassWay {
  type: string;
  geometry?: { lat: number; lon: number }[];
}

async function fetchWays(bbox: BBox): Promise<OverpassWay[]> {
  const [south, west, north, east] = bbox;
  const query =
    `[out:json][timeout:20];` +
    `way["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|footway|path|steps|service|track)$"]["foot"!~"no"]["access"!~"private|no"]["area"!~"yes"]` +
    `(${south},${west},${north},${east});` +
    `out geom;`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass etiquette (browsers send their own UA regardless).
        'User-Agent': 'HKCoolPathAI/0.1 (heat-aware routing demo)',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`overpass ${res.status}`);
    const json = (await res.json()) as { elements?: OverpassWay[] };
    return json.elements ?? [];
  } finally {
    clearTimeout(timer);
  }
}

const overpassCache = new Map<string, Promise<StreetNet | null>>();

function bboxKey(b: BBox): string {
  return b.map((v) => v.toFixed(2)).join(',');
}

/** Overpass fallback (used when the tile graph can't serve a route). */
function getOverpassNet(bbox: BBox): Promise<StreetNet | null> {
  const k = bboxKey(bbox);
  const hit = overpassCache.get(k);
  if (hit) return hit;
  const p = fetchWays(bbox)
    .then((ways) => {
      if (ways.length === 0) return null;
      const net = newNet();
      for (const w of ways) {
        const g = w.geometry ?? [];
        for (let i = 1; i < g.length; i++) {
          addSegment(net, g[i - 1].lat, g[i - 1].lon, g[i].lat, g[i].lon);
        }
      }
      return net;
    })
    .catch(() => null);
  overpassCache.set(k, p);
  if (overpassCache.size > 8) {
    const oldest = overpassCache.keys().next().value;
    if (oldest !== undefined && oldest !== k) overpassCache.delete(oldest);
  }
  // Negative results are retried after a minute so a flaky network recovers.
  void p.then((net) => {
    if (!net) setTimeout(() => overpassCache.delete(k), 60_000);
  });
  return p;
}

// --- public API --------------------------------------------------------------

/** Minimum graph size near a pick for the tile network to be trusted. */
const MIN_NODES = 40;

/**
 * Build (or reuse) the street graph from the map's loaded tiles. Resolves
 * null when the tiles yield nothing usable (caller may fall back to
 * Overpass, then to the grid estimate).
 */
export function getStreetNetForMap(map: MLMap): Promise<StreetNet | null> {
  const lines = collectLinesFromMap(map);
  if (lines.length === 0) return Promise.resolve(null);
  const net = buildNet(lines);
  if (net.nodes.size < MIN_NODES) return Promise.resolve(null);
  return Promise.resolve(net);
}

/** Warm the graph when the viewport changes so route clicks stay instant. */
export function prefetchStreetsForMap(map: MLMap): Promise<StreetNet | null> {
  return getStreetNetForMap(map);
}

export function prefetchStreetsFromOverpass(bbox: BBox): Promise<StreetNet | null> {
  return getOverpassNet(bbox);
}

// --- routing -----------------------------------------------------------------

class MinHeap {
  private keys: number[] = [];
  private vals: string[] = [];

  get size(): number {
    return this.vals.length;
  }

  push(key: number, val: string): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(): string | undefined {
    if (this.vals.length === 0) return undefined;
    const top = this.vals[0];
    const lastK = this.keys.pop() as number;
    const lastV = this.vals.pop() as string;
    if (this.vals.length > 0) {
      this.keys[0] = lastK;
      this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const v = this.vals[a];
    this.vals[a] = this.vals[b];
    this.vals[b] = v;
  }
}

function snap(net: StreetNet, p: RoutePoint): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  for (const [k, n] of net.nodes) {
    const d = Math.hypot(
      (n.lat - p.lat) * M_PER_DEG_LAT,
      (n.lon - p.lon) * M_PER_DEG_LAT * cosLat,
    );
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return bestD <= SNAP_RADIUS_M ? best : null;
}

/**
 * Heat-aware Dijkstra over real streets. Cost per edge is walking TIME under
 * the given pace model — exactly the grid router's semantics, so route
 * choices and the minutes shown stay consistent between the two sources.
 * `speedOf` scales each edge (path edges slower, primary roads faster).
 */
export function planOnStreets(
  net: StreetNet,
  sampler: HeatSampler,
  start: RoutePoint,
  end: RoutePoint,
  coolest: boolean,
  heatPaceMinPerM: (score: number) => number,
  fastPaceMinPerM: number,
  speedOf?: (lat: number, lon: number) => number,
): StreetRouteSummary | null {
  const s = snap(net, start);
  const e = snap(net, end);
  if (!s || !e || s === e) return null;

  const scoreOf = (k: string): number => {
    const n = net.nodes.get(k);
    if (!n) return 55;
    return sampler(n.lat, n.lon) ?? 55; // 55 = heat onset: neutral off-field
  };
  const paceScale = (k: string): number => {
    if (!speedOf) return 1;
    const n = net.nodes.get(k);
    return n ? speedOf(n.lat, n.lon) : 1;
  };

  const dist = new Map<string, number>([[s, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  const heap = new MinHeap();
  heap.push(0, s);
  while (heap.size > 0) {
    const u = heap.pop() as string;
    if (done.has(u)) continue;
    done.add(u);
    if (u === e) break;
    const un = net.nodes.get(u);
    if (!un) continue;
    const uScore = scoreOf(u);
    const uScale = paceScale(u);
    for (const [v, lenM] of un.adj) {
      if (done.has(v)) continue;
      const meanScore = (uScore + scoreOf(v)) / 2;
      const pace = (coolest ? heatPaceMinPerM(meanScore) : fastPaceMinPerM) /
        ((uScale + paceScale(v)) / 2);
      const alt = (dist.get(u) ?? Infinity) + lenM * pace * 60; // seconds
      if (alt < (dist.get(v) ?? Infinity)) {
        dist.set(v, alt);
        prev.set(v, u);
        heap.push(alt, v);
      }
    }
  }
  if (!done.has(e)) return null;

  // Trace and measure.
  const sNode = net.nodes.get(s);
  if (!sNode) return null;
  const pts: { lat: number; lon: number }[] = [];
  let cur: string | undefined = e;
  let reachedStart = false;
  while (cur !== undefined) {
    const n = net.nodes.get(cur);
    if (!n) return null;
    pts.push({ lat: n.lat, lon: n.lon });
    if (cur === s) {
      reachedStart = true;
      break;
    }
    cur = prev.get(cur);
  }
  if (!reachedStart || pts.length < 2) return null;
  pts.reverse();

  let distanceM = 0;
  let hotMin = 0;
  let fastMin = 0;
  let scoreSum = 0;
  let scoreMax = 0;
  for (let i = 0; i < pts.length; i++) {
    const sc = scoreOf(key(pts[i].lat, pts[i].lon));
    scoreSum += sc;
    scoreMax = Math.max(scoreMax, sc);
    if (i > 0) {
      const q = pts[i - 1];
      const len = haversineM(q.lat, q.lon, pts[i].lat, pts[i].lon);
      distanceM += len;
      const mean = (sc + scoreOf(key(q.lat, q.lon))) / 2;
      hotMin += len * heatPaceMinPerM(mean);
      fastMin += len * fastPaceMinPerM;
    }
  }
  return {
    line: pts.map((p) => [p.lon, p.lat] as [number, number]),
    distanceM,
    minutesHotPace: hotMin,
    minutesFastPace: fastMin,
    meanHeat: scoreSum / pts.length,
    maxHeat: scoreMax,
  };
}
