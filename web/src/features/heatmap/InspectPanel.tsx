import type { CoolingSpot, HeatCell, HeatPointResult } from '../../api/client';

interface InspectPanelProps {
  cell: HeatCell | null;
  thermal: HeatPointResult | null;
  nearby: CoolingSpot[];
  onClose: () => void;
}

/** Plain words for a shade-fraction (physics in the fine print only). */
function shadeWords(f: number): string {
  if (f >= 0.7) return 'Mostly shaded right now';
  if (f >= 0.4) return 'Partly shaded';
  if (f >= 0.15) return 'A little shade';
  return 'In the open sun';
}

function windWords(w: number): string {
  if (w >= 0.5) return 'Breezy — heat can lift';
  if (w >= 0.25) return 'Slight breeze';
  return 'Still air — it clings';
}

/**
 * Human breakdown for the clicked spot: what it feels like, WHY (plain
 * language, with the actual physics numbers as fine print), and what to do
 * (nearby cool places). Never a JSON dump, never raw jargon in a headline.
 */
export function InspectPanel({ cell, thermal, nearby, onClose }: InspectPanelProps) {
  if (!cell && !thermal) return null;
  const factors = thermal?.factors ?? cell?.factors ?? [];
  const hot = factors.filter((f) => f.delta > 0.4);
  const cool = factors.filter((f) => f.delta < -0.4);
  const score = thermal?.heatScore ?? cell?.heatScore ?? 0;
  const shade = thermal?.shadeScore ?? cell?.shadeScore ?? 0;
  const wind = thermal?.windScore ?? cell?.windScore ?? 0;

  const word =
    score >= 80 ? 'DANGEROUSLY HOT'
      : score >= 70 ? 'VERY HOT'
        : score >= 60 ? 'HOT'
          : score >= 45 ? 'WARM'
            : 'OK';

  const tip =
    score >= 80
      ? 'Avoid staying here — find air-conditioning.'
      : score >= 70
        ? 'Rest often, drink water, use the shade.'
        : score >= 60
          ? 'Take it easy; shade breaks help a lot.'
          : score >= 45
            ? 'Fine for most people at a easy pace.'
            : 'Comfortable walking.';

  return (
    <aside className="side-panel" style={{ width: 300 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>This exact spot</h2>
        <button className="info-btn" onClick={onClose} title="Close">×</button>
      </div>

      <div className="score-pill" style={{ margin: '12px 0' }}>
        <span
          className="num"
          style={{
            color:
              score >= 80 ? '#f34a1d' : score >= 70 ? '#fb8827' : score >= 60 ? '#fed535' : 'var(--good)',
          }}
        >
          {word}
        </span>
        <span className="cap">
          feels-like heat score {Math.round(score)}/100
          <br />
          {tip}
        </span>
      </div>

      <h3>Why it's like this here</h3>
      <div className="factor">
        <span>☀️ Shade at this hour</span>
        <span className="delta">{shadeWords(shade)}</span>
      </div>
      <div className="factor">
        <span>💨 Air movement</span>
        <span className="delta">{windWords(wind)}</span>
      </div>
      {hot.slice(0, 3).map((f) => (
        <div className="factor hot" key={f.factorId}>
          <span>
            🔥 {plainFactorLabel(f.label)}
            <span className="detail">{f.detail}</span>
          </span>
          <span className="delta hot">+{f.delta.toFixed(0)}</span>
        </div>
      ))}
      {cool.slice(0, 2).map((f) => (
        <div className="factor cool" key={f.factorId}>
          <span>
            💧 {plainFactorLabel(f.label)}
            <span className="detail">{f.detail}</span>
          </span>
          <span className="delta cool">{f.delta.toFixed(0)}</span>
        </div>
      ))}

      {thermal && (
        <>
          <h3 style={{ marginBottom: 4 }}>The actual numbers</h3>
          <p className="placeholder" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5 }}>
            In the sun it feels like {thermal.apparentTemperatureSunC.toFixed(0)}°C;
            in shade {thermal.apparentTemperatureShadeC.toFixed(0)}°C
            (Steadman&nbsp;'84). Surfaces radiate {thermal.meanRadiantTempC.toFixed(0)}°C
            worth of heat (Thorsson&nbsp;'07). Humidity: wet-bulb {thermal.wetBulbC.toFixed(1)}°C
            (Stull&nbsp;'11); heat-stress index WBGT {thermal.wbgtShadeC.toFixed(1)}°C.
            Open-sky fraction {thermal.skyViewFactor.toFixed(2)} (Steyn&nbsp;'80).
            Careful estimate, not a measurement.
          </p>
        </>
      )}

      <h3>Places to cool down nearby</h3>
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
    </aside>
  );
}

/** Map physics-speak to one-liners people actually say. */
function plainFactorLabel(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('air_temperature')) return 'Hot air';
  if (l.includes('radiation') || l.includes('radiant')) return 'Sun & hot surfaces beaming at you';
  if (l.includes('sky_view')) return 'Wide-open sky adds heat';
  if (l.includes('vegetation')) return 'Trees & greenery cooling';
  if (l.includes('water')) return 'Water nearby cooling';
  if (l.includes('humidity')) return 'Sticky air (sweat can\'t evaporate)';
  if (l.includes('wind')) return 'Breeze helping';
  return label;
}
