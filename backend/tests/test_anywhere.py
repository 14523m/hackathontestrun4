"""Tests for anywhere-in-HK heat queries and the published thermal equations."""

from __future__ import annotations

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.engines.heat.anywhere import AnywhereHeatService
from app.engines.heat.thermal import (
    clear_sky_fluxes,
    stull_wet_bulb_c,
    steadman_at_c,
    vapour_pressure_hpa,
    wbgt_shade_c,
)
from app.core.solar import solar_position
from app.main import app
from app.providers.spatial import SpatialData
from app.providers.weather import MockWeatherProvider

MONG_KOK = (22.319, 114.169)
HARBOUR_OPEN = (22.295, 114.145)


@pytest.fixture(scope="module")
def service():
    return AnywhereHeatService(SpatialData(), MockWeatherProvider())


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


# -- published equations ---------------------------------------------------- #


def test_steadman_at_exact_formula():
    # AT = Ta + 0.33 e - 0.70 ws - 4.00 (Steadman 1984).
    e = vapour_pressure_hpa(30.0, 70.0)
    assert steadman_at_c(30.0, e, 2.0) == pytest.approx(
        30.0 + 0.33 * e - 0.70 * 2.0 - 4.00, abs=1e-9
    )


def test_stull_wet_bulb_bounds_and_monotonicity():
    tw_dry = stull_wet_bulb_c(32.0, 50.0)
    tw_humid = stull_wet_bulb_c(32.0, 90.0)
    assert 0 < tw_dry < 32.0  # wet-bulb below air temp, above zero
    assert tw_humid > tw_dry  # more humidity -> higher wet-bulb
    assert tw_humid < 32.0


def test_wbgt_shade_formula():
    e = vapour_pressure_hpa(30.0, 80.0)
    assert wbgt_shade_c(30.0, e) == pytest.approx(0.567 * 30.0 + 0.393 * e + 3.94)


def test_clear_sky_fluxes_day_vs_night():
    noon = solar_position(datetime(2026, 6, 21, 12, 0), 22.30, 114.17)
    night = solar_position(datetime(2026, 6, 21, 23, 0), 22.30, 114.17)
    day = clear_sky_fluxes(noon)
    assert day.global_horizontal > 500.0
    assert 0 < day.diffuse < day.global_horizontal
    assert clear_sky_fluxes(night).global_horizontal == 0.0


# -- anywhere point queries -------------------------------------------------- #


def test_point_anywhere_returns_published_metrics(service):
    pred = service.predict_point(*MONG_KOK, datetime(2026, 6, 21, 14, 30))
    for key in (
        "heatScore", "apparentTemperatureShadeC", "apparentTemperatureSunC",
        "wetBulbC", "wbgtShadeC", "meanRadiantTempC", "skyViewFactor",
        "shadeScore", "factors",
    ):
        assert key in pred
    assert 0.0 <= pred["heatScore"] <= 100.0
    assert 0.05 <= pred["skyViewFactor"] <= 1.0
    assert len(pred["factors"]) >= 4


def test_point_is_time_dependent(service):
    morning = service.predict_point(*MONG_KOK, datetime(2026, 6, 21, 9, 0))
    afternoon = service.predict_point(*MONG_KOK, datetime(2026, 6, 21, 15, 0))
    assert afternoon["heatScore"] > morning["heatScore"]


def test_point_outside_hk_rejected(service):
    with pytest.raises(ValueError):
        service.predict_point(1.0, 103.0, datetime(2026, 6, 21, 12, 0))


def test_open_sky_hotter_than_deep_canyon(service):
    """Same weather: open harbour front beats a shaded street canyon on MRT."""
    noon = datetime(2026, 6, 21, 12, 30)
    open_p = service.predict_point(*HARBOUR_OPEN, noon)
    canyon = service.predict_point(*MONG_KOK, noon)
    assert open_p["meanRadiantTempC"] > canyon["meanRadiantTempC"]


# -- viewport field ----------------------------------------------------------- #


def test_viewport_returns_grid_of_real_evaluations(service):
    field = service.viewport_field(
        22.30, 114.15, 22.33, 114.19, datetime(2026, 6, 21, 14, 30)
    )
    assert field["cols"] >= 2 and field["rows"] >= 2
    assert len(field["cells"]) <= 220
    assert len(field["cells"]) == field["cols"] * field["rows"]
    scores = {c["heatScore"] for c in field["cells"]}
    assert len(scores) > 1  # real independent evaluations, not copies
    for c in field["cells"]:
        assert 0.0 <= c["heatScore"] <= 100.0
        assert len(c["polygon"]) == 4


def test_heat_point_endpoint(client):
    r = client.get("/heat/point", params={"lat": 22.319, "lon": 114.169,
                                          "hour": 14.5})
    assert r.status_code == 200
    body = r.json()
    assert "meanRadiantTempC" in body and "skyViewFactor" in body
    assert body["isModelled"] is True


def test_heat_point_endpoint_rejects_outside_hk(client):
    r = client.get("/heat/point", params={"lat": 1.0, "lon": 103.0})
    assert r.status_code == 422


def test_heatmap_viewport_endpoint(client):
    r = client.get("/heatmap/viewport", params={
        "south": 22.30, "west": 114.15, "north": 22.33, "east": 114.19,
        "hour": 14.5,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["cols"] * body["rows"] == len(body["cells"])
    assert body["provenance"]["modelled"] is True
