/**
 * Offline in-browser heat engine.
 *
 * The SAME published equations as the backend (app/engines/heat/thermal.py,
 * app/engines/heat/shade.py, app/engines/heat/anywhere.py) ported to
 * TypeScript and evaluated over the generated city skeleton (all 19
 * districts). When the FastAPI server is reachable the live API answers
 * first; this engine keeps the free-pan map specific across ALL of Hong
 * Kong with no server at all — every cell is a real physics evaluation,
 * never an interpolation or a placeholder.
 *
 * Sources (identical to the backend module docstrings):
 *   - Solar position: NOAA low-precision approximation.
 *   - Vapour pressure: Magnus-Tetens (Alduchov & Eskridge 1996).
 *   - Wet-bulb: Stull (2011) Eq. 1.  WBGT shade: Australian BoM form.
 *   - Apparent temperature: Steadman (1984); in-sun variant: BoM.
 *   - Clear-sky beam: Hottel (1976); diffuse split: Erbs et al. (1982);
 *     capped at the observed HK clear-sky regime (GHI 1040, DNI 900 W/m2).
 *   - Sky long-wave: Brutsaert (1975).
 *   - Mean radiant temperature: Thorsson et al. (2007) six-direction form.
 *   - Sky-view factor: Steyn (1980) ring-meridian method.
 */

import { CITY_SKELETON, type SkeletonDistrict } from './skeleton';

const SIGMA = 5.670374419e-8;
const SOLAR_CONSTANT = 1361.0;
const GHI_CLEAR_SKY_CAP = 1040.0;
const DNI_CLEAR_SKY_CAP = 900.0;
const BODY_ABSORPTIVITY = 0.7;
const BODY_EMISSIVITY = 0.97;
const F_UP = 0.06;
const F_DOWN = 0.06;
const F_LAT_TOTAL = 4 * 0.22;
const SKIN_TEMP_C = 35.0;
const GROUND_ALBEDO = 0.2;
const URBAN_SURFACE_DELTA_T = 2.0;

const M_PER_DEG_LAT = 111_320.0;
const MAX_SHADOW_M = 180.0;
const SVF_RADIUS_M = 100.0;
const SVF_RINGS = 10;
const SVF_MERIDIANS = 8;
const WIND_CANYON_FACTOR = 0.5;
const CELL_M = 60.0;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** HK bounding region (app/core/geo.py HK_BOUNDS) — the engine only
 *  evaluates inside it; map views are clamped here for performance. */
const HK_CLIP = { south: 21.9, west: 113.75, north: 22.65, east: 114.5 };

/** Clamp a viewport to the HK bounding region (clipping non-HK sea/land is
 *  free performance — the physics and skeleton data only exist for HK). */
export function clipToBounds(b: {
  south: number;
  west: number;
  north: number;
  east: number;
}): { south: number; west: number; north: number; east: number } {
  const south = Math.max(Math.min(b.south, b.north), HK_CLIP.south);
  const north = Math.min(Math.max(b.south, b.north), HK_CLIP.north);
  const west = Math.max(Math.min(b.west, b.east), HK_CLIP.west);
  const east = Math.min(Math.max(b.west, b.east), HK_CLIP.east);
  return { south, west, north, east };
}

// ---------------------------------------------------------------------------
// Demo weather (mirrors MockWeatherProvider: hot-season HK diurnal cycle)
// ---------------------------------------------------------------------------

function demoWeather(hour: number): { tempC: number; rh: number; windMs: number } {
  const diurnal = 2.6 * Math.sin(((hour - 9.0) / 24.0) * 2 * Math.PI);
  return {
    tempC: 30.0 + diurnal,
    rh: clamp(80.0 - diurnal * 4.0, 55, 96),
    windMs: 2.5 + Math.sin(hour / 3.0),
  };
}

// ---------------------------------------------------------------------------
// Solar position (NOAA low-precision, port of app/core/solar.py)
// ---------------------------------------------------------------------------

export interface SunPos {
  elevationDeg: number;
  azimuthDeg: number;
  isDaytime: boolean;
}

