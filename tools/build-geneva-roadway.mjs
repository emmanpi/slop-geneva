// tools/build-geneva-roadway.mjs — writes data/geneva-roadway.bin, the street space as the cadastre surveys it (SITG,
// CAD_DOMROUTIER_OBJETS_NIV0, fetched by tools/fetch-sitg-roadway.mjs): the carriageways (with the bus lanes on their
// own bed and the parking bays along them), the traffic islands, the kerbs between the carriageways and everything
// raised beside them (footways, islands, verges), and a 1 m mask of the carriageways, for js/roadway.js.
// Format (little-endian):
//   Int32 header [magic 'GRWY', version, rings, ring points, kerbs, kerb points, mask width, mask height, mask x0,
//   mask z0] (the mask's cells are 1 m, x0/z0 its west/north edge in world metres);
//   Uint32 first point per ring (+ end); Uint8 class per ring (0 carriageway, 1 traffic island); Uint8 flags per ring
//   (1: a hole of the last outer ring), each padded to 4 bytes; Float32 [x, z] per ring point;
//   Uint32 first point per kerb (+ end); Float32 [x, z] per kerb point (the carriageway lies on the side (-dz, dx) of each kerb's direction (dx, dz));
//   the mask, one bit per cell, rows north to south, bit (x & 7) of byte (z * width + x) >> 3.
// Optional arguments (see tools/args.mjs): --extent minE,minN,maxE,maxN, --out <path>, --cache-suffix <dir>.
// With --extent (a 1 km canton tile): the rings and kerbs are clipped to the tile (+ 50 m, so the browser clips cleanly
// at the tile edges without spurious kerbs along them); the mask covers the tile alone.
// usage: node tools/build-geneva-roadway.mjs [--extent ...] [--out ...] [--cache-suffix ...]
import fs from 'node:fs';
import path from 'node:path';
import { FRAME, lv95ToWorld } from '../js/geneva-frame.js';
import { DIR, parseArgs, parseExtent, cacheFile } from './args.mjs';
import { clipRing, clipPolyline } from './osm-geometry.mjs';

const args = parseArgs(process.argv.slice(2));
const extent = parseExtent(args.extent);
const SRC = cacheFile(args.cacheSuffix, 'sitg_cad_domroutier_objets_niv0.json');
const OUT = args.out || path.join(DIR, '..', 'data', 'geneva-roadway.bin');
const log = (...a) => console.log('[geneva-roadway]', ...a);

const CARRIAGEWAY = /^(Chaussée|Site propre transport en commun|Espace de stationnement)$/;
const ISLAND = /^Ilot circulation$/;
const SIMPLIFY = 0.05; // m
const FINE = 0.25; // m, the working mask (kerb sides)
const KERB_PROBE = 0.3; // m either side of an edge
const KERB_PIECE = 2; // m: edges are judged in pieces at most this long
const MIN_KERB = 1.0; // m, shorter kerb runs are dropped
const CLIP = extent ? 50 : 0; // m: ring/kerb clipping margin around a canton tile (none for the frame)

const [minE, minN, maxE, maxN] = extent ?? FRAME.lv95;
const west = lv95ToWorld(minE, maxN), east = lv95ToWorld(maxE, minN);
const X0 = Math.floor(west.x), Z0 = Math.floor(west.z), X1 = Math.ceil(east.x), Z1 = Math.ceil(east.z);
// The working (fine) mask covers the output extent plus CLIP on every side, so kerbs are right up to the tile edge.
const FX0 = X0 - CLIP, FZ0 = Z0 - CLIP, FX1 = X1 + CLIP, FZ1 = Z1 + CLIP;
const TILE_BOX = [X0, Z0, X1, Z1];

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
// A closed ring (first point repeated last): simplified in two halves, split at the point farthest from its start;
// returned open
function rdpRing(pts, eps) {
  let far = 0, fd = -1;
  for (let k = 1; k < pts.length - 1; k++) { const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]); if (d > fd) { fd = d; far = k; } }
  return [...rdp(pts.slice(0, far + 1), eps), ...rdp(pts.slice(far), eps).slice(1)].slice(0, -1);
}
const signedArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return a / 2; };

