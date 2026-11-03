// tools/sample-photomesh-facades.mjs — measures the real facades in the SITG photomesh tiles cached by
// tools/build-photomesh.mjs (tools/data/cache/photomesh/<tile>/: OBJ + JPEG): every wall triangle is matched to the OSM
// building footprint it belongs to (js/geneva-geodata.js), and its texture is sampled. Per building:
//   rgb     the wall's colour (sRGB 0-255): the median of the samples between the 45th and 92nd brightness percentile
//           (no windows, no glare)
//   win     the share of dark samples (under 62% of the wall's brightness) on the upper storeys: the windows
//   ground  the ground floor's brightness against the storeys above (< 0.8: shop fronts, arcades, dark stone)
//   n       samples
// Output: tools/data/cache/facade_samples.json { "<osm building index>": { rgb, win, ground, n } }, read by
// tools/build-geneva-facades.mjs (which groups them into facade archetypes for the whole city).
// usage: node tools/sample-photomesh-facades.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { FRAME } from '../js/geneva-frame.js';
import { parseTerrain, gridHeight } from '../js/terrain-grid.js';
import { GENEVA_DATA } from '../js/geneva-geodata.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'data', 'cache', 'photomesh');
const OUT = path.join(DIR, 'data', 'cache', 'facade_samples.json');
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

// --- Samples per building (a reservoir of at most MAX each) -------------------------------------------------------------
const MAX = 4000;
const samples = new Map(); // index -> { s: [[r, g, b, above]], seen }
let rngState = 20261103;
const rand = () => ((rngState = Math.imul(rngState ^ (rngState >>> 15), 2246822519) + 1) >>> 0) / 4294967296;
function keep(index, sample) {
  let e = samples.get(index);
  if (!e) samples.set(index, (e = { s: [], seen: 0 }));
  e.seen++;
  if (e.s.length < MAX) e.s.push(sample);
  else { const k = Math.floor(rand() * e.seen); if (k < MAX) e.s[k] = sample; }
}

const tiles = fs.readdirSync(CACHE).filter((d) => /^\d{7}_\d{7}$/.test(d) && fs.existsSync(path.join(CACHE, d, `${d}.obj`)));
log(`${tiles.length} cached photomesh tiles`);
let walls = 0, matched = 0;
for (const name of tiles) {
  const dir = path.join(CACHE, name);
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
        const cx = (a[0] + b[0] + cc[0]) / 3, cy = (a[1] + b[1] + cc[1]) / 3, cz = (a[2] + b[2] + cc[2]) / 3;
        // the building: either side of the wall, a metre in
        const hx = nx / Math.hypot(nx, nz), hz = nz / Math.hypot(nx, nz);
        const f = footprintAt(cx - hx * 1, cz - hz * 1) || footprintAt(cx + hx * 1, cz + hz * 1);
        if (!f) continue;
        matched++;
        const above = cy - gridHeight(TERRAIN, cx, cz);
        if (above < 0.3) continue;
        const ta = vt[A[1] - 1], tb = vt[B[1] - 1], tc = vt[C[1] - 1];
        if (!ta || !tb || !tc) continue;
        const area = nl / 2, k = Math.max(1, Math.min(10, Math.round(area / 1.5)));
        for (let s = 0; s < k; s++) {
          let p = rand(), q = rand();
          if (p + q > 1) { p = 1 - p; q = 1 - q; }
          const u = ta[0] + (tb[0] - ta[0]) * p + (tc[0] - ta[0]) * q, w = ta[1] + (tb[1] - ta[1]) * p + (tc[1] - ta[1]) * q;
          const px = Math.min(img.width - 1, Math.max(0, Math.round(u * (img.width - 1)))), py = Math.min(img.height - 1, Math.max(0, Math.round(w * (img.height - 1))));
          const o = (py * img.width + px) * 4;
          const y = a[1] + (b[1] - a[1]) * p + (cc[1] - a[1]) * q;
          keep(f.index, [img.data[o], img.data[o + 1], img.data[o + 2], y - gridHeight(TERRAIN, cx, cz)]);
        }
      }
    }
  }
  log(`${name}: ${samples.size} buildings so far`);
}

// --- Features ------------------------------------------------------------------------------------------------------------------
const lum = (s) => 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const out = {};
for (const [index, { s }] of samples) {
  if (s.length < 150) continue;
  const sorted = [...s].sort((p, q) => lum(p) - lum(q));
  const wallSet = sorted.slice(Math.floor(sorted.length * 0.45), Math.floor(sorted.length * 0.92));
  const rgb = [0, 1, 2].map((c) => Math.round(median(wallSet.map((p) => p[c]))));
  const wallL = lum(rgb) || 1;
  const upper = s.filter((p) => p[3] > 4.5);
  const groundS = s.filter((p) => p[3] <= 4);
  const win = upper.length ? upper.filter((p) => lum(p) < 0.62 * wallL).length / upper.length : 0.25;
  const mean = (a) => a.reduce((x, p) => x + lum(p), 0) / Math.max(1, a.length);
  const ground = groundS.length > 20 && upper.length > 20 ? mean(groundS) / Math.max(1, mean(upper)) : 1;
  out[index] = { rgb, win: Math.round(win * 1000) / 1000, ground: Math.round(ground * 1000) / 1000, n: s.length };
}
fs.writeFileSync(OUT, JSON.stringify(out));
log(`${walls} wall triangles, ${matched} matched to a footprint; ${Object.keys(out).length} buildings measured -> ${OUT}`);
