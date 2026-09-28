"""CityBrain integration boundary.

We do NOT have access to City Brain APIs. This module defines the seam where
such a system (or any smart-city data platform) would plug in, plus a mock
implementation returning demonstration data. Real integration requirements
are documented in docs/data-sources.md.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List


class CityBrainProvider(ABC):
    """Boundary for a future smart-city data platform integration."""

    @abstractmethod
    def capability_statement(self) -> Dict[str, Any]:
        """Describe what a live integration would provide."""

    @abstractmethod
    def urban_indicators(self, district_id: str) -> List[Dict[str, Any]]:
        """Return district-level urban indicators (simulated in mock)."""


class MockCityBrainProvider(CityBrainProvider):
    """Demonstration provider. Clearly labelled simulated - never passed off
    as an official smart-city feed."""

    def capability_statement(self) -> Dict[str, Any]:
        return {
            "provider": "MockCityBrainProvider",
            "isSimulated": True,
            "plannedCapabilities": [
                "Spatial data retrieval (base maps, land parcels, 3D tiles)",
                "IoT environmental sensor streams",
                "Urban infrastructure registries",
                "Cross-dataset geospatial joins",
            ],
            "integrationRequirements": [
                "API credentials and access approval from the platform operator",
                "Network access from the deployment environment",
                "Dataset schema documentation and licensing terms",
                "Rate-limit and caching strategy agreement",
            ],
        }

    def urban_indicators(self, district_id: str) -> List[Dict[str, Any]]:
        # Deterministic demo values - NOT official statistics.
        demo = {
            "central-western": [
                {"indicator": "builtAreaShare", "value": 0.62, "unit": "fraction"},
                {"indicator": "treeCanopyShare", "value": 0.11, "unit": "fraction"},
            ],
            "kowloon-yau-tsim": [
                {"indicator": "builtAreaShare", "value": 0.74, "unit": "fraction"},
                {"indicator": "treeCanopyShare", "value": 0.07, "unit": "fraction"},
            ],
            "northern-metropolis": [
                {"indicator": "builtAreaShare", "value": 0.31, "unit": "fraction"},
                {"indicator": "treeCanopyShare", "value": 0.24, "unit": "fraction"},
            ],
        }
        rows = demo.get(district_id, [])
        for r in rows:
            r["simulated"] = True
        return rows