export function solarPosition(utcDate: Date, lat: number, lon: number): SunPos {
  const jd = utcDate.getTime() / 86_400_000 + 2_440_587.5;
  const n = jd - 2_451_545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = rad((357.528 + 0.9856003 * n) % 360);
  const lam = rad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const eps = rad(23.439 - 0.0000004 * n);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  // JS % keeps the sign — normalise like Python's always-positive modulo.
  const norm360 = (x: number) => ((x % 360) + 360) % 360;
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = norm360(gmst * 15 + lon);
  const ra = norm360(deg(Math.atan2(Math.sin(lam) * Math.cos(eps), Math.cos(lam))));
  const ha = rad(norm360(lst - ra + 180) - 180);
  const latR = rad(lat);
  const sinAlt = clamp(
    Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(ha),
    -1,
    1,
  );
  const alt = Math.asin(sinAlt);
  const cosAz = clamp(
    (Math.sin(dec) - Math.sin(alt) * Math.sin(latR)) /
      (Math.cos(alt) * Math.cos(latR) || 1e-9),
    -1,
    1,
  );
  let az = deg(Math.acos(cosAz));
  if (Math.sin(ha) > 0) az = 360 - az;
  return { elevationDeg: deg(alt), azimuthDeg: az % 360, isDaytime: alt > 0 };
}

// ---------------------------------------------------------------------------
// Geometry: shadow wedges + Steyn sky-view over skeleton buildings
// ---------------------------------------------------------------------------

interface Bld {
  clat: number;
  clon: number;
  radius: number;
  height: number;
}

function shadeAt(blds: Bld[], lat: number, lon: number, sun: SunPos): number {
  if (!sun.isDaytime || sun.elevationDeg <= 2.0) return 0.0;
  const mPerLon = M_PER_DEG_LAT * Math.cos(rad(lat));
  let best = 0.0;
  for (const b of blds) {
    const de = (lon - b.clon) * mPerLon;
    const dn = (lat - b.clat) * M_PER_DEG_LAT;
    const dist = Math.hypot(de, dn);
    if (dist > b.radius + MAX_SHADOW_M) continue;
    const shadowLen = Math.min(
      b.height / Math.tan(rad(Math.max(sun.elevationDeg, 2.1))),
      MAX_SHADOW_M,
    );
    const reach = b.radius + shadowLen;
    if (dist > reach) continue;
    const azR = rad(sun.azimuthDeg);
    const along = de * Math.sin(azR) + dn * Math.cos(azR);
    if (along > 0.0) continue; // sun side of the wall
    const falloff = 1.0 - Math.min(1.0, dist / reach);
    best = Math.max(best, Math.min(1.0, 0.55 + 0.4 * falloff));
  }
  return best;
}

function svfAt(blds: Bld[], lat: number, lon: number): number {
  if (blds.length === 0) return 1.0;
  const mPerLon = M_PER_DEG_LAT * Math.cos(rad(lat));
  let obstructionTotal = 0.0;
  for (let m = 0; m < SVF_MERIDIANS; m++) {
    const az = (2 * Math.PI * m) / SVF_MERIDIANS;
    const dirE = Math.sin(az);
    const dirN = Math.cos(az);
    let perMeridian = 0.0;
    for (let k = 1; k <= SVF_RINGS; k++) {
      const rK = (SVF_RADIUS_M * k) / SVF_RINGS;
      let gammaMax = 0.0;
      for (const b of blds) {
        const de = (lon - b.clon) * mPerLon;
        const dn = (lat - b.clat) * M_PER_DEG_LAT;
        const along = de * dirE + dn * dirN;
        if (along <= 0.0) continue;
        const perp = Math.abs(de * dirN - dn * dirE);
        const edgeDist = Math.max(along - b.radius, 0.0);
        if (edgeDist > rK || perp > b.radius) continue;
        const gamma = Math.atan2(b.height, Math.max(edgeDist, 1.0));
        if (gamma > gammaMax) gammaMax = gamma;
      }
      perMeridian += 1.0 - Math.cos(gammaMax);
    }
    obstructionTotal += perMeridian / SVF_RINGS;
  }
  return clamp(1.0 - obstructionTotal / SVF_MERIDIANS, 0.05, 1.0);
}

function enclosureAt(blds: Bld[], lat: number, lon: number): number {
  const mPerLon = M_PER_DEG_LAT * Math.cos(rad(lat));
  let weight = 0.0;
  for (const b of blds) {
    const dist = Math.hypot(
      (lon - b.clon) * mPerLon,
      (lat - b.clat) * M_PER_DEG_LAT,
    );
    if (dist < Math.max(b.radius + 60.0, 80.0)) {
      const proximity = 1.0 - Math.min(1.0, dist / (b.radius + 60.0));
      weight += proximity * Math.min(1.0, b.height / 60.0);
    }
  }
  return Math.min(1.0, weight / 2.0);
}

