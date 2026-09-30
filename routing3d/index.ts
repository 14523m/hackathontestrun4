/**
 * routing3d — public API.
 *
 *   import { buildCentralTstNetwork } from "./mockNetwork.ts";
 *   import { findHkPath, formatItinerary } from "./index.ts";
 *
 *   const plan = findHkPath(buildCentralTstNetwork(), "central-mtr", "tst-pier", 14.5);
 *   console.log(formatItinerary(plan));
 */

import { DEFAULT_PREFERENCES, type Graph, type Preferences } from "./graph.ts";
import { findHkPath, type PathResult } from "./router.ts";
import { etaToMinutes, fetchTdasRoute } from "./tdas.ts";

export interface FindOptions {
  /** Hour of day (0–24, fractional ok). Drives escalator direction & ferry waits. */
  timeOfDay: number;
  preferences?: Preferences;
  /** Also ask the TD API for the official driving route as a benchmark. */
  compareDriving?: boolean;
}

/**
 * find_hk_path(origin, destination, time_of_day, preferences) — the task's
 * entry point. Node ids refer to the graph you pass in (see mockNetwork.ts
 * for the demo ids, or supply your own Graph).
 */
export async function find_hk_path(
  graph: Graph,
  origin: string,
  destination: string,
  time_of_day: number,
  preferences: Preferences = DEFAULT_PREFERENCES,
  options?: { compareDriving?: boolean },
): Promise<PathResult & { driving?: { eta: string; distU: string; speedKmh: string } }> {
  const plan = findHkPath(graph, origin, destination, time_of_day, preferences);

  if (options?.compareDriving && plan.ok) {
    const a = graph.node(origin);
    const b = graph.node(destination);
    if (a && b) {
      try {
        const r = await fetchTdasRoute({
          start: { lat: a.lat, long: a.lon },
          end: { lat: b.lat, long: b.lon },
          lang: "en",
          type: "ST",
        });
        plan.driving = { eta: r.eta, distU: r.distU, speedKmh: String(r.jSpeed).replace(/\s*km\/h/i, "") };
      } catch (e) {
        plan.driving = undefined;
        console.warn(`[routing3d] TDAS benchmark unavailable: ${(e as Error).message}`);
      }
    }
  }
  return plan;
}

const MODE_ICON: Record<string, string> = {
  walk: "🚶",
  escalator: "🧗",
  mtr: "🚇",
  ferry: "⛴️",
};

/** Clean, readable text itinerary. */
export function formatItinerary(plan: PathResult): string {
  if (!plan.ok) {
    return `No route: ${plan.reason}`;
  }
  const lines: string[] = [];
  let leg = 1;
  let prevMode = "";
  for (const s of plan.steps) {
    const icon = MODE_ICON[s.mode] ?? "•";
    const wait = s.waitMin > 0 ? ` (wait ${Math.round(s.waitMin)} min)` : "";
    const climb =
      s.climbM > 5 ? ` ↑${Math.round(s.climbM)} m` : s.climbM < -5 ? ` ↓${Math.round(-s.climbM)} m` : "";
    const transfer = prevMode && s.mode !== prevMode ? "  [transfer]" : "";
    lines.push(
      `${String(leg).padStart(2)}. ${icon} ${s.describe}${wait}${climb} — ${Math.round(s.timeMin)} min${transfer}`,
    );
    leg++;
    prevMode = s.mode;
  }
  const t = plan.totals;
  const fare = t.fare > 0 ? ` | fare HKD ${t.fare.toFixed(1)}` : "";
  const climb = t.climbM > 5 ? ` | climb ${Math.round(t.climbM)} m` : "";
  lines.push(
    `    TOTAL: ${Math.round(t.timeMin)} min walking/riding + ${Math.round(t.waitMin)} min waiting${fare}${climb}`,
  );
  return lines.join("\n");
}

export { DEFAULT_PREFERENCES } from "./graph.ts";
export { findHkPath } from "./router.ts";
export { etaToMinutes, fetchTdasRoute } from "./tdas.ts";
export type { PathResult } from "./router.ts";
export type { Graph, Node3D, EdgeSpec, Mode, Preferences } from "./graph.ts";
