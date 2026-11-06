# Plan: the canton's ground layers as 1 km tiles (background data job)

Executor: an autonomous coding agent (opencode, `opencode-go/deepseek-v4-pro`). **Data only**: tools, data files,
tests. The browser side (streaming these tiles around the camera) is done separately by the owner's other agent once
Phase A's data exists: do not write any browser code. Read this whole file before doing anything.

**Two phases, two sessions.** Your prompt says which one you are in:
- **Phase A — Thônex only, then stop.** Generalise the tools, produce the tiles over the commune of Thônex, check them,
  commit, write the log, end your session. Do not start Phase B.
- **Phase B — the whole canton.** Only when the prompt says so: fix what the owner asked after Phase A, then run the
  canton-wide build (detached, resumable).

## Why

The mapped city (`js/geneva-frame.js` `FRAME.lv95`: E 2498300-2502300, N 1116500-1121300) has fine layers: a 4 m
terrain (`data/geneva-terrain.bin`), a 1 m orthophoto (`data/geneva-ortho.jpg`), the street space with carriageways,
islands and kerbs/footways (`data/geneva-roadway.bin`), the road markings (`data/geneva-roadmarks.bin`) and the
cantonal tree inventory (in `js/geneva-geodata.js` `GENEVA_DATA.trees`). Beyond it the canton has only a 50 m relief
and a ~6 m photo. This job produces the same layers for the rest of the canton, cut in 1 km tiles the browser can
stream.

## Output contract (do not deviate)

Tiles are the LV95 kilometre squares: tile `E-N` (in km, e.g. `2504-1116`) covers E ∈ [E·1000, E·1000+1000],
N ∈ [N·1000, N·1000+1000]. Everything is in **world coordinates** like the city's files
(`x = E - FRAME.E0`, `z = FRAME.N0 - N`, heights `y = h - FRAME.H0`; see `js/geneva-frame.js`).

```
data/canton/index.json                    { source, fetched, tileSize: 1000, area?: { bfs, name },
                                            tiles: { "2504-1116": { layers: ["terrain", "ortho", "roadway", "roadmarks", "trees"],
                                                                    bytes: { terrain: n, ... }, trees: n, orthoYear: 2023 } } }
data/canton/<E>-<N>/terrain.bin            ZTR1, exactly the format of data/geneva-terrain.bin (js/terrain-grid.js
                                            parseTerrain): 4 m cells (FRAME.terrainCell), covering the tile plus ONE
                                            extra cell on its east and south edges so neighbouring tiles share their
                                            edge heights (251 x 251 nodes), heights - FRAME.H0, scale 0.01
data/canton/<E>-<N>/ortho.jpg              SWISSIMAGE 10 cm, newest flight, at 1 m per pixel: 1000 x 1000 px, row 0
                                            the tile's north edge, column 0 its west edge (like data/geneva-ortho.jpg),
                                            JPEG quality 82
data/canton/<E>-<N>/roadway.bin            GRWY, exactly the format of data/geneva-roadway.bin (header comment of
                                            tools/build-geneva-roadway.mjs), its mask over the tile
data/canton/<E>-<N>/roadmarks.bin          GRMK, exactly the format of data/geneva-roadmarks.bin
data/canton/<E>-<N>/trees.json             [{ x, z, h, crown, street, g }, ...] exactly the fields of
                                            GENEVA_DATA.trees (see how tools/build-geneva-geodata.mjs makes them from
                                            tools/data/cache/geneva_trees.json)
```

- A layer with nothing in the tile (no roads in a forest, no markings) is simply absent from `layers` (no file).
- Features crossing a tile edge: kept whole in every tile they touch is fine for markings and roadway rings (the browser
  clips by tile); trees belong to the tile containing their trunk.
- Tiles **entirely inside the city frame** are skipped (the city has its own files). Tiles partly inside are produced in
  full (the browser masks the part the city covers).
- Sizes: Phase A ~20 tiles, a few MB. Phase B ~300 tiles, expect ~100-150 MB in total: report the actual total in the
  log; the owner decides whether it goes into git.

## Sources (all already used by the tools; open data)

- Terrain: swisstopo swissALTI3D 2 m COGs (`tools/build-geneva-terrain.mjs` reads them by HTTP ranges).
- Orthophoto: swisstopo SWISSIMAGE 10 cm COGs, per 1 km tile, newest flight (`tools/build-geneva-ortho.mjs`).
- Roadway: SITG `CAD_DOMROUTIER_OBJETS_NIV0`; markings: SITG `OTC_MARQUAGE_LIGNE`, `OTC_MARQUAGE_SURFACE`
  (`tools/fetch-sitg-roadway.mjs` fetches them in 500 m tiles, paged).
