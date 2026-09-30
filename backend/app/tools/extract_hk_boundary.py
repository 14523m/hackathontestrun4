"""Extract Hong Kong land polygons from Natural Earth 10m subunits.

One-time tool: converts the downloaded shapefile (no external deps — a minimal
.shp/.shx/.dbf polygon reader) into app/data/static/hk_boundary.json rings.
Run from backend/ after fetching the NE zip (see README or run the curl in
the repo docs):

  python -m app.tools.extract_hk_boundary /path/to/ne_10m_admin_0_map_subunits.zip
"""

from __future__ import annotations

import json
import struct
import sys
import zipfile
from pathlib import Path


def read_shp_polygons(shp_bytes: bytes):
    """Minimal .shp reader: returns lists of rings (each a list of [x, y])."""
    polygons = []
    # Shapefile: 100-byte header, then records: 8-byte header + content.
    pos = 100
    while pos + 8 <= len(shp_bytes):
        _rec_num, content_len = struct.unpack(">ii", shp_bytes[pos:pos + 8])
        pos += 8
        content = shp_bytes[pos:pos + content_len * 2]
        pos += content_len * 2
        if len(content) < 4:
            continue
        (shape_type,) = struct.unpack("<i", content[:4])
        if shape_type not in (5, 15, 25):  # Polygon, PolygonZ, PolygonM
            continue
        # BBox (4 doubles), numParts (int32), numPoints (int32)
        _bbox = struct.unpack("<4d", content[4:36])
        num_parts, num_points = struct.unpack("<2i", content[36:44])
        parts = struct.unpack(f"<{num_parts}i", content[44:44 + 4 * num_parts])
        pts_off = 44 + 4 * num_parts
        points = [
            struct.unpack_from("<2d", content, pts_off + k * 16)
            for k in range(num_points)
        ]
        for p in range(num_parts):
            start = parts[p]
            end = parts[p + 1] if p + 1 < num_parts else num_points
            ring = [[x, y] for x, y in points[start:end]]
            if len(ring) >= 4:
                polygons.append(ring)
    return polygons


def read_dbf_names(dbf_bytes: bytes) -> list:
    """Field names from the .dbf header (needed to find the HK row)."""
    n_fields = (dbf_bytes[8] - 1) // 32
    names = []
    for i in range(n_fields):
        off = 32 + i * 32
        names.append(dbf_bytes[off:off + 11].split(b"\x00")[0].decode("latin-1"))
    return names


def main() -> None:
    zip_path = sys.argv[1] if len(sys.argv) > 1 else "ne.zip"
    zf = zipfile.ZipFile(zip_path)
    shp = zf.read("ne_10m_admin_0_map_subunits.shp")
    dbf = zf.read("ne_10m_admin_0_map_subunits.dbf")

    fields = read_dbf_names(dbf)
    # Parse dbf records minimally to find SU_A3/SU_A3/HK rows.
    n_records = struct.unpack("<i", dbf[4:8])[0]
    header_len = struct.unpack("<H", dbf[8:10])[0]
    rec_len = struct.unpack("<H", dbf[10:12])[0]
    hk_indices = []
    for r in range(n_records):
        rec = dbf[header_len + r * rec_len: header_len + (r + 1) * rec_len]
        off = 1
        vals = {}
        for name in fields:
            # assume fixed char fields; grab raw slice and strip
            # field lengths are encoded per field; re-scan descriptor
            break
        # Simpler: search raw record for 'HKG' or 'Hong Kong'
        if b"HKG" in rec or b"Hong K" in rec:
            hk_indices.append(r)
    if not hk_indices:
        raise SystemExit("no HK row found in dbf")

    polygons = read_shp_polygons(shp)
    # HK polygons in NE 10m subunits: small rings in the HK bbox.
    HK_BBOX = (113.75, 21.9, 114.55, 22.65)
    hk = [
        ring for ring in polygons
        if len(ring) >= 4
        and all(
            HK_BBOX[0] <= x <= HK_BBOX[2] and HK_BBOX[1] <= y <= HK_BBOX[3]
            for x, y in ring
        )
    ]
    if not hk:
        raise SystemExit("no HK polygons found in shp")
    hk.sort(key=len, reverse=True)
    hk = [r for r in hk if len(r) >= 8][:60]
    out = {
        "source": "Natural Earth 10m admin_0_map_subunits (public domain)",
        "rings": hk,
    }
    dest = Path(__file__).resolve().parent.parent / "data" / "static" / "hk_boundary.json"
    dest.write_text(json.dumps(out))
    print(f"wrote {dest}: {len(hk)} rings, {sum(len(r) for r in hk)} vertices")
    for r in hk[:5]:
        lons = [p[0] for p in r]
        lats = [p[1] for p in r]
        print(f"  ring {len(r)} pts | lon {min(lons):.3f}-{max(lons):.3f} lat {min(lats):.3f}-{max(lats):.3f}")


if __name__ == "__main__":
    main()
