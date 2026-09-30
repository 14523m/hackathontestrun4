"""Multimodal transit itinerary planning (MTR + KMB + walking).

Pure service: no HTTP concerns here — the router in app.routes.transit
calls ``plan_transit_trip`` and serialises the result.

Model (honest, published-typical values):
  - WALK legs: the web client routes them on real footpaths (OSRM); this
    planner estimates access/egress walk time for candidate ranking only,
    at 12 min/km.
  - MTR legs: geometric line distance at 33 km/h incl. stops, 0.7 min
    dwell per intermediate station, 4–5 min per interchange, distance-
    banded adult Octopus fares.
  - BUS legs: stop-to-stop distance at 18 km/h, 3 min average wait, the
    route's published flat fare family.

Heat is deliberately NOT applied inside vehicles: the app's heat-aware
pace model is for walkers. A customer in an air-conditioned carriage does
not experience street temperature; the itinerary says so in plain words.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from app.providers.transit import (
    DWELL_MIN,
    INTERCHANGE_MIN,
    LINE_CHANGE_MIN,
    TRAIN_SPEED_KMH,
    MTR_LINES,
    MTR_STATIONS_BY_ID,
    TransitNetwork,
    haversine_m,
    mtr_fare_hkd,
)

WALK_MIN_PER_M = 12.0 / 1000.0  # 12 min/km reference pace
BUS_SPEED_KMH = 18.0
BUS_WAIT_MIN = 4.0
MTR_WAIT_MIN = 2.5  # median headway/2 on dense urban lines


class TransitPlanner:
    """Plans MTR+bus itineraries between two coordinates."""

    def __init__(self, data_dir):
        self.net = TransitNetwork(data_dir)

    # -- station utilities --------------------------------------------------- #

    def _station(self, sid: str):
        return MTR_STATIONS_BY_ID[sid]

    def _mtr_legs(
        self, route: List[Tuple[str, str]]
    ) -> List[Dict[str, Any]]:
        """Collapse [(station, line)] into per-line ride legs with geometry."""
        legs: List[Dict[str, Any]] = []
        for (b, line), (a, _) in zip(route, [(route[0][0], "")] + route[:-1]):
            if legs and legs[-1]["line"] == line:
                legs[-1]["stations"].append(b)
            else:
                legs.append({"line": line, "stations": [route[0][0], b]})
        out: List[Dict[str, Any]] = []
        for leg in legs:
            sts = [self._station(s) for s in leg["stations"]]
            dist = sum(
                haversine_m(
                    sa["lat"], sa["lon"], sb["lat"], sb["lon"]
                )
                for sa, sb in zip(sts, sts[1:])
            )
            out.append(
                {
                    "mode": "mtr",
                    "line": leg["line"],
                    "fromStation": sts[0]["name"],
                    "toStation": sts[-1]["name"],
                    "fromId": leg["stations"][0],
                    "toId": leg["stations"][-1],
                    "stationsCount": len(sts) - 1,
                    "distanceM": round(dist),
                    "minutes": dist / 1000 / TRAIN_SPEED_KMH * 60
                    + DWELL_MIN * max(0, len(sts) - 2),
                    "fare": mtr_fare_hkd(dist / 1000),
                    "coords": [[s["lon"], s["lat"]] for s in sts],
                }
            )
        return out

    # -- MTR itinerary ------------------------------------------------------- #

    def _mtr_itinerary(
        self,
        from_lat: float,
        from_lon: float,
        to_lat: float,
        to_lon: float,
    ) -> Optional[Dict[str, Any]]:
        board = self.net.nearest_mtr(from_lat, from_lon)
        alight = self.net.nearest_mtr(to_lat, to_lon)
        # Walk+ride fallback: origins/destinations far from any station
        # (Sai Kung, mid-NT villages) still get an honest itinerary — long
        # access leg shown in plain words — instead of an empty result.
        if not board:
            sid, dist = self.net.nearest_mtr_any(from_lat, from_lon)
            board = [(sid, dist)]
        if not alight:
            sid, dist = self.net.nearest_mtr_any(to_lat, to_lon)
            alight = [(sid, dist)]
        best: Optional[Dict[str, Any]] = None
        for (bs, bd), (asx, ad) in [
            ((b, d1), (a, d2)) for b, d1 in board for a, d2 in alight
        ]:
            route = self.net.mtr_route(bs, asx)
            if not route:
                continue
            walk_in = bd * WALK_MIN_PER_M
            walk_out = ad * WALK_MIN_PER_M
            mtr_legs = self._mtr_legs(route)
            # Drop zero-distance phantom legs (board station repeated when
            # the route starts with a line change at the boarding station).
            mtr_legs = [
                l for l in mtr_legs
                if l["fromId"] != l["toId"] or l["distanceM"] > 0
            ]
            if not mtr_legs:
                continue
            ride = sum(l["minutes"] for l in mtr_legs)
            xfers = max(0, len(mtr_legs) - 1)
            ride += xfers * LINE_CHANGE_MIN
            wait = MTR_WAIT_MIN
            fare = sum(l["fare"] for l in mtr_legs)
            total = walk_in + wait + ride + walk_out
            if best is None or total < best["totalMin"]:
                best = {
                    "board": bs,
                    "alight": asx,
                    "walkInM": round(bd),
                    "walkOutM": round(ad),
                    "legs": mtr_legs,
                    "transfers": xfers,
                    "fare": round(fare, 1),
                    "totalMin": total,
                }
        return best

    # -- BUS itinerary ------------------------------------------------------- #

    def _bus_itinerary(
        self,
        from_lat: float,
        from_lon: float,
        to_lat: float,
        to_lon: float,
    ) -> Optional[Dict[str, Any]]:
        if not self.net.kmb_available():
            return None
        board_routes = self.net.kmb_routes_serving(from_lat, from_lon, 450.0, 30)
        alight_routes = self.net.kmb_routes_serving(to_lat, to_lon, 450.0, 60)
        board_set = {(r, b, st) for r, b, st in board_routes}
        candidates: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        d = self.net._kmb_data()["stops"]
        # The walk budget keeps bus candidates honest: boarding or alighting
        # more than ~900 m from the trip endpoint means the "bus" itinerary
        # is mostly walking anyway.
        MAX_WALK_ACCESS_M = 900.0
        for r, bound, st in alight_routes:
            if (r, bound, st) not in board_set:
                continue
            stops = self.net.kmb_route_stops_ordered(r, bound, st)
            ids = [s for s, _ in stops]
            # Board at the LAST stop near the origin, alight at the FIRST
            # stop near the destination: the bus must travel origin->dest,
            # and stop names repeat on a route so nearest-stop matching can
            # otherwise pair the wrong two stops (e.g. board at an alighting
            # stop further along the route).
            bi = max(
                (
                    i
                    for i, s in enumerate(ids)
                    if s in d
                    and haversine_m(from_lat, from_lon, d[s]["lat"], d[s]["long"])
                    <= MAX_WALK_ACCESS_M
                ),
                default=None,
            )
            ai = min(
                (
                    i
                    for i, s in enumerate(ids)
                    if i > (bi if bi is not None else -1)
                    and s in d
                    and haversine_m(to_lat, to_lon, d[s]["lat"], d[s]["long"])
                    <= MAX_WALK_ACCESS_M
                ),
                default=None,
            )
            if bi is None or ai is None or ai <= bi:
                continue
            ride_ids = ids[bi : ai + 1]
            walk_in = (
                haversine_m(
                    from_lat, from_lon, d[ride_ids[0]]["lat"], d[ride_ids[0]]["long"]
                )
                * WALK_MIN_PER_M
            )
            walk_out = (
                haversine_m(
                    to_lat, to_lon, d[ride_ids[-1]]["lat"], d[ride_ids[-1]]["long"]
                )
                * WALK_MIN_PER_M
            )
            ride = self.net.kmb_ride_minutes(ride_ids)
            total = BUS_WAIT_MIN + walk_in + ride + walk_out
            fare = self.net.kmb_fare(r)
            coords = [
                [d[s]["long"], d[s]["lat"]] for s in ride_ids if s in d
            ]
            key = (r, bound, st)
            if (
                key not in candidates
                or total < candidates[key]["totalMin"]
            ):
                candidates[key] = {
                    "route": r,
                    "bound": bound,
                    "serviceType": st,
                    "boardStop": d[ride_ids[0]]["name_en"].title(),
                    "alightStop": d[ride_ids[-1]]["name_en"].title(),
                    "stopsCount": len(ride_ids) - 1,
                    "walkInM": round(
                        haversine_m(
                            from_lat,
                            from_lon,
                            d[ride_ids[0]]["lat"],
                            d[ride_ids[0]]["long"],
                        )
                    ),
                    "walkOutM": round(
                        haversine_m(
                            to_lat,
                            to_lon,
                            d[ride_ids[-1]]["lat"],
                            d[ride_ids[-1]]["long"],
                        )
                    ),
                    "minutes": ride,
                    "fare": fare,
                    "totalMin": total,
                    "coords": coords,
                }
        if not candidates:
            return None
        best = min(candidates.values(), key=lambda c: c["totalMin"])
        best["legs"] = [
            {
                "mode": "bus",
                "line": best["route"],
                "fromStation": best["boardStop"],
                "toStation": best["alightStop"],
                "stationsCount": best["stopsCount"],
                "distanceM": None,
                "minutes": best["minutes"],
                "fare": best["fare"],
                "coords": best["coords"],
            }
        ]
        return best

    # -- public API ----------------------------------------------------------- #

    def plan(
        self,
        from_lat: float,
        from_lon: float,
        to_lat: float,
        to_lon: float,
        modes: List[str],
    ) -> List[Dict[str, Any]]:
        """Return ranked itineraries for the requested modes.

        Each itinerary: {mode, label, totalMin, fare, transfers, legs[]}.
        Walk-only itineraries are the client's job (OSRM); this returns
        transit options only.
        """
        out: List[Dict[str, Any]] = []
        if "mtr" in modes:
            m = self._mtr_itinerary(from_lat, from_lon, to_lat, to_lon)
            if m:
                out.append(
                    {
                        "mode": "mtr",
                        "label": "MTR",
                        "totalMin": round(m["totalMin"], 1),
                        "fare": m["fare"],
                        "transfers": m["transfers"],
                        "walkInM": m["walkInM"],
                        "walkOutM": m["walkOutM"],
                        "legs": m["legs"],
                    }
                )
        if "bus" in modes:
            b = self._bus_itinerary(from_lat, from_lon, to_lat, to_lon)
            if b:
                out.append(
                    {
                        "mode": "bus",
                        "label": f"Bus {b['route']}",
                        "totalMin": round(b["totalMin"], 1),
                        "fare": b["fare"],
                        "transfers": 0,
                        "walkInM": b["walkInM"],
                        "walkOutM": b["walkOutM"],
                        "legs": b["legs"],
                    }
                )
        out.sort(key=lambda x: x["totalMin"])
        # Flag itineraries whose access walk exceeds a realistic 25 min: the
        # UI shows a caveat instead of pretending it's convenient.
        for it in out:
            long_walk = max(it["walkInM"], it["walkOutM"]) > 2000
            it["longAccess"] = long_walk
            if long_walk:
                it["label"] += " (+ long walk)"
        return out
