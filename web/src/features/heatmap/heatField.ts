/**
 * Continuous heat field: bilinear interpolation over the physics grid.
 *
 * The backend evaluates the full published-equation physics on a ~150 m grid
 * (viewport query) — that stays the source of truth. Everything that needs a
 * value BETWEEN grid points (route edge costs, route stats, the inspect
 * panel) uses the SAME bilinear interpolation over those grid values, so
 * routing is no longer quantized to cell centres and the numbers a user sees
 * never depend on which cell their point happened to fall in.
 *
 * Why bilinear: with grid spacing h ~150 m the underlying heat field varies
 * smoothly (urban form doesn't jump inside a block), so linear interpolation
 * between evaluated neighbours is already below the field's own accuracy —
 * higher-order schemes would add complexity without real precision.
 */

import type { HeatCell } from '../../api/client';

export interface FieldFrame {
  /** [south, west, north, east] of the cell-centre lattice. */
  south: number;
  west: number;
  north: number;
  east: number;
  rows: number;
  cols: number;
  dLat: number; // lattice spacing (deg)
  dLon: number;
  /** Row-major [rows x cols] heat scores; NaN where no data. */
  values: Float64Array;
  /** Row-major shade (0-1); NaN where no data. Optional: routes blend it in
   *  so block-level shade differences (0.0–0.94 in dense HK) steer the path
   *  even when the composite heat score is nearly flat. */
  shade?: Float64Array;
}

/** Cell id schemes: backend "vp-i-j", offline engine "eng-i-j". */
const CELL_ID_RE = /^(?:vp|eng)-(\d+)-(\d+)$/;

/** Cell centre: the declared field, else the polygon centroid (backend
 *  payloads omit `center`; the polygon mean is its exact definition). */
function centreOf(c: HeatCell): { lat: number; lon: number } | null {
  if (c.center) return c.center;
  const poly = c.polygon;
  if (!poly || poly.length < 3) return null;
  const lat = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  const lon = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  return { lat, lon };
}

/**
 * Build the interpolation frame from the viewport's cells. The lattice is
 * reconstructed from the declared grid indices (i=row, j=col), NOT from
 * rounding centres into buckets — that reconstruction is what keeps the
 * frame aligned when a polygon rounding or float noise shifts a centre.
 */
export function buildFieldFrame(cells: HeatCell[]): FieldFrame | null {
  if (cells.length === 0) return null;

  let maxI = 0;
  let maxJ = 0;
  const parsed: { c: HeatCell; i: number; j: number }[] = [];
  for (const c of cells) {
    const m = CELL_ID_RE.exec(c.cellId);
    if (!m) return null; // unknown id scheme: refuse to guess
    const i = Number(m[1]);
    const j = Number(m[2]);
    if (i > maxI) maxI = i;
    if (j > maxJ) maxJ = j;
    parsed.push({ c, i, j });
  }
  const rows = maxI + 1;
  const cols = maxJ + 1;
  if (rows * cols < parsed.length) return null; // inconsistent ids

  const values = new Float64Array(rows * cols).fill(NaN);
  const shade = new Float64Array(rows * cols).fill(NaN);
  let latSum = 0;
  let lonSum = 0;
  const placed: { i: number; j: number; lat: number; lon: number }[] = [];
  for (const { c, i, j } of parsed) {
    values[i * cols + j] = c.heatScore;
    if (typeof c.shadeScore === 'number') shade[i * cols + j] = c.shadeScore;
    const centre = centreOf(c);
    if (!centre) continue; // no position: value stays, excluded from geometry
    placed.push({ i, j, lat: centre.lat, lon: centre.lon });
    latSum += centre.lat;
    lonSum += centre.lon;
  }
  if (placed.length === 0) return null;

  // Lattice geometry from the average centre (robust to a missing corner).
  const n = placed.length;
  const latMid = latSum / n;
  const latC = Math.cos((latMid * Math.PI) / 180);
  const meanLat = latSum / n;
  const meanLon = lonSum / n;
  const meanI = placed.reduce((s, p) => s + p.i, 0) / n;
  const meanJ = placed.reduce((s, p) => s + p.j, 0) / n;
  const mPerLat = M_PER_DEG_LAT;
  const mPerLon = M_PER_DEG_LAT * latC;
  // Regress dLat/dLon against row/col indices in metres for a stable spacing.
  let numI = 0;
  let denI = 0;
  let numJ = 0;
  let denJ = 0;
  for (const p of placed) {
    numI += (p.i - meanI) * ((p.lat - meanLat) * mPerLat);
    denI += (p.i - meanI) ** 2;
    numJ += (p.j - meanJ) * ((p.lon - meanLon) * mPerLon);
    denJ += (p.j - meanJ) ** 2;
  }
  const hLat = denI > 0 ? numI / denI : 0; // metres per row
  const hLon = denJ > 0 ? numJ / denJ : 0; // metres per col
  if (!(hLat > 0) || !(hLon > 0)) return null;

  // Lattice anchor: the (0,0) centre, reconstructed from the mean.
  const south = meanLat - meanI * (hLat / mPerLat);
  const west = meanLon - meanJ * (hLon / mPerLon);
  const north = south + (rows - 1) * (hLat / mPerLat);
  const east = west + (cols - 1) * (hLon / mPerLon);

  return {
    south,
    west,
    north,
    east,
    rows,
    cols,
    dLat: hLat / mPerLat,
    dLon: hLon / mPerLon,
    values,
    shade,
  };
}