// ---------------------------------------------------------------------------
// Published thermal equations (port of thermal.py)
// ---------------------------------------------------------------------------

function vapourPressureHpa(tempC: number, rhPct: number): number {
  return (clamp(rhPct, 0, 100) / 100) * 6.1094 * Math.exp((17.625 * tempC) / (tempC + 243.04));
}

function stullWetBulbC(tempC: number, rhPct: number): number {
  const rh = clamp(rhPct, 5, 99);
  return (
    tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tempC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) -
    4.686035
  );
}

function steadmanAtC(tempC: number, eHpa: number, windMs: number): number {
  return tempC + 0.33 * eHpa - 0.7 * windMs - 4.0;
}

function steadmanAtSunC(
  tempC: number,
  eHpa: number,
  windMs: number,
  netRadiationWm2: number,
): number {
  return (
    tempC + 0.348 * eHpa - 0.7 * windMs +
    (0.7 * Math.max(netRadiationWm2, 0.0)) / (windMs + 10.0) - 4.25
  );
}

function wbgtShadeC(tempC: number, eHpa: number): number {
  return 0.567 * tempC + 0.393 * eHpa + 3.94;
}

interface Fluxes {
  directNormal: number;
  directHorizontal: number;
  diffuse: number;
  globalHorizontal: number;
}

function clearSkyFluxes(sun: SunPos): Fluxes {
  if (sun.elevationDeg <= 0) {
    return { directNormal: 0, directHorizontal: 0, diffuse: 0, globalHorizontal: 0 };
  }
  const h = Math.max(sun.elevationDeg, 3.0);
  const sinH = Math.sin(rad(h));
  const a0 = 0.4237 - 0.00821 * 36; // sea level
  const a1 = 0.5055 + 0.00595 * 42.25;
  const k = 0.2711 + 0.01858 * 6.25;
  let directNormal = SOLAR_CONSTANT * (a0 + a1 * Math.exp(-k / sinH));
  let directHorizontal = directNormal * sinH;
  const kt = Math.min(0.8, directHorizontal / (SOLAR_CONSTANT * sinH));
  const fDiff =
    kt <= 0.22
      ? 1.0 - 0.09 * kt
      : 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  let diffuse = (directHorizontal * fDiff) / Math.max(1e-6, 1.0 - fDiff);
  let globalH = directHorizontal + diffuse;
  if (directNormal > DNI_CLEAR_SKY_CAP) {
    const scale = DNI_CLEAR_SKY_CAP / directNormal;
    directNormal = DNI_CLEAR_SKY_CAP;
    directHorizontal *= scale;
    globalH = directHorizontal + diffuse;
  }
  if (globalH > GHI_CLEAR_SKY_CAP) {
    const scale = GHI_CLEAR_SKY_CAP / globalH;
    diffuse *= scale;
    directHorizontal *= scale;
    directNormal *= scale;
    globalH = GHI_CLEAR_SKY_CAP;
  }
  return { directNormal, directHorizontal, diffuse, globalHorizontal: globalH };
}

function skyLongwaveWm2(tempC: number, rhPct: number): number {
  const tK = tempC + 273.15;
  const epsSky = clamp(1.24 * (vapourPressureHpa(tempC, rhPct) / tK) ** (1 / 7), 0.55, 0.95);
  return epsSky * SIGMA * tK ** 4;
}

