// tools/build-geneva-roadmarks.mjs — writes data/geneva-roadmarks.bin, the road markings as surveyed by the canton
// (SITG, Office cantonal des transports: OTC_MARQUAGE_LIGNE & OTC_MARQUAGE_SURFACE, fetched by
// tools/fetch-sitg-roadway.mjs), in the world frame of js/geneva-frame.js, for js/road-marks.js.
// The survey draws open lines along the middle of each painted line (every dash its own line) and closes the outline
// of what is painted solid: zebra bars, arrows, letters, cycle and bus symbols. Closed outlines that enclose a large
// area for their length (parking bays, boxes) are lines around it, not paint.
// Format (little-endian): Int32 header [magic 'GRMK', version, tile size (m), tiles, shapes, points];
// per tile Int32 [tile x, tile z, first shape, shapes]; Uint8 code per shape; Uint8 flags per shape (1: filled
// outline, 2: hole of the previous filled shape), padded to 4 bytes; Uint32 first point per shape (+ end);
// Int16 [x, z] per point, in cm from its tile's centre.
// Codes: colour in the low 3 bits (0 white, 1 yellow, 2 blue, 3 red surface, 4 green surface, 5 ochre surface), the
// width of a line above them (0: 15 cm, traffic & crossings; 1: 12 cm, cycling; 2: 10 cm, parking).
// usage: node tools/build-geneva-roadmarks.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lv95ToWorld } from '../js/geneva-frame.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'data', 'cache');
const OUT = path.join(DIR, '..', 'data', 'geneva-roadmarks.bin');
const TILE = 256, MAX_PIECE = 60;
const log = (...a) => console.log('[geneva-roadmarks]', ...a);
const read = (name) => JSON.parse(fs.readFileSync(path.join(CACHE, `sitg_${name}.json`), 'utf8')).features;

// Swiss practice (OSR art. 72-79): white for the traffic and white parking; yellow for the pedestrian crossings,
// public transport, cycling and yellow parking; blue for the blue zone
const lineCode = (type) => (/^Stationnement bleu/.test(type) ? 2 : /^(Piéton|Transport commun|Cyclable|Stationnement jaune)/.test(type) ? 1 : 0) |
  (/^Cyclable/.test(type) ? 8 : /^Stationnement/.test(type) ? 16 : 0);
const surfaceCode = (type) => (/rouge/i.test(type) ? 3 : /vert/i.test(type) ? 4 : 5);

