# Canton facades — run log

## Phase A: Thônex (done)

### What was built

- `tools/lib/facade-style.mjs` — the facade styles, RegBL construction periods, default storey heights and `styleOf`
  shared by the city and canton builders. `tools/build-geneva-facades.mjs` now imports them (the Vieille-Ville rule
  stays there, passed in as a predicate); the canton builder calls `styleOf` without it.
- `tools/lib/canton-area.mjs` — the commune outline fetcher (swissBOUNDARIES3D) and the LV95 point/polygon helpers
  (`pointInRings`, `pointNearRings`, `polyIntersectsRings`, `ringsBbox`, `epochYear`).
- `tools/fetch-canton-footprints.mjs` — downloads the SITG `CAD_BATIMENT_HORSOL` polygons (EPSG:2056) into
  `tools/data/cache/canton_footprints.json`, one `{ egid, ring, epoque, annee, niveaux, hauteur, destination }` per
  building. `--area <BFS>` keeps only the footprints intersecting that commune + 100 m; resumable/cached.
- `tools/build-geneva-canton-facades.mjs` — two steps, one file:
  - `--batches` fetches every canton tile's b3dm, caches its feature + batch table JSON only
    (`tools/data/cache/canton_batches/<uri>.json`), links each batch id to its footprint (containing point, else by
    EGID, else nearest within 5 m) and writes `tools/data/cache/canton_buildings.json`.
  - `--facades` reads the linked buildings, the measured wall colours, the RegBL (by EGID) and the city's 32 archetypes
    (reused unchanged), and writes `data/geneva-canton-facades.json`.
- `tools/sample-photomesh-facades.mjs` — added a `--canton` mode (the existing `--all` and cached modes are unchanged):
  photomesh tiles intersecting the canton/commune, wall triangles matched to the **cadastral** footprints (buffered
  ~1.5 m) instead of the city's OSM footprints, keyed by EGID (or a footprint id), streamed download → measure → delete,
  resumable (state + output flushed every 50 tiles, 4 concurrent downloads, retries with back-off).
- `tools/run-canton-facades.sh` — the resumable pipeline: footprints → batches → gwr (if missing) → facades (initial) →
  samples → facades → `npm test`, appending to `tools/data/cache/canton_facades.log` and ending with `DONE` or
  `FAILED: <step>`.
- `tests/canton-facades.test.mjs` — the output contract: styles, the city's 32 archetypes reused unchanged, one entry per
  batch id (counted against the cached batch tables), every entry parses (style, storey 27–45 dm, archetype or −1, hex,
  w/p/t in [0, 1]), and the measured/known shares.

### Thônex (`--area 6640`) — the numbers

- **179** canton tiles have their centre in Thônex (of 6,684 over the canton).
- **3,782** cadastral footprints intersect the commune (+ 100 m margin; 3,276 without the margin).
- **3,249** buildings in those tiles; **2,992 (92.1 %)** linked to a footprint (the rest are open structures or
  "Im Bau" with no cadastral polygon).
- **467** photomesh tiles intersect the commune; **7,905,111** wall triangles, **1,108,798** matched to a footprint.
- **2,006 of 3,249 buildings (61.7 %)** have a measured wall colour; **2,939 (90.5 %)** have a known style.
- Output `data/geneva-canton-facades.json`: **94 KB**, `"area": { "bfs": 6640, "name": "Thônex" }`, 179 tiles.
- `npm test`: **180/180 pass** (all existing tests plus the two new canton checks).

### Decisions / problems met

- The photomesh tile **name** in `url_telechargement` is offset ~48 m from its real extent, so the intersection filter
  uses the ArcGIS feature **geometry rings** (`returnGeometry=true`), not the name; the `.obj` itself is georeferenced
  correctly.
- The city terrain grid (`data/geneva-terrain.bin`) only covers the city frame. Sampling the canton with it made the
  wall height "above ground" negative at the grid's clamped edge and dropped every sample; the `--canton` mode now uses
  the surroundings' **mid ring** (`data/geneva-surroundings.bin`) for the ground height.
- The cadastre's `NO_COMM` is the historical commune number (**43** for Thônex), not the BFS 6640, so the footprints are
  filtered by geometry (commune outline + 100 m) rather than by attribute.
- The canton tiles' batch tables carry **no EGID** (only Latitude/Longitude/Height/OBJEKTART/UUID…), so position is the
  main key into the cadastre, as the plan anticipated.
- `EPOQUE_CONSTRUCTION` ("Période de 1976 à 1980", "Avant 1919") is parsed to a middle year for the cadastre style
  fallback; `ANNEE_CONSTRUCTION` is used when present.

### Expected run time

Thônex's 467 photomesh tiles took ~12 minutes. The whole canton (31,601 photomesh tiles, 6,684 building tiles) is
expected to take **~10–15 hours**, nearly all of it the photomesh step.

### How to check progress / resume