function meanRadiantTempC(
  taC: number,
  rhPct: number,
  f: Fluxes,
  shadeFraction: number,
  svf: number,
  sunElevationDeg: number,
): number {
  const fSun = Math.max(0, 1 - shadeFraction);
  // Fanger/ISO 7726 projection factor (port of body_projection_factor).
  const hR = rad(clamp(sunElevationDeg, 0, 90));
  const fP = clamp(0.86 * Math.cos(hR) ** 2 + 0.14 * Math.sin(hR), 0.14, 0.86);
  const directBody = fP * f.directNormal * fSun;
  const skyDiffuseUp = F_UP * f.diffuse * svf;
  const groundReflected = F_DOWN * GROUND_ALBEDO * (f.globalHorizontal * fSun + f.diffuse);
  const lateralDiffuse = F_LAT_TOTAL * 0.5 * f.diffuse * svf;
  const sw =
    (BODY_ABSORPTIVITY / BODY_EMISSIVITY) *
    (directBody + skyDiffuseUp + groundReflected + lateralDiffuse);
  const lwSky = skyLongwaveWm2(taC, rhPct);
  const lwSurface = 0.95 * SIGMA * (taC + URBAN_SURFACE_DELTA_T + 273.15) ** 4;
  const lw =
    F_UP * lwSky * svf +
    F_DOWN * lwSurface +
    F_LAT_TOTAL * ((1.0 - svf) * lwSurface + svf * lwSky);
  const sStr = sw + lw;
  return (sStr / (BODY_EMISSIVITY * SIGMA)) ** 0.25 - 273.15;
}

function bodyNetRadiationWm2(mrtC: number): number {
  return Math.max(
    0,
    BODY_EMISSIVITY * SIGMA * ((mrtC + 273.15) ** 4 - (SKIN_TEMP_C + 273.15) ** 4),
  );
}

// ---------------------------------------------------------------------------
// City skeleton indexing (all 19 districts, built once)
// ---------------------------------------------------------------------------

interface DistrictIndex {
  id: string;
  south: number;
  west: number;
  north: number;
  east: number;
  buildings: Bld[];
  landuse: { lat: number; lon: number; vf: number; pf: number; wf: number }[];
  cooling: { n: string; lat: number; lon: number; t: string }[];
}

const DISTRICT_INDEX: DistrictIndex[] = CITY_SKELETON.districts.map((d: SkeletonDistrict) => {
  const buildings: Bld[] = d.buildings.map(([clat, clon, radius, height]) => ({
    clat,
    clon,
    radius,
    height,
  }));
  const landuse = d.landuse.map((c) => ({
    lat: c.c[0],
    lon: c.c[1],
    vf: c.vf,
    pf: c.pf,
    wf: c.wf,
  }));
  let south = 90;
  let west = 180;
  let north = -90;
  let east = -180;
  for (const c of landuse) {
    south = Math.min(south, c.lat);
    north = Math.max(north, c.lat);
    west = Math.min(west, c.lon);
    east = Math.max(east, c.lon);
  }
  return {
    id: d.id,
    south: south - 0.004, // ~400 m swell so edges/shadows of neighbours join
    west: west - 0.004,
    north: north + 0.004,
    east: east + 0.004,
    buildings,
    landuse,
    cooling: d.cooling,
  };
});

function districtsCovering(lat: number, lon: number): DistrictIndex[] {
  return DISTRICT_INDEX.filter(
    (d) => lat >= d.south && lat <= d.north && lon >= d.west && lon <= d.east,
  );
}

function landAt(dss: DistrictIndex[], lat: number, lon: number) {
  const mPerLon = M_PER_DEG_LAT * Math.cos(rad(lat));
  let best: { vf: number; pf: number; wf: number } | null = null;
  let bestD = Infinity;
  for (const d of dss) {
    for (const c of d.landuse) {
      const dist = Math.hypot((c.lon - lon) * mPerLon, (c.lat - lat) * M_PER_DEG_LAT);
      if (dist < bestD && dist <= 250.0) {
        best = { vf: c.vf, pf: c.pf, wf: c.wf };
        bestD = dist;
      }
    }
  }
  return best ?? { vf: 0.1, pf: 0.6, wf: 0.0 };
}

export const SKELETON_BOUNDS = (() => {
  let south = 90;
  let west = 180;
  let north = -90;
  let east = -180;
  for (const d of DISTRICT_INDEX) {
    south = Math.min(south, d.south);
    north = Math.max(north, d.north);
    west = Math.min(west, d.west);
    east = Math.max(east, d.east);
  }
  return { south, west, north, east };
})();

// ---------------------------------------------------------------------------
// Public evaluations
// ---------------------------------------------------------------------------

const MODELLED_SOURCES = [
  'noaa-solar',
  'hottel1976-beam',
  'erbs1982-diffuse',
  'brutsaert1975-sky-lw',
  'thorsson2007-mrt',
  'steadman1984-at',
  'stull2011-wetbulb',
  'steyn1980-svf',
  'city-skeleton(mock)',
];

