/**
 * routing3d/graph — domain model for multi-modal, level-aware HK routing.
 *
 * The city is a directed weighted graph. Nodes carry an elevation LEVEL in
 * storeys relative to street (MTR concourse = -2, IFC walkway = +2, street =
 * 0), and edges are transit legs of a specific MODE. Edge cost is the task's
 * composite:
 *
 *     cost = time(min) + fare($) * W_WALLET + elevation_gain(m) * W_FATIGUE
 *
 * with additional per-transfer penalties when the mode changes. Everything is
 * directed: an escalator is one-way at a given time of day; an MTR ride from
 * Central to TST does not imply the reverse (different platform level etc.).
 */

/** Metres per storey used consistently across the demo. */
export const M_PER_LEVEL = 4.5;

/** Transit modes with their physics/economics. */
export type Mode = 'walk' | 'escalator' | 'mtr' | 'ferry';

/** User preferences that tune the cost function (defaults: balanced). */
export interface Preferences {
  /** $ per cost-unit — higher means fares hurt more. */
  walletWeight: number;
  /** metres of elevation gain per cost-unit — higher means hills hurt more. */
  fatigueWeight: number;
  /** extra cost units per mode transfer (waiting, finding the platform). */
  transferPenalty: number;
  /** 0..1 — for ferries, how much the "scenic relaxation" bonus discounts time. */
  relaxation: number;
  /** If set, ONLY these modes may be used (e.g. walking-only accessibility). */
  allowedModes?: Mode[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  walletWeight: 0.5,
  fatigueWeight: 0.08,
  transferPenalty: 4,
  relaxation: 0.3,
};

export interface Node3D {
  id: string;
  name: string;
  /** Storeys relative to street: -2 = underground concourse, +2 = podium. */
  level: number;
  lat: number;
  lon: number;
}

/** Static properties of an edge (time/fare computed per traversal). */
export interface EdgeSpec {
  from: string;
  to: string;
  mode: Mode;
  name?: string;
  /** Walk/escalator legs: geographic length in metres. */
  distanceM?: number;
  /** Escalators move at ~0.5 m/s and reverse on a schedule. */
  escalator?: { /** minutes past midnight when it runs `direction`. */
    fromMin: number;
    toMin: number;
    direction: 'up' | 'down';
  };
  /** MTR/ferry: fixed fare in HKD and line name. */
  fare?: number;
  /** Ferry: scheduled departures (minutes past midnight) from `from`. */
  ferrySchedule?: number[];
  /** Ferry/fixed-speed legs: crossing duration in minutes. */
  durationMin?: number;
  /** Relaxation score 0..1 (ferries high, MTR low). */
  relaxation?: number;
}

export interface Edge extends EdgeSpec {
  /** Cost-minutes at the given time of day (escalator direction applied). */
  cost(timeMin: number, prefs: Preferences): EdgeCost;
  /** Human-readable description of the traversal. */
  describe(timeMin: number): string;
}

export interface EdgeCost {
  /** Total composite cost units. */
  total: number;
  /** Minutes in motion (waiting for ferries is reported separately). */
  timeMin: number;
  /** Wait minutes (ferry headway). */
  waitMin: number;
  fare: number;
  /** Net elevation gain in metres (positive = climbing). */
  climbM: number;
}

/** 3D great-circle distance including the level difference. */
export function distance3dM(a: Node3D, b: Node3D): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const flat = 2 * R * Math.asin(Math.sqrt(h));
  const climb = (b.level - a.level) * M_PER_LEVEL;
  return Math.sqrt(flat * flat + climb * climb);
}

/** Level difference in metres (positive = climbing from a to b). */
export function climbM(a: Node3D, b: Node3D): number {
  return (b.level - a.level) * M_PER_LEVEL;
}

/** Slope-modulated walking time (Tobler-inspired, clipped to sane speeds). */
export function walkTimeMin(distanceM: number, climbMeters: number): number {
  // Base 4.5 km/h; grade (rise/run) slows uphill dramatically, speeds
  // downhill slightly. Downhill *costs* less time but the fatigue term in
  // the cost function still punishes knee-busting descents via climbM<0
  // being free — only positive gain is penalised.
  const grade = distanceM > 0 ? climbMeters / distanceM : 0;
  const speedKmh = 4.5 * Math.exp(-2.5 * Math.abs(Math.max(0, grade)) ) * (grade < 0 ? 1.15 : 1);
  return distanceM / 1000 / Math.max(1.2, speedKmh) * 60;
}

export class Graph {
  readonly nodes = new Map<string, Node3D>();
  private readonly adj = new Map<string, Edge[]>();

  addNode(n: Node3D): this {
    this.nodes.set(n.id, n);
    return this;
  }

  addEdge(e: EdgeSpec): this {
    const edge = makeEdge(e, this);
    const list = this.adj.get(e.from) ?? [];
    list.push(edge);
    this.adj.set(e.from, list);
    return this;
  }

