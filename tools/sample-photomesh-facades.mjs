// tools/sample-photomesh-facades.mjs — measures the real facades in the SITG photomesh (Photomaillage 3D 2019, État
// de Genève, open data): every wall triangle is matched to the OSM building footprint it belongs to
// (js/geneva-geodata.js) and its texture is sampled into per-building brightness histograms. Per building:
//   rgb     the wall's colour (sRGB 0-255): the mean colour between the 45th and 92nd brightness percentile (no
//           windows, no glare)
//   win     the share of dark samples (under 62% of the wall's brightness) on the upper storeys: the windows
//   ground  the ground floor's brightness against the storeys above (< 0.8: shop fronts, arcades, dark stone)
//   rough   the spread of the wall's brightness (smooth render .. stone, brick, patterned)
//   n       samples
// By default the tiles cached by tools/build-photomesh.mjs; with --all, every tile over the frame, each downloaded,
// measured and deleted (the whole frame: ~2,000 tiles, ~13 GB to download, about an hour; resumable).
// Output: tools/data/cache/facade_samples.json { "<osm building index>": { rgb, win, ground, rough, n } }, read by
// tools/build-geneva-facades.mjs (which groups them into facade archetypes for the whole city).
// usage: node tools/sample-photomesh-facades.mjs [--all]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { FRAME } from '../js/geneva-frame.js';
import { parseTerrain, gridHeight } from '../js/terrain-grid.js';
import { GENEVA_DATA } from '../js/geneva-geodata.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'data', 'cache', 'photomesh');
const OUT = path.join(DIR, 'data', 'cache', 'facade_samples.json');
const STATE = path.join(DIR, 'data', 'cache', 'facade_samples.state.json'); // --all: progress, to resume
const SERVICE = 'https://vector.sitg.ge.ch/arcgis/rest/services/Hosted/PHOTOMESH_2019/FeatureServer/0/query';
const ALL = process.argv.includes('--all');
const log = (...a) => console.log('[facade-samples]', ...a);
const terrainFile = fs.readFileSync(path.join(DIR, '..', 'data', 'geneva-terrain.bin'));
const TERRAIN = parseTerrain(terrainFile.buffer.slice(terrainFile.byteOffset, terrainFile.byteOffset + terrainFile.byteLength));

// --- Footprints on a grid ---------------------------------------------------------------------------------------------------
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
const footprintAt = (x, z) => (grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []).find((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && pip(b.ring, x, z));

// --- Per building histograms ------------------------------------------------------------------------------------------------
// [0..63] samples per brightness bin (all heights), [64..255] their r, g, b sums, [256..319] samples per bin on the
// upper storeys, [320] ground floor brightness sum, [321] its samples, [322] upper brightness sum, [323] its samples
const BINS = 64, SIZE = 324;
const acc = new Map(); // index -> Float64Array(SIZE)
const lumOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function add(index, r, g, b, above) {
  let h = acc.get(index);
  if (!h) acc.set(index, (h = new Float64Array(SIZE)));
  const L = lumOf(r, g, b), bin = Math.min(BINS - 1, Math.floor((L / 256) * BINS));
  h[bin]++; h[BINS + bin * 3] += r; h[BINS + bin * 3 + 1] += g; h[BINS + bin * 3 + 2] += b;
  if (above > 4.5) { h[256 + bin]++; h[322] += L; h[323]++; } else if (above <= 4) { h[320] += L; h[321]++; }
}

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
        if (!f) continue;
        matched++;
        const ground = gridHeight(TERRAIN, cx, cz);
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
          add(f.index, img.data[o], img.data[o + 1], img.data[o + 2], above);
        }
      }
    }
  }
}

function features() {
  const out = {};
  for (const [index, h] of acc) {
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
    out[index] = { rgb, win: r3(win), ground: r3(ground), rough: r3(rough), n };
  }
  return out;
}

// --- Tiles ------------------------------------------------------------------------------------------------------------------
async function allTiles() {
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

if (ALL) {
  const urls = await allTiles();
  // resume: the histograms and the tiles done so far
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: [], acc: {} };
  for (const [k, arr] of Object.entries(state.acc)) acc.set(+k, Float64Array.from(arr));
  const done = new Set(state.done);
  log(`${urls.length} tiles over the frame, ${done.size} done before`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photomesh-'));
  const save = () => {
    fs.writeFileSync(STATE, JSON.stringify({ done: [...done], acc: Object.fromEntries([...acc].map(([k, h]) => [k, Array.from(h, (x) => Math.round(x))])) }));
    fs.writeFileSync(OUT, JSON.stringify(features()));
  };
  let since = 0;
  const t0 = Date.now();
  // downloads run ahead (PARALLEL at once) while the tiles are measured one by one
  const PARALLEL = 6;
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
  const fill = () => { while (pending.length < PARALLEL && next < todo.length) pending.push(fetchTile(todo[next++])); };
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
    if (++since >= 20) {
      since = 0;
      save();
      const rate = (Date.now() - t0) / 1000 / Math.max(1, done.size - state.done.length);
      log(`${done.size}/${urls.length} tiles, ${acc.size} buildings, ~${Math.round(((urls.length - done.size) * rate) / 60)} min left`);
    }
  }
  save();
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  const tiles = fs.readdirSync(CACHE).filter((d) => /^\d{7}_\d{7}$/.test(d) && fs.existsSync(path.join(CACHE, d, `${d}.obj`)));
  log(`${tiles.length} cached photomesh tiles`);
  for (const name of tiles) sampleTile(path.join(CACHE, name), name);
  fs.writeFileSync(OUT, JSON.stringify(features()));
}
log(`${walls} wall triangles, ${matched} matched to a footprint; ${Object.keys(JSON.parse(fs.readFileSync(OUT, 'utf8'))).length} buildings measured -> ${OUT}`);
