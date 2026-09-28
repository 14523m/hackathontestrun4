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
        subdivisions: int = 1,
    ) -> Dict[str, Any]:
        """Build the heat layer for a district at a time.

        ``subdivisions=2`` splits each land-use cell into 2x2 sub-cells and
        predicts each with the SAME HeatPredictionService - a finer field for
        the web heatmap surface (still modelled, never interpolated fakes).
        """
        cells: List[Dict[str, Any]] = []
        hot = 0
        for feature in self._spatial.land_use(district_id):
            if subdivisions <= 1:
                preds = [self._heat.predict_cell(
                    district_id, feature, dt_local, overrides=overrides
                )]
            else:
                ring = feature["geometry"]["coordinates"][0]
                lons = [p[0] for p in ring[:-1]]
                lats = [p[1] for p in ring[:-1]]
                lon0, lon1 = min(lons), max(lons)
                lat0, lat1 = min(lats), max(lats)
                n = subdivisions
                preds = []
                for i in range(n):
                    for j in range(n):
                        clat = lat0 + (lat1 - lat0) * (i + 0.5) / n
                        clon = lon0 + (lon1 - lon0) * (j + 0.5) / n
                        pred = self._heat.predict_point(
                            district_id, clat, clon, dt_local,
                            overrides=overrides,
                        )
                        # Sub-cell polygon.
                        w = (lon1 - lon0) / n
                        h = (lat1 - lat0) / n
                        pred["cellId"] = (
                            f"{feature['properties']['id']}-{i}{j}"
                        )
                        pred["polygon"] = [
                            [lon0 + j * w, lat0 + i * h],
                            [lon0 + (j + 1) * w, lat0 + i * h],
                            [lon0 + (j + 1) * w, lat0 + (i + 1) * h],
                            [lon0 + j * w, lat0 + (i + 1) * h],
                        ]
                        preds.append(pred)
            for pred in preds:
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
