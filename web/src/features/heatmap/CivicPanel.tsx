/**
 * CivicPanel — "Report a hot street" + "Where should the city add shade?"
 *
 * Citizen side: file a heat report at the route start, route end, or any
 * clicked map point; each report is corroborated by the heat model and
 * feeds a ready-to-send district-council/1823 dossier.
 * Planner side: the siting optimizer proposes where canopy/shade/misters
 * would cut the most heat, drawn on the map as proposal markers.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  REPORT_KINDS,
  copyText,
  fetchDossier,
  fetchSitingPlan,
  submitReport,
} from './civicApi';
import type { Dossier, ReportKind, SitingPlan } from './civicApi';
import { LYR, SRC, setOverlayData, setLayerVisible } from './HeatLayers';
import type { HeatCell } from '../../api/client';
import type { RoutePoint } from './coolRoute';

/** Local cluster of the map's heat cells (what the click target averages). */
function localHeat(cells: HeatCell[], p: RoutePoint): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const c of cells) {
    const lat = c.polygon.reduce((s, q) => s + q[1], 0) / c.polygon.length;
    const lon = c.polygon.reduce((s, q) => s + q[0], 0) / c.polygon.length;
    const d = Math.hypot(lat - p.lat, lon - p.lon);
    if (d < bestD) {
      bestD = d;
      best = c.heatScore;
    }
  }
  return best;
}

const KIND_ICON: Record<ReportKind, string> = {
  'no-shade': '🌳',
  'hot-surface': '🔥',
  'no-seat': '🪑',
  'no-water': '💧',
  other: '📍',
};

interface CivicPanelProps {
  /** Where to file the report: pick order = route end, route start, map. */
  reportAt: RoutePoint | null;
  cells: HeatCell[];
  hour: number;
  mapReady: boolean;
  map: unknown; // maplibregl.Map — typed loosely to keep this file lean
}

