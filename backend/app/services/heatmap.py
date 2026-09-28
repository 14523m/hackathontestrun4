"""Heat-map service: builds the time-dependent heat layer for a district.

Each land-use cell becomes a HeatCellOut with explainable factors. The layer
is regenerated per requested time (section 48: heat maps are never static).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List

from app.engines.heat.engine import HeatPredictionService
from app.providers.spatial import SpatialData

LEGEND = {
    "0-40": "Comfortable - generous shade / vegetation",
    "40-55": "Warm - moderate exposure",
    "55-70": "Hot - seek shade, hydrate",
    "70-100": "Very hot - avoid prolonged exposure",
}


class HeatMapService:
    def __init__(self, spatial: SpatialData, heat: HeatPredictionService) -> None:
        self._spatial = spatial
        self._heat = heat

    def build(
        self,
        district_id: str,
        dt_local: datetime,
        overrides: Dict[str, float] | None = None,
    ) -> Dict[str, Any]:
        cells: List[Dict[str, Any]] = []
        hot = 0
        for feature in self._spatial.land_use(district_id):
            pred = self._heat.predict_cell(
                district_id, feature, dt_local, overrides=overrides
            )
            poly = pred["polygon"]
            pred["center"] = {
                "lat": round(sum(p[1] for p in poly) / len(poly), 6),
                "lon": round(sum(p[0] for p in poly) / len(poly), 6),
            }
            if pred["heatScore"] >= self._heat.HOT_THRESHOLD:
                hot += 1
            cells.append(pred)

        snap = self._heat._weather_context(dt_local)["snapshot"]  # noqa: SLF001
        prov = snap.get("provenance", {})
        return {
            "generatedAt": datetime.utcnow().isoformat() + "Z",
            "validFor": dt_local.isoformat(),
            "dataMode": "demo",
            "isStale": bool(snap.get("isStale", False)),
            "districtId": district_id,
            "cells": cells,
            "legend": LEGEND,
            "hotspotCount": hot,
            "cellCount": len(cells),
            "provenance": {
                "sources": list(prov.get("sources", []))
                + ["landsd-buildings(mock)", "pland-landuse(mock)"],
                "observed": bool(prov.get("observed", False)),
                "modelled": True,
                "confidence": 0.55,
                "notes": ("Street-level heat exposure ESTIMATED from "
                          "atmospheric anchors + urban geometry; not "
                          "sensor measurements."),
            },
        }
