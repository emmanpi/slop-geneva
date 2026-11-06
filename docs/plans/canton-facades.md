# Plan: facades for every building of the canton (background job)

Executor: an autonomous coding agent (opencode, `opencode-go/deepseek-v4-pro`) working alone for many hours.
Owner review: the result is a branch, reviewed and merged by a human. Read this whole file before doing anything.

## Goal

The browser already streams the swissBUILDINGS3D buildings of the whole canton of Geneva around the camera
(`js/canton.js`, tile list in `data/geneva-canton-buildings.json`). Unlike the city centre's buildings, they have no
facade data: every canton building is drawn with a generic colour and the "inconnu" style.

Produce **`data/geneva-canton-facades.json`**: a facade (style, storey height, archetype, measured wall colour, share of
windows, shop fronts, wall texture) for every building of every tile listed in `data/geneva-canton-buildings.json`.
`js/canton.js` already reads this file when it exists (no browser code to write).

## The output contract (do not deviate)

Same format as the city's `data/geneva-facades.json` (read it, and read `tools/build-geneva-facades.mjs` which
writes it):

```json
{
  "source": "...",
  "fetched": "YYYY-MM-DD",
  "styles": ["ancien", "xixe", "moderne", "contemporain", "bureaux", "inconnu"],
  "archetypes": [ { "rgb": [r, g, b], "win": 0.37, "shop": 0.1, "rough": 0.17, "n": 168 }, ... ],
  "tiles": { "<tile uri, exactly as in data/geneva-canton-buildings.json>": "s,f,a,RRGGBB,w,p,t;s,f,a,RRGGBB,w,p,t;..." }
}
```

- One `;`-separated entry **per batch id of the tile, in batch id order** (entry k = batch id k of the b3dm's batch
  table). The count must equal the tile's batch length (`BATCH_LENGTH` in the b3dm feature table).
- `s` style index into `styles`; `f` storey height in decimetres (integer); `a` archetype index into `archetypes`
  (-1 if none); `RRGGBB` the wall colour, sRGB hex, lowercase, no `#`; `w` share of windows, `p` chance of shop
  fronts, `t` wall texture/roughness (same meaning and ranges as in `data/geneva-facades.json`; 2-3 decimals).
- `archetypes`: **reuse the city's 32 archetypes unchanged** (copy them from `data/geneva-facades.json`), so the
  city and the canton share one palette. Do not recompute k-means.
- Keep the file compact (no pretty-printing). Expect ~2-4 MB.

## Data sources (all open data)

1. **Tiles and their buildings**: `data/geneva-canton-buildings.json` → `{ origin, tiles: [[uri, x, z], ...] }`; each
   tile is `origin + uri`, a b3dm file (3D Tiles 1.0). Only the **feature table and batch table JSON** are needed (no
   geometry decoding): `BATCH_LENGTH`, and per batch id `Latitude`, `Longitude`, `Height`, `OBJEKTART`, and when
   present `EGID`, `GELAENDEPUNKT`, `DACH_MAX`. **The batch table's fields vary from tile to tile: `EGID` is often
   missing** (checked on a canton tile: only `Latitude`/`Longitude`/`Height`/`OBJEKTART`/`UUID`...), so the position
   is the main key. See `parseB3dm` in `js/swissbuildings3d.js` for the header layout (copy the
   logic into the Node tool; `js/swissbuildings3d.js` itself imports three.js from a CDN and cannot run in Node).
2. **Cadastral footprints with EGID**: SITG `CAD_BATIMENT_HORSOL` (83,089 polygons over the canton), ArcGIS REST:
   `https://vector.sitg.ge.ch/arcgis/rest/services/CAD_BATIMENT_HORSOL/FeatureServer/0/query`
   (fields include `EGID`, `EPOQUE_CONSTRUCTION`, `ANNEE_CONSTRUCTION`, `NIVEAUX_HORSOL`, `HAUTEUR`,
   `DESTINATION`; ask for `outSR=2056`, paginate with `resultOffset`/`resultRecordCount`, the server caps a page).
3. **RegBL / GWR** (year, period, storeys, class per EGID): `npm run data:gwr` downloads and unpacks it into
   `tools/data/cache/gwr/` (the city tool reads `gebaeude_batiment_edificio.csv` there).
4. **Measured wall colours**: the SITG photomesh (Photomaillage 3D 2019), **31,601 tiles over the canton**, listed by
   `https://vector.sitg.ge.ch/arcgis/rest/services/Hosted/PHOTOMESH_2019/FeatureServer/0/query`
   (field `url_telechargement`). `tools/sample-photomesh-facades.mjs` already measures walls from these tiles for the
   city centre (its `--all` mode streams tiles: download, measure, delete, resumable). Reuse its measuring code.

## Steps

Work in a git worktree on a branch, never on `main` (it may already exist: then just work in it):

```sh
git worktree add ../slop-gva-canton-facades -b canton-facades
cd ../slop-gva-canton-facades && npm install
```

**Your session will not last the 10-15 hours of step 3.** So the job is a resumable pipeline that finishes on its own:
write the tools of steps 1-5, test each on a small sample (`--limit N` options: a few tiles, a few photomesh tiles),
then write `tools/run-canton-facades.sh` that runs steps 1 → 2 → 3 → 4 → `npm test` in order (each step skipping work
already done, so the script can be re-run after any crash), appending everything to `tools/data/cache/canton_facades.log`,
and writing `DONE` or `FAILED: <step>` as its last line. Launch it detached
(`nohup bash tools/run-canton-facades.sh >> tools/data/cache/canton_facades.log 2>&1 &`), watch it for a few minutes
to see step 3 progressing, commit your work, write the log (below), and end your session. A human commits the final
`data/geneva-canton-facades.json` when the script reports `DONE`.