  edgesFrom(id: string): Edge[] {
    return this.adj.get(id) ?? [];
  }

  node(id: string): Node3D | undefined {
    return this.nodes.get(id);
  }
}

function makeEdge(spec: EdgeSpec, g: Graph): Edge {
  const from = () => g.node(spec.from);
  const to = () => g.node(spec.to);

  function cost(timeMin: number, prefs: Preferences): EdgeCost {
    const a = from();
    const b = to();
    if (!a || !b) throw new Error(`edge ${spec.from}->${spec.to}: missing node`);
    const climb = climbM(a, b);
    const mod = minutesOfDay(timeMin);

    if (spec.mode === 'walk') {
      const d = spec.distanceM ?? distance3dM(a, b);
      const t = walkTimeMin(d, climb);
      return { total: t + climb * prefs.fatigueWeight, timeMin: t, waitMin: 0, fare: 0, climbM: climb };
    }

    if (spec.mode === 'escalator') {
      const esc = spec.escalator;
      const d = spec.distanceM ?? distance3dM(a, b);
      const active = esc ? withinWindow(mod, esc.fromMin, esc.toMin) : true;
      if (!active) {
        // Outside its window the escalator is stairs: slow, and it hurts.
        const t = walkTimeMin(d, climb) * 2.2;
        return {
          total: t + climb * prefs.fatigueWeight * 1.6,
          timeMin: t,
          waitMin: 0,
          fare: 0,
          climbM: climb,
        };
      }
      // Riding: 0.5 m/s regardless of direction; NO fatigue when it carries
      // the climber (that is the entire point of the machine).
      const t = d / 0.5 / 60;
      const gain = climb > 0 && esc?.direction === 'up' ? 0 : climb;
      return { total: t + Math.max(0, gain) * prefs.fatigueWeight, timeMin: t, waitMin: 0, fare: 0, climbM: climb };
    }

    if (spec.mode === 'mtr') {
      const t = spec.durationMin ?? distance3dM(a, b) / 9000 * 60; // ~540 km/h door-to-door is silly; use 30 km/h effective
      const fare = spec.fare ?? 0;
      return { total: t + fare * prefs.walletWeight, timeMin: t, waitMin: 0, fare, climbM: climb };
    }

    // ferry: wait for the next scheduled departure.
    const sched = spec.ferrySchedule ?? [];
    const wait = nextDepartureIn(sched, mod);
    const t = spec.durationMin ?? 10;
    const relax = spec.relaxation ?? 0.5;
    const discounted = t * (1 - prefs.relaxation * relax);
    const fare = spec.fare ?? 0;
    return {
      total: wait + discounted + fare * prefs.walletWeight,
      timeMin: t,
      waitMin: wait,
      fare,
      climbM: climb,
    };
  }

  function describe(timeMin: number): string {
    const a = from();
    const b = to();
    const mod = minutesOfDay(timeMin);
    switch (spec.mode) {
      case 'walk':
        return `Walk ${spec.name ?? ''} to ${b?.name} (~${Math.round(spec.distanceM ?? distance3dM(a!, b!))} m)`.trim();
      case 'escalator': {
        const esc = spec.escalator!;
        const dir = withinWindow(mod, esc.fromMin, esc.toMin) ? esc.direction : 'stairs';
        return dir === 'stairs'
          ? `Climb the stairs at ${spec.name ?? 'the escalator'} (escalator is reversed right now)`
          : `Ride the ${spec.name ?? ''} escalator ${dir === 'up' ? 'up' : 'down'} to ${b?.name}`.trim();
      }
      case 'mtr':
        return `Take the ${spec.name ?? 'MTR'} to ${b?.name} (HKD ${spec.fare ?? 0})`;
      case 'ferry':
        return `Catch the ${spec.name ?? 'Star Ferry'} from ${a?.name} (departs in ~${Math.round(nextDepartureIn(spec.ferrySchedule ?? [], mod))} min, HKD ${spec.fare ?? 0})`;
    }
  }

  return { ...spec, cost, describe };
}

/** Normalise minutes-since-midnight into [0, 1440). */
export function minutesOfDay(timeMin: number): number {
  return Math.round(((timeMin % 1440) + 1440) % 1440);
}

/** [from, to) window; wraps past midnight when from > to. */
function withinWindow(mod: number, fromMin: number, toMin: number): boolean {
  return fromMin < toMin ? mod >= fromMin && mod < toMin : mod >= fromMin || mod < toMin;
}

/** Wait for the next departure; the schedule repeats every hour. */
function nextDepartureIn(sched: number[], mod: number): number {
  if (sched.length === 0) return 0;
  const moh = ((mod % 60) + 60) % 60;
  const next = sched.find((m) => m >= moh) ?? sched[0] + 60;
  return next - moh;
}
