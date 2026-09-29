/**
 * CoolRoute — find a cooler walking route between two points.
 *
 * Graph: the physics cell grid (the offline engine grid, or the backend's
 * viewport grid). Every cell centre is a node; 8-neighbour moves are edges
 * (diagonals sqrt(2) longer). Open water is not walkable.
 *
 * Edge cost is WALKING TIME, so "cooler" and "faster" stay comparable:
 *
 *   pace = 12 x (1 + 0.008 x max(0, score - 55)^1.5) min/km,  capped at 24
 *
 * So a 5 km/h stroll on a comfortable street slows to roughly 2.5 km/h in
 * the worst heat — the same relationship heat-health guidance uses when it
 * tells people to allow extra time and seek shade. The route optimiser
 * cooler AND honest: the heat-aware pace makes shade/park/water detours
 * genuinely faster under heat — the optimiser never trades time for an
 * abstract penalty.
 *
 * Balance slider: 0 = pure fastest (heat ignored), 1 = coolest. Values
 * between snap to the nearest anchor — two honest options beat a vague dial.
 * Every route reports real distance, minutes at BOTH paces, and mean/max
 * heat along the way, plus the same numbers for the pure-fastest route so
 * the tradeoff is explicit.
 */

import type { HeatCell } from '../../api/client';

export interface RoutePoint {
  lat: number;
  lon: number;
}

export interface RouteSummary {
  line: [number, number][]; // [lon, lat] vertices
  distanceM: number;
  minutesHotPace: number; // realistic hot-weather minutes
  minutesFastPace: number; // 12 min/km reference minutes
  meanHeat: number;
  maxHeat: number;
}

export interface RoutePlan {
  chosen: RouteSummary;
  fastest: RouteSummary;
}

const FAST_PACE_MIN_PER_M = 12 / 1000; // 12 min/km ≈ 5 km/h
const HEAT_ONSET = 55.0; // score where heat starts slowing walkers
const PACE_CAP_MIN_PER_KM = 24; // hottest slog ≈ 2.5 km/h

function heatPaceMinPerM(score: number): number {
  const excess = Math.max(0, score - HEAT_ONSET);
  const minPerKm = Math.min(
    PACE_CAP_MIN_PER_KM,
    12 * (1 + 0.008 * excess ** 1.5),
  );
  return minPerKm / 1000;
}

const M_PER_DEG_LAT = 111_320;

const NEIGHBORS: [number, number, number][] = [
  // [di, dj, pathFactor] — diagonal moves are sqrt(2) longer.
  [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [1, 1, Math.SQRT2],
];

interface Grid {
  rows: number;
  cols: number;
  cellM: number;
  mPerLon: number;
  nodes: (Node | null)[]; // row-major
}

interface Node {
  i: number;
  j: number;
  lat: number;
  lon: number;
  score: number;
}

function buildGrid(cells: HeatCell[]): Grid | null {
  if (cells.length === 0) return null;
  const parsed: { c: HeatCell; i: number; j: number }[] = [];
  let maxI = 0;
  let maxJ = 0;
  for (const c of cells) {
    const m = /^(?:eng|vp)-(\d+)-(\d+)$/.exec(c.cellId);
    if (!m) return null; // unknown id scheme: refuse to route on guesses
    const i = Number(m[1]);
    const j = Number(m[2]);
    maxI = Math.max(maxI, i);
    maxJ = Math.max(maxJ, j);
    parsed.push({ c, i, j });
  }
  const rows = maxI + 1;
  const cols = maxJ + 1;

  // Walkable = inside the city skeleton (engine marks open water as out of
  // coverage). Backend cells are all inside HK and therefore all walkable.
  const table: (HeatCell | null)[] = Array(rows * cols).fill(null);
  for (const { c, i, j } of parsed) {
    if (c.inCoverage === false) continue;
    table[i * cols + j] = c;
  }

  const first = parsed[0].c;
  // Cell size from the first cell's polygon (square by construction).
  const poly = first.polygon;
  const latMid = (poly[0][1] + poly[2][1]) / 2;
  const dLat = Math.abs(poly[1][1] - poly[0][1]);
  const dLon = Math.abs(poly[1][0] - poly[0][0]);
  const cellM = Math.hypot(dLat * M_PER_DEG_LAT, dLon * M_PER_DEG_LAT * Math.cos((latMid * Math.PI) / 180));
  const mPerLon = M_PER_DEG_LAT * Math.cos((latMid * Math.PI) / 180);

  const nodes: (Node | null)[] = table.map((c) =>
    c ? { i: 0, j: 0, lat: c.center.lat, lon: c.center.lon, score: c.heatScore } : null,
  );
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n) {
      n.i = Math.floor(k / cols);
      n.j = k % cols;
    }
  }
  return { rows, cols, cellM, mPerLon, nodes };
}

