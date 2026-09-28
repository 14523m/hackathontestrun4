"""Shade estimation from solar geometry and building envelopes.

For a pedestrian point and time, decide whether direct sun reaches it.
Model: a building of height h with circumradius r shades ground points that
are (a) on the anti-solar side of the building and (b) within
r + h/tan(elevation) of the building axis - i.e. the classic wall-shadow
wedge. Points beside the building on the sun side stay sunlit.

Prototype geometric model - not a validated irradiance simulator.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import List, Tuple

from app.core.solar import solar_position
from app.core.types import SunPosition

MAX_SHADOW_M = 180.0  # cap for very tall towers at low sun
M_PER_DEG_LAT = 111_320.0


class ShadeModel:
    """Answers: how shaded is a point at a given time, given buildings?"""

    def __init__(self, buildings: List[dict]) -> None:
        # Precompute (centre_lat, centre_lon, circumradius_m, height_m).
        self._buildings: List[Tuple[float, float, float, float]] = []
        for b in buildings:
            ring = b["geometry"]["coordinates"][0]
            lons = [p[0] for p in ring]
            lats = [p[1] for p in ring]
            clat = sum(lats) / len(lats)
            clon = sum(lons) / len(lons)
            radius = max(
                math.hypot(
                    (lo - clon) * M_PER_DEG_LAT * math.cos(math.radians(clat)),
                    (la - clat) * M_PER_DEG_LAT,
                )
                for lo, la in zip(lons, lats)
            )
            height = float(b["properties"].get("heightM", 20.0))
            self._buildings.append((clat, clon, radius, height))

    def shade_at(self, lat: float, lon: float,
                 dt_local: datetime) -> Tuple[float, SunPosition]:
        """Return (shade 0..1, sun position) for a point and local datetime.

        1.0 = fully shaded, 0.0 = fully exposed. Vegetation shade is added
        separately by the heat model from land-use data.
        """
        sun = solar_position(dt_local, lat, lon)
        if not sun.is_daytime or sun.elevation_deg <= 2.0:
            return 0.0, sun

        m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(lat))
        de = (lon - 0.0)  # placeholder to keep names clear; computed per building
        best = 0.0
        for clat, clon, radius, height in self._buildings:
            de = (lon - clon) * m_per_deg_lon
            dn = (lat - clat) * M_PER_DEG_LAT
            dist = math.hypot(de, dn)
            if dist > radius + MAX_SHADOW_M:
                continue  # cheap reject
            shadow_len = min(height / math.tan(math.radians(sun.elevation_deg)),
                             MAX_SHADOW_M)
            reach = radius + shadow_len
            if dist > reach:
                continue
            # Anti-solar half-plane test: (de, dn) must point away from the sun.
            az = math.radians(sun.azimuth_deg)
            sun_e, sun_n = math.sin(az), math.cos(az)  # horizontal dir toward sun
            along = de * sun_e + dn * sun_n
            if along > 0.0:
                continue  # point on the sun side: wall shadow cannot reach it
            falloff = 1.0 - min(1.0, dist / reach)
            shade = 0.55 + 0.40 * falloff
            best = max(best, min(1.0, shade))
        return best, sun
