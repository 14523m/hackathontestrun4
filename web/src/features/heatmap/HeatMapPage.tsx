/**
 * HeatMapPage — the map people actually use.
 *
 * Plain-language rules for this page:
 *  - No jargon in labels. "Tree cover", not "vegetation fraction".
 *  - The heat layer is a DIRECT score->color paint: the color on screen is
 *    the color in the legend. If it looks orange, it IS hot there.
 *  - Click twice on the map (start, then end) to get a walking route that
 *    avoids the worst heat, with an honest "how much longer / how much
 *    cooler" comparison against the fastest route.
 *  - Clicking an existing pin or route point picks it up again instead of
 *    starting a new route.
 *  - The physics stays published-equation real (see the "About this data"
 *    section and the inspect panel fine print).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MapMouseEvent, StyleSpecification } from 'maplibre-gl';
import { Map as MLMap } from 'maplibre-gl';

import { api, nearestCooling } from '../../api/client';
import type {
  CoolingSpot,
  HeatCell,
  HeatPointResult,
  ViewportField,
} from '../../api/client';
import {
  addHeatSourcesAndLayers,
  BASEMAP_STYLE_URL,
  LYR,
  setHeatData,
  setHeatOpacity as applyMapHeatOpacity,
  setLayerVisible,
  setOverlayData,
  SRC,
} from './HeatLayers';
import { TimeControl, HOUR_STEPS } from './TimeControl';
import { InspectPanel } from './InspectPanel';
import { Legend } from './Legend';
import { PlaceSearch } from './PlaceSearch';
import { planRoute } from './coolRoute';
import type { RoutePlan, RoutePoint } from './coolRoute';
import type { GazetteerPlace } from './gazetteer';

/** Centred on the harbour between Kowloon and Hong Kong Island. */
const HOME: { center: [number, number]; zoom: number } = {
  center: [114.169, 22.302],
  zoom: 13.4,
};

/** Camera locked to HK: the physics and city data only exist here. */
const HK_BOUNDS: [[number, number], [number, number]] = [
  [113.75, 21.9],
  [114.5, 22.65],
];

/** Minimal style used only when the CDN basemap stalls (bad wifi): the heat
 *  layer, routes and interactions stay fully functional without it. */
const BARE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0d1117' } },
  ],
};

type PickMode = 'idle' | 'picking-start' | 'picking-end';

interface RouteUi {
  start: RoutePoint;
  end: RoutePoint;
  plan: RoutePlan;
  balance: number;
}

