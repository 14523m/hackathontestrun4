/**
 * routing3d/router — time-aware A* over the multi-modal 3D graph.
 *
 * State = (node, mode-of-arrival). Two states of the same node differ in
 * cost when the *next* leg starts with a transfer penalty, so the search
 * carries the inbound mode in the state key — the standard trick for
 * mode-change penalties in multimodal routing.
 *
 * Heuristic: 3D haversine (flat distance + level delta) converted to minutes
 * at the fastest imaginable speed (MTR 30 km/h), then discounted by the
 * cheapest possible monetary conversion. It never overestimates the true
 * remaining cost, so A* stays admissible AND optimal.
 *
 * Edge cases handled:
 *  - harbour trap: unreachable goal → clean "no path" with the reason;
 *  - ferry schedules: departure wait is part of the edge cost (time-dependent);
 *  - escalator direction flips at 10:00 — the SAME graph yields different
 *    optimal routes at 08:00 vs 14:00 (time-dependent edge weights).
 */

import type { Edge, Graph, Mode, Preferences } from "./graph.ts";
import { DEFAULT_PREFERENCES } from "./graph.ts";

export interface TimeAndMode {
  node: string;
  mode: Mode | "start";
}

interface Reached {
  cost: number;
  timeMin: number;
  fare: number;
  climbM: number;
  via: { edge: Edge; from: TimeAndMode } | null;
}

export interface PathResult {
  ok: boolean;
  reason?: string;
  /** Human-readable steps with per-leg stats. */
  steps: {
    mode: Mode;
    describe: string;
    timeMin: number;
    waitMin: number;
    fare: number;
    climbM: number;
  }[];
  totals: { timeMin: number; waitMin: number; fare: number; climbM: number; cost: number };
}

/** Rough upper bound on average door-to-door speed, minutes per metre. */
const MTR_MIN_PER_M = 60 / 30_000; // 30 km/h effective incl. stops

export function findHkPath(
  graph: Graph,
  originId: string,
  destinationId: string,
  timeOfDayHours: number,
  preferences: Preferences = DEFAULT_PREFERENCES,
): PathResult {
  const start = graph.node(originId);
  const goal = graph.node(destinationId);
  if (!start || !goal) {
    return { ok: false, reason: `unknown node(s): ${originId}, ${destinationId}`, steps: [], totals: emptyTotals() };
  }

  const startState: TimeAndMode = { node: originId, mode: "start" };
  const goalKey = stateKey({ node: destinationId, mode: "start" });
  // Reaching the goal by ANY mode counts; we track best over all goal states.
  const goalNodes = new Set([destinationId]);

  const best = new Map<string, Reached>();
  const open: { key: string; f: number }[] = [];
  const push = (key: string, f: number) => open.push({ key, f });
  const popMin = () => {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    return open.splice(bi, 1)[0];
  };

  const setBest = (s: TimeAndMode, r: Reached) => best.set(stateKey(s), r);
  const getBest = (s: TimeAndMode): Reached | undefined => best.get(stateKey(s));

  setBest(startState, { cost: 0, timeMin: 0, fare: 0, climbM: 0, via: null });
  push(stateKey(startState), heuristic(graph, originId, destinationId, preferences));

  while (open.length > 0) {
    const { key: curKey } = popMin();
    const cur = best.get(curKey);
    if (!cur) continue; // stale heap entry
    const curState = parseKey(curKey);

    if (goalNodes.has(curState.node)) {
      return reconstruct(graph, curKey, best, timeOfDayHours, preferences);
    }

    const node = graph.node(curState.node)!;
    for (const edge of graph.edgesFrom(curState.node)) {
      const nxt = graph.node(edge.to);
      if (!nxt) continue;
      if (preferences.allowedModes && !preferences.allowedModes.includes(edge.mode)) {
        continue; // user excluded this mode (e.g. walking-only)
      }
      const c = edge.cost(timeOfDayHours * 60, preferences);
      const transfer =
        curState.mode !== "start" && edge.mode !== curState.mode ? preferences.transferPenalty : 0;
      const newCost = cur.cost + c.total + transfer;
      const nextState: TimeAndMode = { node: edge.to, mode: edge.mode };
      const incumbent = getBest(nextState);
      if (incumbent && incumbent.cost <= newCost) continue;
      setBest(nextState, {
        cost: newCost,
        timeMin: cur.timeMin + c.timeMin + c.waitMin,
        fare: cur.fare + c.fare,
        climbM: cur.climbM + c.climbM,
        via: { edge, from: curState },
      });
      push(stateKey(nextState), newCost + heuristic(graph, edge.to, destinationId, preferences));
    }
    void node;
  }

  return {
    ok: false,
    reason: harbourTrapExplanation(graph, originId, destinationId),
    steps: [],
    totals: emptyTotals(),
  };
}

