// tools/build-geneva-canton.mjs — the canton around the mapped city, for js/canton.js and js/surroundings.js:
//  - data/geneva-canton-ortho.jpg (+ .json): a SWISSIMAGE mosaic over the surroundings' mid ring (±12.1 km around the
//    frame: the whole canton, the Petit-Lac, the Salève's foot), from swisstopo's WMTS at 5 m, resampled to 4096 px
//    (~5.9 m per pixel). The relief beyond the city wears it.
//  - data/geneva-canton-buildings.json: the swissBUILDINGS3D 3.0 3D Tiles leaves over the same ring outside the frame
//    ([uri, x, z] with the tile centres in world coordinates). The browser streams them from 3d.geo.admin.ch around
//    the camera (CORS open), nothing is stored here.
// usage: node tools/build-geneva-canton.mjs [--ortho] [--buildings]   (both by default)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { FRAME, lonLatToWorld } from '../js/geneva-frame.js';
import { lv95ToWgs84 } from '../js/swiss-projection.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, '..', 'data');
const CACHE = path.join(DIR, 'data', 'cache', 'canton');
const log = (...a) => console.log('[geneva-canton]', ...a);
const args = process.argv.slice(2);
const all = !args.includes('--ortho') && !args.includes('--buildings');
fs.mkdirSync(CACHE, { recursive: true });

// The mid ring of tools/build-geneva-surroundings.mjs
const HALF = 12100;
const cx = (FRAME.lv95[0] + FRAME.lv95[2]) / 2, cy = (FRAME.lv95[1] + FRAME.lv95[3]) / 2;
const BOX = [cx - HALF, cy - HALF, cx + HALF, cy + HALF]; // LV95 minE, minN, maxE, maxN

