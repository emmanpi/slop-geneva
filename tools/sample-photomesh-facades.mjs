// tools/sample-photomesh-facades.mjs — measures the real facades in the SITG photomesh (Photomaillage 3D 2019, État
// de Genève, open data): every wall triangle is matched to the building footprint it belongs to and its texture is
// sampled into per-building brightness histograms. Per building:
//   rgb     the wall's colour (sRGB 0-255): the mean colour between the 45th and 92nd brightness percentile (no
//           windows, no glare)
//   win     the share of dark samples (under 62% of the wall's brightness) on the upper storeys: the windows
//   ground  the ground floor's brightness against the storeys above (< 0.8: shop fronts, arcades, dark stone)
//   rough   the spread of the wall's brightness (smooth render .. stone, brick, patterned)
//   n       samples
// Modes:
//   (default)            the tiles cached by tools/build-photomesh.mjs (the city centre), matched to the OSM footprints
//                        of js/geneva-geodata.js. Output: tools/data/cache/facade_samples.json.
//   --all                every photomesh tile over the frame (the city centre), each downloaded, measured and deleted;
//                        resumable. Output: tools/data/cache/facade_samples.json.
//   --canton [--area B]  every photomesh tile intersecting the canton outline (data/geneva-canton-boundary.json), or the
//                        commune B, matched to the cadastral footprints (tools/data/cache/canton_footprints.json, keyed by
//                        EGID or a footprint id). Streamed download→measure→delete, resumable. Output:
//                        tools/data/cache/canton_facade_samples.json, state canton_facade_samples.state.json, progress in
//                        tools/data/cache/canton_facades.log. This is the long step of the canton facade job.
// usage: node tools/sample-photomesh-facades.mjs [--all | --canton] [--area 6640] [--limit N]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { FRAME, lv95ToWorld } from '../js/geneva-frame.js';
import { parseTerrain, gridHeight } from '../js/terrain-grid.js';
import { GENEVA_DATA } from '../js/geneva-geodata.js';
import { fetchCommune, polyIntersectsRings, ringsBbox } from './lib/canton-area.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'data', 'cache', 'photomesh');
const SERVICE = 'https://vector.sitg.ge.ch/arcgis/rest/services/Hosted/PHOTOMESH_2019/FeatureServer/0/query';
const log = (...a) => console.log('[facade-samples]', ...a);
const args = process.argv.slice(2);
const ALL = args.includes('--all');
const CANTON = args.includes('--canton');
const area = args.includes('--area') ? +args[args.indexOf('--area') + 1] : null;
const limit = args.includes('--limit') ? +args[args.indexOf('--limit') + 1] : null;
const CITY_OUT = path.join(DIR, 'data', 'cache', 'facade_samples.json');
const CITY_STATE = path.join(DIR, 'data', 'cache', 'facade_samples.state.json');
const CANTON_OUT = path.join(DIR, 'data', 'cache', 'canton_facade_samples.json');
const CANTON_STATE = path.join(DIR, 'data', 'cache', 'canton_facade_samples.state.json');
const terrainFile = fs.readFileSync(path.join(DIR, '..', 'data', 'geneva-terrain.bin'));
const TERRAIN = parseTerrain(terrainFile.buffer.slice(terrainFile.byteOffset, terrainFile.byteOffset + terrainFile.byteLength));
// The ground the walls rise from: the city's terrain grid, or (--canton) the surroundings' mid ring (Thônex and the
// whole canton lie outside the city grid, so its edge height would be wrong there).
let GROUND = TERRAIN;
function useCantonGround() {
  const buf = fs.readFileSync(path.join(DIR, '..', 'data', 'geneva-surroundings.bin'));
  const cols = buf.readUInt16LE(4), rows = buf.readUInt16LE(6);
  GROUND = parseTerrain(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 24 + cols * rows * 2));
  log(`ground: the surroundings' mid ring (${cols}x${rows} @ ${GROUND.cell} m)`);
}

// --- Per building histograms (keyed by whatever footprintAt returns) ---------------------------------------------------------
// [0..63] samples per brightness bin (all heights), [64..255] their r, g, b sums, [256..319] samples per bin on the
// upper storeys, [320] ground floor brightness sum, [321] its samples, [322] upper brightness sum, [323] its samples
const BINS = 64, SIZE = 324;
const acc = new Map();
const lumOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function add(key, r, g, b, above) {
  key = String(key); // (the state restored on a resume has string keys: one histogram per building either way)
  let h = acc.get(key);
  if (!h) acc.set(key, (h = new Float64Array(SIZE)));
  const L = lumOf(r, g, b), bin = Math.min(BINS - 1, Math.floor((L / 256) * BINS));
  h[bin]++; h[BINS + bin * 3] += r; h[BINS + bin * 3 + 1] += g; h[BINS + bin * 3 + 2] += b;
  if (above > 4.5) { h[256 + bin]++; h[322] += L; h[323]++; } else if (above <= 4) { h[320] += L; h[321]++; }
}

