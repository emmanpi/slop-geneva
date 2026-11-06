// tools/build-canton-layers.mjs — the canton's ground layers as 1 km LV95 tiles, for the browser to stream beyond the
// city frame (see docs/plans/canton-layers.md). Data only: this tool runs the generalised per-layer tools over each
// kilometre square that intersects the area's outline, writes data/canton/<E>-<N>/... and data/canton/index.json.
//
// usage:
//   node tools/build-canton-layers.mjs --area 6640          Phase A: the commune of Thônex (BFS 6640)
//   node tools/build-canton-layers.mjs --canton             Phase B: the whole canton (data/geneva-canton-boundary.json)
//   --only terrain,ortho,roadway,roadmarks,trees            build only these layers (default: all five)
//   --limit N                                               build at most N tiles (for testing)
//
// Resumable: a tile whose layers are all written leaves a tools/data/cache/canton/<E>-<N>/done marker; re-running skips
// it. Concurrency 3 tiles, every child process retried with back-off; progress and ETA go to
// tools/data/cache/canton_layers.log. data/canton/index.json is rewritten after every 10 tiles (and at the end).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FRAME, lv95ToWorld } from '../js/geneva-frame.js';
import { phenoClass } from '../js/phenology.js';
import { DIR, CACHE, parseExtent } from './args.mjs';
import { clipRing } from './osm-geometry.mjs';

const REPO = path.join(DIR, '..');
const DATA = path.join(REPO, 'data');
const OUT = path.join(DATA, 'canton');
const LOG = path.join(CACHE, 'canton_layers.log');
const TILE = 1000; // m, one LV95 kilometre square
const FETCH_MARGIN = 100; // m around a tile for the SITG / tree fetches
const CONCURRENCY = 3;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const bfs = value('--area');
const canton = flag('--canton');
const only = value('--only')?.split(',').filter(Boolean) ?? ['terrain', 'ortho', 'roadway', 'roadmarks', 'trees'];
const limit = value('--limit') != null ? parseInt(value('--limit'), 10) : Infinity;
if (!bfs && !canton) { console.error('usage: node tools/build-canton-layers.mjs --area <bfs> | --canton [--only ...] [--limit N]'); process.exit(1); }

