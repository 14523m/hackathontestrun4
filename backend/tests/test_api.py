"""API contract tests (no server needed - FastAPI TestClient)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["dataMode"] == "demo"


def test_districts_include_conceptual_nm(client):
    r = client.get("/districts")
    assert r.status_code == 200
    ids = {d["id"] for d in r.json()}
    assert "northern-metropolis" in ids
    nm = next(d for d in r.json() if d["id"] == "northern-metropolis")
    assert nm["isConceptual"] is True
    assert "CONCEPTUAL" in nm["label"]


def test_routes_contract(client):
    r = client.get(
        "/routes",
        params={"districtId": "central-western", "originLat": 22.2864,
                "originLon": 114.129, "destLat": 22.2864, "destLon": 114.147,
                "hour": 14.5},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["options"]) >= 2
    for o in body["options"]:
        for key in ("id", "type", "label", "emoji", "geometry", "summary",
                    "distanceMeters", "durationMinutes", "heatExposure",
                    "shadeScore"):
            assert key in o, f"missing {key}"
    assert body["provenance"]["modelled"] is True


def test_routes_reject_outside_hk(client):
    r = client.get(
        "/routes",
        params={"districtId": "central-western", "originLat": 1.0,
                "originLon": 103.0, "destLat": 22.2864, "destLon": 114.147},
    )
    assert r.status_code == 422


def test_heatmap_time_dependent(client):
    morning = client.get("/heatmap",
                         params={"districtId": "central-western",
                                 "hour": 9.0})
    afternoon = client.get("/heatmap",
                           params={"districtId": "central-western",
                                   "hour": 15.0})
    assert morning.status_code == afternoon.status_code == 200
    n_cells = morning.json()["cells"]
    a_cells = afternoon.json()["cells"]
    assert n_cells and a_cells
    n_mean = sum(c["heatScore"] for c in n_cells) / len(n_cells)
    a_mean = sum(c["heatScore"] for c in a_cells) / len(a_cells)
    assert a_mean > n_mean


def test_heatmap_cells_explainable(client):
    r = client.get("/heatmap",
                   params={"districtId": "central-western", "hour": 15.0})
    cell = r.json()["cells"][0]
    for key in ("cellId", "heatScore", "factors", "polygon", "confidence"):
        assert key in cell
    assert len(cell["factors"]) >= 1


def test_planner_compare_reduces_heat(client):
    r = client.post(
        "/planner/compare",
        params={"hour": 14.5},
        json={"districtId": "northern-metropolis",
              "interventions": ["add_trees", "add_shaded_corridors"]},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["delta"]["meanHeatScore"] < 0
    assert body["isSimulated"] is True
    assert body["narrative"]


def test_nm_scenario_labelled_conceptual(client):
    r = client.get("/planner/northern-metropolis", params={"hour": 14.0})
    assert r.status_code == 200
    body = r.json()
    assert "CONCEPTUAL" in body["scenarioLabel"]
    assert body["districtId"] == "northern-metropolis"


def test_data_sources_lists_hko(client):
    r = client.get("/config/data-sources")
    assert r.status_code == 200
    body = r.json()
    ids = {s["id"] for s in body["sources"]}
    assert {"hko", "landsd", "pland", "usgs", "lcsd"} <= ids
    assert "modelled" in body["disclaimer"].lower()


def test_equity_is_labelled_prototype(client):
    r = client.get("/equity",
                   params={"districtId": "central-western", "hour": 14.0})
    assert r.status_code == 200
    body = r.json()
    assert 0 <= body["coolAccessGap"] <= 1
    assert "prototype" in body["prototypeNote"].lower()