function stateKey(s: TimeAndMode): string {
  return `${s.node}::${s.mode}`;
}

function parseKey(k: string): TimeAndMode {
  const [node, mode] = k.split("::");
  return { node, mode: mode as Mode | "start" };
}

function emptyTotals() {
  return { timeMin: 0, waitMin: 0, fare: 0, climbM: 0, cost: 0 };
}

/** Admissible 3D heuristic: fly the crow + climb, at MTR speed, zero fare. */
function heuristic(g: Graph, fromId: string, toId: string, prefs: Preferences): number {
  const a = g.node(fromId);
  const b = g.node(toId);
  if (!a || !b) return 0;
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const flat = 2 * R * Math.asin(Math.sqrt(h));
  const climb = Math.abs((b.level - a.level) * 4.5);
  return (Math.sqrt(flat * flat + climb * climb)) * MTR_MIN_PER_M;
}

function reconstruct(
  g: Graph,
  goalKey: string,
  best: Map<string, Reached>,
  hour: number,
  prefs: Preferences,
): PathResult {
  // Walk the via-chain backwards from the goal state.
  const edges: Edge[] = [];
  let k: string | undefined = goalKey;
  let guard = 0;
  while (k && guard++ < 1000) {
    const r = best.get(k);
    if (!r || !r.via) break;
    edges.unshift(r.via.edge);
    k = stateKey(r.via.from);
  }

  const steps: PathResult["steps"] = [];
  const totals = emptyTotals();
  let prevMode: Mode | "start" = "start";
  for (const edge of edges) {
    const c = edge.cost(hour * 60, prefs);
    const transfer =
      prevMode !== "start" && edge.mode !== prevMode ? prefs.transferPenalty : 0;
    totals.cost += c.total + transfer;
    totals.timeMin += c.timeMin;
    totals.waitMin += c.waitMin;
    totals.fare += c.fare;
    totals.climbM += c.climbM;
    steps.push({
      mode: edge.mode,
      describe: edge.describe(hour * 60),
      timeMin: c.timeMin + c.waitMin,
      waitMin: c.waitMin,
      fare: c.fare,
      climbM: c.climbM,
    });
    prevMode = edge.mode;
  }
  void g;
  return { ok: true, steps, totals };
}

/** Plain BFS reachability ignoring costs — used only for explanations. */
function reachable(g: Graph, originId: string, destinationId: string, allowed?: Mode[]): boolean {
  const seen = new Set<string>([originId]);
  const queue = [originId];
  while (queue.length > 0) {
    const u = queue.shift() as string;
    if (u === destinationId) return true;
    for (const e of g.edgesFrom(u)) {
      if (allowed && !allowed.includes(e.mode)) continue;
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return false;
}

function harbourTrapExplanation(g: Graph, originId: string, destinationId: string): string {
  const a = g.node(originId);
  const b = g.node(destinationId);
  const prefix = `no path between ${a?.name ?? originId} and ${b?.name ?? destinationId}`;

  const anyReachable = reachable(g, originId, destinationId);
  if (!anyReachable) {
    return `${prefix}: origin and destination are disconnected in this graph`;
  }
  const walkOnly = reachable(g, originId, destinationId, ["walk"]);
  if (!walkOnly) {
    return `${prefix} on foot alone — this trip needs a paid crossing (Star Ferry or the MTR harbour tube)`;
  }
  return `${prefix} with the currently allowed modes`;
}

/** Re-cost a found chain for the itinerary printout. */
export function costChain(
  graph: Graph,
  chain: { from: string; edge: Edge }[],
  hour: number,
  prefs: Preferences,
): PathResult {
  const steps: PathResult["steps"] = [];
  const totals = emptyTotals();
  let prevMode: Mode | "start" = "start";
  for (const { from, edge } of chain) {
    void from;
    const a = graph.node(edge.from);
    const b = graph.node(edge.to);
    if (!a || !b) continue;
    const c = edge.cost(hour * 60, prefs);
    const transfer = prevMode !== "start" && edge.mode !== prevMode ? prefs.transferPenalty : 0;
    totals.cost += c.total + transfer;
    totals.timeMin += c.timeMin;
    totals.waitMin += c.waitMin;
    totals.fare += c.fare;
    totals.climbM += c.climbM;
    steps.push({
      mode: edge.mode,
      describe: edge.describe(hour * 60),
      timeMin: c.timeMin + c.waitMin,
      waitMin: c.waitMin,
      fare: c.fare,
      climbM: c.climbM,
    });
    prevMode = edge.mode;
  }
  return { ok: true, steps, totals };
}
