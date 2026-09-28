import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import CoolPathMap, { heatColor } from '@/components/map/CoolPathMap';
import { HeatLegend } from '@/components/ui/heat-legend';
import { ModeBadge } from '@/components/ui/mode-badge';
import { TimeSlider } from '@/components/ui/time-slider';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useApi } from '@/hooks/use-api';
import { api } from '@/services/api/client';
import type { HeatCellOut } from '@/services/api/types';

const DISTRICTS = [
  { id: 'central-western', label: 'Central & Western' },
  { id: 'kowloon-yau-tsim', label: 'Yau Tsim Mong' },
  { id: 'northern-metropolis', label: 'Northern Metropolis (conceptual)' },
];

function CenterOf(id: string): [number, number] {
  if (id === 'kowloon-yau-tsim') return [114.172, 22.303];
  if (id === 'northern-metropolis') return [114.135, 22.515];
  return [114.138, 22.285];
}

function CellInspector({
  cell,
  onClose,
}: {
  cell: HeatCellOut;
  onClose: () => void;
}) {
  const hotter = cell.factors.filter((f) => f.delta > 0);
  const cooler = cell.factors.filter((f) => f.delta < 0);
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <ThemedView style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000066' }}>
        <ThemedView
          type="backgroundElement"
          style={{ borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Spacing.four, gap: 8, maxHeight: '70%' }}>
          <ScrollView contentContainerStyle={{ gap: 10, paddingBottom: 20 }}>
            <ThemedView style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ThemedView
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  backgroundColor: heatColor(cell.heatScore),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <ThemedText type="smallBold" style={{ color: '#000' }}>
                  {Math.round(cell.heatScore)}
                </ThemedText>
              </ThemedView>
              <ThemedView style={{ flex: 1 }}>
                <ThemedText type="smallBold">Why is this area hot?</ThemedText>
                <ThemedText type="small" style={{ opacity: 0.7 }}>
                  Confidence {Math.round(cell.confidence * 100)}% · modelled estimate
                </ThemedText>
              </ThemedView>
              <Pressable onPress={onClose}>
                <ThemedText type="link">Close</ThemedText>
              </Pressable>
            </ThemedView>

            <ThemedText type="smallBold">Main factors</ThemedText>
            {hotter.map((f) => (
              <ThemedText key={f.factorId} type="small">
                ➕ {f.label} (+{f.delta.toFixed(1)}) — {f.detail}
              </ThemedText>
            ))}
            {cooler.map((f) => (
              <ThemedText key={f.factorId} type="small">
                ➖ {f.label} ({f.delta.toFixed(1)}) — {f.detail}
              </ThemedText>
            ))}
            <ThemedText type="small" style={{ opacity: 0.7 }}>
              Shade {Math.round(cell.shadeScore * 100)}% · vegetation{' '}
              {Math.round(cell.vegetationScore * 100)}% · building density{' '}
              {Math.round(cell.buildingDensity * 100)}%
            </ThemedText>
            <ThemedText type="small" style={{ opacity: 0.55 }}>
              Sources: {cell.sources.join(', ')}
            </ThemedText>
          </ScrollView>
        </ThemedView>
      </ThemedView>
    </Modal>
  );
}

export default function HeatMapScreen() {
  const [districtId, setDistrictId] = useState('central-western');
  const [hour, setHour] = useState(14.5);
  const [cell, setCell] = useState<HeatCellOut | null>(null);

  const map = useApi(() => api.mapData(districtId), [districtId]);
  const heat = useApi(() => api.heatmap(districtId, hour), [districtId, hour]);

  const stats = useMemo(() => {
    const cells = heat.data?.cells ?? [];
    if (!cells.length) return null;
    const mean = cells.reduce((s, c) => s + c.heatScore, 0) / cells.length;
    const hot = cells.filter((c) => c.heatScore >= 65).length;
    return { mean, hot, count: cells.length };
  }, [heat.data]);

  return (
    <ThemedView style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <ThemedView style={{ paddingHorizontal: Spacing.three, paddingTop: Spacing.two, gap: 6 }}>
          <ThemedView style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ThemedText type="subtitle" style={{ flex: 1, fontSize: 22, lineHeight: 28 }}>
              District heat map
            </ThemedText>
            <ModeBadge
              isObserved={heat.data?.provenance.observed ?? false}
              isStale={heat.data?.isStale ?? false}
            />
          </ThemedView>
          <ThemedView style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {DISTRICTS.map((d) => (
              <Pressable
                key={d.id}
                onPress={() => setDistrictId(d.id)}>
                <ThemedView
                  type={d.id === districtId ? 'backgroundSelected' : 'backgroundElement'}
                  style={{
                    borderRadius: 16,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderWidth: 1,
                    borderColor: d.id === districtId ? '#29b6f6' : 'transparent',
                  }}>
                  <ThemedText type="small">{d.label}</ThemedText>
                </ThemedView>
              </Pressable>
            ))}
          </ThemedView>
          {stats && (
            <ThemedText type="small" style={{ opacity: 0.7 }}>
              Mean exposure {stats.mean.toFixed(0)}/100 · {stats.hot} of {stats.count} cells hot
              (≥65) · tap any area to see why
            </ThemedText>
          )}
        </ThemedView>

        <ThemedView style={{ flex: 1 }}>
          <CoolPathMap
            mapData={map.data}
            heatCells={heat.data?.cells}
            center={CenterOf(districtId)}
            onPressCell={(feature) => {
              const id = feature?.properties?.cellId;
              const found = heat.data?.cells.find((c) => c.cellId === id) ?? null;
              setCell(found);
            }}
          />
        </ThemedView>

        <ThemedView style={{ padding: Spacing.three, gap: 10 }}>
          <TimeSlider hour={hour} onChange={setHour} />
          <HeatLegend />
        </ThemedView>

        {cell && <CellInspector cell={cell} onClose={() => setCell(null)} />}
      </SafeAreaView>
    </ThemedView>
  );
}
