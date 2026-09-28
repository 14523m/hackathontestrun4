"""Solar position (NOAA low-precision approximation).

Computes sun elevation/azimuth for a coordinate and local date-time so the
same pedestrian edge can be sunny at 12:00 and shaded at 09:00/15:00 - the
key technical differentiator of the project (master prompt section 47/48).
Accuracy of ~0.3 degrees is ample for shade estimation.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Optional

from .types import SunPosition


def _julian_day(dt_utc: datetime) -> float:
    y, m = dt_utc.year, dt_utc.month
    d = dt_utc.day + (dt_utc.hour + dt_utc.minute / 60 + dt_utc.second / 3600) / 24.0
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return (
        math.floor(365.25 * (y + 4716))
        + math.floor(30.6001 * (m + 1))
        + d
        + b
        - 1524.5
    )


def solar_position(dt_local: datetime, lat: float, lon: float,
                   utc_offset_hours: Optional[float] = None) -> SunPosition:
    """Sun elevation and azimuth (degrees) for local date-time.

    ``dt_local`` must be naive or carry the local offset; HK standard time is
    UTC+8. If the datetime is aware, its offset is used directly.
    """
    if dt_local.tzinfo is None:
        offset = 8.0 if utc_offset_hours is None else float(utc_offset_hours)
        dt_aware = dt_local.replace(tzinfo=timezone_fixed(offset))
    else:
        offset = dt_local.utcoffset().total_seconds() / 3600.0
        dt_aware = dt_local

    dt_utc = (dt_aware - timedelta(hours=offset)).replace(tzinfo=None)
    jd = _julian_day(dt_utc)
    n = jd - 2451545.0

    # Mean longitude / anomaly / ecliptic longitude (deg).
    L = (280.460 + 0.9856474 * n) % 360.0
    g = math.radians((357.528 + 0.9856003 * n) % 360.0)
    lam = math.radians(L + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g))

    # Obliquity and declination.
    eps = math.radians(23.439 - 0.0000004 * n)
    dec = math.asin(math.sin(eps) * math.sin(lam))

    # GMST (hours) -> local sidereal time -> hour angle.
    gmst_hours = (18.697374558 + 24.06570982441908 * n) % 24.0
    lst_deg = (gmst_hours * 15.0 + lon) % 360.0
    ra_deg = math.degrees(_right_ascension(dec, lam, eps)) % 360.0
    ha = math.radians(((lst_deg - ra_deg + 180.0) % 360.0) - 180.0)

    lat_r = math.radians(lat)
    sin_alt = (
        math.sin(lat_r) * math.sin(dec)
        + math.cos(lat_r) * math.cos(dec) * math.cos(ha)
    )
    sin_alt = max(-1.0, min(1.0, sin_alt))
    alt = math.asin(sin_alt)

    cos_az = (math.sin(dec) - math.sin(alt) * math.sin(lat_r)) / (
        math.cos(alt) * math.cos(lat_r)
    )
    cos_az = max(-1.0, min(1.0, cos_az))
    az = math.degrees(math.acos(cos_az))
    if math.sin(ha) > 0:
        az = 360.0 - az

    return SunPosition(
        elevation_deg=math.degrees(alt),
        azimuth_deg=az % 360.0,
        is_daytime=alt > 0.0,
    )


def _right_ascension(dec: float, lam: float, eps: float) -> float:
    """Right ascension (radians) from ecliptic longitude and obliquity."""
    return math.atan2(math.sin(lam) * math.cos(eps), math.cos(lam))


def timezone_fixed(offset_hours: float):
    """Build a fixed-offset tzinfo without external dependencies."""
    from datetime import timezone

    return timezone(timedelta(hours=offset_hours))


def utc_now_local_hk(now_utc: Optional[datetime] = None) -> datetime:
    """Current HK local time (UTC+8) as an aware datetime."""
    now = now_utc or datetime.utcnow()
    return (now + timedelta(hours=8)).replace(tzinfo=timezone_fixed(8.0))
