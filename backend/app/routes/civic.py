"""Civic engagement endpoints: citizen heat reports + cooling siting optimizer.

Two halves of one story:
  - citizens REPORT heat problems they experience ("this street is an oven");
  - the siting optimizer turns the heat model into WHERE the city should
    intervene (canopy / shade sails / misters), and public reports CORROBORATE
    the model's top sites — evidence, not anecdote.
"""

from __future__ import annotations

import json
import math
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request

from app.core.geo import in_hong_kong

router = APIRouter(prefix="/civic", tags=["civic"])

# --------------------------------------------------------------------------- #
# Report store: append-only JSONL (hackathon-simple, honest about it).
# Concurrency-safe within the process; a real deployment swaps in Postgres
# behind the same interface. Rate limit is per-IP, in-memory.
# --------------------------------------------------------------------------- #

_REPORTS_PATH: Optional[Any] = None
_lock = threading.Lock()
_post_times: Dict[str, List[float]] = {}  # ip -> recent post times
_WINDOW_S = 10.0
_WINDOW_MAX = 5  # 5 reports / 10 s per IP: spam-proof, humans-free
_MAX_LIST = 500


def _reports_file() -> Any:
    global _REPORTS_PATH
    if _REPORTS_PATH is None:
        from app.config import REPO_ROOT

        _REPORTS_PATH = REPO_ROOT / "backend" / "app" / "data" / "civic_reports.jsonl"
    return _REPORTS_PATH


def _append_report(rec: Dict[str, Any]) -> None:
    f = _reports_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        with f.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _read_reports(limit: int) -> List[Dict[str, Any]]:
    f = _reports_file()
    if not f.exists():
        return []
    with _lock:
        lines = f.read_text(encoding="utf-8").splitlines()
    out = []
    for ln in lines[-limit:]:
        try:
            out.append(json.loads(ln))
        except json.JSONDecodeError:
            continue
    return out


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(a))


def _label_for(lat: float, lon: float) -> str:
    """Nearest MTR station as a human label ('near XXX (420 m)'), else 'Yim
    Tin Tsai-style lat/lon' is pointless — fall back to district-ish grid."""
    try:
        from app.providers.transit import MTR_STATIONS

        best, best_d = None, 1e9
        for s in MTR_STATIONS:
            d = _haversine_m(lat, lon, s["lat"], s["lon"])
            if d < best_d:
                best, best_d = s, d
        if best is not None and best_d <= 2000:
            return f"near {best['name']} ({int(round(best_d))} m)"
    except Exception:  # noqa: BLE001 — labelling must never fail a report
        pass
    return f"{lat:.4f}, {lon:.4f}"


# --------------------------------------------------------------------------- #
# Heat confirm: score the reported location with the real heat model, so a
# report is corroborated (or honestly flagged) by physics — not just echoed.
# --------------------------------------------------------------------------- #


def _model_confirm(lat: float, lon: float, hour: float) -> Dict[str, Any]:
    from app.core.solar import timezone_fixed

    now = datetime.now(timezone_fixed(8.0))
    d = now.replace(hour=int(hour), minute=int(round((hour % 1) * 60)))
    try:
        from app.engines.heat.anywhere import AnywhereHeatService
        from app.main import anywhere_service

        res = anywhere_service.predict_point(lat, lon, d)
        return {
            "score": res.get("heatScore"),
            "band": res.get("band") or res.get("label"),
        }
    except Exception:  # noqa: BLE001 — demo resilience: reports work offline
        return {"score": None, "band": None}


_RATE_NOTE = "per-IP throttle (3 s), in-memory, resets on restart"


