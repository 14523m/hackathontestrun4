import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import CoolPathMap from '@/components/map/CoolPathMap';
import { ModeBadge } from '@/components/ui/mode-badge';
import { TimeSlider } from '@/components/ui/time-slider';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useApi } from '@/hooks/use-api';
import { api } from '@/services/api/client';
import type { GeoPointLite } from '@/services/api/client';
import type { RouteOptionOut } from '@/services/api/types';

/** Demo trips: origin/destination pairs that showcase the routing story. */
const TRIPS: Record<string, { label: string; origin: GeoPointLite; destination: GeoPointLite }[]> = {
  'central-western': [
    {
      label: 'Sai Ying Pun → Central',
      origin: { lat: 22.2864, lon: 114.129 },
      destination: { lat: 22.2864, lon: 114.147 },
    },
    {
      label: 'Cross-district diagonal',
      origin: { lat: 22.279, lon: 114.13 },
      destination: { lat: 22.29, lon: 114.146 },
    },
  ],
  'kowloon-yau-tsim': [
    {
      label: 'Jordan → Tsim Sha Tsui',
      origin: { lat: 22.298, lon: 114.166 },
      destination: { lat: 22.308, lon: 114.178 },
    },
  ],
  'northern-metropolis': [
    {
      label: 'Conceptual cross-district walk',
      origin: { lat: 22.508, lon: 114.123 },
      destination: { lat: 22.522, lon: 114.147 },
    },
  ],
};

function RouteCard({
  route,
  selected,
  onSelect,
}: {
  route: RouteOptionOut;
  selected: boolean;
  onSelect: () => void;
}) {
  const exposureLabel =
    route.heatExposure >= 70
      ? 'High heat'
      : route.heatExposure >= 55
        ? 'Moderate heat'
        : 'Low heat';
  const tint =
    route.type === 'coolest' ? '#1b5e20' : route.type === 'balanced' ? '#455a64' : '#8d4e2a';
  return (
    <Pressable onPress={onSelect}>
      <ThemedView
        type="backgroundElement"
        style={{
          borderRadius: 14,
          padding: 14,
          gap: 4,
          borderWidth: 2,
          borderColor: selected ? '#29b6f6' : 'transparent',
        }}>
        <ThemedText type="smallBold" style={{ color: tint }}>
          {route.emoji} {route.label}
        </ThemedText>
        <ThemedText type="subtitle" style={{ fontSize: 24, lineHeight: 30 }}>
          {route.durationMinutes.toFixed(0)} min
          <ThemedText type="small">
            {'  '}
            {(route.distanceMeters / 1000).toFixed(1)} km
          </ThemedText>
        </ThemedText>
        <ThemedText type="small">
          Heat exposure {route.heatExposure.toFixed(0)}/100 · {exposureLabel}
        </ThemedText>
        <ThemedText type="small" style={{ opacity: 0.75 }}>
          {route.hottestStretchMinutes.toFixed(0)} min in hot sections ·{' '}
          {Math.round(route.shadeScore * 100)}% avg shade
        </ThemedText>
        <ThemedText type="small" style={{ opacity: 0.6 }}>
          {route.summary}
        </ThemedText>
      </ThemedView>
    </Pressable>
  );
}

