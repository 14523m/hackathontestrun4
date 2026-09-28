/**
 * WEB FALLBACK for CoolPathMap (platform-split via .web.tsx).
 *
 * MapLibre RN is native-only; `npx expo start --web` cannot render native
 * maps. This fallback keeps the web bundle working (no codegenNativeComponent
 * crash) and previews the heat layer as coloured cells + route lines, with a
 * pointer to run the real app on iOS/Android.
 */

import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import type {
  HeatCellOut,
  MapDataResponse,
  RouteOptionOut,
} from '@/services/api/types';

export function heatColor(score: number): string {
  if (score >= 70) return '#d73027';
  if (score >= 55) return '#fc8d59';
  if (score >= 40) return '#fee08b';
  return '#1a9850';
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 8 },
  canvas: {
    flex: 1,
    borderRadius: 12,
    backgroundColor: '#10151c',
    overflow: 'hidden',
    position: 'relative',
  },
  cell: { position: 'absolute', borderRadius: 3 },
  routeLine: {
    position: 'absolute',
    height: 4,
    borderRadius: 2,
    backgroundColor: '#29b6f6',
  },
  note: { paddingVertical: 6, opacity: 0.8 },
});

interface CoolPathMapProps {
  mapData?: MapDataResponse | null;
  heatCells?: HeatCellOut[];
  routes?: RouteOptionOut[];
  selectedRouteId?: string | null;
  center: [number, number]; // [lon, lat] — kept for API parity with native
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
}: CoolPathMapProps) {
  type Bounds = {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
  };
  type Pct = `${number}%`;

  const bounds = useMemo<Bounds | null>(() => {
    const src = heatCells?.length
      ? heatCells.flatMap((c) => c.polygon)
      : (mapData?.landUse.features ?? [])
          .map((f) => (f.geometry as GeoJSON.Polygon).coordinates[0])
          .flat();
    if (!src.length) return null;
    const lons = src.map((p) => p[0]);
    const lats = src.map((p) => p[1]);
    return {
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
    };
  }, [heatCells, mapData]);

  const toPct = (f: number): Pct => {
    const clamped = Math.min(98, Math.max(0, f * 100));
    return `${clamped}%` as Pct;
  };

  const posOf = (lon: number, lat: number) => {
    if (!bounds) return { left: '50%' as Pct, top: '50%' as Pct };
    const fx = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon || 1);
    const fy = 1 - (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat || 1);
    return { left: toPct(fx), top: toPct(fy) };
  };

  const sizeOf = (lo: number, hi: number, axis: 'lon' | 'lat'): Pct => {
    const span = bounds
      ? axis === 'lon'
        ? bounds.maxLon - bounds.minLon
        : bounds.maxLat - bounds.minLat
      : 1;
    return toPct(Math.max(0.015, (hi - lo) / (span || 1)));
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.canvas}>
        {(heatCells ?? []).slice(0, 260).map((c) => {
          const lons = c.polygon.map((p) => p[0]);
          const lats = c.polygon.map((p) => p[1]);
          const pos = posOf(Math.min(...lons), Math.max(...lats));
          return (
            <View
              key={c.cellId}
              style={[
                styles.cell,
                pos,
                {
                  width: sizeOf(Math.min(...lons), Math.max(...lons), 'lon'),
                  height: sizeOf(Math.min(...lats), Math.max(...lats), 'lat'),
                  backgroundColor: heatColor(c.heatScore),
                  opacity: 0.75,
                },
              ]}
            />
          );
        })}

        {(routes ?? [])
          .filter((r) => r.id === selectedRouteId)
          .map((r) => {
            const pts = r.geometry.coordinates;
            if (pts.length < 2) return null;
            const a = posOf(pts[0][0], pts[0][1]);
            const b = posOf(pts[pts.length - 1][0], pts[pts.length - 1][1]);
            const aX = parseFloat(a.left);
            const bX = parseFloat(b.left);
            return (
              <View
                key={r.id}
                style={[
                  styles.routeLine,
                  {
                    left: a.left,
                    top: a.top,
                    width: `${Math.abs(bX - aX)}%` as Pct,
                  },
                ]}
              />
            );
          })}

        {!heatCells && !routes && (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ThemedText style={{ color: '#8fa3b8' }}>Loading heat data…</ThemedText>
          </View>
        )}
      </View>

      <ThemedText type="small" style={styles.note}>
        🖥️ Web preview (simplified heat grid). For the real interactive map with
        shade geometry and route comparison, run the app on iOS / Android:
        {' '}npx expo run:ios
      </ThemedText>
    </View>
  );
}
