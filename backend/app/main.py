"""HK CoolPath AI API - FastAPI application and route definitions.

Wires providers + engines + services into HTTP endpoints. The mobile app
consumes only this contract (mirrored in mobile/src/services/api/types.ts).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.config import REPO_ROOT, settings
from app.core.solar import timezone_fixed
from app.core.types import HeatModelParameters, LatLon
from app.engines.heat.anywhere import AnywhereHeatService
from app.engines.heat.engine import HeatPredictionService
from app.engines.routing.engine import MODE_WEIGHTS, RouteEngine
from app.providers.citybrain import MockCityBrainProvider
from app.providers.cooling import CoolingSpotProvider, CrowdReportProvider
from app.providers.spatial import SpatialData
from app.providers.weather import get_weather_provider
from app.schemas import (
    DataSourcesOut,
    DistrictOut,
    ErrorResponse,
    HeatMapOut,
    PlannerState,
    RoutePlanOut,
    ScenarioComparison,
)
from app.services.heatmap import HeatMapService
from app.services.planner import (
    INTERVENTION_LABELS,
    PlannerService,
    overrides_for,
)

# --------------------------------------------------------------------------- #
# Composition root: single place where concrete implementations are chosen.
# Swap providers here (or via DATA_MODE) - engines never change.
# --------------------------------------------------------------------------- #

spatial = SpatialData()
weather = get_weather_provider(
    data_mode=settings.data_mode,
    hko_base_url=settings.hko_base_url,
    cache_seconds=settings.weather_cache_seconds,
    stale_seconds=settings.weather_stale_after_seconds,
)
heat_params = HeatModelParameters.from_settings(settings)
heat_service = HeatPredictionService(spatial, weather, heat_params)
route_engine = RouteEngine(spatial, heat_service)
heat_map_service = HeatMapService(spatial, heat_service)
anywhere_service = AnywhereHeatService(spatial, weather)
planner_service = PlannerService(spatial, heat_service)
cooling_provider = CoolingSpotProvider(spatial)
crowd_provider = CrowdReportProvider(spatial)
citybrain = MockCityBrainProvider()

app = FastAPI(
    title=settings.api_title,
    version=settings.api_version,
    description=(
        "Heat exposure estimation and heat-aware pedestrian routing for Hong "
        "Kong. Predictions are modelled estimates, not measurements."
    ),
)
from app.routes.transit import router as transit_router
from app.routes.civic import router as civic_router

app.include_router(transit_router)
app.include_router(civic_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)


def _dt_from_query(
    date: Optional[str], hour: Optional[float], default_hour: float = 14.0
) -> datetime:
    """Parse ?date=YYYY-MM-DD & ?hour=H.HH (HK local time) into a datetime."""
    try:
        d = datetime.strptime(date, "%Y-%m-%d") if date else datetime.utcnow()
        hour_val = hour if hour is not None else default_hour
        hh = int(hour_val)
        mm = int(round((hour_val - hh) * 60))
        return datetime(d.year, d.month, d.day, hh, mm, tzinfo=timezone_fixed(8.0))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid date/hour: {exc}")


# --------------------------------------------------------------------------- #
# Meta / discovery
# --------------------------------------------------------------------------- #

@app.get("/", tags=["meta"])
def root() -> Any:
    """API discovery payload — unless the built web UI is being served, in
    which case ``/`` must BE the UI. FastAPI would otherwise shadow the
    StaticFiles mount here and judges hitting the deployment URL would see
    JSON instead of the app."""
    if _WEB_DIST is not None and (_WEB_DIST / "index.html").exists():
        return RedirectResponse(url="/index.html", status_code=307)
    return {
        "service": settings.api_title,
        "version": settings.api_version,
        "dataMode": settings.data_mode,
        "docs": "/docs",
        "webUi": {
            "available": False,
            "hint": (
                "Blank page at '/'? The web UI is not built yet. Run "
                "`cd web && npm install && npm run build`, then restart this "
                "API — until then only this JSON and /docs are served."
            ),
        },
        "endpoints": [
            "/districts", "/heatmap", "/routes", "/cooling-spots",
            "/crowd-reports", "/planner/compare", "/planner/northern-metropolis",
            "/equity", "/weather", "/config/data-sources", "/citybrain/capabilities",
        ],
    }


@app.get("/health", tags=["meta"])
def health() -> Dict[str, str]:
    return {"status": "ok", "dataMode": settings.data_mode}


@app.get("/config/data-sources", response_model=DataSourcesOut, tags=["meta"])
def data_sources() -> Dict[str, Any]:
    """Data provenance panel content (section 53): what is observed vs modelled."""
    weather_prov = weather.current().get("provenance", {})
    return {
        "dataMode": settings.data_mode,
        "weatherMode": (
            "live (HKO Open Data)" if settings.is_live
            else "demo (deterministic simulation)"
        ),
        "sources": [
            {
                "id": "hko",
                "name": "Hong Kong Observatory",
                "role": "Weather / heat-stress observations (10-min updates)",
                "status": "live" if settings.is_live else "simulated",
                "url": "https://www.hko.gov.hk/en/abouthko/opendata_intro.htm",
                "notes": weather_prov.get("notes", ""),
            },
            {
                "id": "landsd",
                "name": "Lands Department",
                "role": "Buildings, 3D spatial data, 3D pedestrian network",
                "status": "simulated (mock geodata in MVP)",
                "url": "https://portal.csdi.gov.hk/csdi-webpage/dataset/landsd_rcd_1637222018065_52265",
                "notes": "MVP uses deterministic mock networks/buildings.",
            },
            {
                "id": "pland",
                "name": "Planning Department",
                "role": "Land utilisation raster (10 m)",
                "status": "simulated (mock geodata in MVP)",
                "url": "https://data.gov.hk/en-data/dataset/hk-pland-pland1-land-utilization-in-hong-kong-raster-grid",
                "notes": "",
            },
            {
                "id": "usgs",
                "name": "USGS / Landsat",
                "role": "Surface temperature calibration (future work)",
                "status": "not yet integrated",
                "url": "https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature",
                "notes": "Treated as surface_heat_reference, never as air temperature.",
            },
            {
                "id": "lcsd",
                "name": "LCSD",
                "role": "Trees and public venues (cooling spots)",
                "status": "simulated (mock venues in MVP)",
                "url": "https://data.gov.hk/en-data/dataset/hk-lcsd-venue-venue",
                "notes": "",
            },
        ],
        "disclaimer": (
            "All heat values are modelled estimates. Demo datasets are "
            "simulated. This tool does not replace official HKO warnings."
        ),
    }


@app.get("/citybrain/capabilities", tags=["meta"])
def citybrain_capabilities() -> Dict[str, Any]:
    """City Brain integration boundary: what a real integration would need."""
    return citybrain.capability_statement()


# --------------------------------------------------------------------------- #
# Districts / weather / points of interest
# --------------------------------------------------------------------------- #

@app.get("/districts", response_model=List[DistrictOut], tags=["districts"])
def districts() -> List[Dict[str, Any]]:
    out = []
    for d in spatial.districts():
        bbox_ring = next(
            f["geometry"]["coordinates"][0]
            for f in spatial._load("districts.geojson")["features"]  # noqa: SLF001
            if f["properties"]["id"] == d["id"]
        )
        clat = sum(p[1] for p in bbox_ring) / len(bbox_ring)
        clon = sum(p[0] for p in bbox_ring) / len(bbox_ring)
        out.append({
            "id": d["id"],
            "name": d["name"],
            "nameZh": d.get("nameZh"),
            "kind": d.get("kind", "existing"),
            "isConceptual": d.get("kind") == "conceptual",
            "center": {"lat": clat, "lon": clon},
            "description": d.get("description", ""),
            "label": ("CONCEPTUAL / SIMULATED planning scenario"
                      if d.get("kind") == "conceptual" else ""),
        })
    return out


@app.get("/weather", tags=["weather"])
def weather_current() -> Dict[str, Any]:
    """Regional atmospheric snapshot (observed in live mode, simulated in demo)."""
    snap = weather.current()
    stations = snap.pop("stations", [])
    return {
        "snapshot": snap,
        "stations": [
            {"name": s["name"], "location": s["location"],
             "temperatureC": s["temperatureC"]}
            for s in stations
        ],
    }


@app.get("/places/search", tags=["districts"])
def places_search(
    q: str = Query("", max_length=60),
    limit: int = Query(8, ge=1, le=20),
) -> List[Dict[str, Any]]:
    """Search the HK gazetteer (MTR stations, neighbourhoods, landmarks).

    SIMULATED demo accuracy; real deployment would swap in the GeoCom/CSDI
    gazetteer through the same interface.
    """
    from app.providers.gazetteer import search_places

    return search_places(q, limit)


@app.get("/cooling-spots", tags=["cooling"])
def cooling_spots(
    districtId: Optional[str] = None,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    limit: int = 5,
    maxDistanceMeters: Optional[float] = Query(None, gt=0),
) -> List[Dict[str, Any]]:
    """Cooling spots; with lat/lon returns nearest-first, optionally bounded
    by ``maxDistanceMeters`` (used by the web inspect panel's 500 m search)."""
    if lat is not None and lon is not None:
        spots = cooling_provider.nearest(lat, lon, limit=limit,
                                         district_id=districtId)
        if maxDistanceMeters is not None:
            spots = [s for s in spots
                     if s["distanceMeters"] <= maxDistanceMeters]
        return spots
    return cooling_provider.list(districtId)


@app.get("/crowd-reports", tags=["crowd"])
def crowd_reports(districtId: Optional[str] = None) -> List[Dict[str, Any]]:
    """Simulated crowd reports (anonymised by design)."""
    return crowd_provider.list(districtId)


# --------------------------------------------------------------------------- #
# Heat map
# --------------------------------------------------------------------------- #

@app.get("/map-data", tags=["heatmap"])
def map_data(districtId: str = Query("central-western")) -> Dict[str, Any]:
    """All GeoJSON layers for the district map in one payload (mobile-friendly):
    land use, buildings, pedestrian network, cooling spots, district outline."""
    try:
        spatial.district(districtId)
    except KeyError:
        raise HTTPException(404, f"Unknown district: {districtId}")
    return {
        "districtId": districtId,
        "landUse": {
            "type": "FeatureCollection",
            "features": spatial.land_use(districtId),
        },
        "buildings": {
            "type": "FeatureCollection",
            "features": spatial.buildings(districtId),
        },
        "network": {
            "type": "FeatureCollection",
            "features": spatial.network(districtId),
        },
        "coolingSpots": {
            "type": "FeatureCollection",
            "features": spatial.cooling_spots(districtId),
        },
    }


@app.get("/heatmap", response_model=HeatMapOut, tags=["heatmap"])
def heatmap(
    districtId: str = Query("central-western"),
    date: Optional[str] = None,
    hour: Optional[float] = Query(None, ge=0, le=23.99),
    detail: str = Query("standard", pattern="^(standard|high)$"),
) -> Dict[str, Any]:
    """Time-dependent heat layer.

    ``detail=high`` subdivides each land-use cell 2x2 (same heat model per
    sub-cell) for a smoother surface on the web heatmap.
    """
    dt = _dt_from_query(date, hour)
    if dt.hour < 5 or dt.hour >= 22:
        return {
            "generatedAt": datetime.utcnow().isoformat() + "Z",
            "validFor": dt.isoformat(),
            "dataMode": settings.data_mode,
            "isStale": False,
            "districtId": districtId,
            "cells": [],
            "legend": {},
            "note": "Night hours: solar exposure model inactive (demo scope).",
        }
    layer = heat_map_service.build(
        districtId, dt, subdivisions=2 if detail == "high" else 1
    )
    layer["dataMode"] = settings.data_mode
    return layer


@app.get("/heat/point", tags=["heatmap"])
def heat_point(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    date: Optional[str] = None,
    hour: Optional[float] = Query(None, ge=0, le=23.99),
) -> Dict[str, Any]:
    """Physics-based heat prediction at ANY coordinate in Hong Kong.

    No districtId needed: building shadows + sky-view factor from the global
    building index, land-use sampling from the nearest cell, HKO-anchored
    weather, published thermal equations (Steadman AT, Stull wet-bulb, ABM
    WBGT, Thorsson MRT). The click-inspect payload for the free-pan web map.
    """
    from app.core.geo import in_hong_kong

    if not in_hong_kong(lat, lon):
        raise HTTPException(422, "coordinate outside the Hong Kong bounding region")
    dt = _dt_from_query(date, hour)
    try:
        return anywhere_service.predict_point(lat, lon, dt)
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@app.get("/heatmap/territory", tags=["heatmap"])
def heatmap_territory() -> FileResponse:
    """Whole-territory thermal-load raster (precomputed, deterministic).

    A 75 m lattice over all of Hong Kong, sea masked out, scored with the
    same published heat physics as the live endpoints. Served as a static
    file: the client renders every non-null cell as a filled square, giving
    the 'specific at every location' territory raster.
    """
    path = REPO_ROOT / "backend" / "app" / "data" / "static" / "thermal_grid.json"
    if not path.exists():
        raise HTTPException(
            404,
            "thermal_grid.json not generated yet — run "
            "`python -m app.tools.generate_thermal_grid` in backend/",
        )
    return FileResponse(path, media_type="application/json")


@app.get("/heatmap/viewport", tags=["heatmap"])
def heatmap_viewport(
    south: float = Query(..., ge=-90, le=90),
    west: float = Query(..., ge=-180, le=180),
    north: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-180, le=180),
    date: Optional[str] = None,
    hour: Optional[float] = Query(None, ge=0, le=23.99),
    maxCells: int = Query(220, ge=20, le=400),
) -> Dict[str, Any]:
    """Heat field for a map viewport - anywhere in Hong Kong, free pan/zoom.

    Grid resolution adapts to the viewport size so every returned cell is a
    real physics evaluation at that coordinate (max ``maxCells`` of them),
    never interpolated decoration.
    """
    dt = _dt_from_query(date, hour)
    try:
        return anywhere_service.viewport_field(
            south, west, north, east, dt, max_cells=maxCells
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc))


