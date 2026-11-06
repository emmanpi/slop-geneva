// tools/build-geneva-canton-facades.mjs — writes data/geneva-canton-facades.json: a facade style, storey height,
// wall colour, share of windows, shop fronts and wall texture for every building of every tile in
// data/geneva-canton-buildings.json, so that js/canton.js draws the canton's buildings with real facades (it reads the
// file once it exists). Two steps, one file:
//   --batches  fetch every tile's b3dm, cache its feature + batch table JSON (tools/data/cache/canton_batches/), link
//              each batch id to its cadastral footprint (step 1: tools/data/cache/canton_footprints.json), and write
//              tools/data/cache/canton_buildings.json (the per-building inputs for --facades). Resumable.
//   --facades  read the linked buildings, the measured wall colours (tools/sample-photomesh-facades.mjs --canton) and
//              the RegBL (tools/data/cache/gwr/gebaeude_batiment_edificio.csv), and write data/geneva-canton-facades.json.
//              The 32 facade archetypes are the city's, reused unchanged (data/geneva-facades.json): a measured building
//              keeps its own colour/measures, the others take the archetype most common among the measured buildings most
//              like them (style, year, storeys, nearby). Runs with no samples too (every building then an archetype), so
//              the file is valid at every stage.
// Both steps take --area <BFS> (Phase A: a single commune, e.g. Thônex 6640) and --limit N (testing: a few tiles).
// usage: node tools/build-geneva-canton-facades.mjs --batches [--area 6640] [--limit N]
//        node tools/build-geneva-canton-facades.mjs --facades [--area 6640]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STYLES, S, PERIOD, DEFAULT_STOREY, styleOf } from './lib/facade-style.mjs';
import { fetchCommune, pointInRings, epochYear } from './lib/canton-area.mjs';
import { wgs84ToLv95 } from '../js/swiss-projection.js';
import { worldToLv95 } from '../js/geneva-frame.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const TILES_INDEX = path.join(ROOT, 'data', 'geneva-canton-buildings.json');
const CITY_FACADES = path.join(ROOT, 'data', 'geneva-facades.json');
const OUT = path.join(ROOT, 'data', 'geneva-canton-facades.json');
const BATCHES = path.join(DIR, 'data', 'cache', 'canton_batches');
const FOOTPRINTS = path.join(DIR, 'data', 'cache', 'canton_footprints.json');
const BUILDINGS = path.join(DIR, 'data', 'cache', 'canton_buildings.json');
const SAMPLES = path.join(DIR, 'data', 'cache', 'canton_facade_samples.json');
const GWR = path.join(DIR, 'data', 'cache', 'gwr', 'gebaeude_batiment_edificio.csv');
const CONCURRENCY = 6;
const log = (...a) => console.log('[canton-facades]', ...a);

const args = process.argv.slice(2);
const facades = args.includes('--facades');
const area = args.includes('--area') ? +args[args.indexOf('--area') + 1] : null;
const limit = args.includes('--limit') ? +args[args.indexOf('--limit') + 1] : null;

