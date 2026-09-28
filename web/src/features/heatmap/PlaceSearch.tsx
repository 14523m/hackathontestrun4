import { useMemo, useRef, useState } from 'react';

import { GAZETTEER, type GazetteerPlace } from './gazetteer';

interface PlaceSearchProps {
  onPick: (place: GazetteerPlace) => void;
}

/**
 * "Where in Hong Kong?" — type-ahead over the gazetteer (MTR stations,
 * neighbourhoods, peaks, landmarks). Client-side filtering: instant and
 * works in the offline snapshot mode.
 */
export function PlaceSearch({ onPick }: PlaceSearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);

  const matches = useMemo<GazetteerPlace[]>(() => {
    const q = query.trim().toLowerCase();
    const pool = GAZETTEER;
    if (!q) return pool.slice(0, 8);
    return pool
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.nameZh.includes(query.trim()) ||
          p.kind.includes(q),
      )
      .slice(0, 8);
  }, [query]);

  function pick(p: GazetteerPlace) {
    onPick(p);
    setQuery(p.name);
    setOpen(false);
  }

  return (
    <div style={{ position: 'relative', marginBottom: 10 }}>
      <input
        value={query}
        placeholder="Search any place in Hong Kong… (e.g. Mong Kok, Stanley, The Peak)"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = window.setTimeout(() => setOpen(false), 150);
        }}
        style={{
          width: '100%',
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          color: 'var(--text)',
          padding: '8px 10px',
          fontSize: 13,
          outline: 'none',
        }}
      />
      {open && matches.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 50,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            marginTop: 4,
            overflow: 'hidden',
            boxShadow: '0 8px 24px rgba(0,0,0,.5)',
          }}
        >
          {matches.map((p) => (
            <button
              key={p.id}
              onMouseDown={(e) => {
                e.preventDefault();
                if (blurTimer.current) window.clearTimeout(blurTimer.current);
                pick(p);
              }}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                width: '100%',
                background: 'transparent',
                border: 'none',
                color: 'var(--text)',
                padding: '8px 10px',
                fontSize: 13,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span>
                {p.name} <span style={{ color: 'var(--text-dim)' }}>{p.nameZh}</span>
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 11, whiteSpace: 'nowrap' }}>
                {p.kind.replace(/_/g, ' ')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
