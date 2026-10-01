"""Civic endpoints: citizen heat reports + cooling siting optimizer."""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


# --------------------------------------------------------------------------- #
# Reports: submit, list, summary, dossier
# --------------------------------------------------------------------------- #


def _post(client, lat, lon, kind="no-shade", severity=3, note="", hour=14.5):
    return client.post(
        "/api/civic/reports",
        json={"lat": lat, "lon": lon, "kind": kind, "severity": severity,
              "note": note, "hour": hour},
    )


def test_report_submit_is_model_corroborated(client):
    r = _post(client, 22.319, 114.169, kind="no-shade", severity=4,
              note="Nathan Rd", hour=14.5)
    assert r.status_code == 200
    d = r.json()
    assert d["kindLabel"] == "No shade on the walk"
    assert d["severity"] == 4
    # Lived experience is corroborated by the heat model, not just echoed.
    assert isinstance(d["model"]["score"], (int, float))
    assert 0 <= d["model"]["score"] <= 100


def test_report_validates_location_and_kind(client):
    assert client.post(
        "/api/civic/reports",
        json={"lat": 35.0, "lon": 139.0, "kind": "no-shade"},
    ).status_code == 422  # Tokyo is not Hong Kong
    assert client.post(
        "/api/civic/reports",
        json={"lat": 22.319, "lon": 114.169, "kind": "swimming-pool"},
    ).status_code == 422


def test_report_summary_clusters_nearby(client):
    # Two reports ~80 m apart should merge into one cluster.
    r1 = _post(client, 22.300, 114.160, severity=2)
    r2 = _post(client, 22.30072, 114.160, severity=3)
    assert r1.status_code == r2.status_code == 200
    s = client.get("/api/civic/reports/summary")
    assert s.status_code == 200
    clusters = s.json()["clusters"]
    hit = [c for c in clusters
           if math.hypot(c["lat"] - 22.300, c["lon"] - 114.160) < 0.002]
    assert hit, "expected a cluster near the two posted reports"
    assert hit[0]["n"] >= 2
    assert hit[0]["meanSeverity"] == pytest.approx(
        hit[0]["severitySum"] / hit[0]["n"], abs=0.01)


def test_report_dossier_is_decision_maker_ready(client):
    d = client.get("/api/civic/reports/dossier")
    assert d.status_code == 200
    j = d.json()
    assert j["totalReports"] >= 1
    assert "COMMUNITY HEAT REPORT" in j["text"]
    assert "1823" in j["text"]
    assert j["topLocations"], "dossier must name locations"
    # Honest about what the evidence is and is not.
    assert "estimates" in j["disclaimer"]


# --------------------------------------------------------------------------- #
# Siting optimizer
# --------------------------------------------------------------------------- #


def test_siting_returns_spread_sites(client):
    r = client.get("/api/civic/siting/cooling?kind=canopy&budget=6")
    assert r.status_code == 200
    d = r.json()
    assert d["kind"] == "canopy"
    assert d["radiusM"] == 180
    assert len(d["sites"]) == 6
    # Greedy must SPREAD: no two sites within one radius of each other.
    for a in d["sites"]:
        for b in d["sites"]:
            if a is b:
                continue
            dlat = (a["lat"] - b["lat"]) * 111_320
            dlon = (a["lon"] - b["lon"]) * 111_320 * math.cos(
                math.radians(a["lat"]))
            assert math.hypot(dlat, dlon) > 170, "sites overlap one radius"
    # Every site is in genuinely hot territory.
    assert all(s["heatScore"] >= 70 for s in d["sites"])


def test_siting_radius_varies_by_kind(client):
    r_canopy = client.get("/api/civic/siting/cooling?kind=canopy&budget=3")
    r_mist = client.get("/api/civic/siting/cooling?kind=misting&budget=3")
    assert r_canopy.json()["radiusM"] == 180
    assert r_mist.json()["radiusM"] == 60


def test_siting_validates_params(client):
    assert client.get(
        "/api/civic/siting/cooling?kind=geothermal&budget=5").status_code == 422
    assert client.get(
        "/api/civic/siting/cooling?kind=canopy&budget=99").status_code == 422
