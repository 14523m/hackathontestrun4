import { useEffect, useState } from 'react';
import { api } from '../../api/client';

interface Props {
  onClose: () => void;
}

/**
 * Section 2/25 data transparency: what the user is looking at, what is real
 * vs simulated, and the responsible-AI notes (docs/responsible-ai.md).
 */
export function TransparencyModal({ onClose }: Props) {
  const [sources, setSources] = useState<Awaited<ReturnType<typeof api.dataSources>> | null>(null);
  useEffect(() => {
    api.dataSources().then(setSources).catch(() => setSources(null));
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Data sources & responsible AI</h2>
        <p className="muted">
          {sources?.disclaimer ??
            'All heat values are modelled estimates. Demo datasets are simulated. This tool does not replace official HKO warnings.'}
        </p>

        <h3 style={{ fontSize: 13, marginBottom: 6 }}>Where the data comes from</h3>
        <ul style={{ paddingLeft: 18 }}>
          {(sources?.sources ?? []).map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong> — {s.role}
              <br />
              <span className="muted">
                Status: {s.status}
                {s.url && (
                  <>
                    {' · '}
                    <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                      official site
                    </a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>

        <h3 style={{ fontSize: 13, marginBottom: 6 }}>Read before judging</h3>
        <ul style={{ paddingLeft: 18 }}>
          <li>Heat values are <strong>modelled estimates</strong>, not measurements.</li>
          <li>Demo spatial data is <strong>simulated</strong>; weather can be <strong>live HKO</strong> (badge in the header).</li>
          <li>The Northern Metropolis layer is a <strong>CONCEPTUAL / SIMULATED scenario</strong> — not a prediction.</li>
          <li>This tool does not replace official Hong Kong Observatory warnings.</li>
          <li>Real deployment requires validation against ground measurements.</li>
          <li>No personal data is collected; crowd reports are anonymised by design.</li>
          <li>Planning decisions must never be made from an AI score alone.</li>
        </ul>

        <p className="muted" style={{ fontSize: 12 }}>
          Full notes: <code>docs/responsible-ai.md</code> ·{' '}
          <code>docs/data-sources.md</code>
        </p>

        <button className="info-btn" onClick={onClose} style={{ width: 'auto', padding: '6px 14px', borderRadius: 8 }}>
          Close
        </button>
      </div>
    </div>
  );
}
