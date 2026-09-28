/**
 * HeatMapPage — the judge-facing heat map (web rebuild).
 *
 * All heat data comes from the backend's HeatPredictionService via /heatmap;
 * this component never computes or hard-codes heat values. Basemap:
 * OpenFreeMap vector tiles (coastline, roads, water, MTR context).
 */

import { useEffect, useRef, useState } from 'react';
import type { MapMouseEvent } from 'maplibre-gl';
import { Map as MLMap } from 'maplibre-gl';

import { api, nearestCooling } from '../../api/client';
import type {
  CoolingSpot,
  HeatCell,
  HeatMapResponse,
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

const DISTRICTS: {
  id: string;
  label: string;
  description: string;
  center: [number, number];
  zoom: number;
}[] = [
  {
    id: 'central-western',
    label: 'Central & Western',
    description:
      'Dense historic district on Hong Kong Island — steep terrain, narrow streets, little park space. Simulated district for demonstration.',
    center: [114.138, 22.285],
    zoom: 14.6,
  },
  {
    id: 'kowloon-yau-tsim',
    label: 'Yau Tsim Mong',
    description:
      'Extremely dense Kowloon urban core — street canyons and tower shade. Simulated district for demonstration.',
    center: [114.172, 22.303],
    zoom: 14.6,
  },
  {
    id: 'northern-metropolis',
    label: 'Northern Metropolis (conceptual)',
    description:
      'A CONCEPTUAL / SIMULATED new-district scenario for planning-stage heat assessment. Not an official plan or prediction.',
    center: [114.135, 22.515],
    zoom: 13.6,
  },
];

export default function HeatMapPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [districtId, setDistrictId] = useState('central-western');
  const [hour, setHour] = useState(14.5);
  const [heat, setHeat] = useState<HeatMapResponse | null>(null);
  const [cooling, setCooling] = useState<CoolingSpot[]>([]);
  const [loading, setLoading] = useState(false);

  const [showHeat, setShowHeat] = useState(true);
  const [heatOpacity, setHeatOpacity] = useState(0.75);
  const [showGreen, setShowGreen] = useState(false);
  const [showBuildings, setShowBuildings] = useState(false);
  const [showCooling, setShowCooling] = useState(true);

  const [selected, setSelected] = useState<HeatCell | null>(null);
  const [nearby, setNearby] = useState<CoolingSpot[]>([]);

  // --- map lifecycle --------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MLMap({
      container: containerRef.current,
      style: BASEMAP_STYLE_URL,
      center: DISTRICTS[0].center,
      zoom: DISTRICTS[0].zoom,
      attributionControl: false,
    });
    mapRef.current = map;
    // Debug/demo hook: lets the console (and tests) inspect the live map.
    (window as unknown as { __coolpathMap?: MLMap }).__coolpathMap = map;
    map.on('load', handler.onLoad);

    return () => {
      map.off('load', handler.onLoad);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const handler = {
    onLoad: () => {
      if (mapRef.current) {
        addHeatSourcesAndLayers(mapRef.current);
        setMapReady(true);
      }
    },
  };

  // --- data loading ----------------------------------------------------------
  useEffect(() => {
    if (!mapReady) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([api.heatmap(districtId, hour, 'high'), api.coolingSpots(districtId)])
      .then(([hm, spots]) => {
        if (cancelled || !mapRef.current) return;
        setHeat(hm);
        setCooling(spots);
        setHeatData(mapRef.current, cellsToFC(hm.cells));
        setOverlayData(mapRef.current, SRC.cooling, spotsToFC(spots));
        setOverlayData(mapRef.current, SRC.green, greenToFC(hm.cells));
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, districtId, hour]);

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
  }, [mapReady, showGreen, showHeat, showCooling, showBuildings, heat]);

  // --- click-to-inspect (on cell outlines; surface swallows clicks) ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !heat) return;

    function onMapClick(e: MapMouseEvent) {
      const m = mapRef.current;
      if (!m) return;
      const feats = m.queryRenderedFeatures(e.point, {
        layers: [LYR.heatHit],
      });
      const cellId = feats[0]?.properties?.cellId as string | undefined;
      const cell = heat?.cells.find((c) => c.cellId === cellId);
      if (cell) {
        setSelected(cell);
        setNearby(nearestCooling(cooling, cell.center, 500, 4));
      }
    }

    map.on('click', onMapClick);
    return () => {
      map.off('click', onMapClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, heat]);

  const activeDistrict = DISTRICTS.find((d) => d.id === districtId)!;

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
          nearby={nearby}
          onClose={() => setSelected(null)}
        />
      </div>

      <aside className="side-panel">
        <div className="district-row">
          {DISTRICTS.map((d) => (
            <button
              key={d.id}
              className={d.id === districtId ? 'active' : ''}
              onClick={() => {
                setDistrictId(d.id);
                setSelected(null);
                mapRef.current?.flyTo({ center: d.center, zoom: d.zoom });
              }}
            >
              {d.label}
            </button>
          ))}
        </div>

        <h2>{activeDistrict.label}</h2>
        {heat && (
          <>
            <div className="score-pill" style={{ marginBottom: 12 }}>
              <span className="num">{Math.round(meanOf(heat.cells))}</span>
              <span className="cap">
                district mean at {fmtHour(hour)}
                <br />
                {heat.cells.filter((c) => c.heatScore >= 65).length} hot cells (≥65)
              </span>
            </div>
            <p className="placeholder">{activeDistrict.description}</p>

            <h3>Cooling spots here</h3>
            {cooling.slice(0, 6).map((s) => (
              <div className="cooling-item" key={s.id}>
                <span>{s.name}</span>
                <span className="dist">{s.type.replace(/_/g, ' ')}</span>
              </div>
            ))}

            <h3>About this layer</h3>
            <p className="placeholder">{heat.provenance.notes}</p>
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

function meanOf(cells: HeatCell[]): number {
  if (!cells.length) return 0;
  return cells.reduce((s, c) => s + c.heatScore, 0) / cells.length;
}

function fmtHour(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