function nearestNode(grid: Grid, p: RoutePoint): Node | null {
  let best: Node | null = null;
  let bestD = Infinity;
  for (const n of grid.nodes) {
    if (!n) continue;
    const d = Math.hypot((n.lon - p.lon) * grid.mPerLon, (n.lat - p.lat) * M_PER_DEG_LAT);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

interface DijkstraResult {
  dist: Float64Array;
  prev: Int32Array;
}

/** Classic Dijkstra with a lazy-deletion binary heap. */
function shortestPath(grid: Grid, src: Node, coolest: boolean): DijkstraResult | null {
  const n = grid.rows * grid.cols;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const idx = (node: Node) => node.i * grid.cols + node.j;
  const s = idx(src);
  dist[s] = 0;

  // Binary min-heap on dist.
  const heap: number[] = [];
  const push = (v: number) => {
    heap.push(v);
    let k = heap.length - 1;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (dist[heap[parent]] <= dist[heap[k]]) break;
      [heap[parent], heap[k]] = [heap[k], heap[parent]];
      k = parent;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && dist[heap[l]] < dist[heap[m]]) m = l;
        if (r < heap.length && dist[heap[r]] < dist[heap[m]]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };

  push(s);
  while (heap.length > 0) {
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    const ui = Math.floor(u / grid.cols);
    const uj = u % grid.cols;
    const un = grid.nodes[u];
    if (!un) continue;
    for (const [di, dj, factor] of NEIGHBORS) {
      const vi = ui + di;
      const vj = uj + dj;
      if (vi < 0 || vi >= grid.rows || vj < 0 || vj >= grid.cols) continue;
      const v = vi * grid.cols + vj;
      const vn = grid.nodes[v];
      if (!vn || done[v]) continue;
      const distM = factor * grid.cellM;
      const meanScore = (un.score + vn.score) / 2;
      const pace = coolest ? heatPaceMinPerM(meanScore) : FAST_PACE_MIN_PER_M;
      const w = distM * pace * 60; // seconds
      const alt = dist[u] + w;
      if (alt < dist[v]) {
        dist[v] = alt;
        prev[v] = u;
        push(v);
      }
    }
  }
  return { dist, prev };
}

function tracePath(grid: Grid, res: DijkstraResult, src: Node, dst: Node): RoutePoint[] {
  const idx = (node: Node) => node.i * grid.cols + node.j;
  const s = idx(src);
  let cur = idx(dst);
  const pts: RoutePoint[] = [];
  let guard = 0;
  while (cur !== -1 && guard++ < 10_000) {
    const n = grid.nodes[cur];
    if (!n) break;
    pts.push({ lat: n.lat, lon: n.lon });
    if (cur === s) break;
    cur = res.prev[cur];
  }
  return pts.reverse();
}

function summarize(
  pts: RoutePoint[],
  grid: Grid,
): RouteSummary {
  const scoreAt = (p: RoutePoint): number => {
    const nn = nearestNode(grid, p);
    return nn ? nn.score : 0;
  };
  let distM = 0;
  let hotMin = 0;
  let fastMin = 0;
  let scoreSum = 0;
  let scoreMax = 0;
  for (let k = 0; k < pts.length; k++) {
    const score = scoreAt(pts[k]);
    scoreSum += score;
    scoreMax = Math.max(scoreMax, score);
    if (k > 0) {
      const q = pts[k - 1];
      const mPerLon = M_PER_DEG_LAT * Math.cos((pts[k].lat * Math.PI) / 180);
      const d = Math.hypot(
        (pts[k].lon - q.lon) * mPerLon,
        (pts[k].lat - q.lat) * M_PER_DEG_LAT,
      );
      distM += d;
      hotMin += d * heatPaceMinPerM((score + scoreAt(q)) / 2);
      fastMin += d * FAST_PACE_MIN_PER_M;
    }
  }
  return {
    line: pts.map((p) => [p.lon, p.lat] as [number, number]),
    distanceM: distM,
    minutesHotPace: hotMin,
    minutesFastPace: fastMin,
    meanHeat: pts.length ? scoreSum / pts.length : 0,
    maxHeat: scoreMax,
  };
}

/**
 * Plan a route. balance 0 = fastest (heat ignored), 1 = coolest (heat-aware
 * pace). Returns the chosen route plus the pure-fastest one for comparison.
 */
export function planRoute(
  cells: HeatCell[],
  start: RoutePoint,
  end: RoutePoint,
  balance: number,
): RoutePlan | null {
  const grid = buildGrid(cells);
  if (!grid) return null;
  const s = nearestNode(grid, start);
  const e = nearestNode(grid, end);
  if (!s || !e || s === e) return null;

  const fast = shortestPath(grid, s, false);
  if (!fast) return null;
  const fastPts = tracePath(grid, fast, s, e);
  if (fastPts.length < 2) return null;
  const fastest = summarize(fastPts, grid);

  let chosen = fastest;
  if (balance >= 0.5) {
    const cool = shortestPath(grid, s, true);
    if (cool) {
      const coolPts = tracePath(grid, cool, s, e);
      if (coolPts.length >= 2) chosen = summarize(coolPts, grid);
    }
  }
  return { chosen, fastest };
}
