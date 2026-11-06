// tools/build-geneva-ortho.mjs — writes data/geneva-ortho.jpg: a SWISSIMAGE 10 cm orthophoto mosaic of the world frame at
// 1 m per pixel (4000 x 4800 px), the newest flight of each 1 km tile. Row 0 is the frame's north edge (z = minZ),
// column 0 its west edge (x = minX), so the browser samples it at uv = ((x - minX) / W, (z - minZ) / H)
// (js/orthophoto.js). Each tile's cloud-optimised GeoTIFF is read at its 0.4 m overview with HTTP range requests and
// box-filtered down to 1 m. A flight whose COG the server cannot read (a defective file) falls back to the tile's next
// newest flight; the year used is written to the .json sidecar.
// usage: node tools/build-geneva-ortho.mjs [--extent minE,minN,maxE,maxN] [--out out.jpg] [--trees trees.json]
//   [--cache-suffix dir] [--download]   (out.jpg as the last positional argument still works)
import fs from 'node:fs';
import path from 'node:path';
import { fromUrl } from 'geotiff';
import jpeg from 'jpeg-js';
import { FRAME } from '../js/geneva-frame.js';
import { lv95ToWgs84 } from '../js/swiss-projection.js';
import { DIR, parseArgs, parseExtent, cacheFile } from './args.mjs';

const args = parseArgs(process.argv.slice(2));
const extent = parseExtent(args.extent);
const OUT = args.out || args.positional[0] || path.join(DIR, '..', 'data', 'geneva-ortho.jpg');
const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissimage-dop10/items';
const RES = 1; // metres per output pixel
const OVERVIEW_RES = 0.4; // the COG overview read (0.1 m full resolution / 4)
const log = (...a) => console.log('[geneva-ortho]', ...a);

const [minE, minN, maxE, maxN] = extent ?? FRAME.lv95;
const W = Math.round((maxE - minE) / RES), H = Math.round((maxN - minN) / RES);

// --- Newest 10 cm tile of each square kilometre ----------------------------------------------------------------------------
const corners = [[minE, minN], [maxE, minN], [minE, maxN], [maxE, maxN]].map(([e, n]) => lv95ToWgs84(e, n));
const bbox = [
  Math.min(...corners.map((c) => c.lon)), Math.min(...corners.map((c) => c.lat)),
  Math.max(...corners.map((c) => c.lon)), Math.max(...corners.map((c) => c.lat))
].join(',');
const flights = new Map(); // key -> the tile's flights, newest first
for (let url = `${STAC}?bbox=${bbox}&limit=100`; url;) {
  const page = await (await fetch(url)).json();
  for (const f of page.features) {
    const m = /_(\d{4})_(\d{4})-(\d{4})$/.exec(f.id);
    if (!m) continue;
    const [, year, e, n] = m;
    if (+e * 1000 + 1000 <= minE || +e * 1000 >= maxE || +n * 1000 + 1000 <= minN || +n * 1000 >= maxN) continue;
    const asset = Object.values(f.assets).find((a) => /_0\.1_2056\.tif$/.test(a.href));
    const key = `${e}-${n}`;
    if (!asset) continue;
    const list = flights.get(key) ?? [];
    if (!list.some((c) => c.year === +year)) list.push({ year: +year, e: +e, n: +n, href: asset.href });
    flights.set(key, list.sort((a, b) => b.year - a.year));
  }
  url = page.links?.find((l) => l.rel === 'next')?.href;
}
log(`${flights.size} tiles:`, [...flights].map(([k, list]) => `${k}@${list[0].year}`).join(' '));
const years = new Map([...flights].map(([key, list]) => [key, list[0].year])); // the flight actually used, per tile