let footprintAt = null; // (x, z) -> a building key, or null

let rngState = 20261103;
const rand = () => ((rngState = Math.imul(rngState ^ (rngState >>> 15), 2246822519) + 1) >>> 0) / 4294967296;
let walls = 0, matched = 0;
function sampleTile(dir, name) {
  const mtl = fs.readFileSync(path.join(dir, `${name}.mtl`), 'utf8');
  const img = jpeg.decode(fs.readFileSync(path.join(dir, /map_Kd\s+(.+)/.exec(mtl)[1].trim().replace(/\\/g, '/'))), { useTArray: true, maxMemoryUsageInMB: 2048 });
  const v = [], vt = [];
  for (const line of fs.readFileSync(path.join(dir, `${name}.obj`), 'utf8').split('\n')) {
    if (line.startsWith('v ')) { const p = line.split(/\s+/); v.push([+p[1] - FRAME.E0, +p[3] - FRAME.H0, FRAME.N0 - +p[2]]); }
    else if (line.startsWith('vt ')) { const p = line.split(/\s+/); vt.push([+p[1], 1 - +p[2]]); }
    else if (line.startsWith('f ')) {
      const c = line.trim().split(/\s+/).slice(1).map((s) => s.split('/').map(Number));
      for (let i = 1; i + 1 < c.length; i++) {
        const [A, B, C] = [c[0], c[i], c[i + 1]];
        const a = v[A[0] - 1], b = v[B[0] - 1], cc = v[C[0] - 1];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = cc[0] - a[0], wy = cc[1] - a[1], wz = cc[2] - a[2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, nl = Math.hypot(nx, ny, nz);
        if (!nl || Math.abs(ny) > 0.3 * nl) continue; // walls only
        walls++;
        const cx = (a[0] + b[0] + cc[0]) / 3, cz = (a[2] + b[2] + cc[2]) / 3;
        // the building: either side of the wall, a metre in
        const hx = nx / Math.hypot(nx, nz), hz = nz / Math.hypot(nx, nz);
        const f = footprintAt(cx - hx, cz - hz) || footprintAt(cx + hx, cz + hz);
        if (f == null) continue;
        matched++;
        const ground = gridHeight(GROUND, cx, cz);
        const ta = vt[A[1] - 1], tb = vt[B[1] - 1], tc = vt[C[1] - 1];
        if (!ta || !tb || !tc) continue;
        const k = Math.max(1, Math.min(10, Math.round(nl / 3)));
        for (let s = 0; s < k; s++) {
          let p = rand(), q = rand();
          if (p + q > 1) { p = 1 - p; q = 1 - q; }
          const above = a[1] + (b[1] - a[1]) * p + (cc[1] - a[1]) * q - ground;
          if (above < 0.3) continue;
          const u = ta[0] + (tb[0] - ta[0]) * p + (tc[0] - ta[0]) * q, w = ta[1] + (tb[1] - ta[1]) * p + (tc[1] - ta[1]) * q;
          const px = Math.min(img.width - 1, Math.max(0, Math.round(u * (img.width - 1)))), py = Math.min(img.height - 1, Math.max(0, Math.round(w * (img.height - 1))));
          const o = (py * img.width + px) * 4;
          add(f, img.data[o], img.data[o + 1], img.data[o + 2], above);
        }
      }
    }
  }
}

function features() {
  const out = {};
  for (const [key, h] of acc) {
    const n = h.slice(0, BINS).reduce((a, b) => a + b, 0);
    if (n < 150) continue;
    // the wall: the bins between the 45th and 92nd percentile
    let cum = 0, r = 0, g = 0, b = 0, m = 0, l1 = 0, l2 = 0;
    for (let i = 0; i < BINS; i++) {
      const lo = cum / n, hi = (cum + h[i]) / n;
      cum += h[i];
      const share = Math.max(0, Math.min(hi, 0.92) - Math.max(lo, 0.45)) / Math.max(1e-9, hi - lo);
      if (share <= 0 || !h[i]) continue;
      const w = share; // the part of the bin inside the band
      r += h[BINS + i * 3] * w; g += h[BINS + i * 3 + 1] * w; b += h[BINS + i * 3 + 2] * w; m += h[i] * w;
      const L = ((i + 0.5) / BINS) * 256;
      l1 += L * h[i] * w; l2 += L * L * h[i] * w;
    }
    const rgb = [r / m, g / m, b / m].map(Math.round);
    const wallL = lumOf(...rgb) || 1;
    const meanL = l1 / m, rough = Math.sqrt(Math.max(0, l2 / m - meanL * meanL)) / wallL;
    let upperN = 0, dark = 0;
    for (let i = 0; i < BINS; i++) { upperN += h[256 + i]; if (((i + 0.5) / BINS) * 256 < 0.62 * wallL) dark += h[256 + i]; }
    const win = upperN ? dark / upperN : 0.25;
    const ground = h[321] > 20 && h[323] > 20 ? (h[320] / h[321]) / Math.max(1, h[322] / h[323]) : 1;
    const r3 = (x) => Math.round(x * 1000) / 1000;
    out[key] = { rgb, win: r3(win), ground: r3(ground), rough: r3(rough), n };
  }
  return out;
}

// --- City footprints (OSM, world coordinates), keyed by their index in js/geneva-geodata.js ----------------------------------
function useCityFootprints() {
  const CELL = 20, grid = new Map();
  GENEVA_DATA.buildings.forEach((b, index) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < b.ring.length; i += 2) { x0 = Math.min(x0, b.ring[i]); x1 = Math.max(x1, b.ring[i]); z0 = Math.min(z0, b.ring[i + 1]); z1 = Math.max(z1, b.ring[i + 1]); }
    const item = { index, ring: b.ring, x0, x1, z0, z1 };
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      const k = `${i},${j}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(item);
    }
  });
  const pip = (r, x, z) => { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { if ((r[i + 1] > z) !== (r[j + 1] > z) && x < ((r[j] - r[i]) * (z - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c; } return c; };
  footprintAt = (x, z) => {
    const b = (grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []).find((q) => x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1 && pip(q.ring, x, z));
    return b ? b.index : null;
  };
}

// --- Canton footprints (cadastre, LV95 -> world), keyed by EGID or "none:<index>", buffered ~1.5 m ---------------------------
function useCantonFootprints() {
  const footprints = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'cache', 'canton_footprints.json'), 'utf8'));
  const CELL = 20, grid = new Map();
  footprints.forEach((fp, index) => {
    const key = fp.egid != null ? fp.egid : `none:${index}`;
    const ring = fp.ring.map(([e, n]) => { const p = lv95ToWorld(e, n); return [p.x, p.z]; });
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const item = { key, ring, x0: x0 - 1.5, x1: x1 + 1.5, z0: z0 - 1.5, z1: z1 + 1.5 };
    for (let i = Math.floor(item.x0 / CELL); i <= Math.floor(item.x1 / CELL); i++) for (let j = Math.floor(item.z0 / CELL); j <= Math.floor(item.z1 / CELL); j++) {
      const k = `${i},${j}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(item);
    }
  });
  // inside the ring, or within ~1.5 m of its boundary (walls sit just outside the cadastral footprint)
  const inOrNear = (r, x, z, buf) => {
    let c = false, d = buf;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [ax, az] = r[i], [bx, bz] = r[j];
      if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      d = Math.min(d, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
    return c || d < buf;
  };
  footprintAt = (x, z) => {
    const b = (grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []).find((q) => x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1 && inOrNear(q.ring, x, z, 1.5));
    return b ? b.key : null;
  };
  log(`${footprints.length} cadastral footprints on the grid`);
}

