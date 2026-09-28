"""Pydantic schemas: the stable API contract between backend and clients.

Mobile devs / other agents should treat these models (mirrored in
mobile/src/services/api/types.ts) as the interface boundary. Field names use
camelCase over the wire.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

RouteType = Literal["fastest", "balanced", "coolest"]


class GeoPoint(BaseModel):
    lat: float = Field(..., description="WGS84 latitude", ge=-90, le=90)
    lon: float = Field(..., description="WGS84 longitude", ge=-180, le=180)


class ProvenanceOut(BaseModel):
    sources: List[str] = []
    observed: bool = False
    modelled: bool = True
    confidence: float = Field(0.5, ge=0, le=1)
    resolutionMeters: Optional[float] = None
    notes: str = ""


class FactorContributionOut(BaseModel):
    factorId: str
    label: str
    delta: float
    detail: str = ""


class WeatherSnapshotOut(BaseModel):
    timestamp: str
    temperatureC: float
    relativeHumidity: float = Field(..., ge=0, le=100)
    windSpeedMs: float = Field(..., ge=0)
    windDirectionDeg: float = Field(..., ge=0, lt=360)
    globalSolarRadiation: Optional[float] = None
    heatIndexC: Optional[float] = None
    wetBulbGlobeTemperatureC: Optional[float] = None
    isObserved: bool
    isStale: bool
    anchorStation: str = ""
    provenance: ProvenanceOut


class RouteOptionOut(BaseModel):
    id: str
    type: RouteType
    label: str
    emoji: str
    geometry: Dict[str, Any]  # GeoJSON LineString
    distanceMeters: float
    durationMinutes: float
    heatExposure: float  # duration-weighted average 0-100
    averageHeat: float  # simple average of edge scores
    hottestStretchMinutes: float
    shadeScore: float  # 0-1
    slopePenaltySeconds: float
    coolSpotIds: List[str] = []
    summary: str


class RouteExplanationFactor(BaseModel):
    label: str
    delta: float
    detail: str = ""


class RoutePlanOut(BaseModel):
    requestedType: Optional[RouteType] = None
    requestedAt: str
    origin: GeoPoint
    destination: GeoPoint
    options: List[RouteOptionOut]
    weather: WeatherSnapshotOut
    provenance: ProvenanceOut
    notes: List[str] = []


class HeatCellOut(BaseModel):
    cellId: str
    center: GeoPoint
    polygon: List[List[float]]  # [[lon, lat], ...]
    heatScore: float  # 0-100 estimated pedestrian heat exposure
    shadeScore: float  # 0-1
    vegetationScore: float  # 0-1
    buildingDensity: float  # 0-1
    windScore: float  # 0-1
    confidence: float  # 0-1
    factors: List[FactorContributionOut]
    sources: List[str] = []
    isModelled: bool = True


class HeatMapOut(BaseModel):
    generatedAt: str
    validFor: str  # ISO time the layer applies to
    dataMode: str
    isStale: bool
    districtId: str
    cells: List[HeatCellOut]
    legend: Dict[str, str]
    provenance: ProvenanceOut
    scenarioLabel: Optional[str] = None
    appliedInterventions: List[str] = []
    note: Optional[str] = None


class CoolingSpotOut(BaseModel):
    id: str
    name: str
    location: GeoPoint
    type: str
    coolingLevel: int = Field(..., ge=1, le=3)
    openingHours: str = ""
    capacityEstimate: Optional[int] = None
    accessibility: bool = True


class PlannerState(BaseModel):
    districtId: str
    interventions: List[str] = []
    treeCanopyDelta: float = 0.0
    pavedAreaReduction: float = 0.0
    buildingSpacingDelta: float = 0.0
    shadedCorridorKm: float = 0.0
    ventilationCorridor: bool = False
    coolingFacilitiesAdded: int = 0


class PlannerMetrics(BaseModel):
    meanHeatScore: float
    maxHeatScore: float
    hotCellShare: float  # fraction of cells above hot threshold
    meanShade: float
    coolAccessGap: float  # 0-1, higher = worse access
    hotspots: List[Dict[str, Any]] = []


class ScenarioComparison(BaseModel):
    baseline: PlannerMetrics
    scenario: PlannerMetrics
    delta: Dict[str, float]
    narrative: List[str]
    interventions: List[str]
    isSimulated: bool = True


class DistrictOut(BaseModel):
    id: str
    name: str
    nameZh: Optional[str] = None
    kind: Literal["existing", "conceptual"]
    isConceptual: bool
    center: GeoPoint
    description: str
    label: str = ""


class DataSourcesOut(BaseModel):
    dataMode: str
    weatherMode: str
    sources: List[Dict[str, Any]]
    disclaimer: str


class ErrorResponse(BaseModel):
    detail: str
