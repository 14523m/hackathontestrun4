import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import CoolPathMap from '@/components/map/CoolPathMap';
import { ModeBadge } from '@/components/ui/mode-badge';
import { TimeSlider } from '@/components/ui/time-slider';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useApi } from '@/hooks/use-api';
import { api } from '@/services/api/client';
import type { ScenarioComparison } from '@/services/api/types';

const NM_CENTER: [number, number] = [114.135, 22.515];

function MetricRow({
  label,
  baseline,
  scenario,
  lowerIsBetter = true,
  suffix = '',
}: {
  label: string;
  baseline: number;
  scenario: number;
  lowerIsBetter?: boolean;
  suffix?: string;
}) {
  const delta = scenario - baseline;
  const good = lowerIsBetter ? delta < 0 : delta > 0;
  return (
    <ThemedView
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 4,
      }}>
      <ThemedText type="small" style={{ flex: 1 }}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold">
        {baseline.toFixed(1)}
        {suffix} → {scenario.toFixed(1)}
        {suffix}
      </ThemedText>
      <ThemedText
        type="smallBold"
        style={{ color: good ? '#1b5e20' : '#c62828', width: 70, textAlign: 'right' }}>
        {delta > 0 ? '+' : ''}
        {delta.toFixed(1)}
        {suffix}
      </ThemedText>
    </ThemedView>
  );
}

export default function PlannerScreen() {
  const [hour, setHour] = useState(14);
  const [selected, setSelected] = useState<string[]>([
    'add_trees',
    'add_shaded_corridors',
  ]);
  const [comparison, setComparison] = useState<ScenarioComparison | null>(null);
  const [simulating, setSimulating] = useState(false);

  const interventions = useApi(() => api.plannerInterventions(), []);
  const nmMap = useApi(() => api.mapData('northern-metropolis'), []);
  const nmLayer = useApi(
    () => api.northernMetropolis(hour, selected),
    [hour, selected],
  );

  useEffect(() => {
    let cancelled = false;
    setSimulating(true);
    api
      .plannerCompare('northern-metropolis', selected, hour)
      .then((c) => {
        if (!cancelled) setComparison(c);
      })
      .finally(() => {
        if (!cancelled) setSimulating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hour, selected]);

  function toggle(id: string) {
    setSelected((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  }

  const hotspotFC = useMemo(() => {
    const spots = comparison?.baseline.hotspots ?? [];
    return {
      type: 'FeatureCollection' as const,
      features: spots.map((h, i) => ({
        type: 'Feature' as const,
        id: `hs-${i}`,
        properties: { heatScore: h.heatScore },
        geometry: {
          type: 'Point' as const,
          coordinates: h.center,
        },
      })),
    };
  }, [comparison]);

  return (
    <ThemedView style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ThemedView style={{ paddingHorizontal: Spacing.three, paddingTop: Spacing.two, gap: 6 }}>
          <ThemedView style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ThemedText type="subtitle" style={{ flex: 1, fontSize: 22, lineHeight: 28 }}>
              Planner · see tomorrow's heat
            </ThemedText>
            <ModeBadge isObserved={false} />
          </ThemedView>
          <ThemedText type="small" style={{ color: '#ff8f00' }}>
            ⚠ CONCEPTUAL / SIMULATED planning scenario — not an official plan or
            prediction about the real Northern Metropolis.
          </ThemedText>
        </ThemedView>

        <ThemedView style={{ flex: 1 }}>
          <CoolPathMap
            mapData={nmMap.data}
            heatCells={nmLayer.data?.cells}
            center={NM_CENTER}
            zoom={13}
            showNetwork={false}
            showCoolingSpots={false}
          />
        </ThemedView>

        <ThemedView style={{ maxHeight: 380 }}>
          <ScrollView contentContainerStyle={{ padding: Spacing.three, gap: Spacing.two }}>
            <TimeSlider hour={hour} onChange={setHour} />

            <ThemedText type="smallBold">
              Interventions (tap to toggle, simulates instantly)
            </ThemedText>
            <ThemedView style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {(interventions.data ?? []).map((iv) => {
                const on = selected.includes(iv.id);
                return (
                  <Pressable key={iv.id} onPress={() => toggle(iv.id)}>
                    <ThemedView
                      style={{
                        backgroundColor: on ? '#1b5e20' : undefined,
                        borderRadius: 16,
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderWidth: 1,
                        borderColor: on ? '#1b5e20' : '#607d8b',
                      }}>
                      <ThemedText type="small" style={on ? { color: '#ffffff' } : undefined}>
                        {on ? '✓ ' : ''}
                        {iv.label}
                      </ThemedText>
                    </ThemedView>
                  </Pressable>
                );
              })}
            </ThemedView>

            {comparison && (
              <ThemedView type="backgroundElement" style={{ borderRadius: 14, padding: 14, gap: 6 }}>
                <ThemedText type="smallBold">
                  Before → after ({simulating ? 'simulating…' : 'simulated'}) ·{' '}
                  {comparison.isSimulated ? 'prototype model' : ''}
                </ThemedText>
                <MetricRow
                  label="Mean heat exposure"
                  baseline={comparison.baseline.meanHeatScore}
                  scenario={comparison.scenario.meanHeatScore}
                />
                <MetricRow
                  label="Peak hotspot"
                  baseline={comparison.baseline.maxHeatScore}
                  scenario={comparison.scenario.maxHeatScore}
                />
                <MetricRow
                  label="Hot area share"
                  baseline={comparison.baseline.hotCellShare * 100}
                  scenario={comparison.scenario.hotCellShare * 100}
                  suffix="%"
                />
                <MetricRow
                  label="Average shade"
                  baseline={comparison.baseline.meanShade * 100}
                  scenario={comparison.scenario.meanShade * 100}
                  lowerIsBetter={false}
                  suffix="%"
                />
                <MetricRow
                  label="Cooling access gap"
                  baseline={comparison.baseline.coolAccessGap * 100}
                  scenario={comparison.scenario.coolAccessGap * 100}
                  suffix="%"
                />
                {comparison.narrative.map((n, i) => (
                  <ThemedText key={i} type="small" style={{ opacity: 0.75 }}>
                    • {n}
                  </ThemedText>
                ))}
              </ThemedView>
            )}

            <ThemedText type="small" style={{ opacity: 0.6 }}>
              Design → simulate → compare → improve. Future hotspots are flagged
              BEFORE the district is built. All figures simulated (prototype
              calibration).
            </ThemedText>
          </ScrollView>
        </ThemedView>
      </SafeAreaView>
    </ThemedView>
  );
}