// --- Tile listing -------------------------------------------------------------------------------------------------------------
async function cityTiles() {
  const [minE, minN, maxE, maxN] = FRAME.lv95;
  const urls = new Set();
  for (let offset = 0; ; offset += 1000) {
    const params = new URLSearchParams({
      where: '1=1', geometry: `${minE},${minN},${maxE},${maxN}`, geometryType: 'esriGeometryEnvelope', inSR: '2056',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'url_telechargement', returnGeometry: 'false', f: 'json',
      orderByFields: 'url_telechargement', resultOffset: String(offset), resultRecordCount: '1000'
    });
    const { features: fs2 } = await (await fetch(`${SERVICE}?${params}`)).json();
    for (const f of fs2) urls.add(f.attributes.url_telechargement);
    if (fs2.length < 1000) break;
  }
  return [...urls].sort();
}

async function cantonTiles() {
  let rings, label;
  if (area) { const c = await fetchCommune(area); rings = c.rings; label = `${c.name} (${c.bfs})`; }
  else { const b = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'data', 'geneva-canton-boundary.json'), 'utf8')); rings = b.lv95; label = 'the canton'; }
  const [minE, minN, maxE, maxN] = ringsBbox(rings, 200);
  const urls = [];
  for (let offset = 0; ; offset += 2000) {
    const params = new URLSearchParams({
      where: '1=1', geometry: `${minE},${minN},${maxE},${maxN}`, geometryType: 'esriGeometryEnvelope', inSR: '2056',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'url_telechargement', returnGeometry: 'true', outSR: '2056', f: 'json',
      resultOffset: String(offset), resultRecordCount: '2000'
    });
    const { features: fs2 } = await (await fetch(`${SERVICE}?${params}`)).json();
    for (const f of fs2) {
      const poly = f.geometry?.rings?.[0];
      if (poly && polyIntersectsRings(rings, poly)) urls.push(f.attributes.url_telechargement);
    }
    if ((fs2?.length ?? 0) < 2000) break;
  }
  const sorted = urls.sort();
  log(`${sorted.length} photomesh tiles over ${label}${limit ? ` (limited to ${limit})` : ''}`);
  return limit ? sorted.slice(0, limit) : sorted;
}

