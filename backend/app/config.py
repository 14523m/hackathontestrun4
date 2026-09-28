"""Application configuration for HK CoolPath AI.

Loaded once at startup from environment variables. See ``.env.example`` for
documented values. ``DATA_MODE`` controls which data providers are active;
the rest of the application never needs to know which mode is running.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent  # backend/app
REPO_ROOT = BACKEND_ROOT.parent.parent  # repo root (contains web/, mobile/)


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    return _env(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    """Runtime settings. All values overridable via environment variables."""

    data_mode: str = _env("DATA_MODE", "demo")
    api_title: str = "HK CoolPath AI API"
    api_version: str = "0.1.0"

    # --- CORS ---
    cors_origins: tuple[str, ...] = ("*",)

    # --- Weather (HKO Open Data) ---
    hko_base_url: str = _env(
        "HKO_BASE_URL",
        "https://data.weather.gov.hk/weatherAPI/opendata/weather.php",
    )
    weather_cache_seconds: float = _env_float("WEATHER_CACHE_SECONDS", 600.0)
    weather_stale_after_seconds: float = _env_float(
        "WEATHER_STALE_AFTER_SECONDS", 21600.0  # 6 h: keep last valid obs, flagged stale
    )

    # --- Static / mock data ---
    static_data_dir: Path = BACKEND_ROOT / "data" / "static"

    # --- Heat model (prototype calibration parameters, documented in docs/architecture.md) ---
    # Weights are tuned so typical urban-form contrasts (shaded street vs
    # open paved corridor) produce a 15-25 point Heat Exposure Score gap -
    # large enough to be visible on the map AND to justify route detours.
    solar_weight: float = _env_float("HEAT_SOLAR_WEIGHT", 7.0)
    shade_weight: float = _env_float("HEAT_SHADE_WEIGHT", 7.0)
    vegetation_weight: float = _env_float("HEAT_VEGETATION_WEIGHT", 5.5)
    surface_temperature_weight: float = _env_float("HEAT_SURFACE_TEMPERATURE_WEIGHT", 4.0)
    wind_weight: float = _env_float("HEAT_WIND_WEIGHT", 2.5)
    humidity_weight: float = _env_float("HEAT_HUMIDITY_WEIGHT", 2.0)
    building_density_weight: float = _env_float("HEAT_BUILDING_DENSITY_WEIGHT", 2.2)

    # --- Route engine mode weights (alpha=travel time, beta=heat, gamma=slope) ---
    fastest_alpha: float = _env_float("ROUTE_FASTEST_ALPHA", 1.0)
    fastest_beta: float = _env_float("ROUTE_FASTEST_BETA", 0.05)
    fastest_gamma: float = _env_float("ROUTE_FASTEST_GAMMA", 0.5)
    balanced_alpha: float = _env_float("ROUTE_BALANCED_ALPHA", 0.6)
    balanced_beta: float = _env_float("ROUTE_BALANCED_BETA", 0.6)
    balanced_gamma: float = _env_float("ROUTE_BALANCED_GAMMA", 0.5)
    coolest_alpha: float = _env_float("ROUTE_COOLEST_ALPHA", 0.2)
    coolest_beta: float = _env_float("ROUTE_COOLEST_BETA", 1.2)
    coolest_gamma: float = _env_float("ROUTE_COOLEST_GAMMA", 0.5)

    # --- Time slider / temporal modelling ---
    max_forecast_hours_ahead: int = int(_env_float("MAX_FORECAST_HOURS_AHEAD", 24))

    # --- Demo hardening ---
    allow_live_calls: bool = _env_bool("ALLOW_LIVE_CALLS", True)

    @property
    def is_demo(self) -> bool:
        return self.data_mode == "demo"

    @property
    def is_live(self) -> bool:
        return self.data_mode == "live"


settings = Settings()