async function fetchRetry(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'slop-geneva data tools' } }).catch((error) => ({ ok: false, status: error.message }));
    if (res.ok) return res;
    if (attempt === 4) throw new Error(`${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
}
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) await fn(items[next++]); }));
}

// --- Orthophoto mosaic --------------------------------------------------------------------------------------------------------
if (all || args.includes('--ortho')) {
  const LEVEL = 21, RES = 5, TILE = 256, ORIGIN = [2420000, 1350000];
  const span = TILE * RES;
  const c0 = Math.floor((BOX[0] - ORIGIN[0]) / span), c1 = Math.floor((BOX[2] - ORIGIN[0]) / span);
  const r0 = Math.floor((ORIGIN[1] - BOX[3]) / span), r1 = Math.floor((ORIGIN[1] - BOX[1]) / span);
  const W = Math.round((BOX[2] - BOX[0]) / RES), H = Math.round((BOX[3] - BOX[1]) / RES);
  const mosaic = new Uint8Array(W * H * 3);
  const jobs = [];
  for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) jobs.push([c, r]);
  log(`${jobs.length} SWISSIMAGE tiles at ${RES} m`);
  let done = 0;
  await pool(jobs, 8, async ([c, r]) => {
    const file = path.join(CACHE, `${LEVEL}_${c}_${r}.jpeg`);
    if (!fs.existsSync(file)) {
      const res = await fetchRetry(`https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/2056/${LEVEL}/${c}/${r}.jpeg`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    const img = jpeg.decode(fs.readFileSync(file), { useTArray: true });
    // tile pixel (i, j) covers E = ORIGIN + (c * TILE + i) * RES, N = ORIGIN - (r * TILE + j) * RES
    for (let j = 0; j < img.height; j++) {
      const y = Math.round((BOX[3] - (ORIGIN[1] - (r * TILE + j) * RES)) / RES);
      if (y < 0 || y >= H) continue;
      for (let i = 0; i < img.width; i++) {
        const x = Math.round((ORIGIN[0] + (c * TILE + i) * RES - BOX[0]) / RES);
        if (x < 0 || x >= W) continue;
        const o = (j * img.width + i) * 4, p = (y * W + x) * 3;
        mosaic[p] = img.data[o]; mosaic[p + 1] = img.data[o + 1]; mosaic[p + 2] = img.data[o + 2];
      }
    }
    if (++done % 50 === 0) log(`  ${done}/${jobs.length}`);
  });
  // Box-filtered down to OUT px
  const OUT = 4096;
  const out = new Uint8Array(OUT * OUT * 4);
  const f = W / OUT;
  for (let y = 0; y < OUT; y++) for (let x = 0; x < OUT; x++) {
    let R = 0, G = 0, B = 0, n = 0;
    for (let yy = Math.floor(y * f); yy < Math.min(H, Math.ceil((y + 1) * f)); yy++) {
      for (let xx = Math.floor(x * f); xx < Math.min(W, Math.ceil((x + 1) * f)); xx++) {
        const p = (yy * W + xx) * 3;
        R += mosaic[p]; G += mosaic[p + 1]; B += mosaic[p + 2]; n++;
      }
    }
    const o = (y * OUT + x) * 4;
    out[o] = R / n; out[o + 1] = G / n; out[o + 2] = B / n; out[o + 3] = 255;
  }
  fs.writeFileSync(path.join(DATA, 'geneva-canton-ortho.jpg'), jpeg.encode({ data: out, width: OUT, height: OUT }, 84).data);
  fs.writeFileSync(path.join(DATA, 'geneva-canton-ortho.json'), JSON.stringify({
    source: 'swisstopo SWISSIMAGE (WMTS, 5 m), resampled', lv95: BOX, size: OUT, metresPerPixel: (BOX[2] - BOX[0]) / OUT,
    // world bounds [minX, minZ, maxX, maxZ]
    bounds: [BOX[0] - FRAME.E0, FRAME.N0 - BOX[3], BOX[2] - FRAME.E0, FRAME.N0 - BOX[1]]
  }));
  log(`wrote data/geneva-canton-ortho.jpg (${(fs.statSync(path.join(DATA, 'geneva-canton-ortho.jpg')).size / 1048576).toFixed(1)} MB)`);
}

// --- swissBUILDINGS3D tiles over the ring ----------------------------------------------------------------------------------
if (all || args.includes('--buildings')) {
  const ROOT = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json';
  const getJson = async (url) => (await fetchRetry(url)).json();
  const deg = (r) => (r * 180) / Math.PI;
  const corners = [[BOX[0], BOX[1]], [BOX[2], BOX[1]], [BOX[0], BOX[3]], [BOX[2], BOX[3]]].map(([e, n]) => lv95ToWgs84(e, n));
  const W = Math.min(...corners.map((c) => c.lon)), E = Math.max(...corners.map((c) => c.lon));
  const S = Math.min(...corners.map((c) => c.lat)), N = Math.max(...corners.map((c) => c.lat));
  const overlaps = (r) => deg(r[2]) >= W && deg(r[0]) <= E && deg(r[3]) >= S && deg(r[1]) <= N;
  const releases = [];
  (function collect(node) {
    if (node.content?.uri) releases.push(node.content.uri);
    for (const c of node.children || []) collect(c);
  })((await getJson(ROOT)).root);
  const release = releases.sort().at(-1);
  const base = new URL(release, ROOT).href;
  const releaseDir = new URL('.', base).href;
  // The frame's own tiles are stored in data/swissbuildings3d/: left out here
  const stored = new Set(JSON.parse(fs.readFileSync(path.join(DATA, 'swissbuildings3d', 'index.json'), 'utf8')).tiles.map((t) => t.u));
  const tiles = [];
  async function visit(node, url) {
    const region = node.boundingVolume?.region;
    if (!region || !overlaps(region)) return;
    const uri = node.content?.uri;
    if (uri?.endsWith('.json')) {
      const sub = new URL(uri, url).href;
      await visit((await getJson(sub)).root, sub);
    } else if (uri) {
      const u = new URL(uri, url).href.slice(releaseDir.length);
      const c = lonLatToWorld(deg((region[0] + region[2]) / 2), deg((region[1] + region[3]) / 2));
      if (!stored.has(u)) tiles.push([u, Math.round(c.x), Math.round(c.z)]);
    }
    await Promise.all((node.children || []).map((c) => visit(c, url)));
  }
  await visit((await getJson(base)).root, base);
  tiles.sort((a, b) => a[0].localeCompare(b[0]));
  fs.writeFileSync(path.join(DATA, 'geneva-canton-buildings.json'), JSON.stringify({
    source: 'swisstopo swissBUILDINGS3D 3.0 (3D Tiles), streamed by the browser', origin: releaseDir, release: release.split('/')[0],
    fetched: new Date().toISOString().slice(0, 10), tiles
  }));
  log(`${tiles.length} swissBUILDINGS3D tiles around the frame (release ${release.split('/')[0]})`);
}