# --------------------------------------------------------------------------- #
# Routing
# --------------------------------------------------------------------------- #

@app.get("/routes", response_model=RoutePlanOut, tags=["routing"])
def routes(
    districtId: str = Query("central-western"),
    originLat: float = Query(..., ge=-90, le=90),
    originLon: float = Query(..., ge=-180, le=180),
    destLat: float = Query(..., ge=-90, le=90),
    destLon: float = Query(..., ge=-180, le=180),
    preference: Optional[str] = Query(None, pattern="^(fastest|balanced|coolest)$"),
    date: Optional[str] = None,
    hour: Optional[float] = Query(None, ge=0, le=23.99),
) -> Dict[str, Any]:
    """Three route options (fastest/balanced/coolest) with exposure metrics.

    Heat exposure is duration-weighted (section 49). Time-dependent: the same
    OD pair can produce different routes at 09:00 vs 15:00.
    """
    from app.core.geo import in_hong_kong

    for name, la, lo in (("origin", originLat, originLon),
                         ("destination", destLat, destLon)):
        if not in_hong_kong(la, lo):
            raise HTTPException(422, f"{name} outside Hong Kong bounding region")
    dt = _dt_from_query(date, hour)
    plan = route_engine.plan_routes(
        districtId, LatLon(originLat, originLon), LatLon(destLat, destLon), dt
    )
    weather_snap = {
        k: v for k, v in weather.current().items() if k != "stations"
    }
    return {
        "requestedType": preference,
        "requestedAt": datetime.utcnow().isoformat() + "Z",
        "origin": {"lat": originLat, "lon": originLon},
        "destination": {"lat": destLat, "lon": destLon},
        "options": plan["options"],
        "weather": weather_snap,
        "provenance": {
            "sources": ["hko-or-mock-weather", "mock-pedestrian-network",
                        "mock-buildings", "mock-landuse"],
            "observed": bool(weather_snap.get("isObserved")),
            "modelled": True,
            "confidence": 0.55,
            "notes": ("Heat exposure values are modelled estimates from the "
                      "prototype street-edge heat model."),
        },
        "notes": [
            "Walking speed assumed 1.2 m/s on flat ground.",
            "Route weights (alpha/beta/gamma) are prototype calibration "
            "parameters; see /config/data-sources.",
        ],
    }


