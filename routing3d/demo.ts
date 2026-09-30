/**
 * routing3d/demo — working prototype, step by step.
 * Run:  node --experimental-strip-types routing3d/demo.ts   (Node ≥22)
 *   or: npx tsx routing3d/demo.ts
 */

import { buildCentralTstNetwork } from "./mockNetwork.ts";
import { find_hk_path, formatItinerary } from "./index.ts";

async function main() {
  console.log("== HK multi-modal 3D routing — prototype ==\n");

  // 1) Uphill INTO Mid-Levels at 14:30 with a fatigue-averse user: the
  //    escalator (up 10:00–00:00) should beat the stairs.
  console.log("— 14:30, Central MTR → Mid-Levels, hates climbing —");
  const p1 = await find_hk_path(buildCentralTstNetwork(), "central-mtr", "escalator-top", 14.5, {
    walletWeight: 0.5,
    fatigueWeight: 0.5,
    transferPenalty: 4,
    relaxation: 0.3,
  });
  console.log(formatItinerary(p1));
  console.log();

  // 2) Afternoon downhill the other way: escalator is stairs when reversing,
  //    so the engine may pick the MTR route to TST instead.
  console.log("— 14:30, Mid-Levels → Star Ferry Pier TST (with TDAS driving benchmark) —");
  const p2 = await find_hk_path(buildCentralTstNetwork(), "escalator-top", "tst-mtr", 14.5, undefined, {
    compareDriving: true,
  });
  console.log(formatItinerary(p2));
  if (p2.driving) {
    console.log(
      `    [TDAS driving benchmark: ETA ${p2.driving.eta}, ${p2.driving.distU} @ ${p2.driving.speedKmh} km/h avg]`,
    );
  }
  console.log();

  // 3) Morning rush: escalator runs DOWNHILL 06:00–10:00 — the descent is a
  //    free ride before 10:00.
  console.log("— 08:00, Mid-Levels → TST MTR (escalator downhill window) —");
  const p3 = await find_hk_path(buildCentralTstNetwork(), "escalator-top", "tst-mtr", 8);
  console.log(formatItinerary(p3));
  console.log();

  // 4) The harbour trap, for real: walking-only user tries to cross Victoria
  //    Harbour. There is NO walking edge over the water — the engine must
  //    refuse with the explanation, not invent a path.
  console.log("— Harbour trap: Central IFC → TST pier, WALKING ONLY —");
  const p4 = await find_hk_path(buildCentralTstNetwork(), "ifc-roof", "tst-pier", 14.5, {
    walletWeight: 0.5,
    fatigueWeight: 0.08,
    transferPenalty: 4,
    relaxation: 0.3,
    allowedModes: ["walk"],
  });
  console.log(formatItinerary(p4));
  console.log();

  // 5) Same crossing with all modes: MTR vs ferry compete; ferry wins on
  //    relaxation when the user is in no hurry.
  console.log("— Same crossing, all modes —");
  const p5 = await find_hk_path(buildCentralTstNetwork(), "ifc-roof", "tst-pier", 14.5);
  console.log(formatItinerary(p5));
}

void main();
