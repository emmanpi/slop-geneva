# Canton facades — run log (Phase A: Thônex)

## What was built

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

## Thônex (`--area 6640`) — the numbers

- **179** canton tiles have their centre in Thônex (of 6,684 over the canton).
- **3,782** cadastral footprints intersect the commune (+ 100 m margin; 3,276 without the margin).
- **3,249** buildings in those tiles; **2,992 (92.1 %)** linked to a footprint (the rest are open structures or
  "Im Bau" with no cadastral polygon).
- **467** photomesh tiles intersect the commune; **7,905,111** wall triangles, **1,108,798** matched to a footprint.
- **2,006 of 3,249 buildings (61.7 %)** have a measured wall colour; **2,939 (90.5 %)** have a known style.
- Output `data/geneva-canton-facades.json`: **94 KB**, `"area": { "bfs": 6640, "name": "Thônex" }`, 179 tiles.
- `npm test`: **180/180 pass** (all existing tests plus the two new canton checks).

## Decisions / problems met

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

## Expected run time

Thônex's 467 photomesh tiles took ~12 minutes. The whole canton (31,601 photomesh tiles, 6,684 building tiles) is
expected to take **~10–15 hours**, nearly all of it the photomesh step.

## How to check progress / resume

- Progress: `tail -f tools/data/cache/canton_facades.log` (the last line is `DONE` or `FAILED: <step>`).
- Resume (any step skips work already done): `bash tools/run-canton-facades.sh [--area 6640]`.
- Look at Thônex: `npm run serve`, then in the console
  `__slopgeneva.mode('helicopter'); __slopgeneva.teleportXZ(4600, 1300)`.