const M_PER_DEG_LAT = 111_320;

/**
 * Bilinear heat at an arbitrary point. Returns null outside the lattice
 * (routes then treat it as neutral, and callers can choose to refuse).
 */
export function interpolateHeat(
  frame: FieldFrame,
  lat: number,
  lon: number,
): number | null {
  // Fractional lattice coordinates.
  const fi = (lat - frame.south) / frame.dLat;
  const fj = (lon - frame.west) / frame.dLon;
  if (fi < -0.5 || fj < -0.5 || fi > frame.rows - 0.5 || fj > frame.cols - 0.5) {
    return null; // outside the lattice (half-cell margin like the polygons)
  }
  const i0 = Math.max(0, Math.min(frame.rows - 1, Math.floor(fi)));
  const j0 = Math.max(0, Math.min(frame.cols - 1, Math.floor(fj)));
  const i1 = Math.min(frame.rows - 1, i0 + 1);
  const j1 = Math.min(frame.cols - 1, j0 + 1);
  const ti = fi - i0;
  const tj = fj - j0;

  const v00 = frame.values[i0 * frame.cols + j0];
  const v01 = frame.values[i0 * frame.cols + j1];
  const v10 = frame.values[i1 * frame.cols + j0];
  const v11 = frame.values[i1 * frame.cols + j1];

  const anyNaN = Number.isNaN(v00) || Number.isNaN(v01) || Number.isNaN(v10) || Number.isNaN(v11);
  if (anyNaN) {
    // Inside the lattice but a corner lacks data: nearest evaluated value.
    const cands = [v00, v01, v10, v11].filter((v) => !Number.isNaN(v));
    if (cands.length === 0) return null;
    return cands[0];
  }

  const top = v00 + (v01 - v00) * tj;
  const bottom = v10 + (v11 - v10) * tj;
  return top + (bottom - top) * ti;
}

/**
 * Sampler for the routers: bilinear inside the lattice, extended by clamping
 * across the half-cell rim (the area the edge cells' polygons actually
 * cover, so a street just past the last grid row still gets the edge value),
 * and null beyond — no invented data far from the field.
 */
/**
 * Continuous heat sampler. When the frame carries shade data, the returned
 * value is a ROUTING-EXPLOSURE blend: composite heat score plus a shade
 * penalty that survives inside dense districts (where the 0-100 composite
 * is nearly flat but shade varies 0.0-0.94 block to block). K = 10 points
 * of full-shade loss ≈ one pace-band step, enough to steer a route to the
 * shaded side of a street without inventing imaginary temperature.
 */
