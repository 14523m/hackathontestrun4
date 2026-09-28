import { View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

const STOPS: [string, string][] = [
  ['#1a9850', 'Comfortable'],
  ['#a6d96a', 'Warm'],
  ['#fee08b', 'Hot'],
  ['#d73027', 'Very hot'],
];

/** Legend for the Heat Exposure Score (0-100, modelled estimate). */
export function HeatLegend() {
  return (
    <View style={{ gap: Spacing.one }}>
      <ThemedText type="smallBold">Heat exposure (0-100, modelled)</ThemedText>
      <View style={{ flexDirection: 'row', gap: Spacing.two, flexWrap: 'wrap' }}>
        {STOPS.map(([color, label]) => (
          <View
            key={label}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                backgroundColor: color,
              }}
            />
            <ThemedText type="small">{label}</ThemedText>
          </View>
        ))}
      </View>
      <ThemedText type="small" style={{ opacity: 0.7 }}>
        Estimated from HKO weather anchors + urban geometry. Not sensor
        measurements.
      </ThemedText>
    </View>
  );
}
