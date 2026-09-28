import { turboCssGradient } from './colors';

/**
 * Fixed legend — never clipped by nav chrome (kept clear of map controls).
 */
export function Legend() {
  return (
    <div className="legend">
      <div className="scale-title">Heat Exposure Score (0–100)</div>
      <div className="grad" style={{ background: turboCssGradient() }} />
      <div className="ticks">
        <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
      </div>
      <div className="scale-note">
        Modelled estimate — HKO-anchored weather, urban geometry and solar
        position. Not sensor measurements.
      </div>
    </div>
  );
}