export interface EngineFactors {
  factorId: string;
  label: string;
  delta: number;
  detail: string;
}

/** Full physics evaluation at one coordinate (matches /heat/point shape). */
export function pointPrediction(lat: number, lon: number, hour: number) {
  const dss = districtsCovering(lat, lon);
  const blds: Bld[] = [];
  for (const d of dss) blds.push(...d.buildings);

  const wx = demoWeather(hour);
  // HK local wall time = UTC + 8.
  const sun = solarPosition(new Date(Date.UTC(2026, 5, 21, hour - 8)), lat, lon);
  const shade = shadeAt(blds, lat, lon, sun);
  const svf = svfAt(blds, lat, lon);
  // Outside the city skeleton = open water: no canyon, full wind, no land.
  const land = dss.length === 0 ? { vf: 0.0, pf: 0.0, wf: 1.0 } : landAt(dss, lat, lon);
  const windMs = wx.windMs * (dss.length === 0 ? 1.0 : WIND_CANYON_FACTOR);

  const fluxes = clearSkyFluxes(sun);
  const mrtC = meanRadiantTempC(wx.tempC, wx.rh, fluxes, shade, svf, sun.elevationDeg);
  const eHpa = vapourPressureHpa(wx.tempC, wx.rh);
  const twC = stullWetBulbC(wx.tempC, wx.rh);
  const atShade = steadmanAtC(wx.tempC, eHpa, windMs);
  const qBody = bodyNetRadiationWm2(mrtC);
  const atSun = steadmanAtSunC(wx.tempC, eHpa, windMs, qBody);
  const wbgt = wbgtShadeC(wx.tempC, eHpa);

  // Score, identical composition to AnywhereHeatService.predict_point.
  const base = clamp(((atShade - 24.0) / 21.0) * 100.0, 0, 100);
  let radiationBonus = 0.0;
  if (sun.isDaytime && shade < 0.9) {
    radiationBonus = (1.0 - shade) * Math.sqrt(svf) * Math.min(14.0, 0.016 * qBody);
  }
  const dVeg = -4.0 * land.vf;
  const dWater = -4.0 * land.wf;
  const dWind = -3.0 * Math.min(1.0, windMs / 6.0);
  const heatScore = clamp(base + radiationBonus + dVeg + dWater + dWind, 0, 100);

  const factors: EngineFactors[] = [
    {
      factorId: 'air_temperature',
      label: 'Air temperature (demo hot-season cycle)',
      delta: Math.round(Math.max(0.0, base - 40.0) * 10) / 10,
      detail: `${wx.tempC.toFixed(1)} °C at ${String(Math.floor(hour)).padStart(2, '0')}:00`,
    },
    {
      factorId: 'radiation',
      label: 'Mean radiant temperature (Thorsson 2007)',
      delta: Math.round(radiationBonus * 10) / 10,
      detail: `MRT ${mrtC.toFixed(0)} °C, sun ${sun.elevationDeg.toFixed(0)}° up`,
    },
    {
      factorId: 'sky_view',
      label: "Sky-view factor (Steyn 1980)",
      delta: 0.0,
      detail: `SVF ${svf.toFixed(2)} — folded into the radiation term`,
    },
    {
      factorId: 'vegetation',
      label: 'Vegetation cooling',
      delta: Math.round(dVeg * 10) / 10,
      detail: `Vegetation fraction ${(land.vf * 100).toFixed(0)}%`,
    },
    {
      factorId: 'humidity',
      label: 'Humidity (Stull wet-bulb)',
      delta: Math.round(clamp(twC - 24.0, 0, 6) * 10) / 10,
      detail: `RH ${wx.rh.toFixed(0)}%, wet-bulb ${twC.toFixed(1)} °C`,
    },
    {
      factorId: 'wind',
      label: 'Wind cooling (canyon-adjusted)',
      delta: Math.round(dWind * 10) / 10,
      detail: `${windMs.toFixed(1)} m/s at pedestrian level`,
    },
  ];

  return {
    heatScore: Math.round(heatScore * 10) / 10,
    temperatureC: Math.round(wx.tempC * 10) / 10,
    apparentTemperatureShadeC: Math.round(atShade * 10) / 10,
    apparentTemperatureSunC: Math.round(atSun * 10) / 10,
    wetBulbC: Math.round(twC * 10) / 10,
    wbgtShadeC: Math.round(wbgt * 10) / 10,
    meanRadiantTempC: Math.round(mrtC * 10) / 10,
    skyViewFactor: Math.round(svf * 100) / 100,
    shadeScore: Math.round(shade * 100) / 100,
    vegetationScore: land.vf,
    buildingDensity: Math.round(enclosureAt(blds, lat, lon) * 100) / 100,
    windScore: Math.round(Math.min(1.0, windMs / 8.0) * 100) / 100,
    isDaytime: sun.isDaytime,
    districtId: dss[0]?.id ?? null,
    factors,
    confidence: 0.45,
    isModelled: true,
    sources: MODELLED_SOURCES,
    offlineApproximate: dss.length === 0,
  };
}