export default function HeatMapPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const loadToken = useRef(0);
  const [mapReady, setMapReady] = useState(false);

  const [hour, setHour] = useState(14.5);
  const [field, setField] = useState<ViewportField | null>(null);
  const [loading, setLoading] = useState(false);

  const [showHeat, setShowHeat] = useState(true);
  const [heatOpacity, setHeatOpacity] = useState(0.75);
  const [showGreen, setShowGreen] = useState(false);
  const [showBuildings, setShowBuildings] = useState(false);
  const [showCooling, setShowCooling] = useState(true);

  // --- route picking state machine -----------------------------------------
  const [pickMode, setPickMode] = useState<PickMode>('idle');
  const [pendingStart, setPendingStart] = useState<RoutePoint | null>(null);
  const [pendingEnd, setPendingEnd] = useState<RoutePoint | null>(null);
  const [route, setRoute] = useState<RouteUi | null>(null);
  const [selected, setSelected] = useState<HeatCell | null>(null);
  const [thermal, setThermal] = useState<HeatPointResult | null>(null);
  const [nearby, setNearby] = useState<CoolingSpot[]>([]);
  const [viewCooling, setViewCooling] = useState<CoolingSpot[]>([]);

  // --- map lifecycle --------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MLMap({
      container: containerRef.current,
      style: BASEMAP_STYLE_URL,
      center: HOME.center,
      zoom: HOME.zoom,
      maxBounds: HK_BOUNDS,
      attributionControl: false,
    });
    mapRef.current = map;
    // Debug/demo hook: lets the console (and tests) inspect the live map.
    (window as unknown as { __coolpathMap?: MLMap }).__coolpathMap = map;
    // Venue-wifi insurance: if the CDN basemap stalls, swap to a minimal
    // offline style after 8 s so the heat field still renders.
    const fallbackTimer = window.setTimeout(() => {
      if (!map.isStyleLoaded()) {
        try {
          map.setStyle(BARE_STYLE, { diff: false });
          addHeatSourcesAndLayers(map);
          setMapReady(true);
        } catch {
          /* unmounted */
        }
      }
    }, 8000);
    map.on('load', () => {
      window.clearTimeout(fallbackTimer);
      addHeatSourcesAndLayers(map);
      setMapReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // --- data loading: the VIEWPORT is the query ------------------------------
  const loadViewport = useCallback(
    (map: MLMap, h: number) => {
      const token = ++loadToken.current;
      const b = map.getBounds();
      setLoading(true);
      api
        .viewport(
          {
            south: b.getSouth(),
            west: b.getWest(),
            north: b.getNorth(),
            east: b.getEast(),
          },
          h,
        )
        .then((vf) => {
          if (token !== loadToken.current || !mapRef.current) return;
          setField(vf);
          setHeatData(mapRef.current, cellsToFC(vf.cells));
          setOverlayData(mapRef.current, SRC.green, greenToFC(vf.cells));
          setOverlayData(mapRef.current, SRC.buildings, tallBuildingsToFC(vf.cells));
        })
        .catch(() => undefined)
        .finally(() => token === loadToken.current && setLoading(false));
    },
    [],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const reload = () => loadViewport(map, hour);
    reload();
    map.on('moveend', reload);
    return () => {
      map.off('moveend', reload);
    };
  }, [mapReady, hour, loadViewport]);

  // Cooling spots near the map centre (all districts, nearest-first).
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    let cancelled = false;
    const refresh = () => {
      const c = map.getCenter();
      api
        .coolingNear(c.lat, c.lng, 2500, 25)
        .then((spots) => !cancelled && setViewCooling(spots))
        .catch(() => undefined);
    };
    refresh();
    map.on('moveend', refresh);
    return () => {
      cancelled = true;
      map.off('moveend', refresh);
    };
  }, [mapReady]);

  useEffect(() => {
    if (!mapRef.current) return;
    setOverlayData(mapRef.current, SRC.cooling, spotsToFC(viewCooling));
  }, [viewCooling]);

  // --- visibility / opacity sync ---------------------------------------------
  useEffect(() => {
    if (mapReady && mapRef.current)
      applyMapHeatOpacity(mapRef.current, showHeat ? heatOpacity : 0);
  }, [mapReady, showHeat, heatOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    setLayerVisible(map, LYR.green, showGreen);
    for (const id of [LYR.coolingHalo, LYR.coolingDots, LYR.coolingIcons, LYR.coolingLabels]) {
      setLayerVisible(map, id, showCooling);
    }
    setLayerVisible(map, LYR.buildings, showBuildings);
  }, [mapReady, showGreen, showHeat, showCooling, showBuildings, field]);

  // --- route drawing ----------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (route) {
      setOverlayData(map, SRC.route, {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: route.plan.chosen.line },
          },
        ],
      });
      setOverlayData(map, SRC.routeFast, {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: route.plan.fastest.line },
          },
        ],
      });
      setOverlayData(map, SRC.routePts, {
        type: 'FeatureCollection',
        features: [
          pointFc(route.start, 'start'),
          pointFc(route.end, 'end'),
        ],
      });
    } else {
      setOverlayData(map, SRC.route, emptyFc());
      setOverlayData(map, SRC.routeFast, emptyFc());
      setOverlayData(map, SRC.routePts, emptyFc());
    }
  }, [mapReady, route]);

  // --- map clicks: pick pins, or start/end a route, else inspect --------------
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !field) return;

    function onMapClick(e: MapMouseEvent) {
      const m = mapRef.current;
      if (!m) return;
      const pt: RoutePoint = { lat: e.lngLat.lat, lon: e.lngLat.lng };

      // Existing pins: click the start/end dot to pick it up and move it.
      const pins = m.queryRenderedFeatures(e.point, { layers: [LYR.routeDots] });
      const pinKind = pins[0]?.properties?.kind as string | undefined;
      if (route && pinKind) {
        if (pinKind === 'start') {
          // Move the start: keep the existing end, ask for a new start.
          setPendingEnd(route.end);
          setPendingStart(null);
          setPickMode('picking-start');
        } else {
          // Move the end: keep the existing start.
          setPendingStart(route.start);
          setPendingEnd(null);
          setPickMode('picking-end');
        }
        setRoute(null);
        return;
      }

      if (pickMode === 'picking-start') {
        setPendingStart(pt);
        if (pendingEnd && field) {
          const plan = planRoute(field.cells, pt, pendingEnd, route?.balance ?? 1);
          if (plan) {
            setRoute({ start: pt, end: pendingEnd, plan, balance: route?.balance ?? 1 });
            setPickMode('idle');
            setPendingEnd(null);
          } else {
            setPendingEnd(null);
            setPickMode('idle');
          }
        } else {
          setPickMode('picking-end');
        }
      } else if (pickMode === 'idle' || !pendingStart) {
        // First click: begin a route silently AND inspect the spot.
        setPendingStart(pt);
        setPendingEnd(null);
        setPickMode('picking-end');
      } else if (field) {
        // Second click: build the route from the current heat field.
        const plan = planRoute(field.cells, pendingStart, pt, 1);
        if (plan) {
          setRoute({ start: pendingStart, end: pt, plan, balance: 1 });
          setPickMode('idle');
          setPendingEnd(null);
        } else {
          // No walkable path (e.g. across the harbour): try a closer end.
          setPendingStart(pt);
          setPendingEnd(null);
          setPickMode('picking-end');
        }
      }

      // Inspect: always show the physics for the exact spot clicked.
      const feats = m.queryRenderedFeatures(e.point, {
        layers: [LYR.heatHit],
      });
      const cellId = feats[0]?.properties?.cellId as string | undefined;
      const cell = field?.cells.find((c) => c.cellId === cellId);
      if (cell) {
        setSelected(cell);
        setNearby(nearestCooling(viewCooling, cell.center, 500, 4));
      }
      api
        .heatPoint(e.lngLat.lat, e.lngLat.lng, hour)
        .then((p) => setThermal(p))
        .catch(() => setThermal(null));
    }

    map.on('click', onMapClick);
    return () => {
      map.off('click', onMapClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, field, viewCooling, hour, pickMode, pendingStart, route]);

  // --- place search: fly anywhere, data follows the viewport -----------------
  function onPlacePicked(place: GazetteerPlace) {
    setSelected(null);
    setThermal(null);
    mapRef.current?.flyTo({
      center: [place.location.lon, place.location.lat],
      zoom: 15,
      speed: 1.2,
    });
  }

  function setBalance(b: number) {
    if (!route || !field) return;
    const plan = planRoute(field.cells, route.start, route.end, b);
    if (plan) setRoute({ ...route, plan, balance: b });
  }

  const mean = field && field.cells.length
    ? field.cells.reduce((s, c) => s + c.heatScore, 0) / field.cells.length
    : null;

  const live = field?.dataMode === 'viewport';

  return (
    <div className="app-body">
      <div className="map-wrap" ref={containerRef}>
        <TimeControl
          hour={hour}
          onChange={setHour}
          steps={HOUR_STEPS}
          hint="Slide through the day — shade moves, heat moves."
        />

        <div className="layer-toggles">
          <label>
            <input
              type="checkbox"
              checked={showHeat}
              onChange={(e) => setShowHeat(e.target.checked)}
            />
            Heat map
          </label>
          <div className="opacity-row">
            <span>opacity</span>
            <input
              type="range"
              min={0.15}
              max={0.9}
              step={0.05}
              value={heatOpacity}
              onChange={(e) => setHeatOpacity(parseFloat(e.target.value))}
            />
          </div>
          <label>
            <input
              type="checkbox"
              checked={showGreen}
              onChange={(e) => setShowGreen(e.target.checked)}
            />
            Parks &amp; trees
          </label>
          <label>
            <input
              type="checkbox"
              checked={showBuildings}
              onChange={(e) => setShowBuildings(e.target.checked)}
            />
            Tall-building areas
          </label>
          <label>
            <input
              type="checkbox"
              checked={showCooling}
              onChange={(e) => setShowCooling(e.target.checked)}
            />
            Cool places to rest
          </label>
        </div>

        {loading && <div className="loading">Calculating…</div>}

        {pickMode !== 'idle' && (
          <div className="route-banner">
            {pickMode === 'picking-start'
              ? 'Click your START point on the map'
              : 'Now click your END point'}{' '}
            <button
              className="route-cancel"
              onClick={() => {
                setPickMode('idle');
                setPendingStart(null);
                setPendingEnd(null);
              }}
            >
              cancel
            </button>
          </div>
        )}

        <Legend />

        {route && (
          <RouteCard
            route={route}
            onBalance={setBalance}
            onClose={() => {
              setRoute(null);
              setPickMode('idle');
              setPendingStart(null);
            }}
          />
        )}

        <InspectPanel
          cell={selected}
          thermal={thermal}
          nearby={nearby}
          onClose={() => {
            setSelected(null);
            setThermal(null);
          }}
        />
      </div>

      <aside className="side-panel">
        <PlaceSearch onPick={onPlacePicked} />

        <div className="howto">
          <p style={{ margin: '0 0 6px' }}>
            <strong>Click two points</strong> on the map — start, then end —
            and CoolPath finds a cooler way to walk there.
          </p>
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            Pan or zoom anywhere in Hong Kong; the heat picture rebuilds for
            every view.
          </p>
        </div>

        {field && (
          <p
            className="placeholder"
            style={{
              marginTop: 8,
              color: live ? '#7ee787' : '#8ab4f8',
            }}
          >
            {live
              ? '● Live — calculated fresh by the server just now'
              : '● Offline mode — same physics, calculated in your browser'}
          </p>
        )}

        {mean !== null && (
          <div className="score-pill" style={{ marginBottom: 12 }}>
            <span className="num">{Math.round(mean)}</span>
            <span className="cap">
              how hot this view is on average at {fmtHour(hour)}
              <br />
              {field?.cells.filter((c) => c.heatScore >= 65).length ?? 0} hot
              spots · {field?.cells.length ?? 0} areas checked
            </span>
          </div>
        )}

        {field && (
          <>
            <h3>About this data</h3>
            <p className="placeholder">{plainProvenance(field)}</p>
          </>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route card: the honest tradeoff, in words a walker can act on.
// ---------------------------------------------------------------------------

function RouteCard({
  route,
  onBalance,
  onClose,
}: {
  route: RouteUi;
  onBalance: (b: number) => void;
  onClose: () => void;
}) {
  const { chosen, fastest } = route.plan;
  const extraMin = chosen.minutesHotPace - fastest.minutesHotPace;
  const degreesCooler = fastest.meanHeat - chosen.meanHeat;
  const winsOnTime = extraMin < -0.05; // >3 s quicker: display rounding
  const winsOnHeat = degreesCooler > 0.5 || chosen.maxHeat < fastest.maxHeat - 0.5;
  const coolerWins = winsOnTime || winsOnHeat;
  const minsSaved = Math.round(-extraMin);
  const timePhrase =
    minsSaved >= 1
      ? `${minsSaved} min quicker in today's heat`
      : 'slightly quicker in today\'s heat';

  const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)} min`);
  const dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

  return (
    <div className="route-card">
      <div className="route-card-head">
        <strong>Your route</strong>
        <button className="info-btn" onClick={onClose} title="Clear route">×</button>
      </div>

      <div className="route-balance">
        <label style={{ fontSize: 12 }}>
          <input
            type="checkbox"
            checked={route.balance >= 0.5}
            onChange={(e) => onBalance(e.target.checked ? 1 : 0)}
          />
          Prefer shade &amp; breeze (may take a few minutes longer)
        </label>
      </div>

      <div className="route-rows">
        <div className="route-row">
          <span>Distance</span>
          <span>{dist(chosen.distanceM)}</span>
        </div>
        <div className="route-row">
          <span>Walking time in today's heat</span>
          <span>{mins(chosen.minutesHotPace)}</span>
        </div>
        <div className="route-row dim">
          <span>Fastest way instead</span>
          <span>{mins(fastest.minutesHotPace)}</span>
        </div>
        <div className="route-row">
          <span>Heat along the way (average)</span>
          <span>{Math.round(chosen.meanHeat)}</span>
        </div>
      </div>

      {coolerWins && (
        <p className="route-verdict good">
          {winsOnTime && !winsOnHeat
            ? `Shade route: ${timePhrase} — and it dodges the worst spots.`
            : winsOnTime && winsOnHeat
              ? `Shade route wins both ways: ${timePhrase} and cooler on average.`
              : `Only +${Math.round(Math.max(0, extraMin))} min vs the fastest way, but noticeably cooler on average (${Math.round(Math.abs(degreesCooler) * 10) / 10} pts less heat, peak ${Math.round(chosen.maxHeat)} vs ${Math.round(fastest.maxHeat)}).`}
        </p>
      )}
      {!coolerWins && (
        <p className="route-verdict">
          The fastest way is already the coolest sensible option right now.
        </p>
      )}
      <p className="route-fineprint">
        Times assume a normal walking pace, slowed by heat the way people
        actually slow down. The dashed grey line is the fastest way, for
        comparison.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function plainProvenance(field: ViewportField): string {
  if (field.dataMode === 'engine-viewport' || field.dataMode === 'viewport') {
    return (
      'Every value on this map is calculated from published weather-science ' +
      'equations (how sun, shade, humidity and building geometry combine), ' +
      'combined with the actual street layout. It is a careful estimate, not ' +
      'a thermometer on the street.'
    );
  }
  return (
    'This view shows a pre-calculated snapshot for the demo hours. Start the ' +
    'backend for fully live calculations anywhere.'
  );
}

function pointFc(p: RoutePoint, kind: 'start' | 'end'): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: { kind },
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  };
}

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function cellsToFC(cells: HeatCell[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cells.map((c) => ({
      type: 'Feature' as const,
      id: c.cellId,
      properties: {
        cellId: c.cellId,
        heatScore: c.heatScore,
        shadeScore: c.shadeScore,
        vegetationScore: c.vegetationScore,
        buildingDensity: c.buildingDensity,
      },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[...c.polygon, c.polygon[0]]],
      },
    })),
  };
}

function spotsToFC(spots: CoolingSpot[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: spots.map((s) => ({
      type: 'Feature' as const,
      id: s.id,
      properties: {
        name: s.name,
        type: s.type,
        openingHours: s.openingHours,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [s.location.lon, s.location.lat],
      },
    })),
  };
}

function greenToFC(cells: HeatCell[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cells
      .filter((c) => c.vegetationScore >= 0.45)
      .map((c) => ({
        type: 'Feature' as const,
        id: `g-${c.cellId}`,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[...c.polygon, c.polygon[0]]],
        },
      })),
  };
}

/** Cells hemmed in by tall buildings — the streets where heat lingers
 *  after sunset. Same data the heat score uses, shown on its own layer. */
function tallBuildingsToFC(cells: HeatCell[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cells
      .filter((c) => c.buildingDensity >= 0.5)
      .map((c) => ({
        type: 'Feature' as const,
        id: `b-${c.cellId}`,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[...c.polygon, c.polygon[0]]],
        },
      })),
  };
}

function fmtHour(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