// --- The polygons: [{ cls, rings: [outer, ...holes] }] in world x-z -----------------------------------------------------
const polygons = [];
const counts = {};
for (const f of JSON.parse(fs.readFileSync(SRC, 'utf8')).features) {
  const cls = CARRIAGEWAY.test(f.OBJET) ? 0 : ISLAND.test(f.OBJET) ? 1 : -1;
  if (cls < 0 || !f.rings) continue;
  counts[f.OBJET] = (counts[f.OBJET] || 0) + 1;
  // (ArcGIS: outer rings clockwise in east-north, holes anticlockwise, each hole after its outer ring)
  let current = null;
  for (const raw of f.rings) {
    const outer = signedArea(raw) > 0; // shoelace on (E, N) with this sign convention: clockwise is positive
    const ring = rdpRing(raw.map(([e, n]) => { const { x, z } = lv95ToWorld(e, n); return [x, z]; }), SIMPLIFY);
    const kept = extent ? clipRing(ring, [FX0, FZ0, FX1, FZ1]) : ring;
    if (kept.length < 3) continue;
    if (outer || !current) { current = { cls, rings: [kept] }; polygons.push(current); }
    else current.rings.push(kept);
  }
}

// --- The carriageway mask, at FINE m (even-odd scanlines, per polygon) --------------------------------------------------
const W = Math.ceil((FX1 - FX0) / FINE), H = Math.ceil((FZ1 - FZ0) / FINE);
const fine = new Uint8Array(Math.ceil((W * H) / 8));
const setSpan = (row, a, b) => { for (let i = Math.max(0, a); i <= Math.min(W - 1, b); i++) { const k = row * W + i; fine[k >> 3] |= 1 << (k & 7); } };
const fineAt = (x, z) => {
  const i = Math.floor((x - FX0) / FINE), j = Math.floor((z - FZ0) / FINE);
  if (i < 0 || j < 0 || i >= W || j >= H) return false;
  const k = j * W + i; return (fine[k >> 3] >> (k & 7)) & 1;
};
function fill(rings, cell, rowsCount, set) {
  let lo = Infinity, hi = -Infinity;
  for (const r of rings) for (const [, z] of r) { lo = Math.min(lo, z); hi = Math.max(hi, z); }
  for (let j = Math.max(0, Math.floor((lo - FZ0) / cell)); j <= Math.min(rowsCount - 1, Math.ceil((hi - FZ0) / cell)); j++) {
    const z = FZ0 + (j + 0.5) * cell, xs = [];
    for (const r of rings) for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
      const [ax, az] = r[k], [bx, bz] = r[i];
      if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) set(j, Math.ceil((xs[k] - FX0) / cell - 0.5), Math.floor((xs[k + 1] - FX0) / cell - 0.5));
  }
}
for (const p of polygons) if (p.cls === 0) fill(p.rings, FINE, H, setSpan);

// --- Kerbs: the carriageways' edges with carriageway on one side only ---------------------------------------------------
const kerbs = [];
let kerbLength = 0;
for (const p of polygons) {
  if (p.cls !== 0) continue;
  for (const ring of p.rings) {
    // per piece of edge: +1 carriageway on its side (-dz, dx) (kerb as is), -1 on the other (reversed), 0 no kerb
    const pieces = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-3) continue;
      const n = Math.ceil(len / KERB_PIECE), lx = -(b[1] - a[1]) / len, lz = (b[0] - a[0]) / len;
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n, tm = (t0 + t1) / 2;
        const mx = a[0] + (b[0] - a[0]) * tm, mz = a[1] + (b[1] - a[1]) * tm;
        const l = fineAt(mx + lx * KERB_PROBE, mz + lz * KERB_PROBE), r = fineAt(mx - lx * KERB_PROBE, mz - lz * KERB_PROBE);
        pieces.push({ a: [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], b: [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], s: l && !r ? 1 : r && !l ? -1 : 0 });
      }
    }
    // runs of the same side, joined around the ring's closing point
    if (!pieces.length) continue;
    let start = pieces.findIndex((q, i) => q.s !== pieces[(i + pieces.length - 1) % pieces.length].s);
    if (start < 0) start = 0;
    let run = null;
    const flush = () => {
      if (!run || !run.s) { run = null; return; }
      const pts = run.pts;
      const len = pts.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) : 0), 0);
      if (len >= MIN_KERB) { kerbs.push(rdp(run.s > 0 ? pts : pts.reverse(), SIMPLIFY / 2)); kerbLength += len; }
      run = null;
    };
    for (let k = 0; k < pieces.length; k++) {
      const q = pieces[(start + k) % pieces.length];
      if (run && run.s === q.s && Math.hypot(run.pts[run.pts.length - 1][0] - q.a[0], run.pts[run.pts.length - 1][1] - q.a[1]) < 1e-3) run.pts.push(q.b);
      else { flush(); run = { s: q.s, pts: [q.a, q.b] }; }
    }
    flush();
  }
}

