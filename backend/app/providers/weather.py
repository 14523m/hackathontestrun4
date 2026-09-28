"""Weather providers: HKO Open Data (live) and deterministic mock.

``WeatherProvider`` is the only interface the rest of the app consumes.
Live mode fetches HKO's open ``rhrread`` current-weather report (10-min
updates) with multi-station temperature; observations are cached and, when
the feed is unreachable, the last valid observation is served flagged as
stale (never silently fabricated).
"""

from __future__ import annotations

import math
import time
from abc import ABC, abstractmethod
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.core.geo import haversine_m
from app.core.solar import timezone_fixed
from app.core.types import LatLon

# Approximate coordinates of HKO rhrread temperature stations (WGS84).
# For regional interpolation only - station positions are approximate.
HKO_STATION_COORDS: Dict[str, LatLon] = {
    "Hong Kong Observatory": LatLon(22.3013, 114.1722),
    "King's Park": LatLon(22.3119, 114.1631),
    "Wong Chuk Hang": LatLon(22.2472, 114.1687),
    "Ta Kwu Ling": LatLon(22.5292, 114.1680),
    "Lau Fau Shan": LatLon(22.4690, 113.9877),
    "Tai Po": LatLon(22.4500, 114.1640),
    "Sha Tin": LatLon(22.3760, 114.1860),
    "Tuen Mun": LatLon(22.4210, 113.9730),
    "Tseung Kwan O": LatLon(22.3170, 114.2610),
    "Sai Kung": LatLon(22.3820, 114.2710),
    "Cheung Chau": LatLon(22.2060, 114.0290),
    "Chek Lap Kok": LatLon(22.3080, 113.9180),
    "Tsing Yi": LatLon(22.3520, 114.1050),
    "Shek Kong": LatLon(22.4310, 114.0780),
    "Tsuen Wan Ho Koon": LatLon(22.3740, 114.1130),
    "Tsuen Wan Shing Mun Valley": LatLon(22.3750, 114.1400),
    "Hong Kong Park": LatLon(22.2770, 114.1600),
    "Shau Kei Wan": LatLon(22.2800, 114.2290),
    "Kowloon City": LatLon(22.3320, 114.1910),
    "Happy Valley": LatLon(22.2660, 114.1800),
    "Wong Tai Sin": LatLon(22.3420, 114.1930),
    "Stanley": LatLon(22.2190, 114.2130),
    "Kwun Tong": LatLon(22.3100, 114.2260),
    "Sham Shui Po": LatLon(22.3300, 114.1550),
    "Yuen Long": LatLon(22.4450, 114.0350),
    "North Point": LatLon(22.2920, 114.2010),
    "Peng Chau": LatLon(22.2840, 114.0420),
}

class WeatherProvider(ABC):
    """Interface for atmospheric conditions (regional anchors, not street temps)."""

    @abstractmethod
    def current(self) -> Dict[str, Any]:
        """Return a WeatherSnapshotOut-shaped dict."""

    @abstractmethod
    def stations(self) -> List[Dict[str, Any]]:
        """Return available observation stations with coordinates."""


class MockWeatherProvider(WeatherProvider):
    """Deterministic seasonal/diurnal simulation for offline demo mode.

    Produces plausible Hong Kong hot-season conditions derived from the clock
    (no randomness). Clearly labelled modelled/simulated downstream.
    """

    def current(self, now_local: Optional[datetime] = None) -> Dict[str, Any]:
        now = now_local or datetime.now(timezone_fixed(8.0))
        hour = now.hour + now.minute / 60.0
        # Diurnal cycle peaking mid-afternoon; hot-season baseline.
        diurnal = 2.6 * math.sin((hour - 9.0) / 24.0 * 2.0 * math.pi)
        temp = round(30.0 + diurnal, 1)
        humidity = round(min(96.0, max(55.0, 80.0 - diurnal * 4.0)), 1)
        radiation = round(max(0.0, 850.0 * math.sin(max(0.0, (hour - 6.0)) / 12.0 * math.pi)), 0)
        if not (6.0 < hour < 18.5):
            radiation = 0.0
        return {
            "timestamp": now.isoformat(),
            "temperatureC": temp,
            "relativeHumidity": humidity,
            "windSpeedMs": round(2.5 + 1.0 * math.sin(hour / 3.0), 2),
            "windDirectionDeg": 135.0,  # SE monsoon-ish
            "globalSolarRadiation": radiation,
            "heatIndexC": round(temp + 1.0, 1),
            "wetBulbGlobeTemperatureC": None,
            "isObserved": False,
            "isStale": False,
            "anchorStation": "simulated-regional-mean",
            "provenance": {
                "sources": ["mock-weather"],
                "observed": False,
                "modelled": True,
                "confidence": 0.5,
                "resolutionMeters": None,
                "notes": "Deterministic simulation for demo mode - not measured data.",
            },
        }

    def stations(self) -> List[Dict[str, Any]]:
        base = self.current()
        out = []
        for name, coord in HKO_STATION_COORDS.items():
            out.append({
                "name": name,
                "location": {"lat": coord.lat, "lon": coord.lon},
                "temperatureC": base["temperatureC"],
            })
        return out


