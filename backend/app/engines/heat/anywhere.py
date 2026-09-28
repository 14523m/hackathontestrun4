"""Anywhere-in-Hong-Kong heat predictions: point queries and viewport fields.

The district HeatMapService stays as-is (flagship curated layers). This
service answers "how hot is it right HERE" for ANY coordinate inside the HK
bounding region, using:

- the global building index (SpatialData.buildings_near) for shadow wedges
  and the Steyn ring-meridian sky-view factor,
- containing/nearest land-use cells (SpatialData.land_use_near) for
  vegetation / paving / water fractions,
- HKO-style regional weather anchoring + diurnal adjustment,
- published thermal equations from app.engines.heat.thermal (Steadman AT,
  Stull wet-bulb, ABM WBGT, Thorsson MRT).

Every value stays modelled: geometry + published first-order physics, not
sensor measurements.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.core.geo import in_hong_kong, point_in_polygon
from app.core.solar import timezone_fixed
from app.core.types import LatLon
from app.engines.heat.shade import M_PER_DEG_LAT, ShadeModel
from app.engines.heat.thermal import (
    body_net_radiation_wm2,
    clear_sky_fluxes,
    mean_radiant_temp_c,
    steadman_at_c,
    steadman_at_sun_c,
    stull_wet_bulb_c,
    vapour_pressure_hpa,
    wbgt_shade_c,
)
from app.providers.spatial import SpatialData
from app.providers.weather import diurnal_adjust

# Urban-canyon wind sheltering: measured 10 m wind vs pedestrian level.
WIND_CANYON_FACTOR = 0.5  # pedestrian wind ~50 % of regional (open) wind
CELL_M = 60.0  # viewport grid resolution (approx metres)


def _default_land() -> Dict[str, float]:
    return {"vegetation": 0.1, "paved": 0.6, "water": 0.0}


class AnywhereHeatService:
    """Heat predictions at any HK coordinate, independent of district files."""

    HOT_THRESHOLD = 65.0

    def __init__(self, spatial: SpatialData, weather) -> None:  # noqa: ANN001
        self._spatial = spatial
        self._weather = weather
        self._shade_models: Dict[str, ShadeModel] = {}

    # -- context -------------------------------------------------------------- #

    def _land_at(self, lat: float, lon: float) -> Dict[str, float]:
        """Vegetation/paved/water from the containing cell, else nearest centre."""
        cells = self._spatial.land_use_near(lat, lon, radius_m=250.0)
        best: Optional[dict] = None
        best_d = float("inf")
        m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(lat))
        for f in cells:
            ring = f["geometry"]["coordinates"][0]
            if point_in_polygon(lon, lat, ring):
                best = f
                break
            clat = sum(p[1] for p in ring) / len(ring)
            clon = sum(p[0] for p in ring) / len(ring)
            d = math.hypot((clon - lon) * m_per_deg_lon, (clat - lat) * M_PER_DEG_LAT)
            if d < best_d:
                best, best_d = f, d
        if best is None:
            return _default_land()
        p = best["properties"]
        return {
            "vegetation": float(p.get("vegetationFraction", 0.0)),
            "paved": float(p.get("pavedFraction", 0.0)),
            "water": float(p.get("waterFraction", 0.0)),
        }

    def _context(self, lat: float, lon: float, dt_local: datetime) -> Dict[str, Any]:
        snap = self._weather.current()
        stations = snap.get("stations", [])
        if stations:
            air_temp, anchor = _interpolate(stations, lat, lon,
                                            float(snap["temperatureC"]))
        else:
            air_temp, anchor = float(snap["temperatureC"]), snap.get("anchorStation", "")
        temp_c = diurnal_adjust(air_temp, dt_local.hour + dt_local.minute / 60.0)
        return {
            "snapshot": snap,
            "tempC": temp_c,
            "humidity": float(snap["relativeHumidity"]),
            "wind_ms": float(snap["windSpeedMs"]) * WIND_CANYON_FACTOR,
            "anchor": anchor,
        }

    # -- point prediction ------------------------------------------------------ #

    def predict_point(
        self,
        lat: float,
        lon: float,
        dt_local: datetime,
        overrides: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        if not in_hong_kong(lat, lon):
            raise ValueError("coordinate outside the Hong Kong bounding region")

        ov = overrides or {}
        ctx = self._context(lat, lon, dt_local)

        # Geometry: shadows + sky-view from the global building index.
        model = self._model_for(lat, lon)
        shade, sun = model.shade_at(lat, lon, dt_local)
        svf = model.svf_at(lat, lon)
        shade = min(1.0, shade + float(ov.get("extra_shade", 0.0)))
        land = self._land_at(lat, lon)
        vegetation = min(1.0, land["vegetation"] + float(ov.get("extra_vegetation", 0.0)))
        paved = min(1.0, max(0.0, land["paved"] + float(ov.get("paved_delta", 0.0))))
        water = land["water"]
        density = model.enclosure_at(lat, lon)
        wind_ms = ctx["wind_ms"] * float(ov.get("wind_multiplier", 1.0))

        # Published-equation thermal metrics.
        fluxes = clear_sky_fluxes(sun)
        mrt_c = mean_radiant_temp_c(
            ctx["tempC"], ctx["humidity"], fluxes, shade, svf, sun.elevation_deg
        )
        e_hpa = vapour_pressure_hpa(ctx["tempC"], ctx["humidity"])
        tw_c = stull_wet_bulb_c(ctx["tempC"], ctx["humidity"])
        at_shade = steadman_at_c(ctx["tempC"], e_hpa, wind_ms)
        q_body = body_net_radiation_wm2(mrt_c)
        at_sun = steadman_at_sun_c(ctx["tempC"], e_hpa, wind_ms, q_body)
        wbgt = wbgt_shade_c(ctx["tempC"], e_hpa)

        # Explainable 0-100 exposure score, same scale as the district model:
        # Steadman's AT is defined on the shade state, so ATshade sets the
        # level; radiation enters as a bounded bonus from the SAME MRT fluxes
        # (mapping raw ATsun onto 0-100 saturates and kills the gradient).
        base = max(0.0, min(100.0, (at_shade - 24.0) / 21.0 * 100.0))
        radiation_bonus = 0.0
        if sun.is_daytime and shade < 0.9:
            radiation_bonus = (1.0 - shade) * (svf ** 0.5) * min(14.0, 0.016 * q_body)
        d_veg = -4.0 * vegetation
        d_water = -4.0 * water
        d_wind = -3.0 * min(1.0, wind_ms / 6.0)
        heat_score = max(0.0, min(100.0,
            base + radiation_bonus + d_veg + d_water + d_wind))

        snap = ctx["snapshot"]
        factors: List[Dict[str, Any]] = [
            {"factorId": "air_temperature",
             "label": "Air temperature (HKO-anchored)",
             "delta": round(max(0.0, base - 40.0), 1),
             "detail": f"{ctx['tempC']:.1f} C interpolated from HKO stations"},
            {"factorId": "radiation",
             "label": "Mean radiant temperature (Thorsson 2007)",
             "delta": round(radiation_bonus, 1),
             "detail": f"MRT {mrt_c:.0f} C, sun {sun.elevation_deg:.0f} deg up"},
            {"factorId": "sky_view",
             "label": "Sky-view factor (Steyn 1980)",
             "delta": round(0.0, 1),
             "detail": f"SVF {svf:.2f} - folded into the radiation term"},
            {"factorId": "vegetation",
             "label": "Vegetation cooling",
             "delta": round(d_veg, 1),
             "detail": f"Vegetation fraction {vegetation:.0%}"},
            {"factorId": "humidity",
             "label": "Humidity (Stull wet-bulb)",
             "delta": round(min(6.0, max(0.0, (tw_c - 24.0))), 1),
             "detail": f"RH {ctx['humidity']:.0f}%, wet-bulb {tw_c:.1f} C"},
            {"factorId": "wind",
             "label": "Wind cooling (canyon-adjusted)",
             "delta": round(d_wind, 1),
             "detail": f"{wind_ms:.1f} m/s at pedestrian level"},
        ]

        return {
            "heatScore": round(heat_score, 1),
            "temperatureC": round(ctx["tempC"], 1),
            "apparentTemperatureShadeC": round(at_shade, 1),
            "apparentTemperatureSunC": round(at_sun, 1),
            "wetBulbC": round(tw_c, 1),
            "wbgtShadeC": round(wbgt, 1),
            "meanRadiantTempC": round(mrt_c, 1),
            "skyViewFactor": round(svf, 2),
            "shadeScore": round(shade, 2),
            "vegetationScore": round(vegetation, 2),
            "buildingDensity": round(density, 2),
            "windScore": round(min(1.0, wind_ms / 8.0), 2),
            "isDaytime": sun.is_daytime,
            "districtId": self._spatial.locate(lat, lon),
            "factors": factors,
            "confidence": 0.6 if snap.get("isObserved") else 0.45,
            "isModelled": True,
            "sources": list(snap.get("provenance", {}).get("sources", []))
            + ["landsd-buildings(mock)", "pland-landuse(mock)"],
            "anchorStation": ctx["anchor"],
            "weatherObserved": bool(snap.get("isObserved")),
            "weatherStale": bool(snap.get("isStale")),
        }

    # -- viewport field --------------------------------------------------------- #

    def viewport_field(
        self,
        south: float,
        west: float,
        north: float,
        east: float,
        dt_local: datetime,
        max_cells: int = 220,
    ) -> Dict[str, Any]:
        """Grid of predictions covering a map viewport (free-pan heat layer).

        Resolution adapts so any zoom level returns at most ``max_cells``
        predictions - each one a real physics evaluation, never interpolated.
        """
        if not (in_hong_kong(south, west) and in_hong_kong(north, east)):
            raise ValueError("viewport outside the Hong Kong bounding region")
        south, north = min(south, north), max(south, north)
        west, east = min(west, east), max(west, east)

        lat_mid = (south + north) / 2.0
        width_m = (east - west) * M_PER_DEG_LAT * math.cos(math.radians(lat_mid))
        height_m = (north - south) * M_PER_DEG_LAT
        aspect = max(width_m, 1.0) / max(height_m, 1.0)
        cols = max(2, min(20, int(round(math.sqrt(max_cells * aspect)))))
        rows = max(2, min(20, int(round(max_cells / cols))))
        if cols * rows > max_cells:  # rounding drift: clamp back under the cap
            rows = max(2, max_cells // cols)
        cols, rows = min(cols, max(2, int(width_m // CELL_M) or 2)), min(
            rows, max(2, int(height_m // CELL_M) or 2)
        )

        cells: List[Dict[str, Any]] = []
        for i in range(rows):
            lat = south + (north - south) * (i + 0.5) / rows
            for j in range(cols):
                lon = west + (east - west) * (j + 0.5) / cols
                try:
                    pred = self.predict_point(lat, lon, dt_local)
                except ValueError:
                    continue
                d_lat = (north - south) / rows
                d_lon = (east - west) / cols
                pred["cellId"] = f"vp-{i}-{j}"
                pred["polygon"] = [
                    [lon - d_lon / 2, lat - d_lat / 2],
                    [lon + d_lon / 2, lat - d_lat / 2],
                    [lon + d_lon / 2, lat + d_lat / 2],
                    [lon - d_lon / 2, lat + d_lat / 2],
                ]
                cells.append(pred)

        snap = self._weather.current()
        return {
            "generatedAt": datetime.utcnow().isoformat() + "Z",
            "validFor": dt_local.isoformat(),
            "dataMode": "viewport",
            "isStale": bool(snap.get("isStale")),
            "districtId": None,
            "bounds": {"south": south, "west": west, "north": north, "east": east},
            "cols": cols,
            "rows": rows,
            "cells": cells,
            "legend": {
                "0-40": "Comfortable - generous shade / vegetation",
                "40-55": "Warm - moderate exposure",
                "55-70": "Hot - seek shade, hydrate",
                "70-100": "Very hot - avoid prolonged exposure",
            },
            "provenance": {
                "sources": ["hko-or-mock-weather", "landsd-buildings(mock)",
                            "pland-landuse(mock)", "steyn1980-svf",
                            "thorsson2007-mrt", "steadman1984-at", "stull2011-wetbulb"],
                "observed": bool(snap.get("isObserved")),
                "modelled": True,
                "confidence": 0.6 if snap.get("isObserved") else 0.45,
                "notes": (
                    "Every cell is an independent physics evaluation at that "
                    "coordinate (shadow geometry, sky-view factor, published "
                    "thermal equations). Modelled estimates, not measurements."
                ),
            },
        }

    # -- helpers ------------------------------------------------------------------ #

    def _model_for(self, lat: float, lon: float) -> "AnywhereShadeModel":
        key = (round(lat, 3), round(lon, 3))
        model = self._shade_models.get(str(key))
        if model is None:
            buildings = self._spatial.buildings_near(lat, lon, radius_m=400.0)
            model = AnywhereShadeModel(buildings)
            self._shade_models[str(key)] = model
        return model


class AnywhereShadeModel(ShadeModel):
    """ShadeModel plus a building-enclosure metric reused from the engine."""

    def enclosure_at(self, lat: float, lon: float) -> float:
        """0..1 urban-canyon enclosure from nearby tall buildings (60 m)."""
        m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(lat))
        weight = 0.0
        for clat, clon, radius, height in self._buildings:
            dist = math.hypot((lon - clon) * m_per_deg_lon, (lat - clat) * M_PER_DEG_LAT)
            if dist < max(radius + 60.0, 80.0):
                proximity = 1.0 - min(1.0, dist / (radius + 60.0))
                weight += proximity * min(1.0, height / 60.0)
        return min(1.0, weight / 2.0)


def _interpolate(stations: List[Dict[str, Any]], lat: float, lon: float,
                 fallback: float):
    """Inverse-distance-squared station interpolation (weather.py helper)."""
    from app.providers.weather import interpolate_temperature

    return interpolate_temperature(stations, LatLon(lat, lon), fallback)


__all__ = ["AnywhereHeatService", "AnywhereShadeModel"]
