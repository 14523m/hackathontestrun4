# Development guide

## Repo layout

```
hk-coolpath/
├── backend/                  FastAPI service (Python ≥3.9)
│   ├── app/
│   │   ├── main.py           HTTP app + composition root
│   │   ├── schemas.py        API contract (mirror: mobile types.ts)
│   │   ├── config.py         env-based settings
│   │   ├── core/             geo math, solar position, shared types
│   │   ├── engines/heat/     THE heat model + shade geometry
│   │   ├── engines/routing/  weighted Dijkstra route engine
│   │   ├── services/         heatmap, planner (orchestration)
│   │   ├── providers/        weather, spatial, cooling, crowd, citybrain
│   │   └── data/             static mock geodata (generated, committed)
│   └── tests/                pytest suite (40 tests)
├── mobile/                   Expo app (iOS/Android, expo-router)
│   └── src/
│       ├── app/              screens: index (Cool Route), explore (Heat Map), planner
│       ├── components/map/   MapLibre map + layers
│       ├── components/ui/    time slider, legend, badges
│       ├── services/api/     typed API client + contract types
│       └── constants/        theme
├── docs/                     architecture, data sources, configuration
├── .github/workflows/ci.yml  backend tests + mobile typecheck
└── docker-compose.yml        backend container
```

## Run locally

### Backend

```bash
cd backend
python3 -m venv .venv
./.venv/bin/pip install -e ".[dev]"
./.venv/bin/python -m app.data.generate_static_data   # regenerate mock geodata
./.venv/bin/uvicorn app.main:app --reload --port 8000
```

- API docs: http://localhost:8000/docs
- `DATA_MODE=demo` (default) is fully offline; `DATA_MODE=live` uses HKO Open Data.

### Mobile

```bash
cd mobile
npm install
npx expo start
```

- MapLibre needs a **dev build** (not Expo Go): `npx expo run:ios` /
  `npx expo run:android` (or `eas build --profile development`).
- The app expects the backend on `http://localhost:8000` (iOS simulator).
  For a physical device, set `EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:8000`
  in `mobile/.env`.

### Docker (backend only)

```bash
docker compose up --build   # API on :8000
```

## Tests & checks

```bash
cd backend && ./.venv/bin/python -m pytest        # 40 tests: solar/shade, heat, routing, providers, API
cd mobile  && npx tsc --noEmit                    # strict typecheck
cd backend && ./.venv/bin/python -m app.main      # smoke-boot
```

## Feature-branch map (one team/agent per area)

| Branch | Owns | May touch | Must NOT touch |
|---|---|---|---|
| `feature/heat-model` | `engines/heat/**`, weights in config | heat tests, config heat weights | routing, UI |
| `feature/cool-routing` | `engines/routing/**` | routing tests, mode weights | heat model internals, UI |
| `feature/map` | `mobile/src/components/map/**` | map layers, styling | API types, screens' logic |
| `feature/planner-dashboard` | planner screen + `services/planner.py` | interventions catalogue | engines |
| `feature/data-providers` | `providers/**`, generator | real integrations (HKO/LandsD), caching | engines' formulas |
| `feature/crowd-reports` | crowd provider + future submission API | report UI | engines |
| `feature/northern-metropolis` | NM scenario data/labels | scenario narrative | engines |
| `feature/ui` | screens, theme, components | — | engines, providers |

**Stable contracts** (coordinate before changing):
`backend/app/schemas.py` ⇄ `mobile/src/services/api/types.ts`, and the
provider interfaces in `backend/app/providers/`.

## Git conventions

Commits follow `feat:`, `fix:`, `refactor:`, `test:`, `docs:` style, e.g.

```
feat: add shaded-corridor intervention
fix: correct morning shadow direction
test: add route exposure weighting tests
docs: document HKO live provider
```

Small, focused commits on a feature branch; rebase onto `main` before opening
a PR. The PR description should name the branch-map row it belongs to.

## Definition of done (per PR)

1. `pytest` green; 2. `tsc --noEmit` green (if mobile touched); 3. no changes
outside your branch-map row without justification in the PR; 4. new
behaviour covered by tests; 5. docs updated when architecture or data
sources change.
