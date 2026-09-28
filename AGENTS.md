# HK CoolPath AI — agent & developer guide

Monorepo: `backend/` (FastAPI, Python ≥3.9) + `mobile/` (Expo SDK 57, React
Native, expo-router). Read `docs/architecture.md` and
`docs/development.md` (branch map) before writing code.

## Commands

Backend (use the project venv):

```bash
cd backend && ./.venv/bin/python -m pytest            # tests (must be green)
cd backend && ./.venv/bin/python -m app.data.generate_static_data   # regen mock geodata
cd backend && ./.venv/bin/uvicorn app.main:app --port 8000
```

Mobile (Expo has changed — do not trust training data; check the SDK docs):

```bash
cd mobile && npx expo install <package>   # ALWAYS, not npm/pnpm/bun add
cd mobile && npx tsc --noEmit             # typecheck (must be green)
cd mobile && npx expo start               # dev server; dev build required for maps
```

MapLibre RN v11 API (installed): `Map` (not `MapView`), `Camera
initialViewState={{center, zoom}}`, `GeoJSONSource data=…`, generic `Layer`
with style-spec `paint`/`filter` (no `style` prop). Check
`node_modules/@maplibre/maplibre-react-native/src/index.ts` for the truth.

## Architecture rules (agents MUST follow)

1. **One heat model.** All heat goes through
   `app/engines/heat/engine.py::HeatPredictionService`. Never add a second
   formula; planner interventions and edge attributes enter via the declared
   `overrides` channel.
2. **Stable contracts.** `backend/app/schemas.py` ⇄
   `mobile/src/services/api/types.ts` are the interface boundary. Changing
   them is an architecture change: document why, update both sides together.
3. **Providers are seams.** Real data integrations replace provider
   implementations (`providers/`), never engines. Keep mock data separate
   under `app/data/static/` (generated, committed, deterministic).
4. **Stay in your lane.** Follow the branch map in `docs/development.md`;
   do not restyle or "improve" another feature's files. If a change outside
   your area is unavoidable, explain why in the PR.
5. **Label everything honestly.** Simulated data is labelled simulated; HKO
   observations are never presented as street-level measurements; the
   Northern Metropolis is always CONCEPTUAL / SIMULATED. See
   `docs/responsible-ai.md`.
6. **Verify before done.** Backend: pytest green. Mobile: `tsc --noEmit`
   green. New behaviour needs tests; architecture changes need doc updates.
7. **Commits**: `feat:` / `fix:` / `refactor:` / `test:` / `docs:` — small and
   focused; never "update everything".
