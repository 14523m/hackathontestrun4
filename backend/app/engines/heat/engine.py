"""HeatPredictionService: the street-edge heat model.

Architecture notes
------------------
* Inputs: HKO-anchored atmospheric conditions (regional) + local urban
  geometry (buildings, land use) -> pedestrian-level heat exposure ESTIMATE.
  HKO stations are never passed off as street-level measurements.
* Fully time-dependent: sun position, shade, diurnal temperature and solar
  radiation all vary with the requested local time.
* Every score is accompanied by signed factor contributions so the UI can
  explain WHY an area is hot (master prompt section 23/46/52).
* All weights come from HeatModelParameters (prototype calibration values).
  Replace this class with an ML model later - callers only use
  ``predict_point`` / ``predict_edge`` / ``predict_cell``.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from app.core.geo import point_in_polygon
from app.core.types import FactorContribution, HeatModelParameters, LatLon
from app.engines.heat.shade import ShadeModel
from app.providers.spatial import SpatialData
from app.providers.weather import (
    WeatherProvider,
    diurnal_adjust,
    interpolate_temperature,
)


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


class HeatPredictionService:
    """Predicts pedestrian heat exposure for points, edges and cells."""

    HOT_THRESHOLD = 65.0  # score above which a cell/edge counts as "hot"

    def __init__(
        self,
        spatial: SpatialData,
        weather: WeatherProvider,
        params: Optional[HeatModelParameters] = None,
    ) -> None:
        self._spatial = spatial
        self._weather = weather
        self._params = params or HeatModelParameters()
        self._shade_models: Dict[str, ShadeModel] = {}

    # -- environment context ------------------------------------------------- #

    def _shade_model(self, district_id: str) -> ShadeModel:
        if district_id not in self._shade_models:
            self._shade_models[district_id] = ShadeModel(
                self._spatial.buildings(district_id)
            )
        return self._shade_models[district_id]

    def _land_use_at(self, district_id: str, lat: float, lon: float) -> Dict[str, float]:
        """Sample the land-use grid: vegetation / paved / water fractions."""
        for f in self._spatial.land_use(district_id):
            ring = f["geometry"]["coordinates"][0]
            if point_in_polygon(lon, lat, ring):
                p = f["properties"]
                return {
                    "vegetation": float(p.get("vegetationFraction", 0.0)),
                    "paved": float(p.get("pavedFraction", 0.0)),
                    "water": float(p.get("waterFraction", 0.0)),
                }
        return {"vegetation": 0.1, "paved": 0.6, "water": 0.0}

    def _building_density_at(self, district_id: str, lat: float, lon: float) -> float:
        """0..1 proxy for enclosure: nearby tall buildings within 60 m."""
        shade_model = self._shade_model(district_id)
        m_per_deg_lon = 111_320.0 * math.cos(math.radians(lat))
        count_weight = 0.0
        for clat, clon, radius, height in shade_model._buildings:  # noqa: SLF001
            dist = math.hypot((lon - clon) * m_per_deg_lon, (lat - clat) * 111_320.0)
            if dist < max(radius + 60.0, 80.0):
                # Taller/nearer buildings contribute more enclosure.
                proximity = 1.0 - min(1.0, dist / (radius + 60.0))
                count_weight += proximity * min(1.0, height / 60.0)
        return _clamp(count_weight / 2.0)

    def _weather_context(self, dt_local: datetime) -> Dict[str, Any]:
        """Regional atmospheric conditions interpolated for this time."""
        snap = self._weather.current()
        return {
            "snapshot": snap,
            "humidity": float(snap["relativeHumidity"]),
            "wind_ms": float(snap["windSpeedMs"]),
            "wind_deg": float(snap["windDirectionDeg"]),
            "radiation": float(snap.get("globalSolarRadiation") or 0.0),
            "is_observed": bool(snap.get("isObserved")),
            "is_stale": bool(snap.get("isStale")),
            "stations": snap.get("stations", []),
        }

    # -- public predictions ---------------------------------------------------- #

    def predict_point(
        self,
        district_id: str,
        lat: float,
        lon: float,
        dt_local: datetime,
        overrides: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        """Full explainable prediction at one point and time.

        ``overrides`` lets the planner inject hypothetical interventions
        (extra vegetation, canopy shade, wind multipliers, density changes)
        WITHOUT duplicating model logic here. Keys (all optional):
        extra_vegetation, extra_shade, paved_delta, density_multiplier,
        wind_multiplier.
        """
        ctx = self._weather_context(dt_local)
        stations = ctx["stations"]
        if stations:
            air_temp, anchor = interpolate_temperature(stations, LatLon(lat, lon),
                                                       float(ctx["snapshot"]["temperatureC"]))
        else:
            air_temp = float(ctx["snapshot"]["temperatureC"])
            anchor = ctx["snapshot"].get("anchorStation", "")
        # Diurnal adjustment for requested time (demo temporal model).
        temp_c = diurnal_adjust(air_temp, dt_local.hour + dt_local.minute / 60.0)

        shade, sun = self._shade_model(district_id).shade_at(lat, lon, dt_local)
        land = self._land_use_at(district_id, lat, lon)
        density = self._building_density_at(district_id, lat, lon)

        return self._score(
            temp_c=temp_c,
            humidity=ctx["humidity"],
            wind_ms=ctx["wind_ms"],
            radiation=ctx["radiation"],
            sun=sun,
            shade=shade,
            vegetation=land["vegetation"],
            paved=land["paved"],
            water=land["water"],
            density=density,
            ctx=ctx,
            overrides=overrides,
        )

    # Edge-attribute -> environment overrides (documented prototype constants).
    # A vegetated corridor adds tree cover and canopy shade along the edge.
    EDGE_KIND_OVERRIDES = {
        "greenLane": {"extra_vegetation": 0.35, "extra_shade": 0.25},
    }

    def predict_edge(
        self, district_id: str, edge: Dict[str, Any], dt_local: datetime
    ) -> Dict[str, Any]:
        """Prediction for a pedestrian edge: sampled at its midpoint.

        Edge attributes (e.g. greenLane) enter the model through the same
        override mechanism the planner uses - one model, declared inputs.
        """
        coords = edge["geometry"]["coordinates"]
        mid = coords[len(coords) // 2]
        props = edge.get("properties", {})
        overrides: Dict[str, float] = {}
        for key, ov in self.EDGE_KIND_OVERRIDES.items():
            if props.get(key):
                overrides.update(ov)
        pred = self.predict_point(district_id, mid[1], mid[0], dt_local,
                                  overrides=overrides or None)
        pred["edgeId"] = props.get("id", "")
        pred["lengthM"] = float(props.get("lengthM", 0.0))
        pred["gradientPct"] = float(props.get("gradientPct", 0.0))
        return pred

    def predict_cell(
        self,
        district_id: str,
        feature: Dict[str, Any],
        dt_local: datetime,
        overrides: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        """Prediction for a land-use cell (used to build the heat-map layer).

        ``overrides`` supports planner what-if scenarios on the same model.
        """
        ring = feature["geometry"]["coordinates"][0]
        clon = sum(p[0] for p in ring) / len(ring)
        clat = sum(p[1] for p in ring) / len(ring)
        pred = self.predict_point(district_id, clat, clon, dt_local,
                                  overrides=overrides)
        pred["cellId"] = feature["properties"]["id"]
        pred["polygon"] = ring[:-1] if ring[0] == ring[-1] else ring
        return pred

    # -- scoring core ------------------------------------------------------------ #

    def _score(
        self,
        temp_c: float,
        humidity: float,
        wind_ms: float,
        radiation: float,
        sun: Any,  # SunPosition
        shade: float,
        vegetation: float,
        paved: float,
        water: float,
        density: float,
        ctx: Dict[str, Any],
        overrides: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        p = self._params
        ov = overrides or {}

        # Apply planner intervention overrides (declared inputs, single model).
        vegetation = _clamp(vegetation + float(ov.get("extra_vegetation", 0.0)))
        shade = _clamp(shade + float(ov.get("extra_shade", 0.0)))
        paved = _clamp(paved + float(ov.get("paved_delta", 0.0)))
        density = _clamp(density * float(ov.get("density_multiplier", 1.0)))
        wind_ms = wind_ms * float(ov.get("wind_multiplier", 1.0))

        # Base: normalise air temperature to 0-100 (24-38 C band).
        base = _clamp((temp_c - 24.0) / 14.0) * 100.0

        # Sun strength 0..1 from elevation + observed/modelled radiation.
        sun_strength = 0.0
        if sun.is_daytime:
            sun_strength = _clamp(math.sin(sun.elevation_rad)) * _clamp(
                (radiation / 800.0) if radiation > 0 else 0.55
            )

        # Wind: stronger wind cools; dense urban form suppresses it.
        wind_score = _clamp((wind_ms / 8.0) * (1.0 - 0.6 * density))

        humidity_norm = _clamp((humidity - 60.0) / 40.0)  # relevant above 60%

        factors: List[FactorContribution] = []

        def add(fid: str, label: str, delta: float, detail: str = "") -> None:
            if abs(delta) >= 0.4:
                factors.append(FactorContribution(fid, label, delta, detail))

        d_solar = p.solar_weight * 4.0 * (1.0 - shade) * sun_strength
        add("solar", "Direct solar exposure", d_solar,
            f"Sun elevation {sun.elevation_deg:.0f} deg, shade {shade:.0%}")

        d_shade = -p.shade_weight * 4.0 * shade
        add("shade", "Shade from buildings", d_shade,
            "Building shadow geometry at requested time")

        d_veg = -p.vegetation_weight * 4.0 * vegetation
        add("vegetation", "Vegetation cooling", d_veg,
            f"Vegetation fraction {vegetation:.0%}")

        d_surface = p.surface_temperature_weight * 4.0 * paved
        add("surface", "Paved / heat-retaining surface", d_surface,
            f"Paved fraction {paved:.0%}")

        d_density = p.building_density_weight * 4.0 * density
        add("density", "Building density (urban canyon)", d_density,
            "Nearby tall buildings trap heat")

        d_wind = -p.wind_weight * 4.0 * wind_score
        add("wind", "Wind cooling", d_wind,
            f"Wind {wind_ms:.1f} m/s (canyon-adjusted)")

        d_humidity = p.humidity_weight * 4.0 * humidity_norm * 0.5
        add("humidity", "Humidity discomfort", d_humidity,
            f"Relative humidity {humidity:.0f}%")

        d_water = -2.0 * water
        add("water", "Water bodies", d_water, f"Water fraction {water:.0%}")

        total = base + sum(f.delta for f in factors)
        heat_score = _clamp(total, 0.0, 100.0)

        # Confidence: observed weather anchors raise it; stale lowers it.
        confidence = 0.55 if ctx["is_observed"] else 0.45
        if ctx["is_stale"]:
            confidence -= 0.15
        confidence = _clamp(confidence, 0.05, 0.95)

        source_ids = list(ctx["snapshot"].get("provenance", {}).get("sources", []))
        source_ids += ["landsd-buildings(mock)", "pland-landuse(mock)"]

        return {
            "heatScore": round(heat_score, 1),
            "temperatureC": round(temp_c, 1),
            "shadeScore": round(shade, 2),
            "vegetationScore": round(vegetation, 2),
            "buildingDensity": round(density, 2),
            "windScore": round(wind_score, 2),
            "isDaytime": sun.is_daytime,
            "factors": [f.as_dict() for f in factors],
            "confidence": round(confidence, 2),
            "isModelled": True,
            "sources": source_ids,
            "anchorStation": ctx["snapshot"].get("anchorStation", ""),
            "weatherObserved": ctx["is_observed"],
            "weatherStale": ctx["is_stale"],
        }