export default function CoolRouteScreen() {
  const [districtId, setDistrictId] = useState('central-western');
  const [hour, setHour] = useState(14.5);
  const [tripIdx, setTripIdx] = useState(0);
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof api.routes>> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);

  const trips = TRIPS[districtId] ?? [];
  const trip = trips[Math.min(tripIdx, trips.length - 1)];

  const map = useApi(() => api.mapData(districtId), [districtId]);
  const heat = useApi(() => api.heatmap(districtId, hour), [districtId, hour]);

  const center = useMemo<[number, number]>(() => {
    const d = map.data?.districtId;
    if (d === 'kowloon-yau-tsim') return [114.172, 22.303];
    if (d === 'northern-metropolis') return [114.135, 22.515];
    return [114.138, 22.285];
  }, [map.data?.districtId]);

  async function findRoutes() {
    if (!trip) return;
    setFinding(true);
    setSelectedId(null);
    try {
      const result = await api.routes({
        districtId,
        origin: trip.origin,
        destination: trip.destination,
        hour,
      });
      setPlan(result);
      const coolest = result.options.find((o) => o.type === 'coolest');
      setSelectedId(coolest?.id ?? result.options[0]?.id ?? null);
    } finally {
      setFinding(false);
    }
  }

  const options = plan?.options ?? [];
  const weather = plan?.weather;

  return (
    <ThemedView style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ThemedView style={{ paddingHorizontal: Spacing.three, paddingTop: Spacing.two, gap: 6 }}>
          <ThemedView style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ThemedText type="subtitle" style={{ flex: 1, fontSize: 22, lineHeight: 28 }}>
              Find a cooler way through Hong Kong
            </ThemedText>
            <ModeBadge
              isObserved={weather?.isObserved ?? false}
              isStale={weather?.isStale ?? false}
            />
          </ThemedView>
          {weather && (
            <ThemedText type="small" style={{ opacity: 0.7 }}>
              {weather.isObserved ? 'HKO observed' : 'Simulated'} ·{' '}
              {weather.temperatureC.toFixed(0)}°C · humidity{' '}
              {weather.relativeHumidity.toFixed(0)}% · wind {weather.windSpeedMs.toFixed(1)} m/s
            </ThemedText>
          )}
        </ThemedView>

        <ThemedView style={{ flex: 1 }}>
          <CoolPathMap
            mapData={map.data}
            heatCells={heat.data?.cells ?? undefined}
            routes={options}
            selectedRouteId={selectedId}
            center={center}
          />
          {map.loading && (
            <ThemedView
              style={{ position: 'absolute', top: 12, alignSelf: 'center', borderRadius: 10, padding: 8 }}>
              <ActivityIndicator />
            </ThemedView>
          )}
        </ThemedView>

        <ThemedView style={{ maxHeight: 330 }}>
          <ScrollView contentContainerStyle={{ padding: Spacing.three, gap: Spacing.two }}>
            <TimeSlider hour={hour} onChange={setHour} />

            <ThemedView type="backgroundElement" style={{ borderRadius: 12, padding: 12, gap: 8 }}>
              <ThemedText type="smallBold">Demo trip (simulated geodata)</ThemedText>
              <ThemedView style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {trips.map((t, i) => (
                  <Pressable
                    key={t.label}
                    onPress={() => {
                      setTripIdx(i);
                      setPlan(null);
                    }}>
                    <ThemedView
                      type={i === tripIdx ? 'backgroundSelected' : 'background'}
                      style={{
                        borderRadius: 16,
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderWidth: 1,
                        borderColor: '#607d8b',
                      }}>
                      <ThemedText type="small">{t.label}</ThemedText>
                    </ThemedView>
                  </Pressable>
                ))}
              </ThemedView>
              <Pressable onPress={findRoutes} disabled={finding}>
                <ThemedView
                  style={{
                    backgroundColor: '#0277bd',
                    borderRadius: 12,
                    paddingVertical: 12,
                    alignItems: 'center',
                  }}>
                  <ThemedText style={{ color: '#ffffff', fontWeight: '700' }}>
                    {finding ? 'Finding routes…' : '🌱  Find Cool Route'}
                  </ThemedText>
                </ThemedView>
              </Pressable>
            </ThemedView>

            {options.length > 0 && (
              <ThemedText type="smallBold">
                Route options · duration-weighted exposure · {hour.toFixed(2).replace(/\.?0+$/, '')} h
              </ThemedText>
            )}
            {[...options]
              .sort((a, b) => a.heatExposure - b.heatExposure)
              .map((r) => (
                <RouteCard
                  key={r.id}
                  route={r}
                  selected={r.id === selectedId}
                  onSelect={() => setSelectedId(r.id)}
                />
              ))}

            {plan && (
              <ThemedText type="small" style={{ opacity: 0.6 }}>
                {plan.provenance.notes}
              </ThemedText>
            )}
          </ScrollView>
        </ThemedView>
      </SafeAreaView>
    </ThemedView>
  );
}
