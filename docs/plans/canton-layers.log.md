# Canton layers — run log

Two phases on the `canton-layers` worktree, branch `canton-layers`. Phase A (the commune of Thônex, BFS 6640)
generalised the tools, produced its tiles and passed review; Phase B (the whole canton) is the long detached run
documented at the end of this file.

## Phase A — Thônex, BFS 6640

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

## Phase B — the whole canton

Executed on the same worktree and branch. The build ran detached through `tools/run-canton-layers.sh --canton`
(`nohup … >> tools/data/cache/canton_layers.log 2>&1 &`), then the full test suite. The log's last line is `DONE`.

### What changed for the long run

- `tools/run-canton-layers.sh` (new) — the whole-canton pipeline: the resumable builder, then `npm test`. The build
  step is attempted up to three times; each pass skips the tiles already marked done, so a retry only rebuilds the
  tiles that failed (a dropped request, a bad source file).
- `tools/build-canton-layers.mjs` — a resumed run now keeps the tiles it skipped in `data/canton/index.json` (it merges
  the previous index, and re-reads a tile's files if its index entry was lost before the first rewrite); a tile that
  still fails after its retries is listed and the tool exits non-zero, so the run script retries it; empty
  `roadway.bin` / `roadmarks.bin` are detected on the file's own bytes.
- `tools/build-geneva-ortho.mjs` — a flight whose COG the server cannot read now falls back to that tile's next newest
  SWISSIMAGE flight (the year actually used goes into `ortho.json` and `index.json`). SWISSIMAGE 2023 is defective for
  tile `2488-1114`: every range read ends in geotiff's `BlockedSource … reading 'offset'`; the 2020 flight reads fine.

### Run

| | |
| --- | --- |
| started (UTC) | 2026-11-06T17:56:36Z |
| build | 625 s (10 min 25 s) |
| tests | 19 s (`npm test`: **187 / 187 pass**, including the 7 canton checks) |
| pipeline done | 2026-11-06T18:07:21Z |
| wall time | 10 min 45 s |

A first attempt started at 17:50:44Z and was stopped after 87 tiles to deploy the two fixes above; the second run
resumed from those done markers (100 skipped in all, with Phase A's 13) and built the remaining 250.

**350 tiles** (the whole canton, minus the tiles entirely inside the city frame), **200.5 MB** total, **219 460 trees**.
13 of them are Phase A's Thônex tiles, reused as-is; Phase B built 337.

| layer | tiles | bytes | note |
| --- | --- | --- | --- |
| terrain | 350 | 42.07 MB | 251 × 251 nodes @ 4 m, 330–563 m a.s.l. |
| ortho | 350 | 90.99 MB | 347 tiles from the 2023 flight, `2488-1114` from 2020 (defective 2023 COG) |
| roadway | 302 | 43.46 MB | 48 tiles have no carriageway (forest, fields, lake) |
| roadmarks | 270 | 10.69 MB | 80 empty files were removed after the run (see below) |
| trees | 294 | 13.30 MB | 56 tiles have no isolated tree |

- `data/canton/index.json` lists all 350 tiles, `source`, `fetched: 2026-11-06`, `tileSize: 1000`; it has no `area` (the
  whole canton).
- The data is **not committed**: `data/canton/` is untracked, **205 MB on disk** (`du`; the index counts 200.5 MB of
  layer files, the rest is the per-tile `ortho.json` sidecars and block allocation). Per the plan, the owner decides
  whether it goes into git.
- Full progress and child output: `tools/data/cache/canton_layers.log` (the caches, including the per-tile SITG JSON
  and raw ortho mosaics, stay git-ignored under `tools/data/cache/canton/`).

### Problems met / adaptations

- **Defective 2023 orthophoto COG for `2488-1114`.** The geotiff library fails on its 0.4 m overview with
  `Cannot read properties of undefined (reading 'offset')`, reproducibly and from a fresh process; the 2020 COG of the
  same tile reads. The ortho tool now falls back to the next newest available flight and records it. That single tile
  therefore shows 2020 imagery next to its 2023 neighbours.
- **Empty layer masks were kept.** The builder read the header with `fs.readFileSync(out).buffer.slice(0, …)`: for small
  files the Buffer lives in Node's pool, so the slice was not the file's bytes and `nShapes === 0` was missed. 80 empty
  `roadmarks.bin` (28 bytes) were listed in `layers`. The check now copies the file's own bytes; the 80 files and their
  index entries were removed after the run, and the tests still pass.
- **A resumed run dropped skipped tiles from `index.json`.** It rebuilt `tiles` from only the tiles of the current pass.
  The index is now merged with the previous one (and reconstructed from disk if needed), so a crash mid-run never loses
  the tiles already produced.
- **The size estimate was low.** The plan expected ~300 tiles and 100–150 MB; the canton has 350 tiles and 200.5 MB.
  The orthophoto alone is 91 MB (1 m photo of the whole canton); the urban tiles (carriageways, kerbs, markings) are
  the heavy ones.

### What to look at (Phase B)

- **Size and git:** 350 tiles / 200.5 MB are untracked in `data/canton/`, against 101 MB of data already in git
  (`git ls-files data`). Committing them triples the repository's tracked data; streaming them as plain static files is
  what the browser agent expects.
- **The 2020 tile:** `2488-1114` is the only tile from an older flight. Its edges with the 2023 neighbours will show a
  small colour/season seam; every other tile is 2023.
- **Layer absence is real:** 48 tiles without `roadway`, 56 without `trees`, 80 without `roadmarks` (they are listed as
  absent, not as empty files). Those are the forest/field/lake squares; the browser should keep its fallback ground
  there.
- **Tile seams:** the Phase A notes still apply (ortho tree-crown fills run per tile, rings/kerbs are duplicated across
  neighbours and clipped by the browser). The canton-wide run used the same tools, so no new seam source was added.
- **The checks:** `npm test` is 187/187 on the final index. Re-running `bash tools/run-canton-layers.sh` is cheap now
  (all done markers are present); it is also the way to fill any tile a future source outage leaves missing.