// --- Streaming: download -> measure -> delete, resumable ------------------------------------------------------------------------
async function stream(urls, { stateFile, outFile, parallel, flushEvery }) {
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { done: [], acc: {} };
  for (const [k, arr] of Object.entries(state.acc)) acc.set(k, Float64Array.from(arr));
  const done = new Set(state.done);
  log(`${urls.length} tiles, ${done.size} done before`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photomesh-'));
  const save = () => {
    fs.writeFileSync(stateFile, JSON.stringify({ done: [...done], acc: Object.fromEntries([...acc].map(([k, h]) => [k, Array.from(h, (x) => Math.round(x))])) }));
    fs.writeFileSync(outFile, JSON.stringify(features()));
  };
  let since = 0;
  const t0 = Date.now();
  const todo = urls.filter((u) => !done.has(path.basename(u, '.zip')));
  async function fetchTile(url) {
    const name = path.basename(url, '.zip');
    const cached = path.join(CACHE, name);
    if (fs.existsSync(path.join(cached, `${name}.obj`))) return { name, dir: cached, temp: false };
    let buf = null;
    for (let attempt = 1; attempt <= 4 && !buf; attempt++) {
      try { const res = await fetch(url); if (res.ok) buf = Buffer.from(await res.arrayBuffer()); } catch { /* retried */ }
      if (!buf) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    if (!buf) return { name, error: 'download failed' };
    const zip = path.join(tmp, `${name}.zip`), dir = path.join(tmp, name);
    fs.writeFileSync(zip, buf);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
    fs.rmSync(zip, { force: true });
    return { name, dir, temp: true };
  }
  const pending = [];
  let next = 0;
  const fill = () => { while (pending.length < parallel && next < todo.length) pending.push(fetchTile(todo[next++])); };
  fill();
  while (pending.length) {
    const job = await pending.shift();
    fill();
    try {
      if (job.error) { log(`${job.name}: ${job.error}, skipped`); continue; }
      sampleTile(job.dir, job.name);
      done.add(job.name);
    } catch (error) {
      log(`${job.name}: ${error.message}, skipped`);
    } finally {
      if (job.temp) fs.rmSync(job.dir, { recursive: true, force: true });
    }
    if (++since >= flushEvery) {
      since = 0;
      save();
      const rate = (Date.now() - t0) / 1000 / Math.max(1, done.size - state.done.length);
      log(`${done.size}/${urls.length} tiles, ${acc.size} buildings, ~${Math.round(((urls.length - done.size) * rate) / 60)} min left`);
    }
  }
  save();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Dispatch -------------------------------------------------------------------------------------------------------------------
if (CANTON) {
  useCantonFootprints();
  useCantonGround();
  const urls = await cantonTiles();
  await stream(urls, { stateFile: CANTON_STATE, outFile: CANTON_OUT, parallel: 4, flushEvery: 50 });
} else if (ALL) {
  useCityFootprints();
  await stream(await cityTiles(), { stateFile: CITY_STATE, outFile: CITY_OUT, parallel: 6, flushEvery: 20 });
} else {
  useCityFootprints();
  const tiles = fs.readdirSync(CACHE).filter((d) => /^\d{7}_\d{7}$/.test(d) && fs.existsSync(path.join(CACHE, d, `${d}.obj`)));
  log(`${tiles.length} cached photomesh tiles`);
  for (const name of tiles) sampleTile(path.join(CACHE, name), name);
  fs.writeFileSync(CITY_OUT, JSON.stringify(features()));
}
log(`${walls} wall triangles, ${matched} matched to a footprint; ${Object.keys(JSON.parse(fs.readFileSync(CANTON ? CANTON_OUT : CITY_OUT, 'utf8'))).length} buildings measured`);
