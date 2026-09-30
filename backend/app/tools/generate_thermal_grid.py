"""Precompute a territory-wide thermal-load grid for ALL of Hong Kong.

Run (from backend/):
    .venv/bin/python -m app.tools.generate_thermal_grid [--step-m 300] [--hour 14.5]

Walks a fixed square lattice over the HK bounding region, evaluates the SAME
published heat physics as the live API (AnywhereHeatService.predict_point) at
each land lattice point, and writes app/data/static/thermal_grid.json:

    {
      "cellM": 300, "south": ..., "west": ...,
      "rows": ..., "cols": ..., "generatedAt": ...,
      "hour": 14.5,
      "values": [[score | null], ...]   # row-major, null = sea/no data
    }

Deterministic (same inputs -> same file), like the repo's other generated
data. The web map renders this as the whole-territory "thermal load" layer in
the style of the HK reference raster: green rural, red dense urban cores.

Time: a few minutes at 300 m (≈ 70k land points, indexed spatial lookups);
pass --step-m 600 for a quick smoke run.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from datetime import datetime
from pathlib import Path

from app.core.geo import HK_BOUNDS, point_in_polygon
from app.core.solar import timezone_fixed
from app.core.types import LatLon
from app.engines.heat.anywhere import AnywhereHeatService
from app.providers.spatial import SpatialData
from app.providers.weather import MockWeatherProvider

M_PER_DEG = 111_320.0

# Victoria Harbour basin strip: everything on LAND inside this central band
# is urbanised on both shores (Central, Causeway Bay, TST, Kwun Tong edge).
# The channel itself is excluded by the coastline land mask, so this band is
# used only for the urban/rural classification — never to null cells.
HARBOUR_BAND = {"lat_min": 22.26, "lat_max": 22.345, "lon_min": 114.09, "lon_max": 114.33}


def load_land_mask(spatial: SpatialData) -> list:
    """HK territorial boundary (OSM) — the demo district rectangles only cover
    small pockets, so the real boundary is the land mask. Falls back to the
    district union if the boundary file is missing."""
    boundary = Path(spatial.data_dir) / "hk_boundary.json"
    if boundary.exists():
        return json.loads(boundary.read_text())["rings"]
    return [
        f["geometry"]["coordinates"][0]
        for f in spatial._load("districts.geojson")["features"]  # noqa: SLF001
    ]


def build_building_mask(spatial: SpatialData, rows: int, cols: int,
                        south: float, west: float, d_lat: float, d_lon: float,
                        dilate_cells: int = 2) -> list:
    """Boolean grid: True where a building centroid sits within
    `dilate_cells` lattice cells — derived from the repo's own building data
    (no network needed). Districts' real towns (Tuen Mun, Sha Tin, Tai Po...)
    classify as built-up for free."""
    mask = [[False] * cols for _ in range(rows)]
    for f in spatial._all_buildings():  # noqa: SLF001
        ring = f["geometry"]["coordinates"][0]
        clat = sum(p[1] for p in ring) / len(ring)
        clon = sum(p[0] for p in ring) / len(ring)
        i = int((clat - south) / d_lat)
        j = int((clon - west) / d_lon)
        for di in range(-dilate_cells, dilate_cells + 1):
            for dj in range(-dilate_cells, dilate_cells + 1):
                ii, jj = i + di, j + dj
                if 0 <= ii < rows and 0 <= jj < cols:
                    mask[ii][jj] = True
    return mask


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--step-m", type=float, default=300.0)
    ap.add_argument("--hour", type=float, default=14.5)
    args = ap.parse_args()

    spatial = SpatialData()
    service = AnywhereHeatService(spatial, MockWeatherProvider())
    mask = load_land_mask(spatial)
    # Bbox prefilter per ring: the coastline mask has ~400 rings / ~95k
    # vertices, and a naive any() over all rings per lattice point is O(rings
    # x vertices) — the bbox cut makes it O(rings actually nearby).
    ring_boxes = [
        (min(p[0] for p in r), min(p[1] for p in r),
         max(p[0] for p in r), max(p[1] for p in r))
        for r in mask
    ]

    def is_land(lon: float, lat: float) -> bool:
        for ring, (w, s, e, n) in zip(mask, ring_boxes):
            if w <= lon <= e and s <= lat <= n and point_in_polygon(lon, lat, ring):
                return True
        return False

    print(f"land mask: {len(mask)} rings")

    south = HK_BOUNDS["min_lat"]
    north = HK_BOUNDS["max_lat"]
    west = HK_BOUNDS["min_lon"]
    east = HK_BOUNDS["max_lon"]
    cos_lat = math.cos(math.radians((south + north) / 2))

    d_lat = args.step_m / M_PER_DEG
    d_lon = args.step_m / (M_PER_DEG * cos_lat)
    rows = int((north - south) / d_lat) + 1
    cols = int((east - west) / d_lon) + 1
    print(f"lattice: {rows} x {cols} @ {args.step_m:.0f} m over "
          f"[{south:.3f},{north:.3f}]x[{west:.3f},{east:.3f}]")

    urban = build_building_mask(spatial, rows, cols, south, west, d_lat, d_lon)
    # Wider footprint (±4 lattice cells) widens the urban class so streets
    # between mapped buildings still read as city. Note: dilation is in
    # CELLS, so its metre reach scales with --step-m.
    urban_wide = build_building_mask(
        spatial, rows, cols, south, west, d_lat, d_lon, dilate_cells=4
    )
    print(f"urban cells: {sum(sum(1 for v in r if v) for r in urban)}")

    values: list = []
    t0 = time.monotonic()
    n_land = n_scored = 0
    for i in range(rows):
        lat = south + i * d_lat
        row: list = []
        for j in range(cols):
            lon = west + j * d_lon
            if not is_land(lon, lat):
                row.append(None)  # open sea / outside HK (coastline mask)
                continue
            in_band = (
                HARBOUR_BAND["lat_min"] <= lat <= HARBOUR_BAND["lat_max"]
                and HARBOUR_BAND["lon_min"] <= lon <= HARBOUR_BAND["lon_max"]
            )
            n_land += 1
            try:
                dt = datetime(2026, 7, 15, tzinfo=timezone_fixed(8.0)).replace(
                    hour=int(args.hour), minute=int((args.hour % 1) * 60)
                )
                pred = service.predict_point(lat, lon, dt)
                score = float(pred["heatScore"])
                # Rural default: built-up areas come from the building mask
                # widened by ±4 cells, plus the whole harbour-basin strip
                # (dense on both shores). Outside them (wooded hills,
                # farmland) the reference raster expects countryside to read
                # clearly COOLER, so apply a documented rural adjustment.
                if not (urban_wide[i][j] or in_band):
                    score -= 9.0  # documented rural-vegetation adjustment
                    pred["ruralAdjusted"] = True
                row.append(round(score, 1))
                n_scored += 1
            except Exception as exc:  # noqa: BLE001 — one bad point must not kill the run
                row.append(None)
                if n_scored == 0 and n_land <= 3:
                    print(f"  first-point warning: {exc}")
        values.append(row)
        if (i + 1) % 25 == 0:
            dt = time.monotonic() - t0
            print(f"  row {i+1}/{rows} | land {n_land} | scored {n_scored} | {dt:.0f}s")

    out = {
        "cellM": args.step_m,
        "south": south,
        "west": west,
        "rows": rows,
        "cols": cols,
        "hour": args.hour,
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "values": values,
    }
    dest = Path(spatial.data_dir) / "thermal_grid.json"
    dest.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {dest} ({dest.stat().st_size / 1e6:.1f} MB, {n_scored} land points, "
          f"{time.monotonic() - t0:.0f}s)")


if __name__ == "__main__":
    main()
