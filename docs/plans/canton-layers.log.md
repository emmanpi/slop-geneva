# Canton layers — Phase A log (Thônex, BFS 6640)

Executed on the `canton-layers` worktree, branch `canton-layers`. Phase A only: generalised the tools, produced the
tiles over the commune of Thônex, checked them, committed the code. Phase B (the whole canton) is left to a later
session.

## What I built

- `tools/args.mjs` (new) — shared `--extent minE,minN,maxE,maxN`, `--out`, `--cache-suffix`, `--trees`, `--download`
  parsing, plus `cacheFile()` (a JSON cache under `tools/data/cache/<suffix>/`).
- `tools/osm-geometry.mjs` — added `clipRing()` and `clipPolyline()` (Sutherland-Hodgman against an axis-aligned box);
  `clipToFrame()` now delegates to `clipRing()`.
- `tools/fetch-sitg-roadway.mjs`, `tools/fetch-geneva-trees.mjs` — `--extent` and `--cache-suffix` (the fetched JSON).
- `tools/build-geneva-roadway.mjs`, `tools/build-geneva-roadmarks.mjs` — `--extent`, `--out`, `--cache-suffix`; with an
  extent, the rings/markings are clipped to the tile (+50 m) and the masks cover the tile alone.
- `tools/build-geneva-terrain.mjs` — `--extent`, `--out`; the underground-cut fill (which needs the city's OSM ways) is
  skipped outside the frame. The swissALTI3D STAC search reaches 4 m past the tile so its edge nodes sample correctly.
- `tools/build-geneva-ortho.mjs` — `--extent`, `--out`, `--trees`, `--cache-suffix` (the raw mosaic cache moves into the
  per-tile cache dir).
- `tools/build-canton-layers.mjs` (new) — enumerates the 1 km LV95 tiles intersecting the area's outline, runs the
  generalised tools per tile as child processes (concurrency 3, retries with back-off, progress/ETA to
  `tools/data/cache/canton_layers.log`), writes `data/canton/<E>-<N>/...` and `data/canton/index.json` (rewritten after
  every 10 tiles), and leaves a `tools/data/cache/canton/<E>-<N>/done` marker for resumability.
- `tests/canton-layers.test.mjs` (new) — checks every tile in `index.json`: sizes, terrain grids (251 × 251, plausible
  heights, shared edges), roadway/road-marking magic + bounds, tree records, orthophoto dimensions.

## Regression check (step 1, required)

`node tools/build-geneva-roadway.mjs` and `node tools/build-geneva-roadmarks.mjs` (no arguments) rewrite
`data/geneva-roadway.bin` and `data/geneva-roadmarks.bin` **byte-identical** (`cmp` clean; `git diff` shows nothing).
The frame's terrain/ortho default paths were reviewed, not re-run (long downloads); their default output paths are
unchanged (`data/geneva-terrain.bin`, `data/geneva-ortho.jpg`).

## Tiles produced (Phase A)

`node tools/build-canton-layers.mjs --area 6640` — **13 tiles**, **10.0 MB total**, run time **47 s**.

| layer | files | bytes | note |
| --- | --- | --- | --- |
| terrain | 13 | 1 638 338 (1.6 MB) | 251 × 251 nodes @ 4 m, heights 385–428 m a.s.l. |
| ortho | 13 | 4 670 403 (4.5 MB) | SWISSIMAGE 10 cm @ 1 m, flight 2023 |
| roadway | 13 | 2 164 532 (2.1 MB) | carriageways, islands, kerbs, 1 m mask |
| roadmarks | 13 | 884 724 (0.8 MB) | lines, painted shapes, surfaces |
| trees | 13 | 1 166 543 (1.1 MB) | 18 644 trees |

Tiles: `2502-1114, 2502-1115, 2503-1114, 2503-1115, 2503-1116, 2504-1115, 2504-1116, 2504-1117, 2504-1118,
2505-1116, 2505-1117, 2505-1118, 2506-1117`. None are inside the city frame; every tile has all five layers (Thônex is
fully urban, so no empty tiles this run).

`npm test` passes: **185 / 185** (the 178 existing tests plus the 7 new canton checks).

## Problems met / adaptations

- The ArcGIS/SITG query returns each feature's **full** geometry (not clipped to the query envelope). To keep a tile's
  `.bin` bounded (the plan's "±50 m" test) the roadway and road-marking tools clip their output to the tile +50 m, and
  the fine (kerb) mask extends 50 m past the tile so kerbs are correct right up to the edge; the exported 1 m mask
  covers the tile alone.
- swissALTI3D tiles are 1 km-aligned like the canton tiles, so a tile's east/south edge nodes read the neighbouring
  COG's first pixels; the terrain STAC search therefore reaches 4 m past the tile (only in `--extent` mode).
- The phase-A commune outline comes from
  `api3.geo.admin.ch …/ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill/6640`, which returns a single
  `{feature:{…}}` (not a FeatureCollection); `feature.properties.gemname` ("Thônex") is the name.

## What to look at (Phase A review)

- **Data is not committed.** `data/canton/` (10.0 MB) is left untracked; the owner decides whether it goes into git
  (per the plan). `tools/data/cache/` (the fetched JSON and raw ortho mosaics) stays git-ignored.
- Tile-edge seams in the ortho: adjacent tiles come from the same 2023 flight, but the tree-crown removal runs per tile
  with a 100 m tree margin, so a crown straddling two tiles is filled independently on each side — the two fills can
  differ slightly along the shared edge.
- Roadway kerbs are clipped to the tile, rings to +50 m: rings/kerbs duplicated across neighbouring tiles (the browser
  clips), which is the plan's "kept whole … is fine".
- Marking lines that dip outside the tile and return within the same half-plane are split into two pieces
  (`clipPolyline`); rare, but worth a look on any tile with long diagonal roads.
- Trees belong to the tile containing their trunk; a tree just across a boundary whose crown overhangs the neighbour is
  not in that neighbour's `trees.json`, but its crown is still removed from the neighbour's ortho (via the fetch
  margin).