@app.get("/routes/mode-weights", tags=["routing"])
def mode_weights() -> Dict[str, Any]:
    """Expose the prototype routing weights (transparency)."""
    return {"weights": MODE_WEIGHTS, "note": "Prototype calibration values."}


# --------------------------------------------------------------------------- #
# Planner
# --------------------------------------------------------------------------- #

@app.post("/planner/compare", response_model=ScenarioComparison,
          tags=["planner"])
def planner_compare(state: PlannerState, date: Optional[str] = None,
                    hour: Optional[float] = Query(None, ge=0, le=23.99)) -> Dict[str, Any]:
    """Before/after simulation for a set of interventions (SIMULATED output)."""
    dt = _dt_from_query(date, hour)
    return planner_service.compare(state.districtId, dt, state.interventions)


@app.get("/planner/interventions", tags=["planner"])
def planner_interventions() -> List[Dict[str, str]]:
    return [
        {"id": k, "label": v}
        for k, v in INTERVENTION_LABELS.items()
    ] + [{"id": "add_cooling_facilities", "label": "Add cooling facilities"}]


@app.get("/planner/northern-metropolis", response_model=HeatMapOut,
         tags=["planner"])
def northern_metropolis(
    date: Optional[str] = None,
    hour: Optional[float] = Query(None, ge=0, le=23.99),
    interventions: Optional[str] = Query(
        None, description="Comma-separated intervention ids"),
) -> Dict[str, Any]:
    """CONCEPTUAL / SIMULATED Northern Metropolis planning scenario.

    Demonstrates 'evaluate heat risk before the district is built'. Not a
    prediction about the real Northern Metropolis.
    """
    dt = _dt_from_query(date, hour)
    ivs = [i.strip() for i in interventions.split(",")] if interventions else []
    layer = heat_map_service.build(
        "northern-metropolis", dt, overrides=overrides_for(ivs) or None,
    )
    layer["dataMode"] = settings.data_mode
    layer["scenarioLabel"] = (
        "CONCEPTUAL / SIMULATED planning scenario - not an official plan "
        "or prediction"
    )
    layer["appliedInterventions"] = ivs
    return layer


