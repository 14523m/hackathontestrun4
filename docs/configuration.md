# Configuration reference - HK CoolPath AI

All backend configuration is environment-variable based (see `.env.example`).
Nothing needs to be configured for the hackathon demo: defaults work offline.

## Data mode

| Variable | Values | Meaning |
|---|---|---|
| `DATA_MODE` | `demo` (default) / `live` | `demo` = deterministic simulation, zero network. `live` = fetch HKO Open Data; on failure serves the last valid observation flagged `STALE` (never silently fabricated). |

## Weather (HKO Open Data)

| Variable | Default | Meaning |
|---|---|---|
| `HKO_BASE_URL` | `https://data.weather.gov.hk/weatherAPI/opendata/weather.php` | HKO open-data endpoint (`rhrread` current weather). |
| `WEATHER_CACHE_SECONDS` | `600` | Cache duration for observations (~10-min update cadence). |
| `WEATHER_STALE_AFTER_SECONDS` | `21600` | Age after which the last valid observation is no longer served. |

## Heat model (prototype calibration parameters)

These weights are **prototype calibration values**, not scientifically fitted
constants. They are documented and deliberately tunable so an ML model can
replace the demo formula later without interface changes.

| Variable | Default | Term |
|---|---|---|
| `HEAT_SOLAR_WEIGHT` | `7.0` | Direct solar exposure penalty |
| `HEAT_SHADE_WEIGHT` | `7.0` | Building-shade benefit |
| `HEAT_VEGETATION_WEIGHT` | `5.5` | Vegetation cooling benefit |
| `HEAT_SURFACE_TEMPERATURE_WEIGHT` | `4.0` | Paved / heat-retaining surface penalty |
| `HEAT_WIND_WEIGHT` | `2.5` | Wind cooling benefit |
| `HEAT_HUMIDITY_WEIGHT` | `2.0` | Humidity discomfort penalty |
| `HEAT_BUILDING_DENSITY_WEIGHT` | `2.2` | Urban-canyon density penalty |

## Route modes (alpha = time, beta = heat, gamma = slope)

| Variable | Default | Meaning |
|---|---|---|
| `ROUTE_FASTEST_ALPHA` / `_BETA` | `1.0` / `0.05` | Fastest: time dominates. |
| `ROUTE_BALANCED_ALPHA` / `_BETA` | `0.6` / `1.0` | Balanced trade-off. |
| `ROUTE_COOLEST_ALPHA` / `_BETA` | `0.15` / `2.5` | Coolest: accepts long detours to cut exposure. |

`ROUTE_*_GAMMA` (all `0.5`) also exists; slope is a walking-comfort cost, not a
thermal variable (master prompt section 39).

## Mobile

| Variable | Default | Meaning |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `http://localhost:8000` | Backend base URL. Set to your LAN IP for physical devices (e.g. `http://192.168.1.42:8000`). Put this in `mobile/.env`. |
