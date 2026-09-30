/**
 * Territory thermal raster — the whole-of-Hong-Kong heat layer.
 *
 * A precomputed 75 m lattice (backend/app/tools/generate_thermal_grid.py,
 * same published physics as the live endpoints, sea masked out) is rendered
 * as filled squares — every location specific, in the style of the classic
 * HK "Thermal Load" raster. Colors are RELATIVE (percentile-scaled within
 * the territory, like the reference legend: green rural → yellow suburban →
 * red dense urban cores), because the absolute modelled range is narrow; the
 * legend states this explicitly so nobody reads 0–100 absolute degrees.
 */

export interface TerritoryGrid {
  cellM: number;
  south: number;
  west: number;
  rows: number;
  cols: number;
  hour: number;
  generatedAt: string;
  values: (number | null)[][];
}

/** Same perceptual anchors as the reference legend. */
function thermalLoadColor(t: number): [number, number, number] {
  // t in [0,1]: 0 = coolest (green), 0.5 = mid (yellow), 1 = hottest (red)
  const stops: [number, [number, number, number]][] = [
    [0.0, [26, 122, 66]], // deep green (rural/woodland)
    [0.35, [142, 189, 84]], // light green
    [0.55, [247, 231, 116]], // pale yellow (suburban)
    [0.75, [244, 156, 62]], // orange (urban)
    [1.0, [215, 48, 39]], // red (dense core hotspot)
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/** Percentile thresholds so the palette uses the full visual range. */
export function buildTerritoryFeatures(grid: TerritoryGrid): GeoJSON.FeatureCollection {
  const flat: number[] = [];
  for (const row of grid.values) {
    for (const v of row) if (v !== null) flat.push(v);
  }
  if (flat.length === 0) return { type: 'FeatureCollection', features: [] };
  flat.sort((a, b) => a - b);
  const pct = (p: number) => flat[Math.min(flat.length - 1, Math.floor(p * flat.length))];
  const lo = pct(0.02);
  const hi = pct(0.98);

  const dLat = grid.cellM / 111_320;
  const cosLat = Math.cos(((grid.south + grid.rows * dLat) / 2 * Math.PI) / 180);
  const dLon = grid.cellM / (111_320 * cosLat);
  const halfLat = dLat / 2;
  const halfLon = dLon / 2;

  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < grid.rows; i++) {
    const row = grid.values[i];
    const lat = grid.south + i * dLat;
    for (let j = 0; j < grid.cols; j++) {
      const v = row[j];
      if (v === null) continue;
      const lon = grid.west + j * dLon;
      const t = Math.max(0, Math.min(1, (v - lo) / Math.max(1e-9, hi - lo)));
      const [r, g, b] = thermalLoadColor(t);
      features.push({
        type: 'Feature',
        id: `tl-${i}-${j}`,
        properties: {
          heatScore: v,
          // Palette position 0-100, for the legend and tooltips.
          thermalPct: Math.round(t * 100),
          color: `rgb(${r},${g},${b})`,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [lon - halfLon, lat - halfLat],
            [lon + halfLon, lat - halfLat],
            [lon + halfLon, lat + halfLat],
            [lon - halfLon, lat + halfLat],
          ]],
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Legend entries matching buildTerritoryFeatures' palette. */
export function thermalLoadLegend(): { label: string; color: string }[] {
  const labels = ['Lowest', '', '', '', 'Highest'];
  return [0, 0.25, 0.5, 0.75, 1].map((t, i) => {
    const [r, g, b] = thermalLoadColor(t);
    return { label: labels[i], color: `rgb(${r},${g},${b})` };
  });
}
