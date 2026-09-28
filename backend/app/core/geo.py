"""Small geodesy helpers (haversine distance, area sampling)."""

from __future__ import annotations

import math
from typing import List, Tuple

from .types import LatLon

EARTH_RADIUS_M = 6_371_000.0
"""Mean Earth radius in metres (sufficient at city scale)."""

# Hong Kong bounding region used for input validation (deg).
HK_BOUNDS = {
    "min_lat": 21.9,
    "max_lat": 22.65,
    "min_lon": 113.75,
    "max_lon": 114.5,
}


def haversine_m(a: LatLon, b: LatLon) -> float:
    """Great-circle distance between two points in metres."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a.lat, a.lon, b.lat, b.lon))
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def path_length_m(coords) -> float:  # noqa: ANN001
    """Total length in metres of a polyline [(lat, lon), ...]."""
    total = 0.0
    pts = list(coords)
    for (lat1, lon1), (lat2, lon2) in zip(pts, pts[1:]):
        total += haversine_m(LatLon(lat1, lon1), LatLon(lat2, lon2))
    return total


def centroid(coords) -> LatLon:  # noqa: ANN001
    """Arithmetic mean of coordinates (adequate for small polygons/lines)."""
    pts = list(coords)
    n = len(pts) or 1
    return LatLon(sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n)


def in_hong_kong(lat: float, lon: float) -> bool:
    """Validation: coordinates inside the expected Hong Kong bounding region."""
    return (
        HK_BOUNDS["min_lat"] <= lat <= HK_BOUNDS["max_lat"]
        and HK_BOUNDS["min_lon"] <= lon <= HK_BOUNDS["max_lon"]
    )


def point_in_polygon(lon: float, lat: float, ring) -> bool:  # noqa: ANN001
    """Ray-casting point-in-polygon test. ``ring`` = [[lon, lat], ...]."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def bbox_of(coords) -> Tuple[float, float, float, float]:  # noqa: ANN001
    """(min_lon, min_lat, max_lon, max_lat) of nested coordinate lists."""
    lons: List[float] = []
    lats: List[float] = []
    stack = list(coords)
    while stack:
        item = stack.pop()
        if isinstance(item[0], (int, float)):
            lons.append(item[0])
            lats.append(item[1])
        else:
            stack.extend(item)
    return min(lons), min(lats), max(lons), max(lats)
