/**
 * CoolPath map: MapLibre GL v11 with an OFFLINE-FIRST inline style.
 *
 * Deliberately uses a minimal background-only style so all district layers
 * (heat cells, buildings, green space, routes, cooling spots) render from
 * server GeoJSON even with no internet access on demo day. A real basemap
 * can be layered later by the map team (docs/architecture.md).
 */

import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  type FilterSpecification,
  type StyleSpecification,
} from '@maplibre/maplibre-react-native';

import type {
  HeatCellOut,
  MapDataResponse,
  RouteOptionOut,
} from '@/services/api/types';

const OFFLINE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'bg',
      type: 'background',
      paint: { 'background-color': '#10151c' },
    },
  ],
};

// Heat score -> colour ramp stops (matches the legend thresholds).
const HEAT_RAMP = [
  'interpolate',
  ['linear'],
  ['get', 'heatScore'],
  0,
  '#1a9850',
  40,
  '#a6d96a',
  55,
  '#fee08b',
  70,
  '#fc8d59',
  85,
  '#d73027',
] as unknown as Exclude<
  React.ComponentProps<typeof Layer>['paint'],
  undefined
> extends never
  ? never
  : Record<string, unknown>;

export function heatColor(score: number): string {
  if (score >= 70) return '#d73027';
  if (score >= 55) return '#fc8d59';
  if (score >= 40) return '#fee08b';
  return '#1a9850';
}

export function heatFeatureCollection(
  cells: HeatCellOut[],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cells.map((c) => ({
      type: 'Feature' as const,
      id: c.cellId,
      properties: { heatScore: c.heatScore, cellId: c.cellId },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...c.polygon, c.polygon[0]]],
      },
    })),
  };
}

const styles = StyleSheet.create({
  map: { flex: 1 },
});

interface CoolPathMapProps {
  mapData?: MapDataResponse | null;
  heatCells?: HeatCellOut[];
  routes?: RouteOptionOut[];
  selectedRouteId?: string | null;
  center: [number, number]; // [lon, lat]
  zoom?: number;
  showBuildings?: boolean;
  showNetwork?: boolean;
  showCoolingSpots?: boolean;
  onPressCell?: (feature: { properties?: { cellId?: string } } | null) => void;
}

export default function CoolPathMap({
  mapData,
  heatCells,
  routes,
  selectedRouteId,
  center,
  zoom = 13.5,
  showBuildings = true,
  showNetwork = true,
  showCoolingSpots = true,
  onPressCell,
}: CoolPathMapProps) {
  const heatFC = useMemo(
    () => (heatCells ? heatFeatureCollection(heatCells) : null),
    [heatCells],
  );

  const routesFC = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!routes?.length) return null;
    return {
      type: 'FeatureCollection',
      features: routes.map((r) => ({
        type: 'Feature' as const,
        id: r.id,
        properties: {
          routeId: r.id,
          selected: r.id === selectedRouteId ? 1 : 0,
        },
        geometry: r.geometry,
      })),
    };
  }, [routes, selectedRouteId]);

  const heatFilter: FilterSpecification = ['all', ['>=', ['get', 'heatScore'], -1]];
  const selectedFilter: FilterSpecification = ['==', ['get', 'selected'], 1];
  const unselectedFilter: FilterSpecification = ['==', ['get', 'selected'], 0];
  const greenFilter: FilterSpecification = ['==', ['get', 'class'], 'green_space'];
  const openFilter: FilterSpecification = ['==', ['get', 'class'], 'urban_open_space'];

  return (
    <MapLibreMap style={styles.map} mapStyle={OFFLINE_STYLE}>
      <Camera initialViewState={{ center, zoom }} />

      {mapData && (
        <GeoJSONSource id="landuse" data={mapData.landUse}>
          <Layer
            type="fill"
            id="landuse-green"
            source="landuse"
            filter={greenFilter}
            paint={{ 'fill-color': '#1a9641', 'fill-opacity': 0.5 }}
          />
          <Layer
            type="fill"
            id="landuse-open"
            source="landuse"
            filter={openFilter}
            paint={{ 'fill-color': '#a6d96a', 'fill-opacity': 0.3 }}
          />
        </GeoJSONSource>
      )}

      {mapData && showBuildings && (
        <GeoJSONSource id="buildings" data={mapData.buildings}>
          <Layer
            type="fill"
            id="buildings-fill"
            source="buildings"
            paint={{ 'fill-color': '#3d4a5c', 'fill-opacity': 0.85 }}
          />
        </GeoJSONSource>
      )}

      {heatFC && (
        <GeoJSONSource
          id="heat"
          data={heatFC}
          onPress={
            onPressCell
              ? (f) =>
                  onPressCell(
                    (f as { properties?: { cellId?: string } } | null) ?? null,
                  )
              : undefined
          }
        >
          <Layer
            type="fill"
            id="heat-fill"
            source="heat"
            filter={heatFilter}
            paint={{
              'fill-color': HEAT_RAMP as never,
              'fill-opacity': 0.45,
            }}
          />
        </GeoJSONSource>
      )}

      {mapData && showNetwork && (
        <GeoJSONSource id="network" data={mapData.network}>
          <Layer
            type="line"
            id="network-lines"
            source="network"
            paint={{
              'line-color': '#8fa3b8',
              'line-width': 1.5,
              'line-opacity': 0.6,
            }}
          />
        </GeoJSONSource>
      )}

      {routesFC && (
        <GeoJSONSource id="routes" data={routesFC}>
          <Layer
            type="line"
            id="routes-halo"
            source="routes"
            filter={selectedFilter}
            paint={{ 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 }}
          />
          <Layer
            type="line"
            id="routes-line"
            source="routes"
            filter={selectedFilter}
            paint={{ 'line-color': '#29b6f6', 'line-width': 5 }}
          />
          <Layer
            type="line"
            id="routes-dim"
            source="routes"
            filter={unselectedFilter}
            paint={{ 'line-color': '#90a4ae', 'line-width': 3, 'line-opacity': 0.5 }}
          />
        </GeoJSONSource>
      )}

      {mapData && showCoolingSpots && (
        <GeoJSONSource id="cooling" data={mapData.coolingSpots}>
          <Layer
            type="circle"
            id="cooling-dots"
            source="cooling"
            paint={{
              'circle-radius': 6,
              'circle-color': '#4dd0e1',
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            }}
          />
        </GeoJSONSource>
      )}
    </MapLibreMap>
  );
}
