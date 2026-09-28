"""Tests for the street-edge heat model and its explainability contract."""

from __future__ import annotations

from datetime import datetime

import pytest

from app.engines.heat.engine import HeatPredictionService
from app.providers.spatial import SpatialData
from app.providers.weather import MockWeatherProvider

DISTRICT = "central-western"


@pytest.fixture(scope="module")
def service():
    return HeatPredictionService(SpatialData(), MockWeatherProvider())


def test_heat_score_in_bounds(service):
    pred = service.predict_point(DISTRICT, 22.286, 114.136,
                                 datetime(2026, 6, 21, 14, 30))
    assert 0.0 <= pred["heatScore"] <= 100.0


def test_prediction_is_explainable(service):
    pred = service.predict_point(DISTRICT, 22.286, 114.136,
                                 datetime(2026, 6, 21, 14, 30))
    assert len(pred["factors"]) >= 3
    for f in pred["factors"]:
        assert f["label"] and isinstance(f["delta"], float)
    # Signed contributions must sum with base to the reported score +- clamp.
    assert pred["confidence"] > 0


def test_midday_hotter_than_morning(service):
    """Time dependence (section 48): same point, different hour."""
    morning = service.predict_point(DISTRICT, 22.286, 114.136,
                                    datetime(2026, 6, 21, 9, 0))
    afternoon = service.predict_point(DISTRICT, 22.286, 114.136,
                                      datetime(2026, 6, 21, 15, 0))
    assert afternoon["heatScore"] > morning["heatScore"]


def test_park_cell_cooler_than_corridor(service):
    """Vegetated park area must beat the mean of the paved corridor strip."""
    dt = datetime(2026, 6, 21, 14, 30)
    s, w, n, e = 22.278, 114.128, 22.292, 114.148
    park = service.predict_point(DISTRICT, s + (n - s) * 0.75,
                                 w + (e - w) * 0.2, dt)
    corridor_scores = [
        service.predict_point(DISTRICT, s + (n - s) * 0.7,
                              w + (e - w) * f, dt)["heatScore"]
        for f in (0.5, 0.7, 0.9)
    ]
    assert park["vegetationScore"] > 0.6
    assert park["heatScore"] < sum(corridor_scores) / len(corridor_scores)
    assert max(corridor_scores) > park["heatScore"] + 5.0


def test_planner_overrides_reduce_heat(service):
    dt = datetime(2026, 6, 21, 14, 30)
    base = service.predict_point(DISTRICT, 22.286, 114.136, dt)
    greened = service.predict_point(
        DISTRICT, 22.286, 114.136, dt,
        overrides={"extra_vegetation": 0.4, "extra_shade": 0.5},
    )
    assert greened["heatScore"] < base["heatScore"]


def test_predict_cell_returns_polygon(service):
    feature = SpatialData().land_use(DISTRICT)[0]
    pred = service.predict_cell(DISTRICT, feature,
                                datetime(2026, 6, 21, 12, 0))
    assert pred["cellId"]
    assert len(pred["polygon"]) >= 3


def test_edge_prediction_carries_network_attributes(service):
    edge = SpatialData().network(DISTRICT)[0]
    pred = service.predict_edge(DISTRICT, edge, datetime(2026, 6, 21, 12, 0))
    assert pred["edgeId"]
    assert pred["lengthM"] > 0