export function CivicPanel({ reportAt, cells, hour, mapReady, map }: CivicPanelProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ReportKind>('no-shade');
  const [severity, setSeverity] = useState<1 | 2 | 3 | 4 | 5>(3);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Siting state
  const [sitKind, setSitKind] = useState('canopy');
  const [budget, setBudget] = useState(10);
  const [plan, setPlan] = useState<SitingPlan | null>(null);
  const [sitBusy, setSitBusy] = useState(false);
  const [showSites, setShowSites] = useState(true);

  // Dossier state
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [dosBusy, setDosBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const drawSites = useCallback(
    (p: SitingPlan | null, visible: boolean) => {
      if (!mapReady || !map) return;
      const m = map as { getSource: (id: string) => unknown };
      if (!m.getSource(SRC.civicSites)) return;
      setOverlayData(
        map as never,
        SRC.civicSites,
        p && visible
          ? {
              type: 'FeatureCollection',
              features: p.sites.map((s, i) => ({
                type: 'Feature' as const,
                id: `site-${i}`,
                properties: { rank: i + 1, heat: s.heatScore, reports: s.publicReports ?? 0 },
                geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
              })),
            }
          : { type: 'FeatureCollection', features: [] },
      );
    },
    [mapReady, map],
  );

  useEffect(() => {
    drawSites(plan, showSites);
  }, [drawSites, plan, showSites]);

  async function runSiting(k = sitKind, b = budget) {
    setSitBusy(true);
    const p = await fetchSitingPlan(k, b);
    setPlan(p);
    setSitBusy(false);
  }

  async function makeDossier() {
    setDosBusy(true);
    setDossier(await fetchDossier());
    setDosBusy(false);
  }

  async function file() {
    if (!reportAt) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await submitReport({
        lat: reportAt.lat,
        lon: reportAt.lon,
        kind,
        severity,
        note: note.trim() || undefined,
        hour,
      });
      const score = saved.model.score;
      setDone(
        score != null
          ? `Filed ✓ — the heat model agrees: score ${Math.round(score)}/100 there.`
          : 'Filed ✓ (model score unavailable right now).',
      );
      setNote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not file the report.');
    } finally {
      setBusy(false);
    }
  }

  const spot = reportAt
    ? { ...reportAt, heat: localHeat(cells, reportAt) }
    : null;

  return (
    <div
      style={{
        margin: '0 0 14px',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '10px 12px',
        background: 'var(--panel-2)',
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'transparent',
          border: 'none',
          color: 'var(--text)',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <span>🤝 Make HK cooler — report &amp; propose</span>
        <span style={{ color: 'var(--text-dim)' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {/* ---------------- citizen side ---------------- */}
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
            Report a hot spot
          </div>
          {!reportAt && (
            <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 8px' }}>
              Search a route or click the map first — reports attach to a place.
            </p>
          )}
          {spot && (
            <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 8px' }}>
              Reporting for{' '}
              <strong style={{ color: 'var(--text)' }}>
                {spot.lat.toFixed(4)}, {spot.lon.toFixed(4)}
              </strong>{' '}
              {spot.heat != null && (
                <>(local heat {Math.round(spot.heat)}/100)</>
              )}
            </p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {REPORT_KINDS.map((k) => (
              <button
                key={k.id}
                onClick={() => setKind(k.id)}
                style={{
                  fontSize: 11,
                  padding: '4px 8px',
                  borderRadius: 999,
                  border: '1px solid ' + (kind === k.id ? '#22d3ee' : 'var(--border)'),
                  background: kind === k.id ? 'rgba(34,211,238,.12)' : 'transparent',
                  color: kind === k.id ? '#22d3ee' : 'var(--text-dim)',
                  cursor: 'pointer',
                }}
              >
                {KIND_ICON[k.id]} {k.label}
              </button>
            ))}
          </div>
          <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block' }}>
            How bad? {severity}/5
            <input
              type="range"
              min={1}
              max={5}
              value={severity}
              onChange={(e) => setSeverity(Number(e.target.value) as 1 | 2 | 3 | 4 | 5)}
              style={{ width: '100%' }}
            />
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={280}
            placeholder="Optional: what's wrong here? (e.g. 'no trees for 400 m')"
            style={{
              width: '100%',
              marginTop: 6,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              color: 'var(--text)',
              padding: '7px 9px',
              fontSize: 12,
            }}
          />
          <button
            onClick={file}
            disabled={!reportAt || busy}
            style={{
              width: '100%',
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: reportAt && !busy ? '#f97316' : 'var(--panel-2)',
              color: reportAt && !busy ? '#111' : 'var(--text-dim)',
              fontSize: 13,
              fontWeight: 600,
              cursor: reportAt && !busy ? 'pointer' : 'default',
            }}
          >
            {busy ? 'Filing…' : 'File heat report'}
          </button>
          {done && (
            <p style={{ fontSize: 12, color: '#4ade80', margin: '6px 0 0' }}>{done}</p>
          )}
          {error && <p style={{ fontSize: 12, color: '#f88', margin: '6px 0 0' }}>{error}</p>}

          <div style={{ height: 1, background: 'var(--border)', margin: '12px 0' }} />

          {/* ---------------- planner side ---------------- */}
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
            Where should the city add cooling?
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <select
              value={sitKind}
              onChange={(e) => setSitKind(e.target.value)}
              style={{
                flex: 1,
                background: 'var(--panel)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--text)',
                fontSize: 12,
                padding: '6px 8px',
              }}
            >
              <option value="canopy">🌳 Tree canopy</option>
              <option value="shade-sail">⛱️ Shade sail</option>
              <option value="misting">💨 Misting station</option>
              <option value="park-pocket">🏞️ Pocket park</option>
            </select>
            <select
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
              style={{
                width: 74,
                background: 'var(--panel)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--text)',
                fontSize: 12,
                padding: '6px 8px',
              }}
            >
              {[5, 10, 15, 20, 30].map((n) => (
                <option key={n} value={n}>
                  ×{n}
                </option>
              ))}
            </select>
            <button
              onClick={() => runSiting()}
              disabled={sitBusy}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: sitBusy ? 'var(--panel-2)' : '#22d3ee',
                color: sitBusy ? 'var(--text-dim)' : '#111',
                fontSize: 12,
                fontWeight: 600,
                cursor: sitBusy ? 'default' : 'pointer',
              }}
            >
              {sitBusy ? '…' : 'Optimise'}
            </button>
          </div>
          {plan && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>
              <label>
                <input
                  type="checkbox"
                  checked={showSites}
                  onChange={(e) => setShowSites(e.target.checked)}
                />{' '}
                show {plan.sites.length} sites on map
              </label>{' '}
              · {plan.radiusM} m benefit radius each
              {plan.sites.some((s) => s.publicReports) && (
                <> · 🤝 = public reports corroborate</>
              )}
            </div>
          )}
          {plan && (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {plan.sites.map((s, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 12,
                    padding: '3px 0',
                    borderBottom: '1px dashed var(--border)',
                  }}
                >
                  <span>
                    #{i + 1} {s.lat.toFixed(4)}, {s.lon.toFixed(4)}{' '}
                    {s.publicReports ? '🤝' : ''}
                  </span>
                  <span style={{ color: 'var(--text-dim)' }}>
                    heat {Math.round(s.heatScore)} · covers {Math.round(s.coveredHeatMass)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div style={{ height: 1, background: 'var(--border)', margin: '12px 0' }} />

          {/* ---------------- dossier ---------------- */}
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
            Send it to the people who can act
          </div>
          <button
            onClick={makeDossier}
            disabled={dosBusy}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: dosBusy ? 'var(--panel-2)' : 'var(--panel)',
              color: 'var(--text)',
              fontSize: 12,
              fontWeight: 600,
              cursor: dosBusy ? 'default' : 'pointer',
            }}
          >
            {dosBusy ? 'Drafting…' : '📜 Generate 1823 / district-council brief'}
          </button>
          {dossier && (
            <div style={{ marginTop: 8 }}>
              <pre
                style={{
                  fontSize: 11,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  background: 'var(--panel)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 8,
                  maxHeight: 220,
                  overflowY: 'auto',
                  color: 'var(--text-dim)',
                }}
              >
                {dossier.text}
              </pre>
              <button
                onClick={async () => {
                  const ok = await copyText(dossier.text);
                  setCopied(ok);
                  window.setTimeout(() => setCopied(false), 2000);
                }}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {copied ? 'Copied ✓' : 'Copy brief to clipboard'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Wire the civic-sites source visibility (called by the page on toggles). */
export function civicSitesVisible(map: unknown, visible: boolean): void {
  const m = map as { getLayer: (id: string) => unknown } | null;
  if (m?.getLayer(LYR.civicSites)) {
    setLayerVisible(map as never, LYR.civicSites, visible);
  }
}