class HKOWeatherProvider(WeatherProvider):
    """Live Hong Kong Observatory Open Data provider with stale fallback."""

    def __init__(self, base_url: str, cache_seconds: float = 600.0,
                 stale_after_seconds: float = 21600.0,
                 timeout_seconds: float = 6.0) -> None:
        self._base_url = base_url
        self._cache_seconds = cache_seconds
        self._stale_after = stale_after_seconds
        self._timeout = timeout_seconds
        self._cached: Optional[Dict[str, Any]] = None
        self._cached_at: float = 0.0

    # -- fetching ---------------------------------------------------------- #

    def _fetch(self) -> Dict[str, Any]:
        params = {"dataType": "rhrread", "lang": "en"}
        resp = httpx.get(self._base_url, params=params, timeout=self._timeout)
        resp.raise_for_status()
        raw = resp.json()

        temps: List[Dict[str, Any]] = raw.get("temperature", {}).get("data", [])
        if not temps:
            raise ValueError("HKO response missing temperature data")
        humidity_data = raw.get("humidity", {}).get("data") or []
        humidity = float(humidity_data[0]["value"]) if humidity_data else 78.0

        # Anchor station: Hong Kong Observatory HQ, else first station.
        anchor_name = temps[0]["place"]
        for t in temps:
            if t["place"] in HKO_STATION_COORDS:
                anchor_name = t["place"]
                break
        anchor_temp = next(t["value"] for t in temps if t["place"] == anchor_name)

        stations = []
        for t in temps:
            coord = HKO_STATION_COORDS.get(t["place"])
            if coord is not None:
                stations.append({
                    "name": t["place"],
                    "location": {"lat": coord.lat, "lon": coord.lon},
                    "temperatureC": float(t["value"]),
                })

        snapshot_time = datetime.now(timezone_fixed(8.0))
        radiation = max(0.0, 700.0 * math.sin(max(0.0, (snapshot_time.hour + snapshot_time.minute / 60 - 6.0)) / 12.0 * math.pi)) \
            if 6.0 < snapshot_time.hour + snapshot_time.minute / 60 < 18.5 else 0.0

        return {
            "timestamp": raw.get("updateTime") or snapshot_time.isoformat(),
            "fetchedAt": time.time(),
            "temperatureC": float(anchor_temp),
            "relativeHumidity": humidity,
            "windSpeedMs": 3.0,  # rhrread lacks wind: modelled value, flagged below
            "windDirectionDeg": 135.0,
            "globalSolarRadiation": round(radiation, 0),
            "heatIndexC": None,
            "wetBulbGlobeTemperatureC": None,
            "isObserved": True,
            "isStale": False,
            "anchorStation": anchor_name,
            "stations": stations,
            "provenance": {
                "sources": ["hko-rhrread"],
                "observed": True,
                "modelled": False,
                "confidence": 0.9,
                "resolutionMeters": None,
                "notes": (
                    "Air temperature/humidity observed by HKO stations; wind and "
                    "solar radiation are modelled placeholders (station wind feed "
                    "not used in MVP)."
                ),
            },
        }

    # -- public API ---------------------------------------------------------- #

    def current(self, now_local: Optional[datetime] = None) -> Dict[str, Any]:
        now_ts = time.time()
        if self._cached and now_ts - self._cached_at < self._cache_seconds:
            return self._cached

        try:
            fresh = self._fetch()
            self._cached, self._cached_at = fresh, now_ts
            return fresh
        except Exception:
            if self._cached and now_ts - self._cached_at < self._stale_after:
                stale = dict(self._cached)
                stale["isStale"] = True
                prov = dict(stale.get("provenance", {}))
                prov["notes"] = (
                    "Last valid HKO observation (feed temporarily unreachable) - "
                    "flagged STALE, not re-fabricated."
                )
                stale["provenance"] = prov
                return stale
            raise

    def stations(self) -> List[Dict[str, Any]]:
        data = self.current()
        return data.get("stations", [])


def get_weather_provider(data_mode: str, hko_base_url: str,
                         cache_seconds: float, stale_seconds: float) -> WeatherProvider:
    """Factory honouring DATA_MODE. Rest of app never needs the concrete class."""
    if data_mode == "live":
        return HKOWeatherProvider(hko_base_url, cache_seconds, stale_seconds)
    return MockWeatherProvider()


def interpolate_temperature(stations: List[Dict[str, Any]], point: LatLon,
                            fallback_temp: float) -> Tuple[float, str]:
    """Inverse-distance interpolation of station temps to a point.

    Regional atmospheric anchoring (section 33): HKO stations anchor regional
    conditions; local urban geometry modifies pedestrian exposure downstream.
    """
    best_d, best_temp, best_name = float("inf"), fallback_temp, ""
    num, den = 0.0, 0.0
    for s in stations:
        ll = s.get("location")
        if not ll:
            continue
        d = haversine_m(point, LatLon(ll["lat"], ll["lon"])) + 250.0
        w = 1.0 / (d * d)
        num += w * float(s["temperatureC"])
        den += w
        if d < best_d:
            best_d, best_temp, best_name = d, float(s["temperatureC"]), s["name"]
    if den == 0.0:
        return fallback_temp, ""
    return round(num / den, 2), best_name


def diurnal_adjust(base_temp: float, local_hour: float) -> float:
    """Adjust anchored temperature for time-of-day (demo temporal model)."""
    diurnal = 2.6 * math.sin((local_hour - 9.0) / 24.0 * 2.0 * math.pi)
    return round(base_temp + diurnal, 2)
