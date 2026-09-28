import Slider from '@react-native-community/slider';

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

/** Time-of-day control: heat is time-dependent (09:00 vs 15:00 differ). */
export function TimeSlider({ hour, onChange }: TimeSliderProps) {
  return (
    <ThemedView type="backgroundElement" style={{ borderRadius: 12, padding: 12, gap: 4 }}>
      <ThemedText type="small">
        Time of day · {formatHour(hour)} (simulated solar position & shade)
      </ThemedText>
      <Slider
        minimumValue={5}
        maximumValue={21}
        step={0.25}
        value={hour}
        onValueChange={onChange}
        minimumTrackTintColor="#29b6f6"
        maximumTrackTintColor="#90a4ae"
      />
    </ThemedView>
  );
}