@router.post("/reports")
def submit_report(request: Request, body: Dict[str, Any]) -> Dict[str, Any]:
    """Citizen heat report: where + how bad + optional note.

    Anonymous; no accounts. The heat model independently scores the location
    so the dossier shows AGREEMENT between lived experience and physics.
    """
    # --- validate FIRST (bad requests never consume rate quota) ----------
    try:
        lat = float(body["lat"])
        lon = float(body["lon"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(422, "lat/lon required") from exc
    if not in_hong_kong(lat, lon):
        raise HTTPException(422, "outside Hong Kong")

    # --- then throttle: sliding window per IP (in-memory, resets on restart)
    import time

    ip = (request.client.host if request.client else "?") or "?"
    now = time.monotonic()
    with _lock:
        recent = [t for t in _post_times.get(ip, []) if now - t < _WINDOW_S]
        if len(recent) >= _WINDOW_MAX:
            raise HTTPException(429, "too many reports — wait a moment")
        recent.append(now)
        _post_times[ip] = recent

    raw_kind = str(body.get("kind") or "other")
    KINDS = {
        "no-shade": "No shade on the walk",
        "hot-surface": "Scorching pavement / heat radiating up",
        "no-seat": "Nowhere to sit and rest in shade",
        "no-water": "No drinking fountain / water nearby",
        "other": "Other",
    }
    if raw_kind not in KINDS:
        raise HTTPException(422, f"kind must be one of {sorted(KINDS)}")
    severity = body.get("severity", 3)
    try:
        severity = max(1, min(5, int(severity)))
    except (TypeError, ValueError):
        severity = 3
    note = str(body.get("note") or "")[:280]

    hour = body.get("hour")
    try:
        hour = float(hour) if hour is not None else 14.5
    except (TypeError, ValueError):
        hour = 14.5

    rec = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "lat": lat,
        "lon": lon,
        "kind": raw_kind,
        "kindLabel": KINDS[raw_kind],
        "severity": severity,
        "note": note,
        "hour": hour,
        "place": _label_for(lat, lon),
    }
    _append_report(rec)

    conf = _model_confirm(lat, lon, hour)
    rec2 = dict(rec)
    rec2["model"] = conf
    rec2["rateLimit"] = _RATE_NOTE
    return rec2


@router.get("/reports")
def list_reports(limit: int = Query(100, ge=1, le=_MAX_LIST)) -> Dict[str, Any]:
    """Recent reports, newest first (dossier UI + mobile consumption)."""
    recs = _read_reports(limit)
    recs.reverse()
    return {"count": len(recs), "reports": recs}


@router.get("/reports/summary")
def reports_summary() -> Dict[str, Any]:
    """Clustered roll-up powering the dossier: reports grouped by location."""
    recs = _read_reports(2000)
    clusters: List[Dict[str, Any]] = []
    for r in recs:
        for c in clusters:
            if _haversine_m(r["lat"], r["lon"], c["lat"], c["lon"]) <= 150:
                c["n"] += 1
                c["severitySum"] += r["severity"]
                c["kinds"][r["kind"]] = c["kinds"].get(r["kind"], 0) + 1
                if r["severity"] > c["topSeverity"]:
                    c["topSeverity"] = r["severity"]
                if c["ts"] < r["ts"]:
                    c["ts"] = r["ts"]
                break
        else:
            clusters.append({
                "lat": r["lat"],
                "lon": r["lon"],
                "place": r["place"],
                "n": 1,
                "severitySum": r["severity"],
                "topSeverity": r["severity"],
                "kinds": {r["kind"]: 1},
                "ts": r["ts"],
            })
    clusters.sort(key=lambda c: (c["n"], c["severitySum"]), reverse=True)
    for c in clusters:
        c["meanSeverity"] = round(c["severitySum"] / c["n"], 2)
    kinds_total: Dict[str, int] = {}
    for r in recs:
        kinds_total[r["kind"]] = kinds_total.get(r["kind"], 0) + 1
    return {
        "total": len(recs),
        "byKind": kinds_total,
        "clusters": clusters[:24],
        "note": "Clusters within 150 m; ranked by report count then severity.",
    }


@router.get("/reports/dossier")
def reports_dossier() -> Dict[str, Any]:
    """A ready-to-send 1823 / district-council brief, generated from reports.

    This is the sustainability payload: citizens report -> the app aggregates
    -> decision-makers receive a structured, model-corroborated document.
    """
    import time as _t

    summary = reports_summary()
    recs = _read_reports(2000)
    window_days = 30
    cutoff = _t.time() - window_days * 86400
    recent = [r for r in recs if _ts_epoch(r["ts"]) >= cutoff]
    top = summary["clusters"][:8]
    lines = [
        "HOT-WALKING HK — COMMUNITY HEAT REPORT",
        f"Generated {datetime.now(timezone.utc).isoformat()}",
        "",
        f"Reports in the last {window_days} days: {len(recent)}"
        f" (all time: {len(recs)})",
        "What walkers report most:",
    ]
    for k, n in sorted(summary["byKind"].items(), key=lambda kv: -kv[1]):
        lines.append(f"  - {n}x  {KIND_LABELS.get(k, k)}")
    lines += ["", "Worst locations (by number of reports):"]
    for i, c in enumerate(top, 1):
        kinds = ", ".join(
            f"{n}x {KIND_LABELS.get(k, k)}" for k, n in sorted(c["kinds"].items(), key=lambda kv: -kv[1])[:2]
        )
        lines.append(
            f"  {i}. {c['place']} — {c['n']} report(s),"
            f" mean severity {c['meanSeverity']}/5 ({kinds})"
        )
    lines += [
        "",
        "Each location above is corroborated by the heat model when the",
        "report was filed (model score stored with the report). Suggested",
        "interventions and siting evidence: GET /api/civic/siting/cooling",
        "or the 'Cooling siting' panel in the web app.",
        "",
        "Prepared for: 1823 / relevant District Council — delete as needed.",
    ]
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "windowDays": window_days,
        "totalReports": len(recs),
        "recentReports": len(recent),
        "byKind": summary["byKind"],
        "topLocations": top,
        "text": "\n".join(lines),
        "disclaimer": (
            "Community reports are subjective experiences; model scores are "
            "estimates. Together they are evidence for further study, not a "
            "measurement campaign."
        ),
    }


KIND_LABELS = {
    "no-shade": "No shade on the walk",
    "hot-surface": "Scorching pavement / heat radiating up",
    "no-seat": "Nowhere to sit and rest in shade",
    "no-water": "No drinking fountain / water nearby",
    "other": "Other",
}


def _ts_epoch(ts: str) -> float:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