/** Viewport grid — same adaptive resolution rules as the backend. */
export function viewportField(
  b: { south: number; west: number; north: number; east: number },
  hour: number,
  maxCells = 220,
) {
  // Clip the query to Hong Kong: nothing outside has data, and skipping it
  // keeps the per-cell physics budget inside the visible city.
  const clip = clipToBounds(b);
  const south = clip.south;
  const north = clip.north;
  const west = clip.west;
  const east = clip.east;
  const latMid = (south + north) / 2;
  const widthM = (east - west) * M_PER_DEG_LAT * Math.cos(rad(latMid));
  const heightM = (north - south) * M_PER_DEG_LAT;
  const aspect = Math.max(widthM, 1) / Math.max(heightM, 1);
  let cols = Math.max(2, Math.min(20, Math.round(Math.sqrt(maxCells * aspect))));
  let rows = Math.max(2, Math.min(20, Math.round(maxCells / cols)));
  if (cols * rows > maxCells) rows = Math.max(2, Math.floor(maxCells / cols));
  cols = Math.min(cols, Math.max(2, Math.floor(widthM / CELL_M) || 2));
  rows = Math.min(rows, Math.max(2, Math.floor(heightM / CELL_M) || 2));

  const cells = [];
  for (let i = 0; i < rows; i++) {
    const lat = south + ((north - south) * (i + 0.5)) / rows;
    for (let j = 0; j < cols; j++) {
      const lon = west + ((east - west) * (j + 0.5)) / cols;
      const p = pointPrediction(lat, lon, hour);
      const dLat = (north - south) / rows;
      const dLon = (east - west) / cols;
      cells.push({
        ...p,
        cellId: `eng-${i}-${j}`,
        center: { lat, lon },
        polygon: [
          [lon - dLon / 2, lat - dLat / 2],
          [lon + dLon / 2, lat - dLat / 2],
          [lon + dLon / 2, lat + dLat / 2],
          [lon - dLon / 2, lat + dLat / 2],
        ] as [number, number][],
        isModelled: true,
        inCoverage: !p.offlineApproximate,
      });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    validFor: new Date().toISOString(),
    dataMode: 'engine-viewport',
    isStale: false,
    bounds: { south, west, north, east },
    cols,
    rows,
    cells,
    legend: {},
    provenance: {
      sources: MODELLED_SOURCES,
      observed: false,
      modelled: true,
      confidence: 0.45,
      notes:
        'OFFLINE ENGINE: every cell is an independent in-browser evaluation of the ' +
        'same published equations (shadow geometry, sky-view factor, thermal ' +
        'comfort). Modelled estimates, not measurements.',
    },
  };
}

/** Cooling spots within maxM of a point, nearest first (all districts). */
export function coolingNearFrom(
  lat: number,
  lon: number,
  maxM = 500,
  limit = 4,
): { n: string; lat: number; lon: number; t: string; distanceMeters: number }[] {
  const out: { n: string; lat: number; lon: number; t: string; distanceMeters: number }[] = [];
  const mPerLon = M_PER_DEG_LAT * Math.cos(rad(lat));
  for (const d of DISTRICT_INDEX) {
    for (const s of d.cooling) {
      const dist = Math.hypot((s.lon - lon) * mPerLon, (s.lat - lat) * M_PER_DEG_LAT);
      if (dist <= maxM) out.push({ ...s, distanceMeters: dist });
    }
  }
  return out.sort((a, b2) => a.distanceMeters - b2.distanceMeters).slice(0, limit);
}
