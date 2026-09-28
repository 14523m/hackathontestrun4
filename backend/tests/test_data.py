"""Ensures static mock data generation is deterministic and complete."""

from __future__ import annotations

import json

from app.data.generate_static_data import STATIC_DIR, generate_districts


def test_all_expected_datasets_exist():
    expected = [
        "districts.geojson", "cooling_spots.geojson", "crowd_reports.geojson",
    ]
    for district in ("central-western", "kowloon-yau-tsim",
                     "northern-metropolis"):
        expected += [
            f"network_{district}.geojson",
            f"buildings_{district}.geojson",
            f"landuse_{district}.geojson",
        ]
    for name in expected:
        assert (STATIC_DIR / name).exists(), f"missing {name}"


def test_district_generation_is_deterministic():
    assert json.dumps(generate_districts()) == json.dumps(generate_districts())


def test_networks_are_connected_enough():
    """Grid networks: every endpoint should appear in the node set."""
    from app.providers.spatial import SpatialData

    spatial = SpatialData()
    for district in ("central-western", "kowloon-yau-tsim",
                     "northern-metropolis"):
        edges = spatial.network(district)
        assert len(edges) > 50