async function fetchRetry(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url).catch((error) => ({ ok: false, status: error.message }));
    if (res.ok) return res;
    if (attempt === 4) throw new Error(`${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
}
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) await fn(items[next++]); }));
}

// --- b3dm header: the feature table and the batch table JSON only (js/swissbuildings3d.js parseB3dm) -----------------------
function parseB3dmTables(buf) {
  if (buf.toString('ascii', 0, 4) !== 'b3dm') throw new Error('not a b3dm tile');
  const ftJson = buf.readUInt32LE(12), ftBin = buf.readUInt32LE(16), btJson = buf.readUInt32LE(20);
  const text = (s, l) => (l ? JSON.parse(buf.toString('utf8', s, s + l)) : {});
  return { featureTable: text(28, ftJson), batchTable: text(28 + ftJson + ftBin, btJson) };
}
const batchCache = (uri) => path.join(BATCHES, `${uri.replace(/\//g, '_')}.json`);

// --- The footprints on a 20 m grid (LV95), for point-in-polygon and nearest-within-5 m linking ----------------------------
function footprintIndex(footprints) {
  const CELL = 20, grid = new Map(), egidIndex = new Map();
  footprints.forEach((fp, index) => {
    if (fp.egid != null) egidIndex.set(fp.egid, index);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [e, n] of fp.ring) { x0 = Math.min(x0, e); x1 = Math.max(x1, e); y0 = Math.min(y0, n); y1 = Math.max(y1, n); }
    const item = { index, ring: fp.ring, x0, x1, y0, y1 };
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) {
      const k = `${i},${j}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(item);
    }
  });
  const pip = (r, E, N) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { if ((r[i][1] > N) !== (r[j][1] > N) && E < ((r[j][0] - r[i][0]) * (N - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; } return c; };
  const at = (E, N) => (grid.get(`${Math.floor(E / CELL)},${Math.floor(N / CELL)}`) || []).find((b) => E >= b.x0 && E <= b.x1 && N >= b.y0 && N <= b.y1 && pip(b.ring, E, N));
  const distTo = (b, E, N) => {
    let d = Infinity;
    for (let i = 0; i < b.ring.length; i++) {
      const [x, y] = b.ring[i], [x2, y2] = b.ring[(i + 1) % b.ring.length], dx = x2 - x, dy = y2 - y;
      const len = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((E - x) * dx + (N - y) * dy) / len));
      d = Math.min(d, Math.hypot(E - x - t * dx, N - y - t * dy));
    }
    return d;
  };
  const nearest = (E, N, max = 5) => {
    let best = null, d = max;
    for (let i = Math.floor((E - max) / CELL); i <= Math.floor((E + max) / CELL); i++) for (let j = Math.floor((N - max) / CELL); j <= Math.floor((N + max) / CELL); j++) {
      for (const b of grid.get(`${i},${j}`) || []) { const dd = distTo(b, E, N); if (dd < d) { d = dd; best = b; } }
    }
    return best;
  };
  return { at, nearest, egidIndex };
}

// --- Step 2: batch tables and the building -> footprint links --------------------------------------------------------------
async function batches() {
  const index = JSON.parse(fs.readFileSync(TILES_INDEX, 'utf8'));
  const footprints = JSON.parse(fs.readFileSync(FOOTPRINTS, 'utf8'));
  const commune = area ? await fetchCommune(area) : null;
  if (commune) log(`area: ${commune.name} (${commune.bfs})`);
  const idx = footprintIndex(footprints);

  const tiles = index.tiles.filter(([u, x, z]) => {
    if (!commune) return true;
    const { E, N } = worldToLv95(x, z);
    return pointInRings(commune.rings, E, N);
  });
  if (commune) log(`${tiles.length} of ${index.tiles.length} tiles have their centre in ${commune.name}`);
  if (limit) tiles.length = Math.min(tiles.length, limit);

  fs.mkdirSync(BATCHES, { recursive: true });
  let done = 0, linked = 0, total = 0;
  const records = {}; // uri -> [ [E, N, h, egid, fp, fpEgid, fpYear, fpNiveaux, fpHauteur], ... ] in batch id order
  await pool(tiles, CONCURRENCY, async ([u]) => {
    const file = batchCache(u);
    let ft, bt;
    if (fs.existsSync(file)) {
      ({ featureTable: ft, batchTable: bt } = JSON.parse(fs.readFileSync(file, 'utf8')));
    } else {
      const buf = Buffer.from(await (await fetchRetry(index.origin + u)).arrayBuffer());
      ({ featureTable: ft, batchTable: bt } = parseB3dmTables(buf));
      fs.writeFileSync(file, JSON.stringify({ featureTable: ft, batchTable: bt }));
    }
    const lat = bt.Latitude || [], lon = bt.Longitude || [], height = bt.Height || [], egid = bt.EGID || [];
    const n = ft.BATCH_LENGTH ?? lat.length;
    const list = [];
    for (let k = 0; k < n; k++) {
      const p = wgs84ToLv95(lon[k], lat[k]);
      const bEgid = egid[k] ?? null;
      let fp = idx.at(p.E, p.N)?.index ?? -1;
      if (fp < 0 && bEgid != null) fp = idx.egidIndex.get(bEgid) ?? -1;
      if (fp < 0) fp = idx.nearest(p.E, p.N, 5)?.index ?? -1;
      if (fp >= 0) linked++;
      const f = fp >= 0 ? footprints[fp] : null;
      list.push([Math.round(p.E * 100) / 100, Math.round(p.N * 100) / 100, height[k] ?? null, bEgid, fp, f?.egid ?? null, f ? (f.annee ?? epochYear(f.epoque)) : null, f?.niveaux ?? null, f?.hauteur ?? null]);
      total++;
    }
    records[u] = list;
    if (++done % 50 === 0) log(`  ${done}/${tiles.length} tiles`);
  });
  fs.writeFileSync(BUILDINGS, JSON.stringify({ area: commune ? { bfs: commune.bfs, name: commune.name } : null, origin: index.origin, tiles: records }));
  log(`${linked}/${total} buildings linked to a footprint; wrote ${BUILDINGS} (${tiles.length} tiles)`);
}

// --- Step 4: the facades -----------------------------------------------------------------------------------------------------
function facadesStep() {
  const buildings = JSON.parse(fs.readFileSync(BUILDINGS, 'utf8'));
  const areaInfo = buildings.area ?? null;
  const samples = fs.existsSync(SAMPLES) ? JSON.parse(fs.readFileSync(SAMPLES, 'utf8')) : {};
  const city = JSON.parse(fs.readFileSync(CITY_FACADES, 'utf8'));
  const archetypes = city.archetypes;

  // RegBL by EGID (year, period, storeys, class)
  const lines = fs.readFileSync(GWR, 'utf8').split('\n');
  const head = lines[0].split('\t');
  const col = (name) => head.indexOf(name);
  const C = { egid: col('EGID'), year: col('GBAUJ'), period: col('GBAUP'), floors: col('GASTW'), klass: col('GKLAS'), status: col('GSTAT') };
  const gwr = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split('\t');
    if (f[C.status] && f[C.status] !== '1004') continue;
    const egid = f[C.egid] ? +f[C.egid] : null;
    if (!egid) continue;
    gwr.set(egid, { year: f[C.year] ? +f[C.year] : null, period: f[C.period] ? +f[C.period] : null, floors: f[C.floors] ? +f[C.floors] : null, klass: f[C.klass] ? +f[C.klass] : null });
  }
  log(`${gwr.size} RegBL buildings`);

  // Per building: style, storey, year, floors, and its measured sample (own colour) or null
  const records = [];
  for (const [u, list] of Object.entries(buildings.tiles)) {
    for (let k = 0; k < list.length; k++) {
      const [E, N, h, bEgid, fp, fpEgid, fpYear, fpNiveaux, fpHauteur] = list[k];
      const identityEgid = bEgid ?? fpEgid;
      const g = gwr.get(identityEgid) ?? null;
      const year = g?.year ?? (g?.period ? PERIOD[g.period] : null) ?? fpYear;
      const floors = g?.floors ?? fpNiveaux ?? (h > 0 ? Math.round(h / DEFAULT_STOREY[0]) : null);
      const s = styleOf(g ?? (fpYear != null ? { year: fpYear, period: null, klass: null } : null));
      let storey = DEFAULT_STOREY[s];
      const levels = g?.floors ?? fpNiveaux;
      const hgt = (h > 4 ? h : 0) || fpHauteur || 0;
      if (levels && hgt) storey = Math.min(4.5, Math.max(2.7, hgt / levels));
      const sampleKey = fp >= 0 ? (fpEgid ?? `none:${fp}`) : null;
      const m = sampleKey != null ? samples[sampleKey] : null;
      records.push({ u, k, E, N, s, storey, year, floors, m: m && m.n >= 150 ? m : null });
    }
  }
  const measured = records.filter((r) => r.m);

  // White balance: the photos' walls stand half in shade under a blue sky (as the city tool)
  const med = (a) => { if (!a.length) return 1; const x = [...a].sort((p, q) => p - q); return x[Math.floor(x.length / 2)] || 1; };
  if (measured.length) {
    const gm = [0, 1, 2].map((c) => med(measured.map((r) => r.m.rgb[c])));
    const TARGET = [1.03, 1.0, 0.88], LIFT = 1.12;
    const gl = (gm[0] + gm[1] + gm[2]) / 3;
    const wb = gm.map((v, c) => (gl * TARGET[c]) / v);
    const balance = (rgb) => rgb.map((v, c) => Math.min(255, Math.round(v * wb[c] * LIFT)));
    for (const r of measured) r.rgb = balance(r.m.rgb);
    log(`white balance x[${wb.map((v) => v.toFixed(2)).join(', ')}] from the median wall [${gm.join(', ')}]`);
  }

  // Each measured building: the nearest city archetype by colour (Lab), for the others to vote on
  const toLab = ([r, g, b]) => {
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const R = lin(r), G = lin(g), B = lin(b);
    const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.9505, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.089;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  const archLab = archetypes.map((a) => toLab(a.rgb));
  const nearestArchetype = (rgb) => {
    const L = toLab(rgb);
    let best = 0, d = Infinity;
    for (let i = 0; i < archLab.length; i++) { const dd = (L[0] - archLab[i][0]) ** 2 + (L[1] - archLab[i][1]) ** 2 + (L[2] - archLab[i][2]) ** 2; if (dd < d) { d = dd; best = i; } }
    return best;
  };
  for (const r of measured) r.a = nearestArchetype(r.rgb);

  // Every other building: the archetype most common among the measured buildings most like it (style, year, storeys, nearby)
  const likeness = (a, b) => (a.s === b.s ? 0 : 9) + ((a.year ?? 1950) - (b.year ?? 1950)) ** 2 / 625 + ((a.floors ?? 5) - (b.floors ?? 5)) ** 2 / 4 + ((a.E - b.E) ** 2 + (a.N - b.N) ** 2) / 250000;
  const hashOf = (r) => { const v = Math.sin(r.E * 12.9898 + r.N * 78.233) * 43758.5453; return v - Math.floor(v); };
  for (const r of records) {
    if (r.m) continue;
    if (!measured.length) { r.a = 0; r.rgb = [200, 196, 186]; continue; }
    const near = measured.map((o) => ({ o, d: likeness(r, o) })).sort((p, q) => p.d - q.d).slice(0, 9);
    const votes = new Map();
    for (const { o, d } of near) votes.set(o.a, (votes.get(o.a) || 0) + 1 / (d + 0.5));
    r.a = [...votes].sort((p, q) => q[1] - p[1])[0][0];
    const j = 0.94 + hashOf(r) * 0.12;
    r.rgb = archetypes[r.a].rgb.map((v) => Math.min(255, Math.round(v * j)));
  }

  const hex = (rgb) => rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const r2 = (x) => Math.round(x * 100) / 100;
  const tiles = {};
  for (const r of records) {
    const at = archetypes[r.a] ?? archetypes[0];
    const win = r.m ? r.m.win : at.win, shop = r.m ? (r.m.ground < 0.8 ? 1 : 0) : at.shop, rough = r.m ? (r.m.rough ?? at.rough) : at.rough;
    const a = r.m ? -1 : r.a;
    (tiles[r.u] ||= []).push(`${r.s},${Math.round(r.storey * 10)},${a},${hex(r.rgb)},${r2(win)},${r2(shop)},${r2(rough)}`);
  }
  for (const u of Object.keys(tiles)) tiles[u] = tiles[u].join(';');

  const known = records.filter((r) => r.s !== S.inconnu).length;
  const source = `swisstopo swissBUILDINGS3D 3.0; SITG CAD_BATIMENT_HORSOL (cadastre); OFS RegBL; SITG Photomaillage 3D 2019 (facade archetypes, city's reused); ${measured.length} of ${records.length} buildings measured in the photomesh (${(measured.length / Math.max(1, records.length) * 100).toFixed(1)}%); ${known} of ${records.length} with a known style (${(known / Math.max(1, records.length) * 100).toFixed(1)}%)`;
  const out = { source, styles: STYLES, archetypes, fetched: new Date().toISOString().slice(0, 10), tiles };
  if (areaInfo) out.area = areaInfo;
  fs.writeFileSync(OUT, JSON.stringify(out));
  log(`${measured.length} of ${records.length} buildings measured, ${known} with a known style; wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}

if (facades) facadesStep(); else await batches();
