/**
 * routing3d/tdas — client for the HK Transport Department's Traffic Data
 * Analytics System route API (data.gov.hk, TD_TDAS_API_Specifications v1.1).
 *
 * POST https://tdas-api.hkemobility.gov.hk/tdas/api/route
 *   { start:{lat,long}, end:{lat,long}, departIn, lang, type, tunnel }
 * → { jSpeed, distM, distU, eta, cht|wht|eht, ar[], route[{start,end,segment[]}] }
 *
 * IMPORTANT semantics: this is TD's DRIVING network (Intelligent Road
 * Network). Segments carry `dir` (turn codes) and `rid` (IRN centreline ids),
 * not raw geometry — drawing requires the IRN centreline dataset. Average
 * journey speeds (~30-60 km/h in practice) confirm it models cars. We expose
 * it as a first-class provider so the engine can (a) benchmark a walking
 * plan against official driving reality and (b) later fetch real traffic
 * speeds for roads that walking routes must cross. Error messages come back
 * in Chinese (e.g. no street within 75 m of a coordinate) — decoded here.
 */

export interface TdasPoint {
  lat: number;
  long: number;
}

export interface TdasRouteRequest {
  start: TdasPoint;
  end: TdasPoint;
  /** Depart this many minutes from now (0 = now). */
  departIn?: number;
  lang?: "en" | "tc" | "sc";
  /** ST = shortest time, SD = shortest distance (spec §1.1). */
  type?: "ST" | "SD";
  /** Preferred harbour crossing: cht | wht | eht. */
  tunnel?: "cht" | "wht" | "eht";
}

export interface TdasSegment {
  /** Turn direction code [0..4]: 0=turn to, 1=keep/turn left, 2=keep right… */
  dir: number;
  /** IRN centreline Route_ID(s) this segment runs along. */
  rid: number[];
}

export interface TdasRoutePart {
  start: { intersect: number[]; rid: number };
  end: { intersect: number[]; rid: number };
  segment: TdasSegment[];
}

export interface TdasRouteResponse {
  /** Overall average journey speed, km/h. */
  jSpeed: string | number;
  distM: number;
  distU: string;
  /** "hh:mm" estimated journey time. */
  eta: string;
  cht: boolean;
  wht: boolean;
  eht: boolean;
  /** Alternate harbour crossings, when crossing the harbour. */
  ar: { name: string; distU: string; eta: string }[];
  route: TdasRoutePart[];
}

const ENDPOINT = "https://tdas-api.hkemobility.gov.hk/tdas/api/route";

/** Decode the service's Chinese error strings into actionable messages. */
export function decodeTdasError(message: string): string {
  if (message.includes("75米")) {
    return "no drivable street within 75 m of a coordinate — snap your point to a road first";
  }
  if (message.includes("錯誤") || message.includes("error")) {
    return `TDAS rejected the request: ${message}`;
  }
  return message;
}

export async function fetchTdasRoute(
  req: TdasRouteRequest,
  timeoutMs = 15_000,
): Promise<TdasRouteResponse> {
  const body = {
    start: { lat: req.start.lat, long: req.start.long },
    end: { lat: req.end.lat, long: req.end.long },
    departIn: req.departIn ?? 0,
    lang: req.lang ?? "en",
    type: req.type ?? "ST",
    tunnel: req.tunnel ?? "wht",
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`TDAS returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const msg =
        (json as { Message?: string }).Message ?? `HTTP ${res.status}`;
      throw new Error(decodeTdasError(msg));
    }
    return json as TdasRouteResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse "hh:mm" → minutes. */
export function etaToMinutes(eta: string): number {
  const [h, m] = eta.split(":").map(Number);
  return h * 60 + (m || 0);
}
