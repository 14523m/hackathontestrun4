"""Planner service: design -> simulate -> compare -> improve.

Applies hypothetical interventions to the SAME heat model used everywhere
(via the declared ``overrides`` channel), producing before/after metrics and
a plain-language narrative. All results are SIMULATED scenario outputs - the
Northern Metropolis layer is a CONCEPTUAL scenario, not a prediction.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from app.engines.heat.engine import HeatPredictionService
from app.providers.spatial import SpatialData

# Intervention -> overrides applied to the heat model. Values are prototype
# calibration assumptions, documented in docs/architecture.md.
INTERVENTION_OVERRIDES: Dict[str, Dict[str, float]] = {
    "add_trees": {"extra_vegetation": 0.20},
    "add_green_space": {"extra_vegetation": 0.35},
    "add_shaded_corridors": {"extra_shade": 0.30},
    "reduce_paved_area": {"paved_delta": -0.20},
    "increase_building_spacing": {"density_multiplier": 0.75},
    "create_ventilation_corridor": {"wind_multiplier": 1.8},
}

INTERVENTION_LABELS: Dict[str, str] = {
    "add_trees": "Add trees",
    "add_green_space": "Add green space",
    "add_shaded_corridors": "Shaded pedestrian corridors",
    "reduce_paved_area": "Reduce exposed pavement",
    "increase_building_spacing": "Increase building spacing",
    "create_ventilation_corridor": "Create ventilation corridor",
}


def overrides_for(interventions: List[str]) -> Dict[str, float]:
    """Merge intervention overrides into a single declared override dict."""
    merged: Dict[str, float] = {}
    for iv in interventions:
        for k, v in INTERVENTION_OVERRIDES.get(iv, {}).items():
            merged[k] = merged.get(k, 0.0) + v
    # Clamp to physical-ish bounds.
    merged["extra_vegetation"] = min(0.6, merged.get("extra_vegetation", 0.0))
    merged["extra_shade"] = min(0.7, merged.get("extra_shade", 0.0))
    merged["paved_delta"] = max(-0.45, merged.get("paved_delta", 0.0))
    return merged


class PlannerService:
    def __init__(self, spatial: SpatialData, heat: HeatPredictionService) -> None:
        self._spatial = spatial
        self._heat = heat

    def _metrics(
        self, district_id: str, dt_local: datetime,
        interventions: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        ov = overrides_for(interventions or [])
        scores: List[float] = []
        shades: List[float] = []
        hotspots: List[Dict[str, Any]] = []
        for feature in self._spatial.land_use(district_id):
            pred = self._heat.predict_cell(district_id, feature, dt_local,
                                           overrides=ov or None)
            scores.append(pred["heatScore"])
            shades.append(pred["shadeScore"])
            if pred["heatScore"] >= self._heat.HOT_THRESHOLD:
                poly = pred["polygon"]
                hotspots.append({
                    "cellId": pred["cellId"],
                    "heatScore": pred["heatScore"],
                    "center": [round(sum(p[0] for p in poly) / len(poly), 5),
                               round(sum(p[1] for p in poly) / len(poly), 5)],
                    "topFactor": (pred["factors"][0]["label"]
                                  if pred["factors"] else "Base temperature"),
                })
        n = len(scores) or 1
        hotspots.sort(key=lambda h: -h["heatScore"])
        # 'add_cooling_facilities' places virtual cooling spots at the two
        # hottest cells -> demonstrably reduces the Cooling Access Gap.
        extra: List = []
        if "add_cooling_facilities" in (interventions or []):
            from app.core.types import LatLon
            extra = [LatLon(h["center"][1], h["center"][0])
                     for h in hotspots[:2]]
        return {
            "meanHeatScore": round(sum(scores) / n, 1),
            "maxHeatScore": round(max(scores), 1),
            "hotCellShare": round(sum(1 for s in scores
                                      if s >= self._heat.HOT_THRESHOLD) / n, 3),
            "meanShade": round(sum(shades) / n, 2),
            "coolAccessGap": self._cool_access_gap(district_id, extra_spots=extra),
            "hotspots": hotspots[:8],
        }

    def _cool_access_gap(
        self, district_id: str, extra_spots: Optional[List] = None
    ) -> float:
        """Cooling Access Gap (PROTOTYPE metric, section 51): share of
        land-use cell centres farther than 400 m from any cooling spot.
        Deliberately simple; future versions should add population density
        and vulnerable-community layers responsibly."""
        from app.core.geo import haversine_m
        from app.core.types import LatLon

        spots = [
            LatLon(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])
            for f in self._spatial.cooling_spots(district_id)
        ] + list(extra_spots or [])
        if not spots:
            return 1.0
        cells = self._spatial.land_use(district_id)
        if not cells:
            return 0.0
        beyond = 0
        for f in cells:
            ring = f["geometry"]["coordinates"][0]
            clon = sum(p[0] for p in ring) / len(ring)
            clat = sum(p[1] for p in ring) / len(ring)
            pt = LatLon(clat, clon)
            if min(haversine_m(pt, s) for s in spots) > 400.0:
                beyond += 1
        return round(beyond / len(cells), 3)

    def compare(
        self, district_id: str, dt_local: datetime,
        interventions: List[str],
    ) -> Dict[str, Any]:
        """Before/after comparison for a scenario (SIMULATED output)."""
        baseline = self._metrics(district_id, dt_local)
        scenario = self._metrics(district_id, dt_local, interventions)

        d_mean = round(scenario["meanHeatScore"] - baseline["meanHeatScore"], 1)
        d_max = round(scenario["maxHeatScore"] - baseline["maxHeatScore"], 1)
        d_hot = round(scenario["hotCellShare"] - baseline["hotCellShare"], 3)
        d_shade = round(scenario["meanShade"] - baseline["meanShade"], 2)
        d_gap = round(scenario["coolAccessGap"] - baseline["coolAccessGap"], 3)

        narrative: List[str] = []
        if d_mean < -0.5:
            narrative.append(
                f"Mean simulated heat exposure drops {abs(d_mean)} points "
                f"({baseline['meanHeatScore']} -> {scenario['meanHeatScore']})."
            )
        if d_max < -0.5:
            narrative.append(
                f"Peak hotspot intensity falls {abs(d_max)} points."
            )
        if d_hot < -0.001:
            narrative.append(
                f"Hot-cell share reduced by {abs(d_hot) * 100:.0f}% of the area."
            )
        if d_shade > 0.01:
            narrative.append(f"Average shade improves by {d_shade:.0%}.")
        if not narrative:
            narrative.append(
                "Selected interventions have little simulated effect on this "
                "district at this time of day."
            )
        narrative.append(
            "All figures are simulated scenario outputs (prototype model), "
            "not predictions about real developments."
        )

        return {
            "baseline": baseline,
            "scenario": scenario,
            "delta": {
                "meanHeatScore": d_mean,
                "maxHeatScore": d_max,
                "hotCellShare": d_hot,
                "meanShade": d_shade,
                "coolAccessGap": d_gap,
            },
            "narrative": narrative,
            "interventions": interventions,
            "isSimulated": True,
        }
