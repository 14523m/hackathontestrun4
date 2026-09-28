"""Shade and sky-view estimation from solar geometry and building envelopes.

Shade: a building of height h with circumradius r shades ground points that
are (a) on the anti-solar side of the building and (b) within
r + h/tan(elevation) of the building axis - the classic wall-shadow wedge.

Sky-view factor: hemispherical obstruction by surrounding buildings via the
ring-meridian method (Sterk et al. 2013, adapted from Steyn 1980):
K concentric rings x 8 meridians; each ring's blocking angle is computed
from the tallest building intersecting that ring on each meridian;
SVF = 1 - mean over meridians of the cosine-weighted obstruction.

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

SVF_RADIUS_M = 100.0  # search radius for horizon obstruction
SVF_RINGS = 10  # concentric rings (Steyn 1980 / Sterk 2013)
SVF_MERIDIANS = 8  # azimuthal directions


class ShadeModel:
    """Answers: how shaded is a point at a given time, and how open is the sky?"""

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

    # -- sky-view factor ----------------------------------------------------- #

    def svf_at(self, lat: float, lon: float,
               radius_m: float = SVF_RADIUS_M) -> float:
        """Sky-view factor 0..1 at a point (Steyn 1980 ring method).

        For each of 8 meridians, walks K concentric rings of increasing
        radius; the blocking elevation angle of ring k is the max over
        buildings intersecting that ring of atan(h / r_k). Sky obstruction
        per meridian: obstr = sum_k (1 - cos(gamma_k)) / K; the SVF is
        1 minus the mean obstruction (cosine-weighted sky patch share).
        """
        if not self._buildings:
            return 1.0
        m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(lat))
        obstruction_total = 0.0

        for m in range(SVF_MERIDIANS):
            az = 2.0 * math.pi * m / SVF_MERIDIANS
            dir_e, dir_n = math.sin(az), math.cos(az)
            per_meridian = 0.0
            for k in range(1, SVF_RINGS + 1):
                r_k = radius_m * k / SVF_RINGS
                gamma_max = 0.0
                for clat, clon, b_radius, height in self._buildings:
                    de = (lon - clon) * m_per_deg_lon
                    dn = (lat - clat) * M_PER_DEG_LAT
                    along = de * dir_e + dn * dir_n  # projection on meridian
                    if along <= 0.0:
                        continue
                    # Distance of the building centre from the meridian ray.
                    perp = abs(de * dir_n - dn * dir_e)
                    edge_dist = max(along - b_radius, 0.0)
                    if edge_dist > r_k or perp > b_radius:
                        continue
                    eff_r = max(edge_dist, 1.0)
                    gamma = math.atan2(height, eff_r)
                    if gamma > gamma_max:
                        gamma_max = gamma
                per_meridian += 1.0 - math.cos(gamma_max)
            obstruction_total += per_meridian / SVF_RINGS

        svf = 1.0 - obstruction_total / SVF_MERIDIANS
        return min(max(svf, 0.05), 1.0)
