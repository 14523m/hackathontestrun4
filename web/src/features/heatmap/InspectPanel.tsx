import type { CoolingSpot, HeatCell, HeatPointResult } from '../../api/client';

interface InspectPanelProps {
  cell: HeatCell | null;
  thermal: HeatPointResult | null;
  nearby: CoolingSpot[];
  onClose: () => void;
}

/**
 * Section-23 style human-readable breakdown for the clicked point:
 * published-equation thermal comfort metrics, signed factor contributions,
 * environment fractions and nearby cooling — never a JSON dump.
 */
export function InspectPanel({ cell, thermal, nearby, onClose }: InspectPanelProps) {
  if (!cell && !thermal) return null;
  const factors = thermal?.factors ?? cell?.factors ?? [];
  const hot = factors.filter((f) => f.delta > 0.4);
  const cool = factors.filter((f) => f.delta < -0.4);
  const score = thermal?.heatScore ?? cell?.heatScore ?? 0;
  const confidence = thermal?.confidence ?? cell?.confidence ?? 0.5;
  const isModelled = thermal?.isModelled ?? cell?.isModelled ?? true;
  const sources = thermal?.sources ?? cell?.sources ?? [];

  const cap =
    score >= 70
      ? 'Very hot — avoid prolonged exposure'
      : score >= 55
        ? 'Hot — seek shade, hydrate'
        : score >= 40
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
          {Math.round(score)}
        </span>
        <span className="cap">
          Heat Exposure Score<br />{cap} · at this exact spot &amp; hour
        </span>
      </div>

      {thermal && (
        <>
          <h3>Thermal comfort (published equations)</h3>
          <div className="factor">
            <span>Apparent temperature — shade (Steadman '84)</span>
            <span className="delta">{fmtC(thermal.apparentTemperatureShadeC)}</span>
          </div>
          <div className="factor">
            <span>Apparent temperature — in sun</span>
            <span className="delta">{fmtC(thermal.apparentTemperatureSunC)}</span>
          </div>
          <div className="factor">
            <span>Mean radiant temperature (Thorsson '07)</span>
            <span className="delta">{fmtC(thermal.meanRadiantTempC)}</span>
          </div>
          <div className="factor">
            <span>Wet-bulb (Stull '11)</span>
            <span className="delta">{fmtC(thermal.wetBulbC)}</span>
          </div>
          <div className="factor">
            <span>WBGT shade (BoM approx.)</span>
            <span className="delta">{fmtC(thermal.wbgtShadeC)}</span>
          </div>
          <div className="factor">
            <span>Sky-view factor (Steyn '80)</span>
            <span className="delta">{thermal.skyViewFactor.toFixed(2)}</span>
          </div>
        </>
      )}

      <div className="confidence">
        Confidence {Math.round(confidence * 100)}% ·{' '}
        {isModelled ? 'modelled estimate' : 'observed'}
        {thermal?.offlineApproximate ? ' · offline nearest-cell' : ''}
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
        <span className="delta">{pct(thermal?.vegetationScore ?? cell?.vegetationScore)}</span>
      </div>
      <div className="factor">
        <span>Building density</span>
        <span className="delta">{pct(thermal?.buildingDensity ?? cell?.buildingDensity)}</span>
      </div>
      <div className="factor">
        <span>Shade at this hour</span>
        <span className="delta">{pct(thermal?.shadeScore ?? cell?.shadeScore)}</span>
      </div>
      <div className="factor">
        <span>Wind relief</span>
        <span className="delta">{pct(thermal?.windScore ?? cell?.windScore)}</span>
      </div>

      <h3>Nearby cooling (≤ 500 m)</h3>
      {nearby.length === 0 && (
        <p className="placeholder">None within 500 m of this spot.</p>
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
      <p className="placeholder">{sources.join(' · ')}</p>
    </aside>
  );
}

function fmtC(v: number): string {
  return v ? `${v.toFixed(1)} °C` : '—';
}

function pct(v: number | undefined): string {
  return v === undefined ? '—' : `${Math.round(v * 100)}%`;
}