fs.mkdirSync(CACHE, { recursive: true });
const logStream = fs.createWriteStream(LOG, { flags: 'a' });
const log = (...a) => { const s = a.join(' '); process.stdout.write(s + '\n'); logStream.write(s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- The area outline (LV95 rings, first point not repeated) -----------------------------------------------------------
const rings = [];
let area = null;
if (bfs) {
  const url = `https://api3.geo.admin.ch/rest/services/api/MapServer/ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill/${bfs}?geometryFormat=geojson&sr=2056`;
  const res = await (await fetch(url)).json();
  const f = res.feature ?? res.features?.[0];
  if (!f) throw new Error(`no commune ${bfs}: ${JSON.stringify(res).slice(0, 200)}`);
  area = { bfs: +bfs, name: f.properties?.gemname || f.properties?.label || String(bfs) };
  const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  for (const poly of polys) rings.push(poly[0].slice(0, -1)); // outer ring only, opened
} else {
  const boundary = JSON.parse(fs.readFileSync(path.join(DATA, 'geneva-canton-boundary.json'), 'utf8'));
  rings.push(...boundary.lv95.map((r) => (JSON.stringify(r[0]) === JSON.stringify(r.at(-1)) ? r.slice(0, -1) : r)));
}
const bbox = rings.flat().reduce((b, [e, n]) => [Math.min(b[0], e), Math.min(b[1], n), Math.max(b[2], e), Math.max(b[3], n)], [Infinity, Infinity, -Infinity, -Infinity]);

// --- The tiles ----------------------------------------------------------------------------------------------------------
const inFrame = (e, n) => e >= FRAME.lv95[0] && e <= FRAME.lv95[2] && n >= FRAME.lv95[1] && n <= FRAME.lv95[3];
const intersects = (e, n) => {
  const box = [e * TILE, n * TILE, (e + 1) * TILE, (n + 1) * TILE];
  for (const ring of rings) {
    for (const [x, y] of ring) if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) return true;
    if (clipRing(ring, box).length >= 3) return true;
  }
  return false;
};
const tiles = [];
for (let e = Math.floor(bbox[0] / TILE); e <= Math.floor(bbox[2] / TILE); e++) {
  for (let n = Math.floor(bbox[1] / TILE); n <= Math.floor(bbox[3] / TILE); n++) {
    if (!intersects(e, n)) continue;
    // tiles entirely inside the city frame are skipped: the city has its own files
    if (inFrame(e * TILE, n * TILE) && inFrame((e + 1) * TILE, (n + 1) * TILE)) continue;
    tiles.push([e, n]);
  }
}
tiles.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const build = tiles.slice(0, limit);
log(`[canton-layers] ${area ? `commune ${area.name} (BFS ${area.bfs})` : 'whole canton'}: ${tiles.length} tiles intersecting the outline, building ${build.length} (layers: ${only.join(',')})`);

// --- Child process helper -----------------------------------------------------------------------------------------------
function run(tool, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(DIR, tool), ...args], { cwd: REPO, env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; logStream.write(d); });
    child.stderr.on('data', (d) => { out += d; logStream.write(d); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${tool} exited ${code}`))));
  });
}
async function runRetry(tool, args, attempts = 3) {
  for (let i = 1; ; i++) {
    try { return await run(tool, args); } catch (error) {
      if (i === attempts) throw error;
      log(`[canton-layers] retry ${i}/${attempts - 1} ${tool}: ${error.message}`);
      await sleep(i * 2000);
    }
  }
}

// --- The tree transform (exactly the fields of GENEVA_DATA.trees, see tools/build-geneva-geodata.mjs) -------------------
const STREET = /^(Bords de voie|Trottoir\/Zone piétonnière|Place|Parking)$/;
const r1 = (v) => Math.round(v * 10) / 10;
const year = new Date().getFullYear();
function treesFor(tileDir, suffix, e, n) {
  const src = path.join(CACHE, suffix, 'geneva_trees.json');
  if (!fs.existsSync(src)) return [];
  const [x0, x1, z0, z1] = [e * TILE - FRAME.E0, (e + 1) * TILE - FRAME.E0, FRAME.N0 - (n + 1) * TILE, FRAME.N0 - n * TILE];
  return JSON.parse(fs.readFileSync(src, 'utf8')).trees.map((g) => {
    const { x, z } = lv95ToWorld(g.E, g.N);
    const h = g.height ? Math.min(40, Math.max(3, g.height)) : g.crown ? Math.min(30, 3 + g.crown * 1.3) : g.planted ? Math.min(24, 4 + (year - g.planted) * 0.4) : 10;
    return { x: r1(x), z: r1(z), h: r1(h), crown: g.crown ?? null, street: STREET.test(g.situation || ''), g: phenoClass(g.genus) };
  }).filter((t) => t.x >= x0 && t.x < x1 && t.z >= z0 && t.z < z1);
}

// --- One tile -----------------------------------------------------------------------------------------------------------
async function buildTile(e, n) {
  const key = `${e}-${n}`;
  const done = path.join(CACHE, 'canton', key, 'done');
  if (fs.existsSync(done)) return null;
  const tileDir = path.join(OUT, key);
  fs.mkdirSync(tileDir, { recursive: true });
  const suffix = `canton/${key}`;
  const extent = `${e * TILE},${n * TILE},${(e + 1) * TILE},${(n + 1) * TILE}`;
  const fetchExtent = `${e * TILE - FETCH_MARGIN},${n * TILE - FETCH_MARGIN},${(e + 1) * TILE + FETCH_MARGIN},${(n + 1) * TILE + FETCH_MARGIN}`;

  if (only.includes('roadway') || only.includes('roadmarks')) {
    await runRetry('fetch-sitg-roadway.mjs', ['CAD_DOMROUTIER_OBJETS_NIV0', 'OTC_MARQUAGE_LIGNE', 'OTC_MARQUAGE_SURFACE', '--extent', fetchExtent, '--cache-suffix', suffix]);
  }
  if (only.includes('trees') || only.includes('ortho')) {
    await runRetry('fetch-geneva-trees.mjs', ['--extent', fetchExtent, '--cache-suffix', suffix]);
  }

  const tile = { layers: [], bytes: {}, trees: 0, orthoYear: null };

  if (only.includes('terrain')) {
    const out = path.join(tileDir, 'terrain.bin');
    await runRetry('build-geneva-terrain.mjs', ['--extent', extent, '--out', out]);
    tile.bytes.terrain = fs.statSync(out).size; tile.layers.push('terrain');
  }

  if (only.includes('ortho')) {
    const out = path.join(tileDir, 'ortho.jpg');
    await runRetry('build-geneva-ortho.mjs', ['--extent', extent, '--out', out, '--trees', path.join(CACHE, suffix, 'geneva_trees.json'), '--cache-suffix', suffix]);
    tile.bytes.ortho = fs.statSync(out).size; tile.layers.push('ortho');
    const meta = JSON.parse(fs.readFileSync(path.join(tileDir, 'ortho.json'), 'utf8'));
    tile.orthoYear = Object.values(meta.tiles ?? {})[0] ?? null;
  }

  if (only.includes('roadway')) {
    const out = path.join(tileDir, 'roadway.bin');
    await runRetry('build-geneva-roadway.mjs', ['--extent', extent, '--cache-suffix', suffix, '--out', out]);
    const h = new Int32Array(fs.readFileSync(out).buffer.slice(0, 40));
    if (h[2] === 0 && h[4] === 0) fs.rmSync(out); // nothing in the tile: absent from `layers`
    else { tile.bytes.roadway = fs.statSync(out).size; tile.layers.push('roadway'); }
  }

  if (only.includes('roadmarks')) {
    const out = path.join(tileDir, 'roadmarks.bin');
    await runRetry('build-geneva-roadmarks.mjs', ['--extent', extent, '--cache-suffix', suffix, '--out', out]);
    const h = new Int32Array(fs.readFileSync(out).buffer.slice(0, 24));
    if (h[4] === 0) fs.rmSync(out); // nothing in the tile
    else { tile.bytes.roadmarks = fs.statSync(out).size; tile.layers.push('roadmarks'); }
  }

  if (only.includes('trees')) {
    const list = treesFor(tileDir, suffix, e, n);
    if (list.length) {
      const out = path.join(tileDir, 'trees.json');
      fs.writeFileSync(out, JSON.stringify(list));
      tile.bytes.trees = fs.statSync(out).size; tile.trees = list.length; tile.layers.push('trees');
    }
  }

  fs.mkdirSync(path.dirname(done), { recursive: true });
  fs.writeFileSync(done, JSON.stringify({ done: new Date().toISOString() }));
  return tile;
}

// --- The run ------------------------------------------------------------------------------------------------------------
const index = { source: 'swisstopo swissALTI3D & SWISSIMAGE 10 cm; SITG (État de Genève) CAD_DOMROUTIER_OBJETS_NIV0, OTC_MARQUAGE_LIGNE/SURFACE, Inventaire cantonal des arbres isolés', fetched: new Date().toISOString().slice(0, 10), tileSize: TILE, tiles: {} };
if (area) index.area = area;
const tilesMap = {};
const started = Date.now();
let done = 0, skipped = 0;
const writeIndex = () => {
  index.tiles = Object.fromEntries(Object.entries(tilesMap).sort((a, b) => a[0].localeCompare(b[0])));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
};

await new Promise((resolve, reject) => {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, build.length || 1) }, async () => {
    while (next < build.length) {
      const [e, n] = build[next++];
      const key = `${e}-${n}`;
      try {
        const t = await buildTile(e, n);
        if (t === null) { skipped++; log(`[canton-layers] ${key} already done (skipped)`); }
        else { tilesMap[key] = t; done++; }
      } catch (error) {
        log(`[canton-layers] ${key} FAILED: ${error.stack || error.message}`);
      }
      const built = done + skipped, total = build.length;
      const elapsed = (Date.now() - started) / 1000;
      const eta = built ? ((elapsed / built) * (total - built)).toFixed(0) : '?';
      log(`[canton-layers] ${built}/${total} tiles (${done} built, ${skipped} skipped), ${elapsed.toFixed(0)}s elapsed, ETA ${eta}s`);
      if (done && done % 10 === 0) writeIndex();
    }
  });
  Promise.all(workers).then(resolve, reject);
});
writeIndex();

const size = Object.values(tilesMap).reduce((s, t) => s + Object.values(t.bytes).reduce((a, b) => a + b, 0), 0);
log(`[canton-layers] wrote ${Object.keys(tilesMap).length} tiles, ${(size / 1048576).toFixed(1)} MB total -> ${path.join('data', 'canton', 'index.json')}`);
log(`[canton-layers] DONE in ${((Date.now() - started) / 1000).toFixed(0)}s`);
