"""Build the HK land polygon set from the downloaded OSM coastline ways.

Input: the Overpass response saved from
    way["natural"="coastline"](22.10,113.80,22.62,114.46);out geom;
(as hk_coast.json in the Freebuff tmp dir — one-time, the result is committed).

The OSM coastline model: ways are directed so that LAND is on the LEFT of
travel direction. Chaining ways into closed loops yields islands (land rings)
and holes (lakes); loop closure against the query bbox yields mainland pieces.
For a raster land mask at 150 m this simple chaining + bbox closing is ample.

Run from backend/:
    python -m app.tools.build_coastline_mask <hk_coast.json>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SOUTH, WEST, NORTH, EAST = 22.05, 113.75, 22.70, 114.55


def main() -> None:
    src = Path(sys.argv[1])
    el = json.loads(src.read_text())["elements"]
    ways = [e for e in el if e.get("type") == "way" and e.get("geometry")]

    # Chain ways: match end->start coordinates.
    def start(w):
        return (w["geometry"][0]["lat"], w["geometry"][0]["lon"])

    def end(w):
        return (w["geometry"][-1]["lat"], w["geometry"][-1]["lon"])

    by_start = {}
    for w in ways:
        by_start.setdefault(start(w), []).append(w)

    used = set()
    chains = []
    for w in ways:
        if id(w) in used:
            continue
        chain = [w]
        used.add(id(w))
        while True:
            tail = end(chain[-1])
            nxt = next((w2 for w2 in by_start.get(tail, []) if id(w2) not in used), None)
            if nxt is None:
                break
            chain.append(nxt)
            used.add(id(nxt))
        chains.append(chain)

    # Convert chains to coordinate paths. Closure rules:
    #   - closed chain (pts[0]==pts[-1]): island/lake ring, keep as-is;
    #   - open chain whose endpoints lie ON the bbox edge: close around the
    #     bbox perimeter (the coast exits and re-enters the window);
    #   - open chain with both endpoints INSIDE the window: the coast leaves
    #     the window through a neighbouring dataset — for HK the mainland
    #     chain breaks at the Shenzhen border, so a straight end->start cut
    #     approximates the land border (fine at 150 m raster resolution).
    def on_edge(p):
        x, y = p
        return (
            abs(x - WEST) < 1e-6 or abs(x - EAST) < 1e-6
            or abs(y - SOUTH) < 1e-6 or abs(y - NORTH) < 1e-6
        )

    rings = []
    for chain in chains:
        pts = [[c["lon"], c["lat"]] for seg in chain for c in seg["geometry"]]
        if len(pts) < 4:
            continue
        if pts[0] == pts[-1]:
            rings.append(pts)
            continue
        (x0, y0), (x1, y1) = pts[0], pts[-1]
        if not on_edge(pts[0]) and not on_edge(pts[-1]):
            rings.append(pts + [[x0, y0]])  # straight border cut
            continue
        corners = [[WEST, NORTH], [EAST, NORTH], [EAST, SOUTH], [WEST, SOUTH]]

        def near(px, py):
            return min(corners, key=lambda c: (c[0] - px) ** 2 + (c[1] - py) ** 2)

        c_end = near(x1, y1)
        c_start = near(x0, y0)
        path = pts[:] + [c_end]
        order = [[WEST, NORTH], [EAST, NORTH], [EAST, SOUTH], [WEST, SOUTH], [WEST, NORTH]]
        ie = order.index(c_end[:]) if c_end[:] in [o[:] for o in order] else 0
        isx = order.index(c_start[:]) if c_start[:] in [o[:] for o in order] else 0
        walk = order[ie:isx + 1] if ie <= isx else order[ie:] + order[:isx + 1]
        path += walk
        path.append([x0, y0])
        rings.append(path)

    # Keep substantial rings only; drop specks.
    rings.sort(key=len, reverse=True)
    rings = [r for r in rings if len(r) >= 12][:400]
    out = {
        "source": "© OpenStreetMap contributors (coastline ways)",
        "rings": rings,
    }
    dest = Path(__file__).resolve().parent.parent / "data" / "static" / "hk_boundary.json"
    dest.write_text(json.dumps(out))
    total = sum(len(r) for r in rings)
    print(f"wrote {dest}: {len(rings)} rings, {total} vertices")
    print("largest rings:")
    for r in rings[:5]:
        lons = [p[0] for p in r]
        lats = [p[1] for p in r]
        print(f"  {len(r)} pts | lon {min(lons):.3f}-{max(lons):.3f} lat {min(lats):.3f}-{max(lats):.3f}")


if __name__ == "__main__":
    main()
