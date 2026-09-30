/**
 * routing3d/mockNetwork — localized mock dataset: Central ↔ Tsim Sha Tsui.
 *
 * Coordinates are approximate real anchor points; levels encode HK's
 * verticality. Swap this factory for an osmnx/OSM loader later — the engine
 * only talks to `Graph`, so the algorithm code never changes.
 */

import { Graph, type EdgeSpec, type Node3D } from "./graph.ts";

export function buildCentralTstNetwork(): Graph {
  const g = new Graph();

  const N = (n: Node3D) => g.addNode(n);
  const E = (e: EdgeSpec) => g.addEdge(e);

  // ------------------------------------------------------------------ nodes
  N({ id: "central-mtr", name: "Central MTR Station", level: -2, lat: 22.2819, lon: 114.1586 });
  N({ id: "central-elevated", name: "Central Elevated Walkway (IFC link)", level: 2, lat: 22.2831, lon: 114.1591 });
  N({ id: "ifc-roof", name: "IFC Mall Podium", level: 2, lat: 22.2849, lon: 114.1584 });
  N({ id: "escalator-base", name: "Mid-Levels Escalator Base (Central)", level: 1, lat: 22.2828, lon: 114.1551 });
  N({ id: "escalator-top", name: "Mid-Levels (Robinson Rd)", level: 30, lat: 22.2798, lon: 114.1507 });
  N({ id: "central-pier", name: "Star Ferry Pier Central", level: 0, lat: 22.2938, lon: 114.1692 });
  N({ id: "tst-pier", name: "Star Ferry Pier Tsim Sha Tsui", level: 0, lat: 22.2936, lon: 114.1718 });
  N({ id: "tst-mtr", name: "Tsim Sha Tsui MTR Station", level: -2, lat: 22.2988, lon: 114.1722 });
  N({ id: "admiralty-mtr", name: "Admiralty MTR (interchange)", level: -2, lat: 22.2804, lon: 114.1651 });

  // ------------------------------------------------------- walking / podium
  // Street-level shortcuts around Central.
  E({ from: "central-mtr", to: "central-pier", mode: "walk", name: "Pedder St → pier", distanceM: 620 });
  E({ from: "central-pier", to: "central-mtr", mode: "walk", name: "pier → Pedder St", distanceM: 620 });
  E({ from: "central-mtr", to: "central-elevated", mode: "walk", name: "escalator hall up to podium", distanceM: 90 });
  E({ from: "central-elevated", to: "ifc-roof", mode: "walk", name: "IFC Mall Walkway", distanceM: 210 });
  E({ from: "ifc-roof", to: "central-elevated", mode: "walk", name: "IFC Mall Walkway (back)", distanceM: 210 });
  E({ from: "central-elevated", to: "central-mtr", mode: "walk", name: "podium down to concourse", distanceM: 90 });

  // Mid-Levels Escalator: downhill 06:00–10:00, uphill 10:00–00:00 (real schedule).
  E({
    from: "escalator-base",
    to: "escalator-top",
    mode: "escalator",
    name: "Mid-Levels Escalator",
    distanceM: 800,
    escalator: { fromMin: 600, toMin: 1440, direction: "up" },
  });
  E({
    from: "escalator-top",
    to: "escalator-base",
    mode: "escalator",
    name: "Mid-Levels Escalator",
    distanceM: 800,
    escalator: { fromMin: 360, toMin: 600, direction: "down" },
  });
  // Stairs alternative that exists 24/7 next to it.
  E({ from: "escalator-base", to: "escalator-top", mode: "walk", name: "ladder st (stairs)", distanceM: 760 });
  E({ from: "escalator-top", to: "escalator-base", mode: "walk", name: "ladder st (down)", distanceM: 760 });
  E({ from: "central-mtr", to: "escalator-base", mode: "walk", name: "Queen's Rd to escalator base", distanceM: 340 });
  E({ from: "escalator-base", to: "central-mtr", mode: "walk", name: "Queen's Rd back", distanceM: 340 });

  // -------------------------------------------------------------------- MTR
  E({ from: "central-mtr", to: "tst-mtr", mode: "mtr", name: "Tsuen Wan line (via TST)", fare: 12.6, durationMin: 6 });
  E({ from: "tst-mtr", to: "central-mtr", mode: "mtr", name: "Tsuen Wan line (back)", fare: 12.6, durationMin: 6 });
  E({ from: "central-mtr", to: "admiralty-mtr", mode: "mtr", name: "Island line, 1 stop", fare: 5.1, durationMin: 2 });
  E({ from: "admiralty-mtr", to: "central-mtr", mode: "mtr", name: "Island line back, 1 stop", fare: 5.1, durationMin: 2 });
  E({ from: "admiralty-mtr", to: "tst-mtr", mode: "mtr", name: "Tsuen Wan line, 3 stops", fare: 11.5, durationMin: 7 });
  E({ from: "tst-mtr", to: "admiralty-mtr", mode: "mtr", name: "Tsuen Wan line back", fare: 11.5, durationMin: 7 });

  // ------------------------------------------------------------- Star Ferry
  const star = [0, 10, 20, 30, 40, 50]; // every 10 minutes
  E({
    from: "central-pier",
    to: "tst-pier",
    mode: "ferry",
    name: "Star Ferry",
    fare: 5,
    durationMin: 9,
    ferrySchedule: star,
    relaxation: 0.9,
  });
  E({
    from: "tst-pier",
    to: "central-pier",
    mode: "ferry",
    name: "Star Ferry",
    fare: 5,
    durationMin: 9,
    ferrySchedule: star,
    relaxation: 0.9,
  });

  // Pier ↔ TST streets.
  E({ from: "tst-pier", to: "tst-mtr", mode: "walk", name: "Salisbury Rd to TST MTR", distanceM: 450 });
  E({ from: "tst-mtr", to: "tst-pier", mode: "walk", name: "TST MTR to pier", distanceM: 450 });

  // The trap: NO walking edge crosses the harbour. Any plan that tries will
  // be forced through the ferry (or the MTR's harbour tube).

  return g;
}
