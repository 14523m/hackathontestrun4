# Data sources - authoritative Hong Kong data plan

This project prioritises **authoritative, Hong Kong-specific datasets** over
arbitrary third-party APIs. Below: each source, what the MVP does today, and
exactly what real integration requires. The UI's Data Sources panel
(`/config/data-sources`) mirrors this table.

## Weather — Hong Kong Observatory (authoritative)

| | |
|---|---|
| Role | Regional atmospheric anchors: air temperature (multi-station), relative humidity; future: wind, solar radiation, Heat Index, WBGT |
| Status | **Live integration implemented** (`HKOWeatherProvider`, `DATA_MODE=live`) using the open `rhrread` current-weather report (10-min updates); `demo` mode simulates deterministically |
| URL | https://www.hko.gov.hk/en/abouthko/opendata_intro.htm |

**Scientific guardrail (section 33):** HKO has no sensor on every street.
Station observations anchor *regional* conditions; local urban geometry
modifies pedestrian exposure. HKO values are never presented as street-level
measurements, and modelled placeholders (wind in the MVP) are labelled.

**Real-integration upgrades:** add `LTM` 10-min wind/solar datasets, Heat
Index & WBGT feeds; move interpolation to a published method and document it.

## Urban geometry — Lands Department (authoritative)

| Dataset | Role | MVP status |
|---|---|---|
| [Building footprints & attributes](https://data.gov.hk/en-data/dataset/hk-landsd-openmap-landsd-building) | Shade geometry, building density, street canyons | Simulated mock (deterministic); swap point: `SpatialData.buildings` |
| [3D Spatial Data (CSDI)](https://portal.csdi.gov.hk/csdi-webpage/apidoc/3d-spatial-data-api) | Cesium 3D Tiles, tile-based loading for a demo district | Not integrated (architecture supports tile loading) |
| [3D Pedestrian Network](https://portal.csdi.gov.hk/csdi-webpage/dataset/landsd_rcd_1637222018065_52265) | **Preferred routing network**: pedestrian paths, elevation/gradient, accessibility | Simulated grid network; swap point: `SpatialData.network` |
| [3D pedestrian route search API](https://hosting.csdi.gov.hk/csdi-webpage/apidoc/3d-pedestrian-route-search) | Valid point-to-point pedestrian paths | Not integrated (we compute our own heat-aware routes per section 38) |
| Digital Terrain Model (5 m) | Slope / walking-comfort cost | Mock gradients are flat; model supports `gradientPct` |

**Real-integration requirements:** CSDI API key/approval, tile-based fetching
(never bulk-download the territory), schema mapping to our
`PedestrianEdge`-equivalent properties (`lengthM`, `gradientPct`), and caching
of fetched tiles under `backend/app/data/` for offline demo resilience.

## Satellite — USGS Landsat / Sentinel-2

| | |
|---|---|
| [Landsat Collection 2 Surface Temperature](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature) (30 m) | `surface_heat_reference` for calibrating/validating spatial patterns. **Never** interpreted as pedestrian air temperature |
| Sentinel-2 NDVI | `vegetation_fraction`, `impervious_surface_fraction` predictors |
| Status | Not yet integrated (Tier 2). The heat model already separates surface vs air vs vegetation terms so these plug in cleanly |

## Land use — Planning Department

| | |
|---|---|
| [Land utilization raster (10 m)](https://data.gov.hk/en-data/dataset/hk-pland-pland1-land-utilization-in-hong-kong-raster-grid) | built_up / green_space / woodland / water fractions feeding vegetation & paved terms |
| Status | Simulated mock grid; swap point: `SpatialData.land_use` |

## Trees & cooling locations

| | |
|---|---|
| [LCSD trees (major parks)](https://data.gov.hk/en-data/dataset/hk-lcsd-csdi-tree-information-major-parks) | Known-tree authoritative layer (combined with satellite vegetation; never assumed complete) |
| [LCSD venues](https://data.gov.hk/en-data/dataset/hk-lcsd-venue-venue) | Libraries / community centres / parks with addresses & opening hours → `CoolingSpot` normalisation |
| Status | Simulated venues (realistic names, NOT real coordinates); swap point: `CoolingSpotProvider` |

## Road network — Transport Department (supplementary)

| | |
|---|---|
| [Road Network v2](https://data.gov.hk/en-data/dataset/hk-td-tis_15-road-network-v2) | Road geometry/classification context only. Pedestrian routing always prioritises the LandsD 3D pedestrian network |

## City Brain (integration boundary only)

We do **not** have access to City Brain APIs and do not pretend otherwise.
`CityBrainProvider` defines the seam (`providers/citybrain.py`);
`MockCityBrainProvider` returns clearly-simulated data. Real integration
would require:

1. API credentials + access approval from the platform operator.
2. Network reachability from the deployment environment.
3. Dataset schema documentation and licensing terms.
4. Rate-limit / caching strategy agreement.

## Crowd reports

`CrowdReportProvider` stores simulated, **anonymised** reports ("very sunny
here", "no shade"). A real submission API must minimise personal data, strip
identifiers, and validate against spam/abuse before ingestion.

## Demo resilience (section 17)

The demo never depends on any of the above: `DATA_MODE=demo` uses
deterministic mock datasets generated by
`python -m app.data.generate_static_data`. `live` mode degrades gracefully to
the last valid observation (flagged STALE) and never silently fabricates data.
