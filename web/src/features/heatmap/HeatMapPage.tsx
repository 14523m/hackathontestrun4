/**
 * HeatMapPage — the judge-facing heat map (web rebuild).
 *
 * FREE-PAN, ANYWHERE: the viewport itself is the query. Every pan/zoom asks
 * /heatmap/viewport for the visible bounds and the backend evaluates the real
 * physics per grid cell (shadow wedges, sky-view factor, published thermal
 * equations). Clicking anywhere inspects that exact coordinate via
 * /heat/point. No preset district buttons; the place search just flies the
 * camera. All heat values come from the backend's heat services.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MapMouseEvent } from 'maplibre-gl';
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
import type { GazetteerPlace } from './gazetteer';

/** Centred on the harbour between Kowloon and Hong Kong Island. */
const HOME: { center: [number, number]; zoom: number } = {
  center: [114.169, 22.302],
  zoom: 13.4,
};

/** Hard-clip panning to the HK bounding region (app/core/geo.py HK_BOUNDS):
 *  the physics and city data exist only for Hong Kong, so locking the camera
 *  here keeps every evaluated cell inside the city (perf + honesty).
 *  MapLibre LngLatBoundsLike: [[west, south], [east, north]]. */
const HK_BOUNDS: [[number, number], [number, number]] = [
  [113.75, 21.9],
  [114.5, 22.65],
];

export default function HeatMapPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const loadToken = useRef(0);
  const [mapReady, setMapReady] = useState(false);

  const [hour, setHour] = useState(14.5);
  const [field, setField] = useState<ViewportField | null>(null);
  const [loading, setLoading] = useState(false);
  const [offlineGap, setOfflineGap] = useState(false);

  const [showHeat, setShowHeat] = useState(true);
  const [heatOpacity, setHeatOpacity] = useState(0.75);
  const [showGreen, setShowGreen] = useState(false);
  const [showBuildings, setShowBuildings] = useState(false);
  const [showCooling, setShowCooling] = useState(true);

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
    map.on('load', () => {
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
      setOfflineGap(false);
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
          // Any mode producing zero cells here means the view has no data.
          if (vf.cells.length === 0) {
            setOfflineGap(true);
          }
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
    setLayerVisible(map, LYR.heatHit, showHeat);
    for (const id of [LYR.coolingHalo, LYR.coolingDots, LYR.coolingIcons, LYR.coolingLabels]) {
      setLayerVisible(map, id, showCooling);
    }
    setLayerVisible(map, LYR.buildings, showBuildings);
  }, [mapReady, showGreen, showHeat, showCooling, showBuildings, field]);

  // --- click-to-inspect: ANY coordinate --------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !field) return;

    function onMapClick(e: MapMouseEvent) {
      const m = mapRef.current;
      if (!m) return;
      const feats = m.queryRenderedFeatures(e.point, {
        layers: [LYR.heatHit],
      });
      const cellId = feats[0]?.properties?.cellId as string | undefined;
      const cell = field?.cells.find((c) => c.cellId === cellId);
      if (cell) {
        setSelected(cell);
        setNearby(nearestCooling(viewCooling, cell.center, 500, 4));
      }
      // Full published-equation physics at the exact clicked coordinate.
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
  }, [mapReady, field, viewCooling, hour]);

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

  const mean = field && field.cells.length
    ? field.cells.reduce((s, c) => s + c.heatScore, 0) / field.cells.length
    : null;

  return (
    <div className="app-body">
      <div className="map-wrap" ref={containerRef}>
        <TimeControl
          hour={hour}
          onChange={setHour}
          steps={HOUR_STEPS}
          hint="Hourly heat: sun position changes building shade across the city."
        />

        <div className="layer-toggles">
          <label>
            <input
              type="checkbox"
              checked={showHeat}
              onChange={(e) => setShowHeat(e.target.checked)}
            />
            Heat surface
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
            Green coverage
          </label>
          <label>
            <input
              type="checkbox"
              checked={showBuildings}
              onChange={(e) => setShowBuildings(e.target.checked)}
            />
            Building density
          </label>
          <label>
            <input
              type="checkbox"
              checked={showCooling}
              onChange={(e) => setShowCooling(e.target.checked)}
            />
            Cooling spots
          </label>
        </div>

        {loading && <div className="loading">Simulating heat field…</div>}

        <Legend />

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
        <p className="placeholder" style={{ marginTop: 0 }}>
          Pan or zoom anywhere in Hong Kong — the heat field regenerates for
          the view. Click any spot for the physics behind it.
        </p>

        {field && (
          <p
            className="placeholder"
            style={{
              marginTop: 0,
              color: field.dataMode === 'viewport' ? '#7ee787' : '#8ab4f8',
            }}
          >
            {field.dataMode === 'viewport'
              ? '● LIVE API — backend evaluates the published equations per cell'
              : field.dataMode === 'engine-viewport'
                ? '● OFFLINE ENGINE — same published equations, evaluated in-browser per cell'
                : '● OFFLINE SNAPSHOT — flagship districts'}
          </p>
        )}

        {offlineGap && (
          <p className="placeholder" style={{ color: '#ffb86c' }}>
            No heat data in this view — the camera is outside the Hong Kong
            coverage region. Pan back toward the city; every HK district is
            evaluated by the physics engine (no preset areas).
          </p>
        )}

        {mean !== null && (
          <div className="score-pill" style={{ marginBottom: 12 }}>
            <span className="num">{Math.round(mean)}</span>
            <span className="cap">
              mean over this view at {fmtHour(hour)}
              <br />
              {field?.cells.filter((c) => c.heatScore >= 65).length ?? 0} hot
              cells (≥65) · {field?.cells.length ?? 0} evaluated
            </span>
          </div>
        )}

        {field && (
          <>
            <h3>About this layer</h3>
            <p className="placeholder">{field.provenance.notes}</p>
            {field.cells[0] && (
              <p className="placeholder">
                Sources: {field.cells[0].sources.join(' · ')}
              </p>
            )}
          </>
        )}
      </aside>
    </div>
  );
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

function fmtHour(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
