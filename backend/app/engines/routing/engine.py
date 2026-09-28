"""Route engine: heat-aware pedestrian routing.

Pipeline (master prompt section 38):
    pedestrian network -> heat per edge -> weighted graph -> mode-weighted
    shortest-path search -> duration-weighted exposure aggregation.

NOT a recoloured shortest path: the three modes use different (alpha, beta,
gamma) cost weights, and a mode that collapses onto another mode's streets
generates a penalty re-route - accepted only if it genuinely reduces heat
exposure.
"""

from __future__ import annotations

import heapq
import math
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from app.core.geo import path_length_m
from app.core.types import LatLon
from app.engines.heat.engine import HeatPredictionService
from app.providers.spatial import SpatialData

WALK_SPEED_MS = 1.2  # ~4.3 km/h on flat ground

# Route preference -> (alpha=travel time, beta=heat, gamma=slope) weights.
# Prototype calibration parameters - documented in docs/architecture.md.
# Coolest must be willing to take LONG detours to avoid hot streets:
# its marginal heat cost (beta * dHeat) must clearly exceed its time cost.
MODE_WEIGHTS: Dict[str, Tuple[float, float, float]] = {
    "fastest": (1.0, 0.05, 0.5),
    "balanced": (0.6, 1.0, 0.5),
    "coolest": (0.15, 2.5, 0.5),
}

MODE_META = {
    "fastest": {"label": "Fastest", "emoji": "☀️"},
    "balanced": {"label": "Balanced", "emoji": "🌤️"},
    "coolest": {"label": "Coolest", "emoji": "🌳"},
}

HOT_EDGE_THRESHOLD = 0.65  # edge heat fraction counting as "highly exposed"


