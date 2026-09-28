# HK CoolPath AI 🌳☀️

> **Hong Kong's heat problem should not only be measured. It should be
> navigated — and prevented.**

HK CoolPath AI is a spatial-AI platform built for a Hong Kong hackathon:

- **For citizens & tourists** — find a cooler way through the city: compare
  Fastest / Balanced / Coolest walking routes with duration-weighted heat
  exposure, shade and time-of-day solar geometry.
- **For planners & policymakers** — see tomorrow's heat before building
  today's city: simulate interventions (trees, shaded corridors, ventilation)
  on a **CONCEPTUAL / SIMULATED Northern Metropolis scenario** and compare
  before/after heat, shade and cooling access.

Everything runs locally in minutes and works **fully offline** in demo mode;
live HKO weather is one environment variable away.

---

## Quick start

### 1. Backend (FastAPI)

macOS / Linux:

```bash
cd backend && ./setup.sh
./.venv/bin/uvicorn app.main:app --port 8000
```

Windows:

```bat
cd backend && setup.bat
.venv\Scripts\uvicorn app.main:app --port 8000
```

> ⚠️ **Never copy `.venv/` between machines** (AirDrop, zip, USB): it contains
> hardcoded absolute paths and symlinks that only work on the machine that
> created it — this is the usual cause of "python3 can't be found". Share the
> repo via git and run the setup script; it always builds a fresh venv.

Open http://localhost:8000/docs for the interactive API.

### 2. Mobile (Expo, iOS/Android)

```bash
cd mobile
npm install
npx expo run:ios        # or: npx expo run:android  (dev build; MapLibre needs native code)
```

The app connects to `http://localhost:8000` (iOS simulator). For a physical
device put `EXPO_PUBLIC_API_URL=http://<LAN-IP>:8000` in `mobile/.env` and
start the backend exposed to the network:

```bash
./.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Verify from the phone's browser at `http://<LAN-IP>:8000/health` — campus
Wi-Fi that blocks device-to-device traffic (client isolation) will fail here;
use a personal-hotspot connection instead.

### 3. Docker (backend only)

```bash
docker compose up --build
```

## The 3-minute demo story

1. **Cool Route tab** — pick the "Sai Ying Pun → Central" demo trip, drag the
   time slider to 14:30, tap **Find Cool Route**:
   ☀️ Fastest rides the sun-baked arterial (28 min, exposure ~60)
   🌳 Coolest detours through the tree-lined boulevard (~37 min, exposure ~50).
2. Drag time to 09:00 — exposure drops city-wide (time-dependent model).
3. **Heat Map tab** — tap any hot cell: the app *explains* it
   (➕ paved surface, ➖ vegetation …). Switch to Yau Tsim Mong for canyon heat.
4. **Planner tab** — the Northern Metropolis (conceptual) scenario: toggle
   *Add trees* + *Shaded corridors* and watch mean exposure, peak hotspot and
   the Cooling Access Gap fall — **before the district is built**.

All values shown are labelled modelled/simulated estimates — see
[docs/responsible-ai.md](docs/responsible-ai.md).

## Architecture (one-page view)

```
Mobile (Expo + MapLibre RN)  ──JSON──▶  FastAPI
                                        ├── HeatMapService   (explainable layer)
                                        ├── PlannerService   (what-if simulation)
                                        ▼
                     HeatPredictionService ◀── RouteEngine
                     (sun position → shade → heat, per edge, per hour)
                                        ▼
        Providers: Weather (HKO live/mock) · Spatial · Cooling · Crowd · CityBrain
```

- **One heat model** used by map, routing and planner; interventions enter
  through a declared `overrides` channel, never a second formula.
- **Time-dependent**: NOAA solar position drives building-shadow geometry, so
  the same street is shaded at 09:00 and sun-baked at 15:00.
- **Explainable**: every score ships signed factor contributions.
- **Data-mode seam**: `DATA_MODE=demo` (deterministic, offline) vs `live`
  (HKO Open Data with stale-fallback). Details: [docs/architecture.md](docs/architecture.md).

## Data sources

Authoritative Hong Kong data is the priority: HKO Open Data (weather, live),
Lands Department (buildings / 3D pedestrian network), Planning Department
(land use), Landsat / Sentinel-2 (calibration, Tier-2), LCSD (venues & trees).
The MVP uses clearly-labelled deterministic mocks for spatial data and the
real HKO feed for weather. Full catalogue + integration requirements:
[docs/data-sources.md](docs/data-sources.md).

## Team workflow (multi-agent ready)

Feature branches with strict ownership areas — map/UI, heat model, routing,
planner, data providers — so five people can work simultaneously without
collisions. Branch map, commands and PR rules:
[docs/development.md](docs/development.md).

```bash
git checkout -b feature/cool-routing   # then small, focused commits
```

Commit style: `feat: add cool route scoring`, `fix: correct shadow direction`,
`test: add route exposure tests`, `docs: update architecture`.

## Tests

```bash
cd backend && ./setup.sh && ./.venv/bin/python -m pytest   # 40 tests
cd mobile  && npx tsc --noEmit               # strict typecheck
```

## Honest-disclaimer banner

Heat values are **modelled estimates**; demo data is **simulated**; the app
does **not** replace official HKO warnings; real deployment requires
validation against ground measurements. The Northern Metropolis layer is a
conceptual scenario, not a prediction. See
[docs/responsible-ai.md](docs/responsible-ai.md).

## License

MIT — see [LICENSE](LICENSE).