// --- Mosaic (cached raw in tools/data/cache/ortho_raw.rgba: the tree removal below can be re-run without downloading) ----
const RAW = cacheFile(args.cacheSuffix, 'ortho_raw.rgba');
const cached = fs.existsSync(RAW) && fs.statSync(RAW).size === W * H * 4 && !args.download;
const rgba = cached ? fs.readFileSync(RAW) : Buffer.alloc(W * H * 4, 0);
if (cached) log(`raw mosaic from ${RAW} (--download to fetch it again)`);
else {
for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
const k = Math.round(RES / OVERVIEW_RES * 10) / 10; // overview pixels per output pixel (2.5)
let done = 0;
for (const [key, list] of flights) {
  let used = null;
  for (const t of list) {
    for (let attempt = 1; ; attempt++) {
      try {
        const tiff = await fromUrl(t.href);
        const count = await tiff.getImageCount();
        let image = null;
        for (let i = 0; i < count; i++) {
          const im = await tiff.getImage(i);
          if (Math.abs(1000 / im.getWidth() - OVERVIEW_RES) < 0.01) { image = im; break; }
        }
        if (!image) throw new Error(`${t.href}: no ${OVERVIEW_RES} m overview`);
        const size = image.getWidth();
        const raster = await image.readRGB({ interleave: true }); // (JPEG-compressed in YCbCr: converted to RGB)
        const tileE = t.e * 1000, tileN = t.n * 1000;
        // Output pixels whose centre falls in this tile: box filter over the overview pixels they cover
        const c0 = Math.max(0, Math.ceil((tileE - minE) / RES - 0.5)), c1 = Math.min(W - 1, Math.floor((tileE + 1000 - minE) / RES - 0.5));
        const r0 = Math.max(0, Math.ceil((maxN - tileN - 1000) / RES - 0.5)), r1 = Math.min(H - 1, Math.floor((maxN - tileN) / RES - 0.5));
        for (let r = r0; r <= r1; r++) {
          const N = maxN - (r + 0.5) * RES;
          const v0 = (tileN + 1000 - N - RES / 2) / OVERVIEW_RES;
          for (let c = c0; c <= c1; c++) {
            const E = minE + (c + 0.5) * RES;
            const u0 = (E - RES / 2 - tileE) / OVERVIEW_RES;
            let sr = 0, sg = 0, sb = 0, n = 0;
            for (let y = Math.max(0, Math.floor(v0)); y < Math.min(size, Math.ceil(v0 + k)); y++) {
              for (let x = Math.max(0, Math.floor(u0)); x < Math.min(size, Math.ceil(u0 + k)); x++) {
                const p = (y * size + x) * 3;
                sr += raster[p]; sg += raster[p + 1]; sb += raster[p + 2]; n++;
              }
            }
            if (!n) continue;
            const o = (r * W + c) * 4;
            rgba[o] = sr / n; rgba[o + 1] = sg / n; rgba[o + 2] = sb / n;
          }
        }
        used = t;
        break;
      } catch (error) {
        if (attempt === 4) break;
        log(`retry ${t.e}-${t.n}@${t.year}: ${error.message}`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    if (used) break;
    log(`${key}@${t.year} unreadable after 4 attempts, trying an older flight`);
  }
  if (!used) throw new Error(`${key}: no readable SWISSIMAGE flight`);
  years.set(key, used.year);
  log(`${++done}/${flights.size} ${key}@${used.year}`);
}
fs.mkdirSync(path.dirname(RAW), { recursive: true });
fs.writeFileSync(RAW, rgba);
}

// --- Trees out of the photo ---------------------------------------------------------------------------------------------------
// The engine draws its own trees: their crowns in the photo would print green blots on the streets and squares under
// them. Every crown of the cantonal inventory (tools/fetch-geneva-trees.mjs, its surveyed diameter, a margin for the
// lean of the aerial view) is filled from the ground around it by push-pull interpolation: a mask-weighted image
// pyramid, then each level's holes blended from the coarser one.
const TREES = args.trees || path.join(DIR, 'data', 'cache', 'geneva_trees.json');
let removed = 0;
if (fs.existsSync(TREES)) {
  const weight = new Float32Array(W * H).fill(1);
  // The 2023 flight's shadows fall east-south-east of each crown (image x right = east, y down = south): the mask is a
  // capsule from the crown to its shadow, as long as half the crown (a few inventory crowns are outliers: capped)
  const SHADOW = [0.94, 0.34];
  for (const t of JSON.parse(fs.readFileSync(TREES, 'utf8')).trees) {
    const crown = Math.min(24, t.crown || 6);
    const r = (crown / 2) * 1.15 + 1.0, rp = r / RES, len = Math.max(2, crown * 0.55) / RES;
    const ax = (t.E - minE) / RES, ay = (maxN - t.N) / RES, bx = ax + SHADOW[0] * len, by = ay + SHADOW[1] * len;
    if (Math.max(ax, bx) < -rp || Math.max(ay, by) < -rp || Math.min(ax, bx) > W + rp || Math.min(ay, by) > H + rp) continue;
    removed++;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let y = Math.max(0, Math.floor(Math.min(ay, by) - rp)); y <= Math.min(H - 1, Math.ceil(Math.max(ay, by) + rp)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - rp)); x <= Math.min(W - 1, Math.ceil(Math.max(ax, bx) + rp)); x++) {
        const px = x + 0.5, py = y + 0.5, f = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
        // full crown at the trunk, a slimmer shadow at the far end
        if (Math.hypot(ax + f * dx - px, ay + f * dy - py) <= rp * (1 - 0.3 * f)) weight[y * W + x] = 0;
      }
    }
  }
  // Pyramid of premultiplied colour & weight
  const levels = [{ w: W, h: H, c: new Float32Array(W * H * 3), a: Float32Array.from(weight) }]; // (the pull fills `a`)
  for (let i = 0; i < W * H; i++) for (let k = 0; k < 3; k++) levels[0].c[i * 3 + k] = rgba[i * 4 + k] * weight[i];
  while (levels.at(-1).w > 8 && levels.at(-1).h > 8) {
    const f = levels.at(-1), w = Math.ceil(f.w / 2), h = Math.ceil(f.h / 2);
    const c = new Float32Array(w * h * 3), a = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sa = 0; const sc = [0, 0, 0];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const X = Math.min(f.w - 1, x * 2 + dx), Y = Math.min(f.h - 1, y * 2 + dy), j = Y * f.w + X;
        sa += f.a[j]; for (let k = 0; k < 3; k++) sc[k] += f.c[j * 3 + k];
      }
      // normalised colour, weight saturating at 1 (a pixel seen anywhere below is known)
      const o = y * w + x;
      a[o] = Math.min(1, sa);
      for (let k = 0; k < 3; k++) c[o * 3 + k] = sa > 0 ? (sc[k] / sa) * a[o] : 0;
    }
    levels.push({ w, h, c, a });
  }
  // Pull: fill each level's unknown share from the coarser level (bilinear)
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], g = levels[l + 1];
    const at = (x, y, k) => {
      const X = Math.max(0, Math.min(g.w - 1, x)), Y = Math.max(0, Math.min(g.h - 1, y)), j = Y * g.w + X;
      return g.a[j] > 0 ? g.c[j * 3 + k] / g.a[j] : 0;
    };
    for (let y = 0; y < f.h; y++) {
      const v = (y + 0.5) / 2 - 0.5, y0 = Math.floor(v), ty = v - y0;
      for (let x = 0; x < f.w; x++) {
        const o = y * f.w + x, a = f.a[o];
        if (a >= 1) continue;
        const u = (x + 0.5) / 2 - 0.5, x0 = Math.floor(u), tx = u - x0;
        for (let k = 0; k < 3; k++) {
          const coarse = (at(x0, y0, k) * (1 - tx) + at(x0 + 1, y0, k) * tx) * (1 - ty) + (at(x0, y0 + 1, k) * (1 - tx) + at(x0 + 1, y0 + 1, k) * tx) * ty;
          f.c[o * 3 + k] = f.c[o * 3 + k] + (1 - a) * coarse;
        }
        f.a[o] = 1;
      }
    }
  }
  const out = levels[0].c;
  for (let i = 0; i < W * H; i++) if (weight[i] < 1) for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.max(0, Math.min(255, out[i * 3 + k]));
  log(`${removed} tree crowns filled from the ground around them`);
}

const { data } = jpeg.encode({ data: rgba, width: W, height: H }, 82);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, data);
fs.writeFileSync(OUT.replace(/\.jpg$/, '.json'), JSON.stringify({
  source: 'swisstopo SWISSIMAGE 10 cm', lv95: extent ?? FRAME.lv95, resolution: RES, width: W, height: H,
  tiles: Object.fromEntries(years), treesRemoved: removed, fetched: new Date().toISOString().slice(0, 10)
}));
log(`wrote ${OUT}: ${W}x${H} @ ${RES} m, ${(data.length / 1048576).toFixed(1)} MB`);
