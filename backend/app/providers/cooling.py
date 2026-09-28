"""Cooling-spot and crowd-report providers.

Cooling spots follow the normalized ``CoolingSpot`` model (master prompt
section 45); mock data stands in for future LCSD / government venue feeds.
Crowd reports are anonymised by design and stored without user identifiers.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.providers.spatial import SpatialData

COOLING_SPOT_TYPES = {
    "library": "Public library",
    "community_centre": "Community centre",
    "sports_centre": "Sports centre",
    "shopping_centre": "Shopping centre",
    "market": "Covered market",
    "mtr_station": "MTR station",
    "park": "Park / green space",
    "cultural_venue": "Cultural venue",
}


def to_cooling_spot(feature: Dict[str, Any]) -> Dict[str, Any]:
    """Normalise a GeoJSON feature into the CoolingSpot API shape."""
    p = feature["properties"]
    lon, lat = feature["geometry"]["coordinates"][:2]
    return {
        "id": p["id"],
        "name": p["name"],
        "location": {"lat": lat, "lon": lon},
        "type": p.get("type", "facility"),
        "coolingLevel": int(p.get("coolingLevel", 1)),
        "openingHours": p.get("openingHours", ""),
        "capacityEstimate": p.get("capacityEstimate"),
        "accessibility": bool(p.get("accessibility", True)),
        "simulated": bool(p.get("simulated", False)),
    }


class CoolingSpotProvider:
    def __init__(self, spatial: SpatialData) -> None:
        self._spatial = spatial

    def list(self, district_id: Optional[str] = None) -> List[Dict[str, Any]]:
        return [to_cooling_spot(f) for f in self._spatial.cooling_spots(district_id)]

    def nearest(self, point_lat: float, point_lon: float, limit: int = 3,
                district_id: Optional[str] = None) -> List[Dict[str, Any]]:
        from app.core.geo import haversine_m
        from app.core.types import LatLon

        pt = LatLon(point_lat, point_lon)
        spots = self.list(district_id)
        for s in spots:
            s["distanceMeters"] = round(haversine_m(
                pt, LatLon(s["location"]["lat"], s["location"]["lon"])
            ), 1)
        spots.sort(key=lambda s: s["distanceMeters"])
        return spots[:limit]


class CrowdReportProvider:
    """Simulated crowd reports. Future: anonymised citizen submissions API."""

    def __init__(self, spatial: SpatialData) -> None:
        self._spatial = spatial

    def list(self, district_id: Optional[str] = None) -> List[Dict[str, Any]]:
        out = []
        for f in self._spatial.crowd_reports(district_id):
            lon, lat = f["geometry"]["coordinates"][:2]
            p = f["properties"]
            out.append({
                "id": p["id"],
                "message": p["message"],
                "sentiment": p.get("sentiment", "neutral"),
                "location": {"lat": lat, "lon": lon},
                "anonymised": True,
                "simulated": bool(p.get("simulated", True)),
            })
        return out
