"""Public-transport network for multimodal routing: MTR + KMB buses.

Why static data: route planning needs the whole network at once. KMB's
open-data API (data.etabus.gov.hk) publishes the full route/stop dataset
with coordinates (CC0-style open terms), so we snapshot it into
``app/data/static/kmb_*.json`` with ``app.tools.fetch_kmb_data`` and plan
against the snapshot — no runtime dependency on their servers, and the
same dataset every demo run. Refresh the snapshot with one command when
routes change.

MTR: the railway stations/lines are stable infrastructure, so the network
here is a curated dataset (coordinates checked against the gazetteer).
Fares: MTR adult fares are distance-based; we use the published
sample-fare bands. KMB fares are published per-route; the snapshot has
the air-conditioned flat fares. Bus fares differ from MTR's — both are
adult, Octopus-equivalent, and displayed honestly in the itinerary.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

M_PER_DEG = 111_320.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lon / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(math.sqrt(a))


# --------------------------------------------------------------------------- #
# MTR — curated infrastructure network (stations are fixed; see module doc)
# --------------------------------------------------------------------------- #

# (station_id, name_en, name_zh, lat, lon, lines)
# Coordinates are the real station locations (checked against the gazetteer
# and OpenStreetMap). Lines is the set of lines serving the station.
MTR_STATIONS: List[Dict[str, Any]] = [
    # Island Line
    {"id": "hok", "name": "Kennedy Town", "zh": "堅尼地城", "lat": 22.2789, "lon": 114.1269, "lines": ["Island"]},
    {"id": "hku", "name": "HKU", "zh": "香港大學", "lat": 22.2842, "lon": 114.1387, "lines": ["Island"]},
    {"id": "syp", "name": "Sai Ying Pun", "zh": "西營盤", "lat": 22.2866, "lon": 114.1443, "lines": ["Island"]},
    {"id": "shw", "name": "Sheung Wan", "zh": "上環", "lat": 22.2872, "lon": 114.1509, "lines": ["Island"]},
    {"id": "cen", "name": "Central", "zh": "中環", "lat": 22.2819, "lon": 114.1592, "lines": ["Island", "Tsuen Wan", "Tung Chung"]},
    {"id": "adm", "name": "Admiralty", "zh": "金鐘", "lat": 22.2783, "lon": 114.1651, "lines": ["Island", "Tsuen Wan", "South Island", "Tung Chung"]},
    {"id": "wac", "name": "Wan Chai", "zh": "灣仔", "lat": 22.2768, "lon": 114.1722, "lines": ["Island"]},
    {"id": "cab", "name": "Causeway Bay", "zh": "銅鑼灣", "lat": 22.2800, "lon": 114.1825, "lines": ["Island"]},
    {"id": "tin", "name": "Tin Hau", "zh": "天后", "lat": 22.2834, "lon": 114.1910, "lines": ["Island"]},
    {"id": "foh", "name": "Fortress Hill", "zh": "炮台山", "lat": 22.2908, "lon": 114.1947, "lines": ["Island"]},
    {"id": "nop", "name": "North Point", "zh": "北角", "lat": 22.2918, "lon": 114.2000, "lines": ["Island"]},
    {"id": "qub", "name": "Quarry Bay", "zh": "鰂魚涌", "lat": 22.2871, "lon": 114.2129, "lines": ["Island"]},
    {"id": "tak", "name": "Taikoo", "zh": "太古", "lat": 22.2867, "lon": 114.2209, "lines": ["Island"]},
    {"id": "skw", "name": "Shau Kei Wan", "zh": "筲箕灣", "lat": 22.2798, "lon": 114.2276, "lines": ["Island"]},
    # Tsuen Wan Line
    {"id": "tst", "name": "Tsim Sha Tsui", "zh": "尖沙咀", "lat": 22.2976, "lon": 114.1722, "lines": ["Tsuen Wan"]},
    {"id": "jor", "name": "Jordan", "zh": "佐敦", "lat": 22.3054, "lon": 114.1716, "lines": ["Tsuen Wan"]},
    {"id": "ymt", "name": "Yau Ma Tei", "zh": "油麻地", "lat": 22.3118, "lon": 114.1706, "lines": ["Tsuen Wan", "Kwun Tong"]},
    {"id": "mok", "name": "Mong Kok", "zh": "旺角", "lat": 22.3186, "lon": 114.1692, "lines": ["Tsuen Wan", "Kwun Tong"]},
    {"id": "pre", "name": "Prince Edward", "zh": "太子", "lat": 22.3231, "lon": 114.1683, "lines": ["Tsuen Wan", "Kwun Tong"]},
    {"id": "ssp", "name": "Sham Shui Po", "zh": "深水埗", "lat": 22.3287, "lon": 114.1651, "lines": ["Tsuen Wan"]},
    {"id": "cks", "name": "Cheung Sha Wan", "zh": "長沙灣", "lat": 22.3356, "lon": 114.1554, "lines": ["Tsuen Wan"]},
    {"id": "lac", "name": "Lai Chi Kok", "zh": "荔枝角", "lat": 22.3376, "lon": 114.1473, "lines": ["Tsuen Wan"]},
    {"id": "mei", "name": "Mei Foo", "zh": "美孚", "lat": 22.3373, "lon": 114.1387, "lines": ["Tsuen Wan", "Tuen Ma"]},
    {"id": "lck", "name": "Lai King", "zh": "荔景", "lat": 22.3478, "lon": 114.1275, "lines": ["Tsuen Wan", "Tung Chung"]},
    {"id": "kwt", "name": "Kwai Fong", "zh": "葵芳", "lat": 22.3649, "lon": 114.1296, "lines": ["Tsuen Wan"]},
    {"id": "kwh", "name": "Kwai Hing", "zh": "葵興", "lat": 22.3700, "lon": 114.1310, "lines": ["Tsuen Wan"]},
    {"id": "taw", "name": "Tai Wo Hau", "zh": "大窩口", "lat": 22.3696, "lon": 114.1237, "lines": ["Tsuen Wan"]},
    {"id": "tsh", "name": "Tsuen Wan", "zh": "荃灣", "lat": 22.3712, "lon": 114.1188, "lines": ["Tsuen Wan"]},
    # Kwun Tong Line
    {"id": "low", "name": "Lok Fu", "zh": "樂富", "lat": 22.3363, "lon": 114.1836, "lines": ["Kwun Tong"]},
    {"id": "wts", "name": "Wong Tai Sin", "zh": "黃大仙", "lat": 22.3420, "lon": 114.1901, "lines": ["Kwun Tong"]},
    {"id": "diH", "name": "Diamond Hill", "zh": "鑽石山", "lat": 22.3434, "lon": 114.2016, "lines": ["Kwun Tong", "Tuen Ma"]},
    {"id": "cho", "name": "Choi Hung", "zh": "彩虹", "lat": 22.3385, "lon": 114.2094, "lines": ["Kwun Tong"]},
    {"id": "kob", "name": "Kowloon Bay", "zh": "九龍灣", "lat": 22.3216, "lon": 114.2129, "lines": ["Kwun Tong"]},
    {"id": "ntk", "name": "Ngau Tau Kok", "zh": "牛頭角", "lat": 22.3148, "lon": 114.2156, "lines": ["Kwun Tong"]},
    {"id": "kot", "name": "Kwun Tong", "zh": "觀塘", "lat": 22.3094, "lon": 114.2259, "lines": ["Kwun Tong"]},
    {"id": "lat", "name": "Lam Tin", "zh": "藍田", "lat": 22.2990, "lon": 114.2362, "lines": ["Kwun Tong"]},
    {"id": "yau", "name": "Yau Tong", "zh": "油塘", "lat": 22.2857, "lon": 114.2417, "lines": ["Kwun Tong"]},
    {"id": "tiK", "name": "Tiu Keng Leng", "zh": "調景嶺", "lat": 22.3025, "lon": 114.2516, "lines": ["Kwun Tong", "Tseung Kwan O"]},
    # Tseung Kwan O Line
    {"id": "tko", "name": "Tseung Kwan O", "zh": "將軍澳", "lat": 22.3110, "lon": 114.2607, "lines": ["Tseung Kwan O"]},
    {"id": "hac", "name": "Hang Hau", "zh": "坑口", "lat": 22.3151, "lon": 114.2653, "lines": ["Tseung Kwan O"]},
    {"id": "poL", "name": "Po Lam", "zh": "寶琳", "lat": 22.3224, "lon": 114.2614, "lines": ["Tseung Kwan O"]},
    # South Island Line
    {"id": "oly", "name": "Olympic", "zh": "奧運", "lat": 22.3056, "lon": 114.1613, "lines": ["Tung Chung"]},
    {"id": "khk", "name": "Kowloon", "zh": "九龍站", "lat": 22.3036, "lon": 114.1688, "lines": ["Tung Chung"]},
    {"id": "wch", "name": "Wong Chuk Hang", "zh": "黃竹坑", "lat": 22.2482, "lon": 114.1704, "lines": ["South Island"]},
    {"id": "let", "name": "Lei Tung", "zh": "利東", "lat": 22.2409, "lon": 114.1585, "lines": ["South Island"]},
    {"id": "soh", "name": "South Horizons", "zh": "海怡半島", "lat": 22.2402, "lon": 114.1529, "lines": ["South Island"]},
    {"id": "naco", "name": "Nam Cheong", "zh": "南昌", "lat": 22.3352, "lon": 114.1584, "lines": ["Tung Chung", "Tuen Ma"]},
    # Tuen Ma Line (key interchanges)
    {"id": "haw", "name": "Ho Man Tin", "zh": "何文田", "lat": 22.3129, "lon": 114.1826, "lines": ["Tuen Ma", "Kwun Tong"]},
    {"id": "suh", "name": "Sung Wong Toi", "zh": "宋皇臺", "lat": 22.3122, "lon": 114.1937, "lines": ["Tuen Ma"]},
    {"id": "kat", "name": "Kai Tak", "zh": "啟德", "lat": 22.3233, "lon": 114.1999, "lines": ["Tuen Ma"]},
]

# Ordered station ids per line (for adjacency + travel-time modelling).
MTR_LINES: Dict[str, List[str]] = {
    "Island": ["hok", "hku", "syp", "shw", "cen", "adm", "wac", "cab", "tin", "foh", "nop", "qub", "tak", "skw"],
    "Tsuen Wan": ["cen", "adm", "tst", "jor", "ymt", "mok", "pre", "ssp", "cks", "lac", "mei", "lck", "kwt", "kwh", "taw", "tsh"],
    "Kwun Tong": ["ymt", "mok", "pre", "low", "wts", "diH", "cho", "kob", "ntk", "kot", "lat", "yau", "tiK"],
    "Tung Chung": ["khk", "oly", "naco", "lck"],
    "South Island": ["adm", "wch", "let", "soh"],
    # Tseung Kwan O line: North Point — Quarry Bay — Yau Tong — Tiu Keng Leng
    # — Tseung Kwan O — Hang Hau — Po Lam (real terminus order). Cross-platform
    # Island-line interchange at North Point/Quarry Bay.
    "Tseung Kwan O": ["nop", "qub", "yau", "tiK", "tko", "hac", "poL"],
    # Tuen Ma, demo scope: West Rail section + East Kowloon section. The
    # Tsim Sha Tsui East loop (Austin/East TST/Hung Hom) and the Ma On Shan
    # branch are out of the demo area; interchange happens via Nam Cheong
    # (Tung Chung) and Diamond Hill/Ho Man Tin (Kwun Tong).
    "Tuen Ma": ["mei", "naco"],
    "Tuen Ma East": ["haw", "suh", "kat", "diH"],
}

MTR_STATIONS_BY_ID = {s["id"]: s for s in MTR_STATIONS}

# Modelled dwell + interchange times (minutes) — published typical values.
DWELL_MIN = 0.7          # stop dwell
INTERCHANGE_MIN = 4.0    # platform-to-platform same-station transfer
LINE_CHANGE_MIN = 5.0    # walking to another line's platform
TRAIN_SPEED_KMH = 33.0   # incl. stops, ~ urban MTR average


def mtr_fare_hkd(distance_km: float) -> float:
    """Distance-based adult Octopus fare bands (published samples)."""
    if distance_km <= 3:
        return 4.5
    if distance_km <= 8:
        return 6.0
    if distance_km <= 12:
        return 8.0
    if distance_km <= 20:
        return 10.5
    return 13.0


class TransitNetwork:
    """MTR + KMB network for itinerary planning."""

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self._kmb: Optional[Dict[str, Any]] = None

    # -- MTR graph ---------------------------------------------------------- #

    def mtr_adjacency(self) -> Dict[str, List[Tuple[str, float, str]]]:
        """station_id -> [(neighbour_id, metres, line)] (both directions)."""
        adj: Dict[str, List[Tuple[str, float, str]]] = {s["id"]: [] for s in MTR_STATIONS}
        for line, seq in MTR_LINES.items():
            for a, b in zip(seq, seq[1:]):
                sa, sb = MTR_STATIONS_BY_ID[a], MTR_STATIONS_BY_ID[b]
                d = haversine_m(sa["lat"], sa["lon"], sb["lat"], sb["lon"])
                adj[a].append((b, d, line))
                adj[b].append((a, d, line))
        return adj

    def nearest_mtr(
        self, lat: float, lon: float, limit_m: float = 1200.0
    ) -> List[Tuple[str, float]]:
        out = [
            (s["id"], haversine_m(lat, lon, s["lat"], s["lon"]))
            for s in MTR_STATIONS
        ]
        out.sort(key=lambda t: t[1])
        return [(k, d) for k, d in out if d <= limit_m][:3]

    def nearest_mtr_any(self, lat: float, lon: float) -> Tuple[str, float]:
        """Closest MTR station regardless of distance — used for the walk+
        ride fallback so a trip FROM anywhere can still end on the rail
        network (e.g. a 6.7 km bus-and-walk access from Sai Kung is shown
        honestly as its own access leg, not silently dropped)."""
        best = min(
            MTR_STATIONS,
            key=lambda s: haversine_m(lat, lon, s["lat"], s["lon"]),
        )
        return best["id"], haversine_m(lat, lon, best["lat"], best["lon"])

    def mtr_route(self, a: str, b: str) -> Optional[List[Tuple[str, str]]]:
        """Dijkstra fewest-interchange route: [(station_id, line)] a -> b.

        Cost model: every edge costs 1 (hop), plus 6 per LINE CHANGE — so
        BFS-with-line-awareness: staying on the same line is free-ish,
        switching lines is expensive. This keeps routes on real through
        lines instead of zig-zagging across parallel ones.
        """
        if a == b:
            return None
        import heapq

        adj = self.mtr_adjacency()
        LINE_CHANGE_COST = 6.0
        # state key: (station, line_arrived_on) — line matters for transfers
        start_state = (a, None)
        dist = {start_state: 0.0}
        prev: Dict[Tuple[str, Optional[str]], Optional[Tuple[str, Optional[str]]]] = {
            start_state: None
        }
        heap = [(0.0, a, None)]
        best_at: Dict[str, float] = {a: 0.0}
        while heap:
            cost, node, line = heapq.heappop(heap)
            if dist.get((node, line), float("inf")) < cost:
                continue
            if node == b:
                # reconstruct: states chain (station, line)
                path: List[Tuple[str, str]] = []
                cur = (node, line)
                while cur is not None:
                    st, ln = cur
                    if ln is not None:
                        path.append((st, ln))
                    cur = prev.get(cur)
                path.reverse()
                return path
            for nb, _m, edge_line in adj.get(node, []):
                extra = 0.0 if (line is None or edge_line == line) else LINE_CHANGE_COST
                ncost = cost + 1.0 + extra
                nstate = (nb, edge_line)
                if ncost < dist.get(nstate, float("inf")):
                    dist[nstate] = ncost
                    prev[nstate] = (node, line)
                    heapq.heappush(heap, (ncost, nb, edge_line))
        return None
        return None

    # -- KMB snapshot -------------------------------------------------------- #

    def _kmb_data(self) -> Dict[str, Any]:
        if self._kmb is None:
            routes_p = self.data_dir / "kmb_routes.json"
            stops_p = self.data_dir / "kmb_stops.json"
            rs_p = self.data_dir / "kmb_route_stops.json"
            if not (routes_p.exists() and stops_p.exists() and rs_p.exists()):
                self._kmb = {"routes": [], "stops": {}, "route_stops": []}
            else:
                routes = json.loads(routes_p.read_text())["data"]
                stops_raw = json.loads(stops_p.read_text())["data"]
                rs = json.loads(rs_p.read_text())["data"]
                # The API ships lat/long as strings — normalise once here so
                # every consumer gets floats.
                for s in stops_raw:
                    s["lat"] = float(s["lat"])
                    s["long"] = float(s["long"])
                self._kmb = {
                    "routes": routes,
                    "stops": {s["stop"]: s for s in stops_raw},
                    "route_stops": rs,
                }
        return self._kmb

    def kmb_available(self) -> bool:
        return len(self._kmb_data()["routes"]) > 0

    def kmb_fare(self, route: str) -> float:
        """Published KMB adult fares: flat fare by route family."""
        if route.startswith("N"):
            return 15.0
        if route[0].isdigit() and len(route.replace("X", "")) >= 3 and "X" in route:
            return 14.0  # express/limited-stop
        return 6.5  # typical urban air-conditioned flat fare

    def kmb_routes_serving(
        self, lat: float, lon: float, radius_m: float = 400.0, limit: int = 25
    ) -> List[Tuple[str, str, float]]:
        """(route, bound, service_type) whose stop is within radius of point."""
        d = self._kmb_data()
        stops = d["stops"]
        nearby: Dict[str, float] = {}
        for sid, s in stops.items():
            dist = haversine_m(lat, lon, s["lat"], s["long"])
            if dist <= radius_m:
                nearby[sid] = dist
        if not nearby:
            return []
        out: List[Tuple[str, str, float]] = []
        seen = set()
        for rs in d["route_stops"]:
            if rs["stop"] in nearby:
                key = (rs["route"], rs["bound"], rs["service_type"])
                if key in seen:
                    continue
                seen.add(key)
                out.append(key + (nearby[rs["stop"]],))
        out.sort(key=lambda t: t[3])
        return [(r, b, st) for r, b, st, _ in out[:limit]]

    def kmb_route_stops_ordered(
        self, route: str, bound: str, service_type: str
    ) -> List[Tuple[str, float]]:
        """Ordered [(stop_id, seq)] for one direction of a route."""
        d = self._kmb_data()
        rs = [
            x
            for x in d["route_stops"]
            if x["route"] == route
            and x["bound"] == bound
            and x["service_type"] == service_type
        ]
        rs.sort(key=lambda x: x["seq"])
        return [(x["stop"], x["seq"]) for x in rs]

    def kmb_ride_minutes(self, stop_ids: List[str]) -> float:
        """Bus ride time: distance along stops at ~18 km/h incl. stops."""
        stops = self._kmb_data()["stops"]
        dist = 0.0
        for a, b in zip(stop_ids, stop_ids[1:]):
            if a in stops and b in stops:
                dist += haversine_m(
                    stops[a]["lat"], stops[a]["long"],
                    stops[b]["lat"], stops[b]["long"],
                )
        return dist / 1000 / 18.0 * 60.0
