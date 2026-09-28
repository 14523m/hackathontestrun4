"""Deterministic generator for static demo datasets.

Run:  python -m app.data.generate_static_data

Produces reproducible mock GeoJSON/JSON into backend/app/data/static/.
Everything is derived from stable hashes (no randomness), so re-running
always yields identical files. All generated data is SIMULATED - geographically
anchored to real Hong Kong districts, but values are not measurements.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

from app.core.geo import haversine_m
from app.core.types import LatLon

STATIC_DIR = Path(__file__).resolve().parent / "static"

M_PER_DEG_LAT = 111_320.0

# Roughly [south, west, north, east] of each demo district (WGS84).
DISTRICT_BBOXES = {
    "central-western": (22.278, 114.128, 22.292, 114.148),
    "kowloon-yau-tsim": (22.296, 114.164, 22.310, 114.180),
    "northern-metropolis": (22.505, 114.120, 22.525, 114.150),
}

DISTRICT_META = [
    {
        "id": "central-western",
        "name": "Central & Western",
        "nameZh": "中西區",
        "kind": "existing",
        "description": (
            "Dense historic district on Hong Kong Island with steep terrain, "
            "narrow streets and limited park space. Simulated district used for "
            "citizen cool-route and heat-map demonstrations."
        ),
    },
    {
        "id": "kowloon-yau-tsim",
        "name": "Yau Tsim Mong (Kowloon)",
        "nameZh": "油尖旺區",
        "kind": "existing",
        "description": (
            "Extremely dense Kowloon urban core. Simulated district used for "
            "street-canyon heat demonstrations."
        ),
    },
    {
        "id": "northern-metropolis",
        "name": "Northern Metropolis (Conceptual District)",
        "nameZh": "北部都會區（概念情境）",
        "kind": "conceptual",
        "description": (
            "A CONCEPTUAL / SIMULATED new-district scenario inspired by the "
            "Northern Metropolis development area. This is NOT an official plan, "
            "NOT a prediction about the real Northern Metropolis, and all values "
            "are simulated for demonstration of planning-stage heat assessment."
        ),
    },
]


def _hash_floats(*parts: str) -> list[float]:
    digest = hashlib.sha256("|".join(parts).encode()).digest()
    return [b / 255.0 for b in digest]


def _rand(seed: str, i: int = 0) -> float:
    return _hash_floats(seed, str(i))[i % 32]


def _bbox(district_id: str):
    return DISTRICT_BBOXES[district_id]


def _meters_to_deg_offsets(m_north: float, m_east: float):
    dlat = m_north / M_PER_DEG_LAT
    dlon = m_east / (M_PER_DEG_LAT * math.cos(math.radians(22.3)))
    return dlat, dlon


# --------------------------------------------------------------------------- #
# Districts
# --------------------------------------------------------------------------- #

def generate_districts() -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {k: d[k] for k in ("id", "name", "nameZh", "kind", "description")},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[
                        [bbox[1], bbox[0]], [bbox[3], bbox[0]],
                        [bbox[3], bbox[2]], [bbox[1], bbox[2]],
                        [bbox[1], bbox[0]],
                    ]],
                },
            }
            for d, bbox in ((dict(m), _bbox(m["id"])) for m in DISTRICT_META)
        ],
    }


# --------------------------------------------------------------------------- #
# Pedestrian network (edges as GeoJSON LineStrings)
# --------------------------------------------------------------------------- #

def generate_pedestrian_network(district_id: str) -> dict:
    """Grid street network with deterministic jitter.

    A simple but adequate MVP network: real deployments would ingest the
    Lands Department 3D Pedestrian Network via the provider boundary.
    """
    s, w, n, e = _bbox(district_id)
    seed = f"network:{district_id}"
    features = []
    node_index = {}

    def node_id(lat: float, lon: float) -> str:
        key = f"{lat:.5f},{lon:.5f}"
        if key not in node_index:
            node_index[key] = f"n{len(node_index):04d}"
        return node_index[key]

    nx, ny = 7, 6
    lats = [s + (n - s) * i / (ny - 1) for i in range(ny)]
    lons = [w + (e - w) * j / (nx - 1) for j in range(nx)]

    # A tree-lined boulevard row per district, running through that
    # district's park (see PARK_RECTS): gives Coolest routing a connected
    # cool corridor while Fastest rides the sun-baked arterial (row 3).
    green_row = {"central-western": 4, "kowloon-yau-tsim": 4,
                 "northern-metropolis": 2}
    gr = green_row.get(district_id, -1)

    def add_edge(a, b, kind, props=None):
        # IMPORTANT: endpoints are EXACT grid intersections (no jitter) so
        # every edge shares its nodes with neighbours - otherwise special
        # edges (green lanes, corridors) become disconnected islands.
        a2, b2 = a, b
        length = haversine_m(LatLon(*a2), LatLon(*b2))
        eid = f"{district_id}:{node_id(*a2)}->{node_id(*b2)}:{kind}"
        props = dict(props or {})
        features.append({
            "type": "Feature",
            "properties": {
                "id": eid,
                "kind": kind,
                "lengthM": round(length, 1),
                "gradientPct": 0.0,
                **props,
            },
            "geometry": {"type": "LineString", "coordinates": [[a2[1], a2[0]], [b2[1], b2[0]]]},
        })

    # Avenues (E-W trunk), streets (N-S trunk) and connecting lanes.
    for i, lat in enumerate(lats):
        for j in range(nx - 1):
            if i == gr:
                add_edge((lat, lons[j]), (lat, lons[j + 1]), "lane",
                         {"greenLane": True})
            else:
                kind = "avenue" if i in (0, ny - 1) else "street"
                add_edge((lat, lons[j]), (lat, lons[j + 1]), kind)
    for j, lon in enumerate(lons):
        for i in range(ny - 1):
            kind = "avenue" if j in (0, nx - 1) else "street"
            add_edge((lats[i], lon), (lats[i + 1], lon), kind)

    # Diagonal green lane through districts that have one.
    if district_id in ("central-western", "northern-metropolis"):
        add_edge((lats[1], lons[1]), (lats[ny - 2], lons[nx - 2]), "lane",
                 {"greenLane": True})

    # Conceptual NM district: add a proposed shaded-corridor alignment.
    if district_id == "northern-metropolis":
        add_edge((lats[2], lons[0]), (lats[2], lons[nx - 1]), "proposed-corridor",
                 {"proposedShadedCorridor": True})

    return {"type": "FeatureCollection", "features": features}


# --------------------------------------------------------------------------- #
# Buildings
# --------------------------------------------------------------------------- #

def generate_buildings(district_id: str) -> dict:
    s, w, n, e = _bbox(district_id)
    seed = f"buildings:{district_id}"
    features = []
    idx = 0
    # Blocks between grid lines, leaving street space.
    # Heterogeneous urban form is IMPORTANT: low podiums cast almost no
    # shadow, towers shade whole streets, and row i==3 is left open as a
    # wide sun-exposed avenue - this gives the heat model real spatial
    # contrast to route around (and matches real HK morphology).
    ny, nx = 6, 7
    for i in range(ny - 1):
        for j in range(nx - 1):
            r = _hash_floats(seed, f"{i}:{j}")
            # Deterministic gaps (plazas / green space).
            if r[0] < 0.12:
                continue
            # Open sun-exposed avenue corridor.
            if i == 3:
                continue
            lat0 = s + (n - s) * (i + 0.06) / (ny - 1)
            lat1 = s + (n - s) * (i + 0.94) / (ny - 1)
            lon0 = w + (e - w) * (j + 0.06) / (nx - 1)
            lon1 = w + (e - w) * (j + 0.94) / (nx - 1)
            # Height mix by district character: podium / mid-rise / tower.
            if district_id == "kowloon-yau-tsim":
                if r[1] < 0.15:
                    height, floors = 12 + r[2] * 10, 4 + int(r[3] * 3)
                elif r[1] < 0.55:
                    height, floors = 45 + r[2] * 35, 14 + int(r[3] * 10)
                else:
                    height, floors = 95 + r[2] * 60, 28 + int(r[3] * 18)
            elif district_id == "central-western":
                if r[1] < 0.25:
                    height, floors = 10 + r[2] * 12, 3 + int(r[3] * 4)
                elif r[1] < 0.65:
                    height, floors = 40 + r[2] * 35, 12 + int(r[3] * 10)
                else:
                    height, floors = 90 + r[2] * 60, 26 + int(r[3] * 18)
            else:  # conceptual NM: low/mid with a compact tower cluster
                if r[5] > 0.75:
                    height, floors = 60 + r[2] * 60, 18 + int(r[3] * 18)
                elif r[1] < 0.6:
                    height, floors = 12 + r[2] * 15, 4 + int(r[3] * 5)
                else:
                    height, floors = 35 + r[2] * 25, 10 + int(r[3] * 8)
            idx += 1
            features.append({
                "type": "Feature",
                "properties": {
                    "id": f"bld-{district_id}-{idx:03d}",
                    "heightM": round(height, 1),
                    "floors": floors,
                    # Simulated baseline attributes (NOT real LandsD attributes).
                    "simulated": True,
                },
                "geometry": {"type": "Polygon", "coordinates": [[
                    [lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0],
                ]]},
            })
    return {"type": "FeatureCollection", "features": features}


# --------------------------------------------------------------------------- #
# Land use / vegetation / surface (5 m proxy grid, cell = block quarter)
# --------------------------------------------------------------------------- #

# Park rectangles per district as ((lat0f, lat1f), (lon0f, lon1f)) fractions
# of the district bbox. Parks give the heat model strong, routeable
# vegetation contrast (all-day cooling, unlike geometry-dependent shade).
PARK_RECTS = {
    "central-western": [
        ((0.10, 0.30), (0.52, 0.76)),   # park north of the corridor
        ((0.64, 0.88), (0.08, 0.32)),   # park south-west
    ],
    "kowloon-yau-tsim": [
        ((0.08, 0.32), (0.20, 0.46)),   # Kowloon Park analogue
        ((0.62, 0.86), (0.56, 0.80)),   # King's Park analogue
    ],
    "northern-metropolis": [
        ((0.30, 0.52), (0.30, 0.56)),   # conceptual central park
    ],
}


def generate_land_use(district_id: str, step: float = 0.0016) -> dict:
    s, w, n, e = _bbox(district_id)
    seed = f"landuse:{district_id}"
    # The open avenue corridor (see generate_buildings) is a wide, sun-baked
    # arterial: heavily paved, almost no vegetation. This gives the heat
    # model strong, realistic spatial contrast.
    corridor_lo = s + (n - s) * 0.58
    corridor_hi = s + (n - s) * 0.82
    park_rects = [
        (s + (n - s) * a0, s + (n - s) * a1, w + (e - w) * o0, w + (e - w) * o1)
        for (a0, a1), (o0, o1) in PARK_RECTS.get(district_id, [])
    ]
    features = []
    lat = s
    row = 0
    while lat < n:
        lon = w
        col = 0
        while lon < e:
            r = _hash_floats(seed, f"{row}:{col}")
            in_corridor = district_id != "northern-metropolis" and corridor_lo <= lat <= corridor_hi
            if district_id == "kowloon-yau-tsim":
                green = max(0.0, min(0.35, 0.06 + r[0] * 0.12))
                paved = 0.55 + r[1] * 0.3
            elif district_id == "central-western":
                green = max(0.0, min(0.5, 0.10 + r[0] * 0.20))
                paved = 0.45 + r[1] * 0.3
            else:
                green = max(0.0, min(0.65, 0.22 + r[0] * 0.30))
                paved = 0.30 + r[1] * 0.3
            if in_corridor:
                paved = min(0.95, paved + 0.25)
                green *= 0.3
            in_park = any(p0 <= lat <= p1 and q0 <= lon <= q1
                          for p0, p1, q0, q1 in park_rects)
            if in_park:
                green, paved = 0.78, 0.10
            cls = (
                "green_space" if green > 0.4
                else "urban_open_space" if green > 0.25
                else "built_up"
            )
            features.append({
                "type": "Feature",
                "properties": {
                    "id": f"lu-{district_id}-{row:02d}-{col:02d}",
                    "class": cls,
                    "vegetationFraction": round(green, 3),
                    "pavedFraction": round(min(0.95, paved), 3),
                    "waterFraction": round(max(0.0, r[2] * 0.06), 3),
                    "simulated": True,
                },
                "geometry": {"type": "Polygon", "coordinates": [[
                    [lon, lat], [lon + step, lat],
                    [lon + step, lat + step], [lon, lat + step], [lon, lat],
                ]]},
            })
            lon += step
            col += 1
        lat += step
        row += 1
    return {"type": "FeatureCollection", "features": features}


# --------------------------------------------------------------------------- #
# Cooling spots
# --------------------------------------------------------------------------- #

COOLING_SPOTS = {
    "central-western": [
        ("Hong Kong City Hall", "library", 3, "08:00-22:00", True, 600),
        ("Sheung Wan Sports Centre", "sports_centre", 3, "06:30-22:30", True, 800),
        ("Blake Garden", "park", 2, "24 hours", True, 300),
        ("Hollywood Road Park", "park", 2, "24 hours", True, 200),
        ("Tai Kwun Centre", "cultural_venue", 3, "11:00-19:00", True, 500),
        ("MTR Hong Kong Station concourse", "mtr_station", 2, "06:00-01:00", True, 1500),
        ("MTR Central Station concourse", "mtr_station", 2, "05:30-01:30", True, 2000),
        ("Sai Ying Pun Community Hall", "community_centre", 2, "09:00-21:00", True, 250),
    ],
    "kowloon-yau-tsim": [
        ("Kowloon Park", "park", 3, "05:00-23:00", True, 1200),
        ("Hong Kong Cultural Centre", "cultural_venue", 3, "10:00-21:30", True, 700),
        ("Kowloon Public Library", "library", 3, "08:00-21:00", True, 600),
        ("MTR Tsim Sha Tsui Station concourse", "mtr_station", 2, "05:45-01:15", True, 2200),
        ("MTR Jordan Station concourse", "mtr_station", 2, "05:45-01:15", True, 1500),
        ("King's Park", "park", 2, "24 hours", True, 400),
        ("Temple Street Market (covered)", "market", 1, "18:00-23:30", False, 350),
        ("Yau Ma Tei Community Centre", "community_centre", 2, "09:00-21:00", True, 300),
    ],
    "northern-metropolis": [
        ("Conceptual District Library", "library", 3, "08:00-21:00", True, 400),
        ("Conceptual Central Park", "park", 3, "24 hours", True, 900),
        ("Conceptual Community Centre", "community_centre", 2, "09:00-21:00", True, 300),
        ("Conceptual MTR Station concourse", "mtr_station", 2, "05:30-01:30", True, 1200),
    ],
}


def generate_cooling_spots() -> dict:
    features = []
    for district_id, spots in COOLING_SPOTS.items():
        s, w, n, e = _bbox(district_id)
        for i, (name, typ, level, hours, access, cap) in enumerate(spots):
            r = _hash_floats(f"spot:{district_id}", str(i))
            lat = s + (n - s) * (0.15 + 0.7 * r[0])
            lon = w + (e - w) * (0.15 + 0.7 * r[1])
            features.append({
                "type": "Feature",
                "properties": {
                    "id": f"cool-{district_id}-{i:02d}",
                    "districtId": district_id,
                    "name": name,
                    "type": typ,
                    "coolingLevel": level,
                    "openingHours": hours,
                    "capacityEstimate": cap,
                    "accessibility": access,
                    "simulated": True,
                },
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
            })
    return {"type": "FeatureCollection", "features": features}


# --------------------------------------------------------------------------- #
# Crowd reports (simulated)
# --------------------------------------------------------------------------- #

def generate_crowd_reports() -> dict:
    messages = [
        "Very sunny here", "No shade", "Feels breezy here", "Very hot",
        "Good place to cool down", "Shady walkway", "Wind tunnel effect",
    ]
    features = []
    idx = 0
    for district_id, bbox in DISTRICT_BBOXES.items():
        s, w, n, e = bbox
        for i in range(6):
            r = _hash_floats(f"crowd:{district_id}", str(i))
            idx += 1
            features.append({
                "type": "Feature",
                "properties": {
                    "id": f"cr-{idx:04d}",
                    "districtId": district_id,
                    "message": messages[int(r[0] * len(messages)) % len(messages)],
                    "sentiment": "hot" if i % 2 == 0 else "cool",
                    # Anonymised by design: no user identifiers are stored.
                    "anonymised": True,
                    "simulated": True,
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [w + (e - w) * r[1], s + (n - s) * r[2]],
                },
            })
    return {"type": "FeatureCollection", "features": features}


# --------------------------------------------------------------------------- #
# Writer
# --------------------------------------------------------------------------- #

def main() -> None:
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    datasets = {
        "districts.geojson": generate_districts(),
        "cooling_spots.geojson": generate_cooling_spots(),
        "crowd_reports.geojson": generate_crowd_reports(),
    }
    for district_id in DISTRICT_BBOXES:
        datasets[f"network_{district_id}.geojson"] = generate_pedestrian_network(district_id)
        datasets[f"buildings_{district_id}.geojson"] = generate_buildings(district_id)
        datasets[f"landuse_{district_id}.geojson"] = generate_land_use(district_id)

    for fname, data in datasets.items():
        path = STATIC_DIR / fname
        path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        print(f"wrote {path.name}: {len(data['features'])} features")


if __name__ == "__main__":
    main()