const toWorld = (p) => { const { x, z } = lv95ToWorld(p[0], p[1]); return [x, z]; };
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, az] = pts[i], [bx, bz] = pts[j], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1e-9;
    let worst = -1, wd = eps;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k][0] - ax) * dz - (pts[k][1] - az) * dx) / l;
      if (d > wd) { wd = d; worst = k; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([i, worst], [worst, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}
// A closed ring (last point = first): simplified as two halves, split at the point farthest from its start
function rdpRing(pts, eps) {
  let far = 0, fd = -1;
  for (let k = 1; k < pts.length - 1; k++) { const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]); if (d > fd) { fd = d; far = k; } }
  return [...rdp(pts.slice(0, far + 1), eps), ...rdp(pts.slice(far), eps).slice(1)];
}
const length = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
const area = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return Math.abs(a / 2); };
// Long lines in pieces of at most MAX_PIECE m, so each sits in one tile and is laid on the relief closely enough
function pieces(pts) {
  const out = [];
  let cur = [pts[0]], run = 0;
  for (let i = 1; i < pts.length; i++) {
    let [ax, az] = cur[cur.length - 1];
    const [bx, bz] = pts[i];
    let seg = Math.hypot(bx - ax, bz - az);
    while (run + seg > MAX_PIECE) {
      const t = (MAX_PIECE - run) / seg;
      const m = [ax + (bx - ax) * t, az + (bz - az) * t];
      cur.push(m); out.push(cur); cur = [m]; run = 0;
      [ax, az] = m; seg = Math.hypot(bx - ax, bz - az);
    }
    cur.push(pts[i]); run += seg;
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

const shapes = []; // { code, flags, pts: [[x, z]] }
let strokes = 0, fills = 0, surfaces = 0;
for (const f of read('otc_marquage_ligne')) {
  const code = lineCode(f.TYPE || '');
  for (const raw of f.paths) {
    const pts = raw.map(toWorld);
    if (pts.length < 2) continue;
    const closed = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.01;
    if (closed && area(pts) / length(pts) < 0.35) {
      const ring = rdpRing(pts, 0.015).slice(0, -1);
      if (ring.length >= 3) { shapes.push({ code, flags: 1, pts: ring }); fills++; }
      continue;
    }
    for (const piece of pieces(rdp(pts, 0.02))) { shapes.push({ code, flags: 0, pts: piece }); strokes++; }
  }
}
for (const f of read('otc_marquage_surface')) {
  const code = surfaceCode(f.TYPE || '');
  // (ArcGIS rings: outer rings clockwise, holes anticlockwise in E-N; a hole follows its outer ring)
  for (const raw of f.rings || []) {
    const ring = rdpRing(raw.map(toWorld), 0.03).slice(0, -1);
    if (ring.length < 3) continue;
    let s = 0; for (let i = 0, j = raw.length - 1; i < raw.length; j = i++) s += (raw[i][0] - raw[j][0]) * (raw[i][1] + raw[j][1]);
    const hole = s < 0 && shapes.length && shapes[shapes.length - 1].code === code && shapes[shapes.length - 1].flags & 1;
    shapes.push({ code, flags: hole ? 2 : 1, pts: ring }); if (!hole) surfaces++;
  }
}

// Tiles by each shape's first point (holes follow their outer ring)
const tiles = new Map();
let owner = null;
for (const s of shapes) {
  const key = s.flags & 2 && owner ? owner : `${Math.floor(s.pts[0][0] / TILE)}/${Math.floor(s.pts[0][1] / TILE)}`;
  if (!(s.flags & 2)) owner = key;
  if (!tiles.has(key)) tiles.set(key, []);
  tiles.get(key).push(s);
}
const ordered = [], tileRows = [];
for (const [key, list] of tiles) {
  const [tx, tz] = key.split('/').map(Number);
  tileRows.push([tx, tz, ordered.length, list.length]);
  for (const s of list) ordered.push({ ...s, tx, tz });
}
const nPts = ordered.reduce((n, s) => n + s.pts.length, 0);
const pad4 = (n) => (n + 3) & ~3;
const size = 24 + tileRows.length * 16 + pad4(ordered.length) * 2 + (ordered.length + 1) * 4 + nPts * 4;
const buf = Buffer.alloc(size);
let o = 0;
for (const v of [0x4b4d5247, 1, TILE, tileRows.length, ordered.length, nPts]) { buf.writeInt32LE(v, o); o += 4; }
for (const row of tileRows) for (const v of row) { buf.writeInt32LE(v, o); o += 4; }
for (const s of ordered) buf.writeUInt8(s.code, o++);
o = 24 + tileRows.length * 16 + pad4(ordered.length);
for (const s of ordered) buf.writeUInt8(s.flags, o++);
o = 24 + tileRows.length * 16 + pad4(ordered.length) * 2;
let first = 0;
for (const s of ordered) { buf.writeUInt32LE(first, o); o += 4; first += s.pts.length; }
buf.writeUInt32LE(first, o); o += 4;
let clipped = 0;
for (const s of ordered) {
  const cx = (s.tx + 0.5) * TILE, cz = (s.tz + 0.5) * TILE;
  for (const [x, z] of s.pts) {
    const qx = Math.round((x - cx) * 100), qz = Math.round((z - cz) * 100);
    if (Math.abs(qx) > 32767 || Math.abs(qz) > 32767) clipped++;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, qx)), o); o += 2;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, qz)), o); o += 2;
  }
}
fs.writeFileSync(OUT, buf);
log(`${strokes} line pieces, ${fills} painted shapes, ${surfaces} coloured surfaces, ${nPts} points in ${tileRows.length} tiles` +
  `${clipped ? ` (${clipped} points clipped)` : ''} -> ${path.relative(process.cwd(), OUT)} (${(size / 1e6).toFixed(1)} MB)`);
