"""Fetch the KMB open-data route/stop snapshot for offline transit planning.

Run (from backend/):
    .venv/bin/python -m app.tools.fetch_kmb_data

Downloads the three bulk datasets from data.etabus.gov.hk (the official
KMB ETA API, open data) and writes app/data/static/kmb_*.json:

    kmb_routes.json       routes + origins/destinations
    kmb_stops.json        6,700+ stops with coordinates
    kmb_route_stops.json  ordered stop sequences per route/bound

The transit planner (app.providers.transit) reads these snapshots; refresh
with this tool whenever KMB revises routes. Data terms: KMB's open-data
API is published for reuse; we snapshot coordinates/routes only, no
realtime ETAs are cached here.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

BASE = "https://data.etabus.gov.hk/v1/transport/kmb"
DATASETS = {
    "kmb_routes.json": f"{BASE}/route/",
    "kmb_stops.json": f"{BASE}/stop/",
    "kmb_route_stops.json": f"{BASE}/route-stop/",
}
UA = {"User-Agent": "HKCoolPathAI/1.0 (transit planning snapshot)"}


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> None:
    dest = Path(__file__).resolve().parents[1] / "data" / "static"
    dest.mkdir(parents=True, exist_ok=True)
    for name, url in DATASETS.items():
        print(f"fetching {name} ...")
        data = fetch(url)
        n = len(data.get("data", []))
        (dest / name).write_text(json.dumps(data, separators=(",", ":")))
        print(f"  {n} records -> {dest / name}")
    print("done.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — tool must report, not crash CI
        print(f"FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