### 1. Footprints (tools/fetch-canton-footprints.mjs) — minutes

Download all `CAD_BATIMENT_HORSOL` polygons (EPSG:2056) into `tools/data/cache/canton_footprints.json`
(`[{ egid, ring: [[E, N], ...], epoque, annee, niveaux, hauteur, destination }]`). Resumable/cached: skip if present.

### 2. Canton buildings (tools/build-geneva-canton-facades.mjs, first part) — ~30 min

For every tile of `data/geneva-canton-buildings.json`: fetch the b3dm (cache the **feature + batch table JSON only**
in `tools/data/cache/canton_batches/<uri with / replaced by _>.json`, not the glb), concurrency 6, 4 retries with
back-off. For every batch id: EGID, lat/lon → LV95 (`wgs84ToLv95` in `js/swiss-projection.js`), OBJEKTART, heights.
Link each building to its footprint: the footprint containing its LV95 point (`Latitude`/`Longitude`; it lies on the
building), else by EGID when the batch table has one, else the nearest footprint within 5 m, else none.

### 3. Wall colours (tools/sample-photomesh-facades.mjs `--canton`) — the long part, ~10-15 hours

Add a `--canton` mode to `tools/sample-photomesh-facades.mjs` (keep the existing modes working unchanged):
- the photomesh tiles intersecting the canton outline (`data/geneva-canton-boundary.json`, LV95 rings);
- every wall triangle is assigned to the **cadastral footprint** (step 1) containing its centroid, buffered by
  ~1.5 m (instead of the OSM footprints of `js/geneva-geodata.js`, which only cover the city centre);
- same per-building measures as today (`rgb`, `win`, `ground`, `rough`, `n`), keyed by **EGID** (or a footprint id
  when it has no EGID);
- stream: download → measure → delete each tile; never keep more than a few tiles on disk (the disk has ~60 GB free;
  the whole set is ~200 GB). Resumable: progress in `tools/data/cache/canton_facade_samples.state.json`, results
  appended to `tools/data/cache/canton_facade_samples.json` (flush every ~50 tiles), so a restart continues where it
  stopped. Concurrency 3-4, retries with back-off, log progress (`n/31601`, ETA) to
  `tools/data/cache/canton_facades.log`.
- It runs inside `tools/run-canton-facades.sh` (above); if it dies, re-running the script resumes it.

### 4. Facades (tools/build-geneva-canton-facades.mjs, second part) — minutes

Per building, like `tools/build-geneva-facades.mjs` does for the city (reuse its `styleOf`, `PERIOD`,
`DEFAULT_STOREY`; move shared code into a small module rather than copying if it stays simple):
- style from the RegBL (year/period/class, by EGID) or the cadastre's `EPOQUE_CONSTRUCTION`/`ANNEE_CONSTRUCTION`;
  `inconnu` when nothing is known; the Vieille-Ville rule does not apply outside the city;
- storey height: building height / storeys (cadastre `HAUTEUR`/`NIVEAUX_HORSOL` or RegBL `GASTW`), clamped to
  2.7-4.5 m, else the style's default;
- a measured building (step 3, `n` above a minimum) keeps its own colour and window/shop/texture measures; the
  others take the archetype most common among the measured buildings most like them (style, year, storeys, and
  nearby: same commune / within ~500 m), with the archetype's colour slightly varied (as the city tool does);
- write `data/geneva-canton-facades.json` (the contract above). Run it once **before** step 3 finishes too (with the
  samples so far, or none): the file must be valid at every stage.

### 5. Checks — add `tests/canton-facades.test.mjs`

- every tile uri of `data/geneva-canton-buildings.json` has an entry in `tiles`; entry counts equal batch lengths
  (check against the cached batch tables when present, else a sample of 50 tiles);
- every entry parses: style in range, storey 27-45 dm, archetype in range or -1, valid hex, w/p/t in [0, 1];
- the share of buildings with a measured colour, with a known style, logged in `source`;
- `npm test` passes (all existing tests too).

## Rules

- Do not modify anything under `js/`, `css/`, `index.html`, or the existing data files other than adding
  `data/geneva-canton-facades.json`. Tools and tests only. `js/canton.js` already consumes the output.
- Big caches stay in `tools/data/cache/` (git-ignored). Never commit downloaded tiles or caches.
- Code style: match the existing tools (ES modules, header comment explaining sources/outputs/usage, `log()` helper,
  English comments).
- Commit on the `canton-facades` branch, small commits with clear messages (what and why). Do not push, do not merge.
- If a source is unreachable or its format differs from this plan, adapt sensibly and write down what you did in
  `docs/plans/canton-facades.log.md` (decisions, numbers, problems). Do not silently skip a step.
- Before ending your session, write in `docs/plans/canton-facades.log.md`: what you built, the sample results (how
  many buildings matched a footprint, measured colours on the sample), the expected run time, how to check progress
  (`tail tools/data/cache/canton_facades.log`) and how to resume (`bash tools/run-canton-facades.sh`).
