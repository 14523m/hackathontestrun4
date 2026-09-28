"""Shared cross-section types for HK CoolPath AI.

``HeatModelParameters`` is the configurable interface of the heat engine.
Every physical term of the street-edge heat model is a named weight so the
demo model can later be replaced by an ML model without touching callers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass(frozen=True)
class HeatModelParameters:
    """Prototype calibration parameters for the street-edge heat model.

    These weights are NOT derived from a published scientific model. They are
    documented prototype calibration parameters chosen to produce plausible,
    explainable relative differences. See docs/architecture.md.
    """

    solar_weight: float = 7.0
    shade_weight: float = 7.0
    vegetation_weight: float = 5.5
    surface_temperature_weight: float = 4.0
    wind_weight: float = 2.5
    humidity_weight: float = 2.0
    building_density_weight: float = 2.2

    @classmethod
    def from_settings(cls, settings) -> "HeatModelParameters":  # noqa: ANN001
        return cls(
            solar_weight=settings.solar_weight,
            shade_weight=settings.shade_weight,
            vegetation_weight=settings.vegetation_weight,
            surface_temperature_weight=settings.surface_temperature_weight,
            wind_weight=settings.wind_weight,
            humidity_weight=settings.humidity_weight,
            building_density_weight=settings.building_density_weight,
        )


@dataclass(frozen=True)
class Provenance:
    """Where a piece of data came from and how trustworthy it is."""

    source_ids: Tuple[str, ...] = ()
    observed: bool = False
    modelled: bool = True
    confidence: float = 0.5  # 0..1
    resolution_meters: Optional[float] = None
    notes: str = ""

    def as_dict(self) -> Dict[str, object]:
        return {
            "sources": list(self.source_ids),
            "observed": self.observed,
            "modelled": self.modelled,
            "confidence": round(self.confidence, 2),
            "resolutionMeters": self.resolution_meters,
            "notes": self.notes,
        }


@dataclass(frozen=True)
class FactorContribution:
    """One explainable contributor to a prediction, signed (+ hotter / - cooler)."""

    factor_id: str
    label: str
    delta: float  # signed contribution in score points
    detail: str = ""

    def as_dict(self) -> Dict[str, object]:
        return {
            "factorId": self.factor_id,
            "label": self.label,
            "delta": round(self.delta, 2),
            "detail": self.detail,
        }


@dataclass
class TimeInterpolatedWeather:
    """Atmospheric conditions interpolated to an arbitrary local date-time.

    Anchored on observed HKO station data where available; otherwise
    deterministic seasonal/diurnal simulation (clearly labelled modelled).
    """

    timestamp_iso: str
    temperature_c: float
    humidity_pct: float
    wind_speed_ms: float
    wind_direction_deg: float
    solar_radiation_wm2: float
    is_observed: bool
    is_stale: bool
    anchor_station: str
    provenance: Provenance = field(default_factory=Provenance)


@dataclass(frozen=True)
class LatLon:
    """WGS84 coordinate."""

    lat: float
    lon: float

    def as_tuple(self) -> Tuple[float, float]:
        return (self.lat, self.lon)


@dataclass(frozen=True)
class SunPosition:
    """Solar geometry for a place and time (NOAA approximation)."""

    elevation_deg: float  # angle above horizon; <=0 means sun below horizon
    azimuth_deg: float  # clockwise from north
    is_daytime: bool

    @property
    def elevation_rad(self) -> float:
        import math

        return math.radians(self.elevation_deg)

    @property
    def azimuth_rad(self) -> float:
        import math

        return math.radians(self.azimuth_deg)
