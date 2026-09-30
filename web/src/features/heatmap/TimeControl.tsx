import { useEffect, useRef, useState } from 'react';

export const HOUR_STEPS = [6, 9, 12, 15, 18, 21];

interface TimeControlProps {
  hour: number;
  onChange: (h: number) => void;
  steps: number[];
  hint?: string;
}

function fmt(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Hourly heat control (section 48): six steps 06:00-21:00, a fine slider,
 * and a play button that animates the day so the field's motion is obvious.
 */
export function TimeControl({ hour, onChange, steps, hint }: TimeControlProps) {
  const timer = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  function nearestStepIdx(h: number): number {
    let best = 0;
    for (let i = 1; i < steps.length; i++) {
      if (Math.abs(steps[i] - h) < Math.abs(steps[best] - h)) best = i;
    }
    return best;
  }

  function togglePlay() {
    if (playing) {
      setPlaying(false);
      if (timer.current) window.clearTimeout(timer.current);
      return;
    }
    setPlaying(true);
    let idx = nearestStepIdx(hour);
    const advance = () => {
      idx = Math.min(idx + 1, steps.length - 1);
      onChange(steps[idx]);
      if (idx < steps.length - 1) {
        timer.current = window.setTimeout(advance, 1200);
      } else {
        setPlaying(false);
      }
    };
    advance();
  }

  return (
    <div className="time-control">
      <div className="row">
        <button className="play-btn" onClick={togglePlay} title="Play the day">
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="time-label">{fmt(hour)}</span>
        <input
          type="range"
          min={6}
          max={21}
          step={0.25}
          value={hour}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
      </div>
      <div className="steps">
        {steps.map((s) => (
          <button
            key={s}
            className={Math.abs(s - hour) < 0.01 ? 'active' : ''}
            onClick={() => onChange(s)}
          >
            {fmt(s)}
          </button>
        ))}
      </div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
