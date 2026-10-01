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
| **B. Backend API** | HTTP routes, schemas, services (incl. backend transit stack) |
| **C. Data providers** | Spatial, weather, cooling, crowd, transit data snapshots |
| **D. Web map UI** | MapLibre layers, panels, legend, search, basemap features |
| **E. Web routing** | Route providers, heat sampling, route card, transit card |
| **F. Mobile app** | Expo screens, RN components |
| **G. Territory raster** | Offline grid generator + renderer |
| **H. Build/CI/docs** | Dockerfile, workflows, README/docs |
| **I. Civic engagement** | Citizen heat reports, 1823 dossier, cooling siting optimizer |

Cross-area features get ONE lead area per *file*, not per feature. The
transit feature, for example, is B (backend routes/services) + C (data
snapshot) + E (card UI) — nobody owns "transit" wholesale; each file has
exactly one owner.

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
│   ├── providers/                 C  spatial · weather · cooling · gazetteer ·
│   │                                 citybrain · transit (MTR net + KMB loaders)
│   ├── routes/                    B  one APIRouter per feature, wired in main.py:
│   │   ├── transit.py             B  /transit/plan
│   │   └── civic.py               I  /civic/reports* + /civic/siting/*
│   ├── services/                  B  heatmap.py · planner.py · transit.py
│   ├── tools/                     one script per tool, no shared files:
│   │   ├── generate_thermal_grid.py   G  (~135 s; see "Generated data")
│   │   ├── build_coastline_mask.py    G
│   │   ├── extract_hk_boundary.py     G
│   │   ├── fetch_hk_boundary.py       G
│   │   ├── fetch_kmb_data.py          C  KMB snapshot refresh (use curl; urllib
│   │   │                                 fails on sandbox SSL)
│   │   └── export_demo_snapshot.py    E  offline snapshot for the web fallback
│   └── data/
│       ├── static/*.json          generated — never hand-edit:
│       │                          thermal_grid.json (G) · kmb_routes/stops/
│       │                          route_stops.json (C) · demo snapshot (E)
│       └── civic_reports.jsonl    I  runtime report store (append-only; safe to
│                                      delete to reset demo data)
├── backend/tests/                 one file per feature area:
│   ├── test_heat_model.py         A    test_routing.py      E
│   ├── test_api.py                B    test_anywhere.py     A
│   ├── test_providers.py          C    test_data.py         C
│   ├── test_solar_shade.py        A    test_civic.py        I
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
│   │   │   ├── HeatLayers.ts      SHARED  (protocol below)
│   │   │   ├── InspectPanel.tsx   D
│   │   │   ├── Legend.tsx         D
│   │   │   ├── PlaceSearch.tsx    D  incl. parsePastedLocation (Google pin)
│   │   │   ├── TimeControl.tsx    D
│   │   │   ├── TransparencyModal.tsx  D
│   │   │   ├── mapFeatures.ts     D  green/buildings from basemap tiles
│   │   │   ├── colors.ts / demoSnapshots.ts / districts.ts / gazetteer.ts / skeleton.ts  D
│   │   │   ├── heatField.ts       E  continuous field + shade sampler
│   │   │   ├── offlineEngine.ts   E  browser physics fallback
│   │   │   ├── coolRoute.ts       E  planner + candidate selection + pace model
│   │   │   ├── routeOsrm.ts       E  OSRM foot provider
│   │   │   ├── osmStreets.ts      E  street graph + heat-aware Dijkstra
│   │   │   ├── transitApi.ts      E  transit client + card data
│   │   │   ├── territoryRaster.ts G  raster → map squares
│   │   │   ├── CivicPanel.tsx     I  report + siting + dossier UI
│   │   │   └── civicApi.ts        I  civic client
│   │   └── <your-feature>/        any  NEW features get a NEW folder + NEW
│   │       ├── FeaturePage.tsx          files (see civic for the worked example)
│   │       ├── api.ts                   its API calls (own fetch, no client.ts edit)
│   │       ├── layers.ts                its map layers (registry protocol below)
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

1. **`web/src/api/client.ts`** — shared helpers only. *Protocol:* feature
   API clients now live in their own feature folder (`transitApi.ts`,
   `civicApi.ts`) with their own `fetch` + cache + types; they never import
   or edit `client.ts`. `client.ts` keeps only genuinely shared plumbing
   (`getJson`, heat endpoints). If you need a helper from it, import it;
   don't grow it.
2. **`web/src/features/heatmap/HeatMapPage.tsx`** — composition only.
   *Protocol:* this file wires components together; all real logic lives in
   your feature folder. Adding a feature = importing it + placing it in the
   JSX + (if needed) a state slice. Keep every feature's footprint under
   ~20 lines in this file. If two features both need page-level state, lift
   it into a `state.ts` module both import instead.
3. **`backend/app/main.py`** — composition root. *Protocol:* new endpoints
   live in `backend/app/routes/<feature>.py` with an `APIRouter`; main.py
   gains one import + one `include_router` line and should stay under
   ~100 lines of wiring. (Transit and civic are already migrated; the
   remaining inline legacy routes are area B's backlog.)
4. **`backend/app/schemas.py`** — additive-only contract. *Protocol:* add
   optional fields; never rename or remove (mobile + web both compile
   against it via the mirror in `mobile/src/services/api/types.ts`).
5. **`web/src/features/heatmap/HeatLayers.ts`** — layer registry, append-only
   per feature. *Protocol (matches how the file is actually used):* your
   feature adds ONE self-contained block at the end of each list —
   its `SRC`/`LYR` id constants, one `sources` entry, one layer spec, each
   marked with a `// --- <feature>` comment — plus nothing else. Prefer
   `circle`/`fill`/`line` layers over `symbol` with custom glyphs (custom
   icons must be registered in `addCoolingIcons`; don't grow that for
   another feature — ship your own icon loader in your folder if you need
   one). Conflicts here are 3-line insertions at the end of lists: git
   auto-merges them; never reorder or reformat existing blocks.

## Extension points (how to add without touching others)

- **New backend endpoint** → `backend/app/routes/<feature>.py` with an
  `APIRouter` + one line in `main.py`.
- **New data provider** → new file in `providers/` implementing the existing
  interface; wire it in `main.py` (one line). Never edit another provider.
- **New map feature** → new folder in `web/src/features/` following the
  template above; the page imports and renders it (see `CivicPanel` for a
  complete worked example: panel + api client + registry block + tests).
- **New route provider (web)** → new file next to `routeOsrm.ts` exporting
  `async function fetchCandidates(a, b): Promise<RouteSummary[]>`;
  `coolRoute.ts` gains one candidate-push line.
- **New test** → new file `test_<feature>.py` / `*.test.ts`. Never edit
  another area's test file.

## Generated data (read this before "fixing" a data bug)

| File | Owner | Regenerate with | Notes |
|---|---|---|---|
| `backend/app/data/static/thermal_grid.json` | G | `./.venv/bin/python -m app.tools.generate_thermal_grid --step-m 150` (backend/) | ~135 s; whole-territory raster; feeds map + siting optimizer |
| `backend/app/data/static/kmb_*.json` | C | curl the 3 KMB open-data endpoints (see `fetch_kmb_data.py` docstring) | `urllib` fails on sandbox SSL; snapshots are committed |
| `backend/app/data/civic_reports.jsonl` | I | nothing — runtime store | append-only; delete to reset demo data |
| `web/dist/` | H | `cd web && ./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build` | uvicorn SERVES this — after pulling, rebuild or the SPA is stale even though the API is new |

Last one is the classic trap: **backend updated, UI looks unchanged** —
because the browser is running the old built bundle. Rebuild `web/dist`
after any web change.

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
