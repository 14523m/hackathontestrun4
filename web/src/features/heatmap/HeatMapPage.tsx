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
import { buildTerritoryFeatures } from './territoryRaster';
import type { TerritoryGrid } from './territoryRaster';
import {
  collectBuildingsFromMap,
  collectGreenFromMap,
  greenToFC as mapGreenToFC,
  buildingsToFC as mapBuildingsToFC,
} from './mapFeatures';
import { TimeControl, HOUR_STEPS } from './TimeControl';
import { InspectPanel } from './InspectPanel';
import { Legend } from './Legend';
import { PlaceSearch } from './PlaceSearch';
import type { SearchPlace } from './PlaceSearch';
import { planRouteAccurate } from './coolRoute';
import type { RoutePlan, RoutePoint } from './coolRoute';
import { fetchTransitPlan } from './transitApi';
import type { TransitItinerary } from './transitApi';
import {
  boundsOfCells,
  prefetchStreetsForMap,
  prefetchStreetsFromOverpass,
} from './osmStreets';

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
  const [showTerritory, setShowTerritory] = useState(true);
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

  // Latest street network for the current field (a ref so the click handler
  // always reads it synchronously without re-subscribing listeners).
  const streetsRef = useRef<import('./osmStreets').StreetNet | null>(null);
  // Serialises async route planning: only the newest request may set state.
  const routeToken = useRef(0);
  // Transit itineraries for the last search. Declared BEFORE the map-leg
  // effect that reads them (hooks must not be used before declaration).
  const [transitOptions, setTransitOptions] = useState<TransitItinerary[]>([]);
  const [showTransit, setShowTransit] = useState(true);
  // Whole-territory raster (kept in a ref too: routes need it as the
  // anywhere-sampler, and a ref avoids re-subscribing the click handler).
  const territoryRef = useRef<TerritoryGrid | null>(null);

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
          refreshRealLayers(mapRef.current);
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

  // Whole-territory raster: fetched once, drawn as the base heat layer.
  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.VITE_API_BASE ?? '/api'}/heatmap/territory`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((grid: TerritoryGrid) => {
        territoryRef.current = grid;
        if (cancelled || !mapRef.current) return;
        setOverlayData(mapRef.current, SRC.territory, buildTerritoryFeatures(grid));
      })
      .catch(() => undefined); // raster optional: viewport layer still works
    return () => {
      cancelled = true;
    };
  }, []);

  // Real-street network (OpenStreetMap) for the current view: read straight
  // from the basemap's loaded vector tiles — no extra requests, no rate
  // limits — with Overpass as a fallback for views whose tiles fall short.
  // A slow/failed refetch keeps the last working network (streets barely
  // change between adjacent views); only a genuinely null first build leaves
  // routes on the grid fallback.
  useEffect(() => {
    if (!field || field.cells.length === 0) return;
    let cancelled = false;
    const load = async () => {
      const map = mapRef.current;
      let net = map ? await prefetchStreetsForMap(map) : null;
      if (!net && !cancelled) {
        net = await prefetchStreetsFromOverpass(boundsOfCells(field.cells));
      }
      if (!cancelled && net) streetsRef.current = net;
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [field]);

  // Real green/building polygons from the basemap's loaded tiles. Re-extract
  // on every viewport change (tiles load progressively) and when style data
  // first arrives, so toggled layers show the actual parks and buildings.
  const refreshRealLayers = useCallback((map: MLMap) => {
    setOverlayData(map, SRC.green, mapGreenToFC(collectGreenFromMap(map)));
    setOverlayData(map, SRC.buildings, mapBuildingsToFC(collectBuildingsFromMap(map)));
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const refresh = () => refreshRealLayers(map);
    refresh();
    map.on('moveend', refresh);
    map.on('sourcedata', (e) => {
      // Style data arrives in bursts while tiles load; throttled re-extract.
      if ((e as { sourceId?: string }).sourceId === 'openmaptiles' && map.areTilesLoaded()) refresh();
    });
    return () => {
      map.off('moveend', refresh);
    };
  }, [mapReady, refreshRealLayers]);

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
    setLayerVisible(map, LYR.territory, showTerritory);
    setLayerVisible(map, LYR.green, showGreen);
    for (const id of [LYR.coolingHalo, LYR.coolingDots, LYR.coolingIcons, LYR.coolingLabels]) {
      setLayerVisible(map, id, showCooling);
    }
    setLayerVisible(map, LYR.buildings, showBuildings);
  }, [mapReady, showGreen, showHeat, showCooling, showBuildings, showTerritory, field]);

  // --- transit leg drawing ----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const shown = showTransit && transitOptions.length > 0 ? transitOptions[0] : null;
    if (shown) {
      setOverlayData(map, SRC.transit, {
        type: 'FeatureCollection',
        features: shown.legs.map((leg, i) => ({
          type: 'Feature' as const,
          id: `tr-${i}`,
          properties: { mode: leg.mode, line: leg.line },
          geometry: { type: 'LineString' as const, coordinates: leg.coords },
        })),
      });
    } else {
      setOverlayData(map, SRC.transit, emptyFc());
    }
  }, [mapReady, transitOptions, showTransit]);

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
          // OSRM/heat planning is async: a route token keeps rapid clicks honest.
          const token = ++routeToken.current;
          void planRouteAccurate(field.cells, pt, pendingEnd, route?.balance ?? 1, streetsRef.current, territoryRef.current).then((plan) => {
            if (!plan || token !== routeToken.current) return;
            setRoute({ start: pt, end: pendingEnd, plan, balance: route?.balance ?? 1 });
            setPickMode('idle');
            setPendingEnd(null);
          });
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
        const token = ++routeToken.current;
        void planRouteAccurate(field.cells, pendingStart, pt, 1, streetsRef.current, territoryRef.current).then((plan) => {
          if (!plan || token !== routeToken.current) return;
          setRoute({ start: pendingStart, end: pt, plan, balance: 1 });
          setPickMode('idle');
          setPendingEnd(null);
        });
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

  // --- place search: From/To route endpoints ---------------------------------
  const [searchFrom, setSearchFrom] = useState<SearchPlace | null>(null);
  const [searchTo, setSearchTo] = useState<SearchPlace | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  function onPlacePicked(place: SearchPlace, which: 'from' | 'to') {
    setSelected(null);
    setThermal(null);
    setSearchError(null);
    mapRef.current?.flyTo({
      center: [place.location.lon, place.location.lat],
      zoom: 15,
      speed: 1.2,
    });
    if (which === 'from') {
      setSearchFrom(place);
    } else {
      setSearchTo(place);
    }
  }

  /** Search-driven route: transit options + walk route, side by side. */
  function runSearchRoute() {
    if (!searchFrom || !searchTo || !field) return;
    setSearching(true);
    setSearchError(null);
    const token = ++routeToken.current;
    const start = { lat: searchFrom.location.lat, lon: searchFrom.location.lon };
    const end = { lat: searchTo.location.lat, lon: searchTo.location.lon };
    const walkPlan = planRouteAccurate(
      field.cells,
      start,
      end,
      1,
      streetsRef.current,
      territoryRef.current,
    );
    const transitPlan = fetchTransitPlan(start, end, ['mtr', 'bus']);
    void Promise.all([walkPlan, transitPlan])
      .then(([plan, transit]) => {
        if (token !== routeToken.current) return;
        if (!plan && !transit) {
          setSearchError('No walkable route found between those places.');
          return;
        }
        if (plan) {
          setRoute({
            start,
            end,
            plan,
            balance: 1,
          });
        }
        setTransitOptions(transit?.itineraries ?? []);
        setPickMode('idle');
        setPendingStart(null);
        setPendingEnd(null);
      })
      .catch(() => setSearchError('Routing failed — check your connection.'))
      .finally(() => {
        if (token === routeToken.current) setSearching(false);
      });
  }

  function setBalance(b: number) {
    if (!route || !field) return;
    const token = ++routeToken.current;
    void planRouteAccurate(field.cells, route.start, route.end, b, streetsRef.current, territoryRef.current).then((plan) => {
      if (plan && token === routeToken.current) setRoute({ ...route, plan, balance: b });
    });
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
              checked={showTerritory}
              onChange={(e) => setShowTerritory(e.target.checked)}
            />
            Whole-territory heat
          </label>
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
        <PlaceSearch
          label="From"
          placeholder="Start — e.g. Central, HKUST, your street…"
          onPick={(p) => onPlacePicked(p, 'from')}
        />
        <PlaceSearch
          label="To"
          placeholder="End — e.g. Tsim Sha Tsui, The Peak…"
          onPick={(p) => onPlacePicked(p, 'to')}
        />
        <button
          className="route-go"
          onClick={runSearchRoute}
          disabled={!searchFrom || !searchTo || searching}
          style={{
            width: '100%',
            marginBottom: 12,
            padding: '9px 10px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: searchFrom && searchTo ? 'var(--accent, #2ea043)' : 'var(--panel-2)',
            color: searchFrom && searchTo ? '#fff' : 'var(--text-dim)',
            fontSize: 13,
            fontWeight: 600,
            cursor: searchFrom && searchTo ? 'pointer' : 'default',
          }}
        >
          {searching ? 'Finding the coolest way…' : 'Find cool route'}
        </button>
        {searchError && (
          <p style={{ margin: '-6px 0 10px', fontSize: 12, color: '#f88' }}>{searchError}</p>
        )}

        {transitOptions.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 4,
              }}
            >
              <strong style={{ fontSize: 12 }}>Or take public transport</strong>
              <label style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                <input
                  type="checkbox"
                  checked={showTransit}
                  onChange={(e) => setShowTransit(e.target.checked)}
                />{' '}
                show on map
              </label>
            </div>
            {transitOptions.map((it, i) => (
              <button
                key={i}
                onClick={() => setShowTransit(true)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '7px 9px',
                  marginBottom: 5,
                  color: 'var(--text)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <strong style={{ fontSize: 13 }}>
                    {it.mode === 'mtr' ? '🚇' : '🚌'} {it.label}
                  </strong>
                  <span style={{ fontSize: 13 }}>{Math.round(it.totalMin)} min</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                  HKD {it.fare.toFixed(1)} · {it.transfers} transfer{it.transfers === 1 ? '' : 's'}
                  · walk {it.walkInM} m + {it.walkOutM} m (heat-scored)
                </div>
                <div style={{ fontSize: 11, marginTop: 2 }}>
                  {it.legs
                    .map((l) => `${l.line}: ${l.fromStation} → ${l.toStation}`)
                    .join(' · ')}
                </div>
              </button>
            ))}
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text-dim)' }}>
              Trains and buses are air-conditioned — heat doesn't slow them
              down. The walk to and from each stop is heat-scored.
            </p>
          </div>
        )}

        <div className="howto">
          <p style={{ margin: '0 0 6px' }}>
            <strong>Search From + To</strong> above for an accurate route on
            real footpaths — or <strong>click two points</strong> on the map.
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
              {heatBand(mean).label} at {fmtHour(hour)} — {heatBand(mean).hint}
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
          <span>{Math.round(chosen.meanHeat)} — {heatBand(chosen.meanHeat).label}</span>
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

      {chosen.ferryM ? (
        <p className="route-verdict" style={{ margin: '6px 0' }}>
          ⛴️ Includes a ferry crossing ({dist(chosen.ferryM)}) — timed at boat
          speed plus the usual wait, not walking pace.
        </p>
      ) : null}

      {chosen.steps && chosen.steps.length > 0 && (
        <details className="route-steps">
          <summary style={{ cursor: 'pointer', fontSize: 12, margin: '6px 0' }}>
            Turn-by-turn ({chosen.steps.length} streets)
          </summary>
          <ol style={{ margin: '4px 0 8px', paddingLeft: 20, fontSize: 12, lineHeight: 1.5 }}>
            {chosen.steps.slice(0, 30).map((s, i) => (
              <li key={i} style={{ marginBottom: 2 }}>
                {s.name} <span style={{ color: 'var(--text-dim)' }}>{dist(s.distanceM)}</span>
              </li>
            ))}
            {chosen.steps.length > 30 && (
              <li style={{ color: 'var(--text-dim)' }}>
                …{chosen.steps.length - 30} more
              </li>
            )}
          </ol>
        </details>
      )}
      <p className="route-fineprint">
        {route.plan.source === 'streets'
          ? 'Follows real streets and footpaths (OpenStreetMap). Times assume a normal walking pace, slowed by heat the way people actually slow down. The dashed grey line is the fastest way, for comparison.'
          : 'Offline estimate — follows the heat grid, not exact streets. Times assume a normal walking pace, slowed by heat the way people actually slow down. The dashed grey line is the fastest way, for comparison.'}
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



function fmtHour(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Plain-language band for a 0-100 heat score — the number alone means
 * nothing until you've used the app for weeks; the band + hint are
 * readable on first sight (UV-index style). Anchors match the legend.
 */
export function heatBand(score: number): { label: string; hint: string } {
  if (score < 45) return { label: 'Pleasant', hint: 'no heat precautions needed' };
  if (score < 60) return { label: 'Warm', hint: 'fine for most people' };
  if (score < 72) return { label: 'Hot', hint: 'water + shade breaks' };
  if (score < 85) return { label: 'Very hot', hint: 'limit strenuous walks' };
  return { label: 'Dangerous', hint: 'avoid or go indoors/cool route' };
}
