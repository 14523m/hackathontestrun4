"""Transit itinerary endpoints (MTR + KMB bus + walking handoff)."""

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Query

from app.config import REPO_ROOT
from app.services.transit import TransitPlanner

router = APIRouter(prefix="/transit", tags=["transit"])

_planner = TransitPlanner(REPO_ROOT / "backend" / "app" / "data" / "static")


@router.get("/plan")
def transit_plan(
    fromLat: float = Query(..., alias="fromLat"),
    fromLon: float = Query(..., alias="fromLon"),
    toLat: float = Query(..., alias="toLat"),
    toLon: float = Query(..., alias="toLon"),
    modes: str = Query("mtr,bus", description="comma list: mtr,bus"),
) -> Dict[str, Any]:
    """Multimodal itineraries (MTR/bus), ranked by total door-to-door time.

    Walking-only routes stay on the client (OSRM foot router); this endpoint
    is transit-only. Vehicle legs carry no heat penalty (air-conditioned);
    the client says this honestly in the UI.
    """
    if not (-90 <= fromLat <= 90 and -90 <= toLat <= 90):
        raise HTTPException(422, "bad latitude")
    mode_list = [m.strip().lower() for m in modes.split(",") if m.strip()]
    bad = [m for m in mode_list if m not in ("mtr", "bus")]
    if bad:
        raise HTTPException(422, f"unsupported modes: {bad}")
    try:
        itins = _planner.plan(fromLat, fromLon, toLat, toLon, mode_list)
    except Exception as exc:  # noqa: BLE001 — surface a clean 500
        raise HTTPException(500, f"transit planning failed: {exc}") from exc
    return {
        "from": {"lat": fromLat, "lon": fromLon},
        "to": {"lat": toLat, "lon": toLon},
        "modes": mode_list,
        "itineraries": itins,
    }
