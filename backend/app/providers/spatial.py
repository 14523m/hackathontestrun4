"""Spatial data provider: loads and indexes static/cached GeoJSON datasets.

This is the seam for real data integration: swap file loading for Lands
Department / CSDI API calls (see docs/data-sources.md) without touching the
heat or routing engines.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from app.core.geo import haversine_m
from app.core.types import LatLon
from app.data.generate_static_data import STATIC_DIR


class SpatialData:
    """In-memory index of districts, networks, buildings, land use."""

    def __init__(self, data_dir: Optional[Path] = None) -> None:
        self.data_dir = data_dir or STATIC_DIR
        self._cache: Dict[str, dict] = {}

    # -- generic loading ------------------------------------------------- #

    def _load(self, name: str) -> dict:
        if name not in self._cache:
            path = self.data_dir / name
            if not path.exists():
                raise FileNotFoundError(
                    f"Static dataset {name} missing. Run: "
                    f"python -m app.data.generate_static_data"
                )
            self._cache[name] = json.loads(path.read_text(encoding="utf-8"))
        return self._cache[name]

    # -- districts -------------------------------------------------------- #

    def districts(self) -> List[dict]:
        return [f["properties"] for f in self._load("districts.geojson")["features"]]

    def district(self, district_id: str) -> dict:
        for d in self.districts():
            if d["id"] == district_id:
                return d
        raise KeyError(f"Unknown district: {district_id}")

    def district_bbox(self, district_id: str) -> Tuple[float, float, float, float]:
        f = next(
            f for f in self._load("districts.geojson")["features"]
            if f["properties"]["id"] == district_id
        )
        ring = f["geometry"]["coordinates"][0]
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        return (min(lats), min(lons), max(lats), max(lons))

    # -- pedestrian network ------------------------------------------------ #

    def network(self, district_id: str) -> List[dict]:
        fc = self._load(f"network_{district_id}.geojson")
        return [f for f in fc["features"] if f["geometry"]["type"] == "LineString"]

    # -- land use / buildings ---------------------------------------------- #

    def land_use(self, district_id: str) -> List[dict]:
        return self._load(f"landuse_{district_id}.geojson")["features"]

    def buildings(self, district_id: str) -> List[dict]:
        return self._load(f"buildings_{district_id}.geojson")["features"]

    def cooling_spots(self, district_id: Optional[str] = None) -> List[dict]:
        feats = self._load("cooling_spots.geojson")["features"]
        if district_id:
            feats = [f for f in feats if f["properties"].get("districtId") == district_id]
        return feats

    def crowd_reports(self, district_id: Optional[str] = None) -> List[dict]:
        feats = self._load("crowd_reports.geojson")["features"]
        if district_id:
            feats = [f for f in feats if f["properties"].get("districtId") == district_id]
        return feats

    # -- helpers ------------------------------------------------------------ #

    def nearest_node(self, district_id: str, point: LatLon) -> Tuple[str, LatLon]:
        """Closest network endpoint to a point (snap origin/destination)."""
        best: Tuple[float, str, LatLon] = (1e18, "", LatLon(0, 0))
        seen: Dict[str, LatLon] = {}
        for edge in self.network(district_id):
            coords = [
                (c[1], c[0]) for c in edge["geometry"]["coordinates"]
            ]
            for key, ll in ((str(coords[0]), coords[0]), (str(coords[-1]), coords[-1])):
                if key not in seen:
                    seen[key] = LatLon(*ll)
        for node_id, ll in seen.items():
            d = haversine_m(point, ll)
            if d < best[0]:
                best = (d, node_id, ll)
        return best[1], best[2]
