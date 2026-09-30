import { useEffect, useRef, useState } from 'react';

import { GAZETTEER, type GazetteerPlace } from './gazetteer';

/** A searchable point: same shape as a gazetteer place. */
export interface SearchPlace {
  id: string;
  name: string;
  nameZh?: string;
  location: { lat: number; lon: number };
  kind: string;
  /** Where the result came from, shown in the dropdown for trust. */
  source: 'photon' | 'gazetteer' | 'paste';
}

/**
 * Parse a pasted location: Google Maps URLs (place/, @lat,lon, ?q=, !3d!4d),
 * bare "lat, lon" pairs, or geo: URIs. Returns null when the text isn't one.
 * Only coordinates are extracted — Google's route/geocode DATA is never
 * fetched (their terms forbid reuse outside their map); a pasted link is
 * just the user handing us a pin they already have.
 */
export function parsePastedLocation(text: string): SearchPlace | null {
  const t = text.trim();
  if (!t) return null;

  // geo:48.2,16.4?q=... or bare "22.319, 114.169"
  const bare = /(-?\d{1,2}\.\d{3,})[\s,;]+(-?\d{1,3}\.\d{3,})/.exec(t);
  if (bare) {
    const lat = parseFloat(bare[1]);
    const lon = parseFloat(bare[2]);
    if (isFinite(lat) && isFinite(lon)) {
      return {
        id: `paste-${lat},${lon}`,
        name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
        location: { lat, lon },
        kind: 'pasted pin',
        source: 'paste',
      };
    }
  }

  // @22.3190,114.1690 (Google Maps center marker)
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(t);
  if (at) {
    const lat = parseFloat(at[1]);
    const lon = parseFloat(at[2]);
    return {
      id: `paste-${lat},${lon}`,
      name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      location: { lat, lon },
      kind: 'pasted pin',
      source: 'paste',
    };
  }

  // !3d22.3190!4d114.1690 (place-page coordinates)
  const bang3 = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(t);
  if (bang3) {
    const lat = parseFloat(bang3[1]);
    const lon = parseFloat(bang3[2]);
    return {
      id: `paste-${lat},${lon}`,
      name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      location: { lat, lon },
      kind: 'pasted pin',
      source: 'paste',
    };
  }

  // ?q=...&ll= or ?query=lat,lon
  const q = /[?&](?:q|query|ll|destination)=(-?\d+\.\d+)[,%2C\s]+(-?\d+\.\d+)/i.exec(t);
  if (q) {
    const lat = parseFloat(q[1]);
    const lon = parseFloat(q[2]);
    return {
      id: `paste-${lat},${lon}`,
      name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      location: { lat, lon },
      kind: 'pasted pin',
      source: 'paste',
    };
  }

  return null;
}

interface PlaceSearchProps {
  /** Label prefixes the input, e.g. "From" / "To". */
  label?: string;
  placeholder?: string;
  onPick: (place: SearchPlace) => void;
}

/**
 * "Where in Hong Kong?" — type-ahead over the offline gazetteer PLUS live
 * Photon (OSM geocoder) results for anything specific (street addresses,
 * buildings, POIs) the gazetteer doesn't know. Photon returns bilingual
 * names and is bounded to HK by bbox. Falls back to gazetteer-only offline.
 */
export function PlaceSearch({ label, placeholder, onPick }: PlaceSearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<SearchPlace[]>([]);
  const [busy, setBusy] = useState(false);
  const blurTimer = useRef<number | null>(null);
  const seq = useRef(0);

  // Local matches are instant; remote ones arrive ~200 ms later.
  const localMatches = (() => {
    const q = query.trim().toLowerCase();
    const pool: SearchPlace[] = GAZETTEER.map((p: GazetteerPlace) => ({
      id: p.id,
      name: p.name,
      nameZh: p.nameZh,
      location: p.location,
      kind: p.kind,
      source: 'gazetteer' as const,
    }));
    if (!q) return pool.slice(0, 8);
    return pool
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.nameZh ?? '').includes(query.trim()) ||
          p.kind.includes(q),
      )
      .slice(0, 8);
  })();

  // Debounced Photon lookup for anything not obviously in the gazetteer.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRemote([]);
      setBusy(false);
      return;
    }
    // A pasted Google Maps link / coordinates short-circuits the geocoder:
    // instant exact pin, no network.
    const pasted = parsePastedLocation(q);
    if (pasted) {
      setRemote([pasted]);
      setBusy(false);
      return;
    }
    const id = ++seq.current;
    setBusy(true);
    const t = window.setTimeout(() => {
      const url =
        'https://photon.komoot.io/api/?q=' +
        encodeURIComponent(q) +
        '&limit=8&bbox=113.75,22.1,114.5,22.62&lang=en';
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: {
          features?: {
            geometry?: { coordinates?: [number, number] };
            properties?: Record<string, string>;
          }[];
        }) => {
          if (id !== seq.current) return;
          const out: SearchPlace[] = [];
          for (const f of j.features ?? []) {
            const c = f.geometry?.coordinates;
            const name =
              f.properties?.name ??
              f.properties?.street ??
              f.properties?.district ??
              f.properties?.city;
            if (!c || !name) continue;
            const zh = f.properties?.name_zh ?? f.properties?.['name:zh'];
            const kindBits = [f.properties?.osm_value, f.properties?.district]
              .filter(Boolean)
              .join(' · ');
            out.push({
              id: `ph-${f.properties?.osm_id ?? out.length}-${name}`,
              name,
              nameZh: zh,
              location: { lat: c[1], lon: c[0] },
              kind: kindBits || 'place',
              source: 'photon',
            });
          }
          setRemote(out);
          setBusy(false);
        })
        .catch(() => {
          if (id === seq.current) {
            setRemote([]);
            setBusy(false);
          }
        });
    }, 220);
    return () => window.clearTimeout(t);
  }, [query]);

  // Merge: local first (instant, known-good), then Photon, dedup by name.
  const matches: SearchPlace[] = (() => {
    const seen = new Set(localMatches.map((p) => p.name.toLowerCase()));
    const extra = remote.filter((p) => !seen.has(p.name.toLowerCase()));
    return [...localMatches, ...extra].slice(0, 10);
  })();

  function pick(p: SearchPlace) {
    onPick(p);
    setQuery(p.name);
    setOpen(false);
  }

  return (
    <div style={{ position: 'relative', marginBottom: 8 }}>
      {label && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            marginBottom: 3,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}
        >
          {label}
        </div>
      )}
      <input
        value={query}
        placeholder={placeholder ?? 'Search any place in Hong Kong… (e.g. HKUST, Mong Kok, Stanley)'}
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
      {busy && (
        <span
          style={{
            position: 'absolute',
            right: 10,
            top: label ? 30 : 10,
            fontSize: 11,
            color: 'var(--text-dim)',
          }}
        >
          …
        </span>
      )}
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
