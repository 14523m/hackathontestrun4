/**
 * TypeScript mirror of the backend API contract (backend/app/schemas.py).
 * Keep in sync with the pydantic schemas - this is the interface boundary
 * between mobile and backend teams (master prompt section 22).
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface ProvenanceOut {
  sources: string[];
  observed: boolean;
  modelled: boolean;
  confidence: number;
  resolutionMeters?: number | null;
  notes: string;
}

export interface FactorContributionOut {
  factorId: string;
  label: string;
  delta: number;
  detail?: string;
}

export interface WeatherSnapshotOut {
  timestamp: string;
  temperatureC: number;
  relativeHumidity: number;
  windSpeedMs: number;
  windDirectionDeg: number;
  globalSolarRadiation?: number | null;
  heatIndexC?: number | null;
  wetBulbGlobeTemperatureC?: number | null;
  isObserved: boolean;
  isStale: boolean;
  anchorStation: string;
  provenance: ProvenanceOut;
}

export type RouteType = 'fastest' | 'balanced' | 'coolest';

export interface RouteOptionOut {
  id: string;
  type: RouteType;
  label: string;
  emoji: string;
  geometry: GeoJSON.LineString;
  distanceMeters: number;
  durationMinutes: number;
  heatExposure: number;
  averageHeat: number;
  hottestStretchMinutes: number;
  shadeScore: number;
  slopePenaltySeconds: number;
  coolSpotIds: string[];
  summary: string;
}

export interface RoutePlanOut {
  requestedType?: RouteType | null;
  requestedAt: string;
  origin: GeoPoint;
  destination: GeoPoint;
  options: RouteOptionOut[];
  weather: WeatherSnapshotOut;
  provenance: ProvenanceOut;
  notes: string[];
}

export interface HeatCellOut {
  cellId: string;
  center: GeoPoint;
  polygon: [number, number][]; // [lon, lat]
  heatScore: number;
  shadeScore: number;
  vegetationScore: number;
  buildingDensity: number;
  windScore: number;
  confidence: number;
  factors: FactorContributionOut[];
  sources: string[];
  isModelled: boolean;
}

export interface HeatMapOut {
  generatedAt: string;
  validFor: string;
  dataMode: string;
  isStale: boolean;
  districtId: string;
  cells: HeatCellOut[];
  legend: Record<string, string>;
  provenance: ProvenanceOut;
  scenarioLabel?: string | null;
  appliedInterventions?: string[];
  note?: string | null;
}

export interface CoolingSpotOut {
  id: string;
  name: string;
  location: GeoPoint;
  type: string;
  coolingLevel: number;
  openingHours: string;
  capacityEstimate?: number | null;
  accessibility: boolean;
  simulated: boolean;
}

export interface ScenarioComparison {
  baseline: {
    meanHeatScore: number;
    maxHeatScore: number;
    hotCellShare: number;
    meanShade: number;
    coolAccessGap: number;
    hotspots: { cellId: string; heatScore: number; center: [number, number]; topFactor: string }[];
  };
  scenario: {
    meanHeatScore: number;
    maxHeatScore: number;
    hotCellShare: number;
    meanShade: number;
    coolAccessGap: number;
    hotspots: { cellId: string; heatScore: number; center: [number, number]; topFactor: string }[];
  };
  delta: Record<string, number>;
  narrative: string[];
  interventions: string[];
  isSimulated: boolean;
}

export interface DistrictOut {
  id: string;
  name: string;
  nameZh?: string | null;
  kind: 'existing' | 'conceptual';
  isConceptual: boolean;
  center: GeoPoint;
  description: string;
  label: string;
}

export interface DataSourceInfo {
  id: string;
  name: string;
  role: string;
  status: string;
  url: string;
  notes: string;
}

export interface DataSourcesOut {
  dataMode: string;
  weatherMode: string;
  sources: DataSourceInfo[];
  disclaimer: string;
}

export interface MapDataResponse {
  districtId: string;
  landUse: GeoJSON.FeatureCollection;
  buildings: GeoJSON.FeatureCollection;
  network: GeoJSON.FeatureCollection;
  coolingSpots: GeoJSON.FeatureCollection;
}