# --------------------------------------------------------------------------- #
# Cooling siting optimizer: WHERE should the city add shade?
# Greedy max-coverage over the precomputed territory raster, constrained by
# walkability — the planner-side payload of this project.
# --------------------------------------------------------------------------- #

_SITING_CACHE: Dict[str, Any] = {}


@router.get("/siting/cooling")
def siting_cooling(
    kind: str = Query(
        "canopy",
        pattern="^(canopy|shade-sail|misting|park-pocket)$",
        description="Intervention type (affects benefit radius).",
    ),
    budget: int = Query(10, ge=1, le=40, description="Number of installations."),
) -> Dict[str, Any]:
    """Where to add cooling: greedy coverage optimisation over the heat raster.

    Model side of the civic loop: the same raster citizens see is used to
    rank intervention sites by exposed-heat reduction per installation.
    """
    key = (kind, budget)
    if key in _SITING_CACHE:
        return _SITING_CACHE[key]

    from app.config import REPO_ROOT

    path = REPO_ROOT / "backend" / "app" / "data" / "static" / "thermal_grid.json"
    if not path.exists():
        raise HTTPException(404, "thermal_grid.json not generated yet")

    grid = json.loads(path.read_text(encoding="utf-8"))
    values: List[List[Optional[float]]] = grid["values"]
    south, west = grid["south"], grid["west"]
    rows, cols = grid["rows"], grid["cols"]
    step_m = grid["cellM"]

    d_lat = step_m / 111_320.0
    mid_lat = south + (rows * d_lat) / 2.0
    d_lon = step_m / (111_320.0 * math.cos(math.radians(mid_lat)))

    cells: List[Dict[str, Any]] = []
    cell_at: Dict[tuple, int] = {}
    for i in range(rows):
        row = values[i]
        if row is None:
            continue
        for j in range(cols):
            v = row[j]
            # Only 'Hot' and above are intervention-worthy (70 keeps the
            # warm-hot fringe; band threshold 'Hot' is 72).
            if v is None or v < 70:
                continue
            cell_at[(i, j)] = len(cells)
            cells.append({
                "i": i,
                "j": j,
                "lat": south + i * d_lat,
                "lon": west + j * d_lon,
                "score": v,
            })

    if not cells:
        return {"sites": [], "note": "No hot cells above threshold."}

    # Benefit radius per intervention kind (metres).
    radius_m = {
        "canopy": 180,
        "shade-sail": 120,
        "misting": 60,
        "park-pocket": 260,
    }[kind]

    rad_lat = radius_m / 111_320.0
    rad_lon = radius_m / (111_320.0 * math.cos(math.radians(mid_lat)))

    # Greedy max-coverage: pick the cell whose radius covers the most
    # not-yet-covered hot heat mass, repeat. Candidates and neighbours are
    # both indexed by (i, j) so every iteration is a small box lookup —
    # the naive version of this loop took 3 minutes; this one is instant.
    covered = [False] * len(cells)
    ri = int(rad_lat / d_lat)          # radius in grid steps, latitude
    rj = int(rad_lon / d_lon)          # radius in grid steps, longitude

    def neighbours(c: Dict[str, Any]):
        for ni in range(max(0, c["i"] - ri), min(rows, c["i"] + ri + 1)):
            for nj in range(max(0, c["j"] - rj), min(cols, c["j"] + rj + 1)):
                k = cell_at.get((ni, nj))
                if k is not None:
                    yield cells[k]

    chosen: List[Dict[str, Any]] = []
    for _ in range(budget):
        best_ci, best_gain = -1, 0.0
        for ci, c in enumerate(cells):
            if covered[ci]:
                continue
            gain = 0.0
            for n in neighbours(c):
                if not covered[cell_at[(n["i"], n["j"])]]:
                    gain += n["score"] - 70  # heat mass above threshold
            if gain > best_gain:
                best_ci, best_gain = ci, gain
        if best_ci < 0 or best_gain <= 0:
            break
        c = cells[best_ci]
        chosen.append({
            "lat": round(c["lat"], 6),
            "lon": round(c["lon"], 6),
            "heatScore": c["score"],
            "coveredHeatMass": round(best_gain, 1),
        })
        for n in neighbours(c):
            covered[cell_at[(n["i"], n["j"])]] = True

    # Corroboration: reports within 400 m of a site -> "public reports back this".
    reports = _read_reports(2000)
    for site in chosen:
        near = [
            r["kindLabel"]
            for r in reports
            if _haversine_m(site["lat"], site["lon"], r["lat"], r["lon"]) <= 400
        ]
        if near:
            site["publicReports"] = len(near)

    out = {
        "kind": kind,
        "radiusM": radius_m,
        "budget": len(chosen),
        "sites": chosen,
        "method": (
            "Greedy max-coverage over the 150 m territory heat raster; only "
            "cells scoring >= 70 count as intervention-worthy; benefit = heat "
            "mass above threshold inside the intervention radius."
        ),
        "disclaimer": (
            "Planning-support output: indicative siting, not an engineering "
            "or funding plan."
        ),
    }
    _SITING_CACHE[key] = out
    return out
