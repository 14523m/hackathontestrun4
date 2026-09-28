import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

interface ModeBadgeProps {
  isObserved: boolean;
  isStale?: boolean;
}

/**
 * Always tell the user what they are looking at (section 55):
 * LIVE = HKO observations, STALE = last valid obs (feed unreachable),
 * DEMO = deterministic simulation.
 */
export function ModeBadge({ isObserved, isStale }: ModeBadgeProps) {
  const label = !isObserved ? 'DEMO · SIMULATED' : isStale ? 'LIVE · STALE' : 'LIVE';
  const bg = !isObserved
    ? '#5d4037'
    : isStale
      ? '#b26a00'
      : '#1b5e20';
  return (
    <ThemedView
      style={{
        backgroundColor: bg,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 3,
        alignSelf: 'flex-start',
      }}>
      <ThemedText type="smallBold" style={{ color: '#ffffff', fontSize: 11 }}>
        {label}
      </ThemedText>
    </ThemedView>
  );
}
