import type { CoolingSpot, HeatCell } from '../../api/client';

interface InspectPanelProps {
  cell: HeatCell | null;
  nearby: CoolingSpot[];
  onClose: () => void;
}

/**
 * Section-23 style human-readable breakdown:
 *   "+ High building density" / "− Tree cover 23%" — never a JSON dump.
 */
export function InspectPanel({ cell, nearby, onClose }: InspectPanelProps) {
  if (!cell) return null;
  const hot = cell.factors.filter((f) => f.delta > 0.4);
  const cool = cell.factors.filter((f) => f.delta < -0.4);
  const cap =
    cell.heatScore >= 70
      ? 'Very hot — avoid prolonged exposure'
      : cell.heatScore >= 55
        ? 'Hot — seek shade, hydrate'
        : cell.heatScore >= 40
          ? 'Warm — moderate exposure'
          : 'Comfortable';

  return (
    <aside className="side-panel" style={{ width: 300 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Why is it hot here?</h2>
        <button className="info-btn" onClick={onClose} title="Close">×</button>
      </div>

      <div className="score-pill" style={{ margin: '12px 0' }}>
        <span className="num" style={{ color: cap.startsWith('Very') ? 'var(--bad)' : cap.startsWith('Hot') ? '#fb8827' : 'var(--good)' }}>
          {Math.round(cell.heatScore)}
        </span>
        <span className="cap">
          Heat Exposure Score<br />{cap} · at this location & hour
        </span>
      </div>

      <div className="confidence">
        Confidence {Math.round(cell.confidence * 100)}% ·{' '}
        {cell.isModelled ? 'modelled estimate' : 'observed'}
      </div>

      <h3>Main factors</h3>
      {hot.map((f) => (
        <div className="factor hot" key={f.factorId}>
          <span>
            {f.label}
            <span className="detail">{f.detail}</span>
          </span>
          <span className="delta hot">+{f.delta.toFixed(1)}</span>
        </div>
      ))}
      {cool.map((f) => (
        <div className="factor cool" key={f.factorId}>
          <span>
            {f.label}
            <span className="detail">{f.detail}</span>
          </span>
          <span className="delta cool">{f.delta.toFixed(1)}</span>
        </div>
      ))}

      <h3>Environment</h3>
      <div className="factor">
        <span>Vegetation</span>
        <span className="delta">{Math.round(cell.vegetationScore * 100)}%</span>
      </div>
      <div className="factor">
        <span>Building density</span>
        <span className="delta">{Math.round(cell.buildingDensity * 100)}%</span>
      </div>
      <div className="factor">
        <span>Shade at this hour</span>
        <span className="delta">{Math.round(cell.shadeScore * 100)}%</span>
      </div>
      <div className="factor">
        <span>Wind relief</span>
        <span className="delta">{Math.round(cell.windScore * 100)}%</span>
      </div>

      <h3>Nearby cooling (≤ 500 m)</h3>
      {nearby.length === 0 && (
        <p className="placeholder">None within 500 m of this cell.</p>
      )}
      {nearby.map((s) => (
        <div className="cooling-item" key={s.id}>
          <span>
            {s.name}
            <span className="detail">
              {s.type.replace(/_/g, ' ')} · {s.openingHours}
            </span>
          </span>
          <span className="dist">{Math.round(s.distanceMeters ?? 0)} m</span>
        </div>
      ))}

      <h3>Sources</h3>
      <p className="placeholder">
        {cell.sources.join(' · ')}
      </p>
    </aside>
  );
}
