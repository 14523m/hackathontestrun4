/**
 * WEB FALLBACK for TimeSlider (platform-split via .web.tsx).
 *
 * @react-native-community/slider is native-only; on web we use a stepper
 * (− / + in 30-min increments) with the same props.
 */

import { Pressable } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

interface TimeSliderProps {
  hour: number;
  onChange: (hour: number) => void;
}

function formatHour(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function TimeSlider({ hour, onChange }: TimeSliderProps) {
  return (
    <ThemedView
      type="backgroundElement"
      style={{ borderRadius: 12, padding: 12, gap: 8 }}>
      <ThemedText type="small">
        Time of day · {formatHour(hour)} (simulated solar position & shade)
      </ThemedText>
      <ThemedView style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Pressable onPress={() => onChange(Math.max(5, hour - 0.5))}>
          <ThemedView
            type="backgroundSelected"
            style={{ borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 }}>
            <ThemedText type="smallBold">−</ThemedText>
          </ThemedView>
        </Pressable>
        <ThemedText type="smallBold" style={{ minWidth: 60, textAlign: 'center' }}>
          {formatHour(hour)}
        </ThemedText>
        <Pressable onPress={() => onChange(Math.min(21, hour + 0.5))}>
          <ThemedView
            type="backgroundSelected"
            style={{ borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 }}>
            <ThemedText type="smallBold">+</ThemedText>
          </ThemedView>
        </Pressable>
      </ThemedView>
    </ThemedView>
  );
}
