"""Tests for providers: deterministic weather, cooling spots, CityBrain seam."""

from __future__ import annotations

from datetime import datetime

from app.core.solar import timezone_fixed
from app.providers.citybrain import MockCityBrainProvider
from app.providers.cooling import CoolingSpotProvider, CrowdReportProvider
from app.providers.spatial import SpatialData
from app.providers.weather import MockWeatherProvider, interpolate_temperature


def test_mock_weather_is_deterministic():
    a = MockWeatherProvider().current(datetime(2026, 6, 21, 12, 0,
                                              tzinfo=timezone_fixed(8.0)))
    b = MockWeatherProvider().current(datetime(2026, 6, 21, 12, 0,
                                              tzinfo=timezone_fixed(8.0)))
    assert a == b


def test_mock_weather_diurnal_cycle():
    p = MockWeatherProvider()
    noon = p.current(datetime(2026, 6, 21, 14, 0, tzinfo=timezone_fixed(8.0)))
    night = p.current(datetime(2026, 6, 21, 23, 0, tzinfo=timezone_fixed(8.0)))
    assert noon["temperatureC"] > night["temperatureC"]
    assert noon["globalSolarRadiation"] > 0
    assert night["globalSolarRadiation"] == 0
    assert noon["isObserved"] is False  # clearly labelled simulated


def test_interpolate_temperature_idw():
    stations = [
        {"name": "A", "location": {"lat": 22.30, "lon": 114.17},
         "temperatureC": 30.0},
        {"name": "B", "location": {"lat": 22.45, "lon": 114.10},
         "temperatureC": 28.0},
    ]
    from app.core.types import LatLon
    near_a, anchor = interpolate_temperature(stations, LatLon(22.301, 114.172),
                                             29.0)
    assert near_a >= 29.8  # dominated by nearby station A
    assert anchor == "A"


def test_cooling_spots_normalised():
    provider = CoolingSpotProvider(SpatialData())
    spots = provider.list("central-western")
    assert spots
    for s in spots:
        assert {"id", "name", "location", "type", "coolingLevel"} <= set(s)
        assert 1 <= s["coolingLevel"] <= 3


def test_nearest_cooling_spot_sorted():
    provider = CoolingSpotProvider(SpatialData())
    near = provider.nearest(22.286, 114.136, limit=3,
                            district_id="central-western")
    assert len(near) == 3
    dists = [s["distanceMeters"] for s in near]
    assert dists == sorted(dists)


def test_crowd_reports_anonymised():
    provider = CrowdReportProvider(SpatialData())
    reports = provider.list("kowloon-yau-tsim")
    assert reports
    for r in reports:
        assert r["anonymised"] is True
        assert "userId" not in r and "user_id" not in r


def test_citybrain_mock_declares_simulation():
    cap = MockCityBrainProvider().capability_statement()
    assert cap["isSimulated"] is True
    assert cap["integrationRequirements"]