const SHADE_WEIGHT = 10;

export function makeContinuousSampler(
  frame: FieldFrame,
): (lat: number, lon: number) => number | null {
  return sampleFrame(frame, false);
}

/**
 * Pure-shade sampler (0-1) for stats like "62% of this route is shaded".
 * Returns null where there is no shade data.
 */
export function makeShadeSampler(
  frame: FieldFrame,
): (lat: number, lon: number) => number | null {
  if (frame.shade === undefined) return () => null;
  return sampleFrame(frame, true);
}

function sampleFrame(
  frame: FieldFrame,
  shadeOnly: boolean,
): (lat: number, lon: number) => number | null {
  const hasShade = frame.shade !== undefined;
  return (lat, lon) => {
    const fiRaw = (lat - frame.south) / frame.dLat;
    const fjRaw = (lon - frame.west) / frame.dLon;
    const RIM = 0.5; // half a cell, matching the polygons' extent
    if (
      fiRaw < -RIM ||
      fjRaw < -RIM ||
      fiRaw > frame.rows - 1 + RIM ||
      fjRaw > frame.cols - 1 + RIM
    ) {
      return null;
    }
    // Clamp into the lattice and run standard bilinear on clamped coords.
    const fi = Math.max(0, Math.min(frame.rows - 1, fiRaw));
    const fj = Math.max(0, Math.min(frame.cols - 1, fjRaw));
    const i0 = Math.min(frame.rows - 2, Math.floor(fi));
    const j0 = Math.min(frame.cols - 2, Math.floor(fj));
    const i1 = i0 + 1;
    const j1 = j0 + 1;
    const ti = fi - i0;
    const tj = fj - j0;

    const v00 = frame.values[i0 * frame.cols + j0];
    const v01 = frame.values[i0 * frame.cols + j1];
    const v10 = frame.values[i1 * frame.cols + j0];
    const v11 = frame.values[i1 * frame.cols + j1];

    if (shadeOnly) {
      const t00 = (frame.shade as Float64Array)[i0 * frame.cols + j0];
      const t01 = (frame.shade as Float64Array)[i0 * frame.cols + j1];
      const t10 = (frame.shade as Float64Array)[i1 * frame.cols + j0];
      const t11 = (frame.shade as Float64Array)[i1 * frame.cols + j1];
      if (Number.isNaN(t00) || Number.isNaN(t01) || Number.isNaN(t10) || Number.isNaN(t11)) {
        return null;
      }
      const tTop = t00 + (t01 - t00) * tj;
      const tBottom = t10 + (t11 - t10) * tj;
      return tTop + (tBottom - tTop) * ti;
    }

    const anyNaN =
      Number.isNaN(v00) || Number.isNaN(v01) || Number.isNaN(v10) || Number.isNaN(v11);
    if (anyNaN) {
      const cands = [v00, v01, v10, v11].filter((v) => !Number.isNaN(v));
      return cands.length > 0 ? cands[0] : null;
    }
    const top = v00 + (v01 - v00) * tj;
    const bottom = v10 + (v11 - v10) * tj;
    const heat = top + (bottom - top) * ti;
    if (!hasShade) return heat;

    const s00 = (frame.shade as Float64Array)[i0 * frame.cols + j0];
    const s01 = (frame.shade as Float64Array)[i0 * frame.cols + j1];
    const s10 = (frame.shade as Float64Array)[i1 * frame.cols + j0];
    const s11 = (frame.shade as Float64Array)[i1 * frame.cols + j1];
    if (Number.isNaN(s00) || Number.isNaN(s01) || Number.isNaN(s10) || Number.isNaN(s11)) {
      return heat; // shade data missing here: heat only
    }
    const sTop = s00 + (s01 - s00) * tj;
    const sBottom = s10 + (s11 - s10) * tj;
    const shade = sTop + (sBottom - sTop) * ti;
    return heat + SHADE_WEIGHT * (1 - shade);
  };
}
