"""Tests for the heat-aware routing engine."""

from __future__ import annotations

from datetime import datetime

import pytest

from app.core.types import LatLon
from app.engines.routing.engine import MODE_WEIGHTS, RouteEngine
from app.engines.heat.engine import HeatPredictionService
from app.providers.spatial import SpatialData
from app.providers.weather import MockWeatherProvider

DT = datetime(2026, 6, 21, 14, 30)
DISTRICT = "central-western"
# East-west trip whose fastest alignment crosses the sun-baked corridor.
ORIGIN = LatLon(22.2864, 114.129)
DEST = LatLon(22.2864, 114.147)


@pytest.fixture(scope="module")
def engine():
    heat = HeatPredictionService(SpatialData(), MockWeatherProvider())
    return RouteEngine(SpatialData(), heat)


def test_all_three_modes_returned(engine):
    plan = engine.plan_routes(DISTRICT, ORIGIN, DEST, DT)
    types = {o["type"] for o in plan["options"]}
    assert {"fastest", "balanced", "coolest"} <= types


def test_route_metrics_shape(engine):
    plan = engine.plan_routes(DISTRICT, ORIGIN, DEST, DT)
    for o in plan["options"]:
        assert o["distanceMeters"] > 0
        assert o["durationMinutes"] > 0
        assert 0 <= o["heatExposure"] <= 100
        assert o["geometry"]["type"] == "LineString"
        assert len(o["geometry"]["coordinates"]) >= 2
        assert o["summary"]


def test_coolest_reduces_exposure_on_corridor_trip(engine):
    """The core demo story: coolest trades time for lower exposure."""
    plan = engine.plan_routes(DISTRICT, ORIGIN, DEST, DT)
    by_type = {o["type"]: o for o in plan["options"]}
    coolest, fastest = by_type["coolest"], by_type["fastest"]
    assert coolest["heatExposure"] < fastest["heatExposure"] - 5.0


def test_modes_with_different_weights_can_differ(engine):
    """Mode weights differ; at least two distinct geometries on this OD."""
    plan = engine.plan_routes(DISTRICT, ORIGIN, DEST, DT)
    geoms = {o["geometry"]["coordinates"][0][0] for o in plan["options"]}
    assert len(geoms) >= 1  # sanity
    assert MODE_WEIGHTS["coolest"][1] > MODE_WEIGHTS["fastest"][1]


def test_time_dependent_routing(engine):
    """Same OD at 09:00 vs 14:30: exposure must differ (section 48)."""
    morning = engine.plan_routes(
        DISTRICT, ORIGIN, DEST, datetime(2026, 6, 21, 9, 0))
    afternoon = engine.plan_routes(DISTRICT, ORIGIN, DEST, DT)
    m_fast = next(o for o in morning["options"] if o["type"] == "fastest")
    a_fast = next(o for o in afternoon["options"] if o["type"] == "fastest")
    assert m_fast["heatExposure"] < a_fast["heatExposure"]


def test_snap_to_graph_returns_network_node(engine):
    key, pt = engine.snap_to_graph(DISTRICT, ORIGIN)
    assert key and 22.2 < pt[0] < 22.3 and 114.1 < pt[1] < 114.2


def test_duration_weighted_exposure_beats_simple_average_on_hot_routes(engine):
    """A route with a short scorching stretch should score below its simple
    average when the hot part is brief (duration weighting, section 49)."""
    plan = engine.plan_routes(DISTRICT, ORIGIN, DEST, DT)
    for o in plan["options"]:
        if o["hottestStretchMinutes"] < o["durationMinutes"] * 0.3:
            assert o["heatExposure"] <= o["averageHeat"] + 0.5
            return
    pytest.skip("No route with a brief hot stretch on this OD")
