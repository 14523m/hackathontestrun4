# Team code ownership map

> Goal: **five people, one repo, zero merge conflicts.** Every file has
> exactly one owner-area. You may *read* anything; you may only *edit*
> inside your area or via the listed extension points.

## The one rule

**A merge conflict means the ownership map failed.** If two people need the
same file for two features, the fix is to split the file, not to coordinate
harder. New code goes in a NEW file in your area; existing files are edited
only by their owner (or with the owner's OK on the PR).

## Ownership areas

| Area | Scope |
|---|---|
| **A. Heat model** | Physics, solar/shade math, scores |
| **B. Backend API** | HTTP routes, schemas, services |
| **C. Data providers** | Spatial, weather, cooling, crowd data |
| **D. Web map UI** | MapLibre layers, panels, legend, search |
| **E. Web routing** | Route providers, heat sampling, route card |
| **F. Mobile app** | Expo screens, RN components |
| **G. Territory raster** | Offline grid generator + renderer |
| **H. Build/CI/docs** | Dockerfile, workflows, README/docs |

## File tree with owners

```
hk-coolpath/
├── backend/app/
│   ├── main.py                    B  composition root ONLY (wiring, no logic)
│   ├── config.py                  H  env settings
│   ├── schemas.py                 B  API contract — add fields, never rename
│   ├── core/                      A  geo.py · solar.py · thermal.py · types.py
│   ├── engines/
│   │   ├── heat/
│   │   │   ├── engine.py          A  district heat model
│   │   │   ├── anywhere.py        A  point heat model (any lat/lon)
│   │   │   └── shade.py           A  shadow geometry
│   │   └── routing/engine.py      E  server-side Dijkstra
│   ├── providers/                 C  spatial · weather · cooling · gazetteer · citybrain
│   ├── services/                  B  heatmap.py · planner.py (orchestration)
│   ├── tools/                     one script per tool, no shared files:
│   │   ├── generate_thermal_grid.py   G
│   │   ├── build_coastline_mask.py    G
│   │   └── extract_hk_boundary.py     G
│   └── data/static/*.json         generated — never hand-edit (regenerate)
├── backend/tests/                 one file per feature area:
│   ├── test_heat_model.py         A    test_routing.py      E
│   ├── test_api.py                B    test_anywhere.py     A
│   ├── test_providers.py          C    test_data.py         C
│   └── ...                        add test_<yourfeature>.py; NEVER edit
│                                  someone else's test file
├── web/src/
│   ├── main.tsx / App.tsx         D  app shell
│   │                                 (App.tsx is shared-fate: badge only;
│   │                                 UI features never edit it)
│   ├── api/client.ts              SHARED  (protocol below)
│   ├── features/
│   │   ├── heatmap/               D owns the page + panels:
│   │   │   ├── HeatMapPage.tsx    SHARED  (protocol below)
│   │   │   ├── HeatLayers.ts      D  layer registry — protocol below
│   │   │   ├── InspectPanel.tsx   D
│   │   │   ├── Legend.tsx         D
│   │   │   ├── PlaceSearch.tsx    D
│   │   │   ├── TimeControl.tsx    D
│   │   │   ├── TransparencyModal.tsx  D
│   │   │   ├── colors.ts / demoSnapshots.ts / districts.ts / gazetteer.ts / skeleton.ts  D
│   │   │   ├── heatField.ts       E  continuous field + sampler
│   │   │   ├── offlineEngine.ts   E  browser physics fallback
│   │   │   ├── coolRoute.ts       E  planner + candidate selection
│   │   │   ├── routeOsrm.ts       E  OSRM provider
│   │   │   ├── osmStreets.ts      E  street graph fallback
│   │   │   └── territoryRaster.ts G  raster → map squares
│   │   └── <your-feature>/        any  NEW features get a NEW folder:
│   │       ├── FeaturePage.tsx          page/component
│   │       ├── api.ts                   its API calls (calls client.ts, doesn't edit it)
│   │       ├── layers.ts                its map layers (registered once in HeatLayers.ts)
│   │       ├── state.ts                 its state (module store or context)
│   │       └── types.ts                 its types
├── mobile/src/                    F  screens · components · services/api
├── routing3d/                     E  standalone multi-modal engine demo
├── docs/                          H  one doc per topic — never two writers
├── Dockerfile / docker-compose.yml  H
└── .github/workflows/ci.yml       H
```

## The five shared-fate files (and their protocols)

These are the only files where conflicts can happen. Each has a rule that
makes conflicts structurally rare:

1. **`web/src/api/client.ts`** — one exporter per feature. *Protocol:* your
   feature adds its own `export const myFeatureApi = { ... }` at the bottom;
   never edit another feature's exports, never move the shared `getJson`
   helper. If it grows past ~400 lines, split into `api/<feature>.ts` files
   and re-export from `client.ts` (one-line edit).
2. **`web/src/features/heatmap/HeatMapPage.tsx`** — composition only.
   *Protocol:* this file wires components together; all real logic lives in
   your feature folder. Adding a feature = importing it + placing it in the
   JSX + (if needed) a state slice. Keep every feature's footprint under
   ~20 lines in this file. If two features both need page-level state, lift
   it into a `state.ts` module both import instead.
3. **`backend/app/main.py`** — composition root. *Protocol:* new endpoints
   live in `backend/app/routes/<feature>.py` with an `APIRouter`; main.py
   gains one import + one `include_router` line and should stay under
   ~100 lines of wiring. (Existing routes migrate there over time — area
   B's backlog.)
4. **`backend/app/schemas.py`** — additive-only contract. *Protocol:* add
   optional fields; never rename or remove (mobile + web both compile
   against it via the mirror in `mobile/src/services/api/types.ts`).
5. **`web/src/features/heatmap/HeatLayers.ts`** — layer registry.
   *Protocol:* each feature declares its own `SRC`/`LYR` id constants and a
   `registerMyLayers(map)` function in ITS OWN file; HeatLayers.ts gains
   only a re-export line + one `registerMyLayers(map)` call.

## Extension points (how to add without touching others)

- **New backend endpoint** → `backend/app/routes/<feature>.py` with an
  `APIRouter` + one line in `main.py`.
- **New data provider** → new file in `providers/` implementing the existing
  interface; wire it in `main.py` (one line). Never edit another provider.
- **New map feature** → new folder in `web/src/features/` following the
  template above; the page imports and renders it.
- **New route provider (web)** → new file next to `routeOsrm.ts` exporting
  `async function fetchCandidates(a, b): Promise<RouteSummary[]>`;
  `coolRoute.ts` gains one candidate-push line.
- **New test** → new file `test_<feature>.py` / `*.test.ts`. Never edit
  another area's test file.

## Branch & PR discipline

- Branch per feature from latest `main`: `feat/<area>-<feature>`
  (e.g. `feat/D-place-search`, `feat/E-mtr-routing`).
- A PR may only touch files in its own area + shared files via the
  protocols above. Reviewers check the ownership map, not just the code.
- Small PRs (< ~300 lines diff) merge fast; anything touching two areas
  needs both owners' sign-off.
- Commit style: `feat: …`, `fix: …`, `docs: …`, `chore: …` (matches repo
  history).

## The five-minute rule for conflicts

If you hit a conflict anyway: rebase onto `main`, and if the same *lines*
clash twice in a week, file a task to split the file — the map, not the
team, is wrong.
