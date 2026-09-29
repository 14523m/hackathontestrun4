import { useEffect, useState } from 'react';
import HeatMapPage from './features/heatmap/HeatMapPage';
import { TransparencyModal } from './features/heatmap/TransparencyModal';
import { api, apiState, type DataMode } from './api/client';

type BackendMode = 'demo' | 'live' | 'stale';

export default function App() {
  const [backendMode, setBackendMode] = useState<BackendMode | null>(null);
  const [dataMode, setDataMode] = useState<DataMode>('live');
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    // The badge must tell the truth about what is on screen: the backend
    // decides demo/live/stale; the client reports live API vs offline snapshot.
    api.heatmap('central-western', 14.5, 'standard').then((h) => {
      setBackendMode(
        h.dataMode === 'live' ? (h.isStale ? 'stale' : 'live') : 'demo',
      );
      setDataMode(apiState.mode);
    });
  }, []);

  let badge: { cls: string; text: string };
  if (dataMode === 'engine') {
    badge = { cls: 'demo', text: 'OFFLINE ENGINE · SAME PUBLISHED EQUATIONS' };
  } else if (backendMode === 'live') {
    badge = { cls: 'live', text: 'LIVE · HKO OBSERVATIONS' };
  } else if (backendMode === 'stale') {
    badge = { cls: 'stale', text: 'LIVE · STALE (last valid obs)' };
  } else {
    badge = { cls: 'demo', text: 'DEMO · SIMULATED HEAT MODEL' };
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>🌳 HK CoolPath AI — Heat Map</h1>
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
        <span className="badge">
          Heat layer: modelled (HKO-anchored + urban geometry)
        </span>
        <div className="spacer" />
        <button
          className="info-btn"
          onClick={() => setShowInfo(true)}
          title="Data sources & responsible AI"
        >
          ?
        </button>
      </header>
      <HeatMapPage />
      {showInfo && <TransparencyModal onClose={() => setShowInfo(false)} />}
    </div>
  );
}
