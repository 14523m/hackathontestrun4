/**
 * Turbo-like perceptual ramp (Google's Turbo, downscaled) for the continuous
 * heat surface — chosen over rainbow/muddy ramps for perceptual uniformity.
 * The SAME stops drive the MapLibre heatmap-color interpolation and the CSS
 * legend gradient so the legend is truthful to the layer.
 */

export const TURBO_STOPS: [number, string][] = [
  [0, '#30123b'],
  [10, '#4145ab'],
  [20, '#4675ed'],
  [30, '#39a2fc'],
  [40, '#1ae4b6'],
  [50, '#76f957'],
  [60, '#b6f334'],
  [70, '#fed535'],
  [80, '#fb8827'],
  [90, '#f34a1d'],
  [100, '#a61b1e'],
];

/** MapLibre expression fragment: interpolate score 0..100 -> turbo colors. */
export function turboExpression(valueExpr: unknown): unknown[] {
  const flat = TURBO_STOPS.flatMap(([v, c]) => [v, c]);
  return ['interpolate', ['linear'], valueExpr, ...flat];
}

/** CSS gradient string for the legend (identical stops). */
export function turboCssGradient(): string {
  return `linear-gradient(to right, ${TURBO_STOPS.map(([v, c]) => `${c} ${v}%`).join(', ')})`;
}

export function scoreToColor(score: number): string {
  const s = Math.max(0, Math.min(100, score));
  for (let i = 1; i < TURBO_STOPS.length; i++) {
    const [v1, c1] = TURBO_STOPS[i];
    const [v0, c0] = TURBO_STOPS[i - 1];
    if (s <= v1) {
      const t = (s - v0) / (v1 - v0);
      return lerpHex(c0, c1, t);
    }
  }
  return TURBO_STOPS[TURBO_STOPS.length - 1][1];
}

function lerpHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => {
    const va = (pa >> sh) & 255;
    const vb = (pb >> sh) & 255;
    return Math.round(va + (vb - va) * t);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0))
    .toString(16)
    .padStart(6, '0')}`;
}
