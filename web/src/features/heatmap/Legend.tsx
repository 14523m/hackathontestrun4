/**
 * Plain-language legend. "How hot does it FEEL" — the score is an apparent
 * temperature anchored scale, but people need buckets, not numbers.
 */

import { turboCssGradient } from './colors';

export function Legend() {
  return (
    <div className="legend">
      <div className="scale-title">How hot it feels</div>
      <div className="grad" style={{ background: turboCssGradient() }} />
      <div className="ticks">
        <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
      </div>
      <div className="scale-note">
        <span style={{ color: '#39a2fc' }}>■</span> pleasant ·{' '}
        <span style={{ color: '#76f957' }}>■</span> warm ·{' '}
        <span style={{ color: '#fed535' }}>■</span> hot ·{' '}
        <span style={{ color: '#fb8827' }}>■</span> very hot ·{' '}
        <span style={{ color: '#f34a1d' }}>■</span> dangerous
      </div>
      <div className="scale-note" style={{ opacity: 0.75 }}>
        Estimated from sun, shade, humidity and street layout — not a street
        thermometer.
      </div>
    </div>
  );
}
