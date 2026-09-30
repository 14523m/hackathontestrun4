"""Fetch the Hong Kong territorial boundary from OpenStreetMap (once).

Run (from backend/):
    .venv/bin/python -m app.tools.fetch_hk_boundary

Downloads the OSM admin boundary for Hong Kong (relation 913110) via the
Overpass API, keeps outer rings, and writes app/data/static/hk_boundary.json:

    { "source": "© OpenStreetMap contributors", "rings": [[[lon, lat], ...], ...] }

That file is the LAND MASK for generate_thermal_grid.py (the demo district
rectangles only cover small areas, leaving gaps like Central). Committed to
the repo afterwards, so the thermal grid stays deterministic and offline.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx

OVERPASS = "https://overpass.kumi.systems/api/interpreter"
QUERY = """
[out:json][timeout:180];
relation(913110);
out geom;
"""


def main() -> None:
    print("Fetching Hong Kong boundary (OSM relation 913110) via Overpass...")
    r = httpx.post(
        OVERPASS,
        content=f"data={QUERY}",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "HKCoolPathAI/0.1 (boundary fetch for thermal grid)",
        },
        timeout=240,
    )
    r.raise_for_status()
    el = r.json()["elements"]

    # Assemble ways into rings by matching consecutive node ids.
    ways = [e for e in el if e["type"] == "way"]
    nodes = {e["id"]: (e["lon"], e["lat"]) for e in el if e["type"] == "node"}
    rings: list = []
    used = set()
    for w in ways:
        if w["id"] in used:
            continue
        chain = list(w["nodes"])
        used.add(w["id"])
        extended = True
        while extended:
            extended = False
            for w2 in ways:
                if w2["id"] in used:
                    continue
                if w2["nodes"][0] == chain[-1]:
                    chain.extend(w2["nodes"][1:])
                    used.add(w2["id"])
                    extended = True
                elif w2["nodes"][-1] == chain[-1]:
                    chain.extend(list(reversed(w2["nodes"]))[1:])
                    used.add(w2["id"])
                    extended = True
        if len(chain) >= 4 and chain[0] == chain[-1]:
            ring = [[*nodes[n]] for n in chain if n in nodes]
            if len(ring) >= 4:
                rings.append(ring)

    rings.sort(key=len, reverse=True)
    rings = rings[:12]  # mainland + major islands; drop tiny specks
    out = {
        "source": "© OpenStreetMap contributors (relation 913110)",
        "rings": rings,
    }
    dest = Path(__file__).resolve().parent.parent / "data" / "static" / "hk_boundary.json"
    dest.write_text(json.dumps(out))
    pts = sum(len(r) for r in rings)
    print(f"wrote {dest}: {len(rings)} rings, {pts} vertices")


if __name__ == "__main__":
    main()