- Progress: `tail -f tools/data/cache/canton_facades.log` (the last line is `DONE` or `FAILED: <step>`).
- Resume (any step skips work already done): `bash tools/run-canton-facades.sh [--area 6640]`.
- Look at Thônex: `npm run serve`, then in the console
  `__slopgeneva.mode('helicopter'); __slopgeneva.teleportXZ(4600, 1300)`.

## Phase B: the whole canton (running)

Launched detached on **2026-11-06T18:11:26Z** (PID 44588, pidfile `tools/data/cache/canton_facades.pid`) as
`nohup bash tools/run-canton-facades.sh >> tools/data/cache/canton_facades.log 2>&1 &`, with no `--area`.

### Launcher fix

The first launch (18:11:03Z) died immediately at the first step: macOS ships **bash 3.2**, and with `set -u` an empty
`AREA=()` array makes `"${AREA[@]}"` an *unbound variable* — the whole-canton path (no `--area`) had never been
exercised in Phase A. `tools/run-canton-facades.sh` now expands it as `${AREA[@]+"${AREA[@]}"}` (nothing when empty,
two words with `--area 6640`), with a comment explaining why. Re-launched at 18:11:26Z.

### The run so far (first 8 minutes)

- **Step footprints** (18:11:26 → 18:11:35): the whole canton re-downloaded because the cache held Thônex only —
  **83,089** cadastral footprints, as the plan measured.
- **Step batches** (18:11:35 → 18:12:59): all **6,684** canton tiles; the 179 cached Thônex b3dm tables were reused, the
  rest fetched. **80,578** buildings, **67,368 (83.6 %)** linked to a footprint. (Plan: ~30 min for this step; it took
  **84 s** here, partly because of the Phase A cache.)
- **Step gwr**: skipped (the RegBL CSV was already cached). **80,850** RegBL buildings read.
- **Step facades0** (18:12:59 → 18:13:10): a first, valid whole-canton `data/geneva-canton-facades.json` with no
  `"area"` field: **2,443 KB**, 6,684 tiles, **2,264 of 80,578 buildings measured** (2.8 % — only the Thônex photomesh
  samples existed at that point), **64,596 (80.2 %)** with a known style. White balance x[1.06, 1.02, 0.84] from the
  Thônex median wall [138, 139, 150]; it will be recomputed from the whole canton at the end.
- **Step samples** (started 18:13:10): **28,734** photomesh tiles intersect the canton outline (the plan's 31,601 was
  the bbox estimate; the ArcGIS feature geometries give 28,734). **467 tiles were already done** from Phase A and are
  reused: the Phase A state keys every histogram by **EGID** (3,580 keys, zero `none:` fallback keys), so nothing is
  re-measured and no key is invalidated by the whole-canton footprint list.
  At 18:18:39Z: **567/28,734 tiles**, 3,580 buildings with accumulated histograms, ~**0.30 tiles/s**, the script's ETA
  line ~1,430 min. That is **~24 h**, above the plan's 10–15 h estimate (the canton tiles look bigger/denser than
  Thônex's, and network speed varies); the ETA will settle as the run progresses.

### What remains

`sample-photomesh-facades.mjs --canton` → `--facades` (rebuild with the whole canton's measured colours) → `npm test`
→ the script appends `pipeline done` and `DONE`. The final `data/geneva-canton-facades.json` is then expected around
**2026-11-07 18:00–21:00Z** (±several hours); a human reviews and commits it. The file is deliberately **not committed
here** — it is rewritten by each facades pass and only final once the log says `DONE`.

### How to check progress / resume

- Progress: `tail -f tools/data/cache/canton_facades.log` (photomesh lines every 50 tiles: `n/28734 tiles, … ~N min
  left`); step boundaries are the `STEP <name>` marks; the very last line must be `DONE` (or `FAILED: <step>`).
- Counters: `node -e "const s=require('./tools/data/cache/canton_facade_samples.state.json'); console.log(s.done.length)"`.
- Process: `ps -p $(cat tools/data/cache/canton_facades.pid)`.
- Resume after a crash/reboot: re-run `bash tools/run-canton-facades.sh` (no `--area`) — every step skips cached work
  and the photomesh step continues from `canton_facade_samples.state.json`.
- Look at it once `DONE`: `npm run serve`; the file now has no `area`, so `js/canton.js` uses it for every canton tile.

### Decisions / problems met (Phase B)

- The empty-`AREA` bash 3.2 bug above (fixed).
- Kept the Phase A photomesh state and samples: they are canton-valid measurements, and resuming avoids ~12 min of
  rework and keeps the initial facades pass populated.
- The whole-canton footprint list replaces the Thônex one; footprint-order keys (`none:<index>`) would have shifted,
  but the Phase A state contains none, so all cached samples remain addressable by EGID.
- Photomesh tile count is 28,734 (geometry intersection), not the 31,601 bbox figure in the plan.
- Observed photomesh throughput puts the long step nearer 20–26 h than the 10–15 h plan estimate; disk use stays low
  (each tile is downloaded, measured, deleted).