class RouteEngine:
    def __init__(self, spatial: SpatialData, heat: HeatPredictionService) -> None:
        self._spatial = spatial
        self._heat = heat

    # -- graph construction ---------------------------------------------------- #

    def build_graph(
        self, district_id: str, dt_local: datetime,
        edge_penalties: Optional[Dict[str, float]] = None,
    ) -> Dict[str, List[Tuple[str, Dict[str, Any]]]]:
        """Adjacency: node key -> [(neighbour key, edge payload), ...].

        Heat is evaluated per edge for the requested time, so the best route
        depends on WHEN you walk. ``edge_penalties`` lets the planner inject
        hypothetical interventions as per-edge heat adjustments.
        """
        penalties = edge_penalties or {}
        adj: Dict[str, List[Tuple[str, Dict[str, Any]]]] = {}
        for edge in self._spatial.network(district_id):
            coords = [(c[1], c[0]) for c in edge["geometry"]["coordinates"]]
            if len(coords) < 2:
                continue
            eid = edge["properties"]["id"]
            length = float(edge["properties"].get("lengthM") or path_length_m(coords))
            props = edge["properties"]
            gradient = float(props.get("gradientPct", 0.0) or 0.0)
            pred = self._heat.predict_edge(district_id, edge, dt_local)
            heat = min(1.0, max(0.0, float(pred["heatScore"]) / 100.0
                                + penalties.get(eid, 0.0)))

            slope_penalty_min = abs(gradient) / 100.0 * length / 60.0 * 2.5
            duration_min = length / WALK_SPEED_MS / 60.0 + slope_penalty_min

            payload = {
                "edgeId": eid,
                "lengthM": length,
                "durationMin": duration_min,
                "heat": heat,
                "heatScore": pred["heatScore"],
                "gradientPct": gradient,
                "shade": float(pred.get("shadeScore", 0.0)),
                "kind": props.get("kind", "street"),
                "coords": coords,
            }
            a, b = coords[0], coords[-1]
            for u, v in ((a, b), (b, a)):  # pedestrian: undirected
                adj.setdefault(self._key(u), []).append((self._key(v), payload))
        return adj

    @staticmethod
    def _key(pt: Tuple[float, float]) -> str:
        return f"{pt[0]:.5f},{pt[1]:.5f}"

    # -- snapping ---------------------------------------------------------------- #

    def snap_to_graph(
        self, district_id: str, point: LatLon
    ) -> Tuple[str, Tuple[float, float]]:
        """Snap an arbitrary origin/destination to the nearest network node."""
        best_d, best_pt = float("inf"), None
        cos_lat = math.cos(math.radians(point.lat))
        for edge in self._spatial.network(district_id):
            for c in edge["geometry"]["coordinates"]:
                ll = (c[1], c[0])
                d = math.hypot((ll[0] - point.lat) * 111_320.0,
                               (ll[1] - point.lon) * 111_320.0 * cos_lat)
                if d < best_d:
                    best_d, best_pt = d, ll
        if best_pt is None:
            raise ValueError(f"No pedestrian network in district '{district_id}'")
        return self._key(best_pt), best_pt

    # -- search ------------------------------------------------------------------- #

    def _dijkstra(
        self,
        adj: Dict[str, List[Tuple[str, Dict[str, Any]]]],
        start: str,
        goal: str,
        alpha: float, beta: float, gamma: float,
    ) -> Optional[List[Tuple[str, Dict[str, Any]]]]:
        """Weighted Dijkstra; returns [(node_key, edge_payload), ...] or None.

        Cost = alpha*duration + beta*heat*duration + gamma*slope_penalty.
        """
        dist: Dict[str, float] = {start: 0.0}
        prev: Dict[str, Optional[Tuple[str, Dict[str, Any]]]] = {start: None}
        pq: List[Tuple[float, str]] = [(0.0, start)]
        visited: set = set()
        while pq:
            d, u = heapq.heappop(pq)
            if u in visited:
                continue
            visited.add(u)
            if u == goal:
                break
            for v, payload in adj.get(u, []):
                edge_cost = (
                    alpha * payload["durationMin"]
                    + beta * payload["heat"] * payload["durationMin"]
                    + gamma * abs(payload["gradientPct"]) * 0.4
                )
                nd = d + edge_cost
                if v not in dist or nd < dist[v]:
                    dist[v] = nd
                    prev[v] = (u, payload)
                    heapq.heappush(pq, (nd, v))
        if goal not in visited and goal not in dist:
            return None
        # Reconstruct.
        path: List[Tuple[str, Dict[str, Any]]] = []
        cur: Optional[str] = goal
        while cur is not None:
            step = prev.get(cur)
            if step is None:
                path.append((cur, {}))  # start node, no incoming edge
                break
            u, payload = step
            path.append((cur, payload))
            cur = u
        path.reverse()
        return path if path and path[0][0] == start else None

    # -- route metrics ------------------------------------------------------------ #

    def _metrics(self, path: List[Tuple[str, Dict[str, Any]]]) -> Dict[str, Any]:
        edges = [p for _, p in path if p]
        if not edges:
            raise ValueError("Empty path")
        distance = sum(e["lengthM"] for e in edges)
        duration = sum(e["durationMin"] for e in edges)
        # Duration-weighted heat exposure (section 49): a 30 s scorching
        # stretch counts less than 15 min of moderate exposure.
        weighted_heat = sum(e["heat"] * e["durationMin"] for e in edges)
        exposure = weighted_heat / duration if duration > 0 else 0.0
        hot_minutes = sum(
            e["durationMin"] for e in edges if e["heat"] >= HOT_EDGE_THRESHOLD
        )
        shade_score = (sum(e["shade"] * e["durationMin"] for e in edges) / duration
                       if duration > 0 else 0.0)
        geometry: List[List[float]] = []
        for i in range(1, len(path)):
            prev_key = path[i - 1][0]
            payload = path[i][1]
            if not payload:
                continue
            coords = payload["coords"]
            # Orient the segment along traversal direction.
            if self._key(coords[0]) != prev_key:
                coords = list(reversed(coords))
            seg = [[c[1], c[0]] for c in coords]
            if geometry and geometry[-1] == seg[0]:
                geometry.extend(seg[1:])
            else:
                geometry.extend(seg)
        return {
            "edges": edges,
            "geometry": {"type": "LineString", "coordinates": geometry},
            "distanceMeters": round(distance, 1),
            "durationMinutes": round(duration, 1),
            "heatExposure": round(exposure * 100.0, 1),
            "averageHeat": round(
                sum(e["heat"] for e in edges) / len(edges) * 100.0, 1),
            "hottestStretchMinutes": round(hot_minutes, 1),
            "shadeScore": round(shade_score, 2),
            "slopePenaltySeconds": round(sum(
                abs(e["gradientPct"]) / 100.0 * e["lengthM"] / 1.2 * 2.5
                for e in edges), 1),
        }

    @staticmethod
    def _summary(metrics: Dict[str, Any]) -> str:
        """Plain-language route summary for the UI cards."""
        total = metrics["durationMinutes"] or 1.0
        lane_share = sum(
            e["durationMin"] for e in metrics["edges"] if e["kind"] == "lane"
        ) / total
        if lane_share > 0.5:
            return "Mostly tree-lined green lanes with continuous shade"
        if metrics["shadeScore"] >= 0.5:
            return "Predominantly shaded streets between buildings"
        if metrics["hottestStretchMinutes"] >= 5:
            return "Direct route with extended sun-exposed stretches"
        return "Mixed street conditions"

    # -- public API ------------------------------------------------------------------ #

    def plan_routes(
        self,
        district_id: str,
        origin: LatLon,
        destination: LatLon,
        dt_local: datetime,
        requested_type: Optional[str] = None,
        edge_penalties: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        """Generate up to three route options (fastest / balanced / coolest)."""
        adj = self.build_graph(district_id, dt_local, edge_penalties)
        start, _ = self.snap_to_graph(district_id, origin)
        goal, _ = self.snap_to_graph(district_id, destination)

        results: Dict[str, Dict[str, Any]] = {}
        for mode, (alpha, beta, gamma) in MODE_WEIGHTS.items():
            path = self._dijkstra(adj, start, goal, alpha, beta, gamma)
            if not path:
                continue
            metrics = self._metrics(path)
            metrics["type"] = mode
            metrics["nodePath"] = [k for k, _ in path]
            results[mode] = metrics

        if not results:
            raise ValueError("No route found between origin and destination")

        # De-duplicate: if modes found identical streets, try a penalty
        # re-route that avoids them. Accept it ONLY if it genuinely reduces
        # heat exposure (section 50) - never return a worse route just to
        # fake variety. Otherwise keep the optimal path (identical is honest).
        deduped: Dict[str, Dict[str, Any]] = {}
        seen_signatures: Dict[str, str] = {}
        for mode in ("fastest", "balanced", "coolest"):
            if mode not in results:
                continue
            sig = ",".join(results[mode]["nodePath"])
            if sig in seen_signatures.values():
                alt = self._alternative(adj, start, goal, mode,
                                        avoid=results[mode]["nodePath"])
                if alt:
                    alt_metrics = self._metrics(alt["path"])
                    if alt_metrics["heatExposure"] < results[mode]["heatExposure"] - 0.5:
                        alt_metrics["type"] = mode
                        alt_metrics["nodePath"] = alt["nodePath"]
                        results[mode] = alt_metrics
                        sig = alt_metrics["nodePath"] and ",".join(alt_metrics["nodePath"])
            deduped[mode] = results[mode]
            seen_signatures[mode] = sig

        options: List[Dict[str, Any]] = []
        for mode in ("fastest", "balanced", "coolest"):
            if mode not in deduped:
                continue
            m = deduped[mode]
            meta = MODE_META[mode]
            options.append({
                "id": f"route-{mode}",
                "type": mode,
                "label": meta["label"],
                "emoji": meta["emoji"],
                "summary": self._summary(m),
                **m,
            })
        options.sort(key=lambda o: o["heatExposure"], reverse=True)
        return {"options": options}

    def _alternative(
        self, adj, start: str, goal: str, mode: str, avoid: List[str]
    ) -> Optional[Dict[str, Any]]:  # noqa: ANN001
        """Penalty re-route: temporarily raise cost on the previous path's
        edges so the search must find genuinely different streets."""
        alpha, beta, gamma = MODE_WEIGHTS[mode]
        blocked_edges = set()
        for u_k, v_k in zip(avoid, avoid[1:]):
            blocked_edges.add((u_k, v_k))
        def adj_without(u_key: str):
            out = []
            for v, payload in adj.get(u_key, []):
                if (u_key, v) in blocked_edges or (v, u_key) in blocked_edges:
                    continue
                out.append((v, payload))
            return out
        dist = {start: 0.0}
        prev: Dict[str, Optional[Tuple[str, Dict[str, Any]]]] = {start: None}
        pq: List[Tuple[float, str]] = [(0.0, start)]
        visited: set = set()
        while pq:
            d, u = heapq.heappop(pq)
            if u in visited:
                continue
            visited.add(u)
            if u == goal:
                break
            for v, payload in adj_without(u):
                edge_cost = (alpha * payload["durationMin"]
                             + beta * payload["heat"] * payload["durationMin"]
                             + gamma * abs(payload["gradientPct"]) * 0.4)
                nd = d + edge_cost
                if v not in dist or nd < dist[v]:
                    dist[v] = nd
                    prev[v] = (u, payload)
                    heapq.heappush(pq, (nd, v))
        if goal not in dist:
            return None
        path: List[Tuple[str, Dict[str, Any]]] = []
        cur: Optional[str] = goal
        while cur is not None:
            step = prev.get(cur)
            if step is None:
                path.append((cur, {}))
                break
            u, payload = step
            path.append((cur, payload))
            cur = u
        path.reverse()
        if not path or path[0][0] != start:
            return None
        return {"path": path, "nodePath": [k for k, _ in path]}