// --- The exported mask, 1 m cells, set where most of the cell is carriageway ---------------------------------------------
const MW = X1 - X0, MH = Z1 - Z0, per = Math.round(1 / FINE);
const fineIdx = (x, z) => Math.floor((z - FZ0) / FINE) * W + Math.floor((x - FX0) / FINE);
const mask = new Uint8Array(Math.ceil((MW * MH) / 8));
let maskCells = 0;
for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) {
  let n = 0;
  for (let b = 0; b < per; b++) for (let a = 0; a < per; a++) {
    const k = fineIdx(X0 + i + (a + 0.5) / per, Z0 + j + (b + 0.5) / per); n += (fine[k >> 3] >> (k & 7)) & 1;
  }
  if (n * 2 > per * per) { const k = j * MW + i; mask[k >> 3] |= 1 << (k & 7); maskCells++; }
}

// --- Write --------------------------------------------------------------------------------------------------------------
const rings = [];
for (const p of polygons) p.rings.forEach((r, i) => rings.push({ cls: p.cls, hole: i > 0, pts: r }));
// (canton tiles) the kerbs are kept whole during detection, then trimmed to the tile and re-checked for length
const kerbRuns = extent
  ? kerbs.flatMap((k) => clipPolyline(k, TILE_BOX)).map((k) => rdp(k, SIMPLIFY / 2)).filter((k) => k.length >= 2 &&
      k.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - k[i - 1][0], q[1] - k[i - 1][1]) : 0), 0) >= MIN_KERB)
  : kerbs;
const nPts = rings.reduce((n, r) => n + r.pts.length, 0), nKerbPts = kerbRuns.reduce((n, k) => n + k.length, 0);
const pad4 = (n) => (n + 3) & ~3;
const size = 40 + (rings.length + 1) * 4 + pad4(rings.length) * 2 + nPts * 8 + (kerbRuns.length + 1) * 4 + nKerbPts * 8 + mask.length;
const buf = Buffer.alloc(size);
let o = 0;
for (const v of [0x59575247, 1, rings.length, nPts, kerbRuns.length, nKerbPts, MW, MH, X0, Z0]) { buf.writeInt32LE(v, o); o += 4; }
let first = 0;
for (const r of rings) { buf.writeUInt32LE(first, o); o += 4; first += r.pts.length; }
buf.writeUInt32LE(first, o); o += 4;
for (let i = 0; i < rings.length; i++) buf.writeUInt8(rings[i].cls, o + i);
o += pad4(rings.length);
for (let i = 0; i < rings.length; i++) buf.writeUInt8(rings[i].hole ? 1 : 0, o + i);
o += pad4(rings.length);
for (const r of rings) for (const [x, z] of r.pts) { buf.writeFloatLE(x, o); buf.writeFloatLE(z, o + 4); o += 8; }
first = 0;
for (const k of kerbRuns) { buf.writeUInt32LE(first, o); o += 4; first += k.length; }
buf.writeUInt32LE(first, o); o += 4;
for (const k of kerbRuns) for (const [x, z] of k) { buf.writeFloatLE(x, o); buf.writeFloatLE(z, o + 4); o += 8; }
Buffer.from(mask.buffer).copy(buf, o); o += mask.length;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf);
const kerbKm = kerbRuns.reduce((s, k) => s + k.reduce((t, q, i) => (i ? t + Math.hypot(q[0] - k[i - 1][0], q[1] - k[i - 1][1]) : 0), 0), 0) / 1000;
log(`${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
log(`${polygons.filter((p) => p.cls === 0).length} carriageways, ${polygons.filter((p) => p.cls === 1).length} islands, ${rings.length} rings / ${nPts} points; ` +
  `${kerbRuns.length} kerbs (${kerbKm.toFixed(1)} km); mask ${MW} x ${MH} m, ${(maskCells / 1e6).toFixed(2)} km² of carriageway -> ` +
  `${path.relative(process.cwd(), OUT)} (${(size / 1e6).toFixed(1)} MB)`);