- Trees: SITG Inventaire cantonal des arbres isolés (`tools/fetch-geneva-trees.mjs`), whole canton available.
- The canton outline: `data/geneva-canton-boundary.json` (LV95 rings). A commune outline (Phase A):
  `https://api3.geo.admin.ch/rest/services/api/MapServer/ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill/<BFS>?geometryFormat=geojson&sr=2056`.
  **Thônex is BFS 6640** (LV95 bbox E 2502914-2506283, N 1114868-1118564, entirely outside the city frame).

## Steps

Work in a git worktree on a branch, never on `main` (it may already exist: then just work in it):

```sh
git worktree add ../slop-gva-canton-layers -b canton-layers
cd ../slop-gva-canton-layers && npm install
```

The data caches are git-ignored and not in the worktree. For the regression checks of step 1, copy (do not move, do
not symlink) the city's SITG caches from the main checkout: `cp ../slop-gva/tools/data/cache/sitg_*.json tools/data/cache/`.

### 1. Generalise the tools (no behaviour change for the city)

Give `tools/fetch-sitg-roadway.mjs`, `tools/fetch-geneva-trees.mjs`, `tools/build-geneva-roadway.mjs`,
`tools/build-geneva-roadmarks.mjs`, `tools/build-geneva-terrain.mjs` and `tools/build-geneva-ortho.mjs` an optional
extent (`--extent minE,minN,maxE,maxN` in LV95) and output path(s) (`--out`, `--cache-suffix` for the fetched JSON),
defaulting to exactly today's behaviour (the frame, today's files). Where a tool depends on city-only inputs (the
terrain's fill of underground cuts uses OSM ways from `tools/data/cache/osm_geneva.json`), skip that part outside the
frame and say so in the tool's header comment.

**Regression check (required):** with no arguments, `node tools/build-geneva-roadway.mjs` and
`node tools/build-geneva-roadmarks.mjs` must rewrite `data/geneva-roadway.bin` and `data/geneva-roadmarks.bin`
byte-identical (`git diff --stat` shows nothing). Do not re-run the frame's terrain or ortho (long downloads): review
their default path carefully instead.

### 2. The tile builder (tools/build-canton-layers.mjs)

`node tools/build-canton-layers.mjs --area 6640` (Phase A) or `--canton` (Phase B), plus `--only terrain,ortho,...`
and `--limit N` for testing:
- the tiles: every 1 km square intersecting the area's outline (or the canton's), minus those entirely inside the
  city frame;
- per tile: fetch (into `tools/data/cache/canton/<E>-<N>/`) and build each layer with the generalised tools (import
  their functions or run them as child processes with `--extent`/`--out`), write `data/canton/<E>-<N>/...`;
- resumable: a tile whose layers are all written is skipped (write a `tools/data/cache/canton/<E>-<N>/done` marker
  last); re-running continues after a crash;
- concurrency 2-3 tiles, retries with back-off on every request, progress and ETA logged to
  `tools/data/cache/canton_layers.log`;
- writes `data/canton/index.json` at the end (and after every 10 tiles, so it is always valid).

### 3. Checks: tests/canton-layers.test.mjs

For every tile in `data/canton/index.json`: the listed files exist, their sizes match `bytes`; `terrain.bin` parses
with `parseTerrain` (`js/terrain-grid.js`) to 251 x 251 nodes over the tile (+1 cell), heights plausible
(Geneva: 330-1000 m a.s.l. → -42..628 above H0); its edge heights equal the neighbouring tiles' shared edge;
`roadway.bin` / `roadmarks.bin` have the right magic and version and their points fall in the tile (± 50 m);
`trees.json` entries have the GENEVA_DATA.trees fields, inside the tile; `ortho.jpg` is 1000 x 1000.
`npm test` passes (all existing tests too).

### Phase B only: the long run

Write `tools/run-canton-layers.sh` (`node tools/build-canton-layers.mjs --canton` then `npm test`; last line of the
log `DONE` or `FAILED: <step>`), launch it detached
(`nohup bash tools/run-canton-layers.sh >> tools/data/cache/canton_layers.log 2>&1 &`), watch a few tiles complete,
commit your code, write the log, end your session. A human commits the data when it reports `DONE`.

## Rules

- Do not modify anything under `js/`, `css/`, `index.html`, nor the existing `data/` files (step 1's regression check
  rewrites two of them identically: nothing to commit there). Tools, tests, `data/canton/`, `docs/plans/` only.
- Big caches stay in `tools/data/cache/` (git-ignored); never commit downloads.
- Code style: match the existing tools (ES modules, header comment with sources, outputs and usage, `log()` helper,
  English comments). Prefer extending the existing tools to copying them.
- Commit on the `canton-layers` branch, small commits with clear messages. Do not push, do not merge.
- If a source is unreachable or differs from this plan, adapt sensibly and record it in
  `docs/plans/canton-layers.log.md`. Never skip a step silently.
- Before ending your session, write in `docs/plans/canton-layers.log.md`: what you built, per layer the tiles and
  bytes produced, the regression check's result, the run time, problems met, and (Phase A) a list of what to look at.