# --------------------------------------------------------------------------- #
# Heat equity (prototype)
# --------------------------------------------------------------------------- #

@app.get("/equity", tags=["equity"])
def equity(districtId: str = Query("central-western"),
           date: Optional[str] = None,
           hour: Optional[float] = Query(None, ge=0, le=23.99)) -> Dict[str, Any]:
    """Prototype Heat Equity analysis: exposure vs cooling access.

    PROTOTYPE METRIC - deliberately simple; future versions must integrate
    demographic datasets responsibly or not at all.
    """
    dt = _dt_from_query(date, hour)
    metrics = planner_service._metrics(districtId, dt)  # noqa: SLF001
    hotspots = metrics.get("hotspots", [])
    return {
        "districtId": districtId,
        "meanHeatScore": metrics["meanHeatScore"],
        "hotCellShare": metrics["hotCellShare"],
        "coolAccessGap": metrics["coolAccessGap"],
        "hottestAreas": [
            {"center": h["center"], "heatScore": h["heatScore"]}
            for h in hotspots[:5]
        ],
        "prototypeNote": (
            "Cooling Access Gap = share of area >400 m from a cooling spot "
            "(prototype). Real equity analysis requires population and "
            "vulnerability data, used only where legally/ethically appropriate."
        ),
    }


# --------------------------------------------------------------------------- #
# Web UI (judge-facing): when web/dist exists (npm run build in web/), serve
# the built SPA from this same origin - ONE server for API + UI on :8000.
# API routes above are registered first, so they take precedence.
# --------------------------------------------------------------------------- #


@app.middleware("http")
async def _api_prefix_alias(request, call_next):  # noqa: ANN001
    """Accept /api/* as an alias of the root routes.

    The web client calls /api/... (the same convention as the Vite dev
    proxy, which rewrites /api away). When FastAPI serves the built SPA
    itself there is no proxy, so the prefix is stripped here instead of
    duplicating every route - otherwise live calls 404 and the UI silently
    falls back to offline mode.
    """
    path = request.scope.get("path", "")
    if path == "/api" or path.startswith("/api/"):
        request.scope["path"] = path[4:] or "/"
    return await call_next(request)


_WEB_DIST = REPO_ROOT / "web" / "dist"
if _WEB_DIST.exists():
    app.mount("/", StaticFiles(directory=_WEB_DIST, html=True), name="web")
else:
    _WEB_DIST = None


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
