// tools/build-geneva-streetlights.mjs — writes data/geneva-streetlights.bin, Geneva's street lighting and the tram and
// trolleybus overhead lines, for js/streetlights.js:
//  - the overhead lines as the TPG surveyed them (SITG: TPG_MATS, TPG_HAUBANS, TPG_SUSPENSIONS, TPG_LIGNES_CONTACT,
//    fetched by tools/fetch-sitg-roadway.mjs): the masts, the span wires across the streets, the droppers and the
//    contact wires over the tracks;
//  - the street lamps: those OpenStreetMap maps (highway=street_lamp, tools/data/cache/osm_geneva_lamps.json) where
//    they stand; luminaires hung from the span wires over the carriageways; elsewhere lamp posts along the kerbs
//    (data/geneva-roadway.bin), about every 30 m, on the footway, their head over the road. No open inventory of the
//    public lighting exists: only the OSM lamps are real positions.
// Format (little-endian): Int32 header [magic 'GSLT', version, lamps, masts, lines, line points, droppers];
// Float32 [x, z, yaw, kind] per lamp (kind 0 post along a kerb, 1 post mapped by OSM, 2 hung from a span wire,
// 3 post-top lantern; yaw turns the head's +x towards the road); Float32 [x, z] per mast; Uint32 first point per line
// (+ end); Uint8 kind per line (0 contact wire, 1 span wire), padded to 4 bytes; Float32 [x, z] per line point;
// Float32 [x, z] per dropper.
// usage: node tools/build-geneva-streetlights.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lonLatToWorld, lv95ToWorld } from '../js/geneva-frame.js';
import { ROADWAY } from '../js/roadway.js';
import { GENEVA_DATA } from '../js/geneva-geodata.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'data', 'cache');
const OUT = path.join(DIR, '..', 'data', 'geneva-streetlights.bin');
const log = (...a) => console.log('[geneva-streetlights]', ...a);
const read = (name) => { const f = path.join(CACHE, name); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const toWorld = ([e, n]) => { const { x, z } = lv95ToWorld(e, n); return [x, z]; };

const SPACING = 30; // m between lamp posts along a kerb
const CLEAR = 24; // m: no lamp post this close to another lamp
const HUNG_CLEAR = 26; // m between luminaires hung from the span wires
const SETBACK = 0.7; // m from the kerb's face to the post

// --- Lookups: buildings, water, the kerbs ---------------------------------------------------------------------------------
const pip = (r, x, z) => {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
function areaIndex(items, cell = 50) {
  const grid = new Map();
  for (const it of items) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < it.ring.length; i += 2) { x0 = Math.min(x0, it.ring[i]); x1 = Math.max(x1, it.ring[i]); z0 = Math.min(z0, it.ring[i + 1]); z1 = Math.max(z1, it.ring[i + 1]); }
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
      const k = `${i}/${j}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(it);
    }
  }
  return (x, z) => (grid.get(`${Math.floor(x / cell)}/${Math.floor(z / cell)}`) || []).some((it) => pip(it.ring, x, z) && !(it.holes || []).some((h) => pip(h, x, z)));
}
const inBuilding = areaIndex(GENEVA_DATA.buildings);
const inWater = areaIndex(GENEVA_DATA.water.filter((w) => w.ring?.length >= 6));
const onRoad = (x, z, r = 0.3) => ROADWAY && [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].some(([dx, dz]) => ROADWAY.onCarriageway(x + dx, z + dz));

// Points along the kerbs (every 2 m) with the way out of the carriageway, for the nearest kerb to a point
const kerbPoints = [];
const KCELL = 10, kerbGrid = new Map();
for (const line of ROADWAY ? ROADWAY.kerbs : []) {
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.01) continue;
    const ox = (b.z - a.z) / len, oz = -(b.x - a.x) / len; // away from the carriageway
    for (let s = 0; s < len; s += 2) {
      const p = { x: a.x + ((b.x - a.x) * s) / len, z: a.z + ((b.z - a.z) * s) / len, ox, oz };
      kerbPoints.push(p);
      const k = `${Math.floor(p.x / KCELL)}/${Math.floor(p.z / KCELL)}`;
      if (!kerbGrid.has(k)) kerbGrid.set(k, []); kerbGrid.get(k).push(p);
    }
  }
}
function nearestKerb(x, z, reach) {
  let best = null, bd = reach;
  for (let i = Math.floor((x - reach) / KCELL); i <= Math.floor((x + reach) / KCELL); i++) for (let j = Math.floor((z - reach) / KCELL); j <= Math.floor((z + reach) / KCELL); j++) {
    for (const p of kerbGrid.get(`${i}/${j}`) || []) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p; } }
  }
  return best;
}

// --- Lamps ---------------------------------------------------------------------------------------------------------------
const lamps = [];
const LCELL = 32, lampGrid = new Map();
const addLamp = (l) => { lamps.push(l); const k = `${Math.floor(l.x / LCELL)}/${Math.floor(l.z / LCELL)}`; if (!lampGrid.has(k)) lampGrid.set(k, []); lampGrid.get(k).push(l); };
const lampWithin = (x, z, r, test = () => true) => {
  for (let i = Math.floor((x - r) / LCELL); i <= Math.floor((x + r) / LCELL); i++) for (let j = Math.floor((z - r) / LCELL); j <= Math.floor((z + r) / LCELL); j++) {
    for (const l of lampGrid.get(`${i}/${j}`) || []) if (test(l) && Math.hypot(l.x - x, l.z - z) < r) return true;
  }
  return false;
};
const yawTowards = (dx, dz) => Math.atan2(-dz, dx); // turns +x onto (dx, dz)
const counts = [0, 0, 0, 0];

// 1. OpenStreetMap's lamps, where they stand: a post with its head over the nearest road, a lantern on its post away
// from the roads, or hung where OSM says so
const osm = read('osm_geneva_lamps.json');
for (const e of osm ? osm.elements : []) {
  if (e.type !== 'node') continue;
  const { x, z } = lonLatToWorld(e.lon, e.lat);
  if (inWater(x, z)) continue;
  const kerb = nearestKerb(x, z, 8);
  const hung = e.tags?.lamp_mount === 'suspended';
  const kind = hung ? 2 : kerb ? 1 : 3;
  addLamp({ x, z, yaw: kerb ? yawTowards(-kerb.ox, -kerb.oz) : 0, kind });
  counts[kind]++;
}

// 2. Luminaires hung from the span wires, over the middle of the carriageways
const haubans = read('sitg_tpg_haubans.json')?.features || [];
const spans = []; // [[x, z], ...] per span wire piece, in the world frame
for (const f of haubans) for (const p of f.paths || []) if (p.length >= 2) spans.push(p.map(toWorld));
for (const pts of spans) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) continue;
    const x = (ax + bx) / 2, z = (az + bz) / 2;
    if (!ROADWAY || !ROADWAY.onCarriageway(x, z) || [[2, 0], [-2, 0], [0, 2], [0, -2]].some(([dx, dz]) => !ROADWAY.onCarriageway(x + dx, z + dz))) continue;
    if (lampWithin(x, z, HUNG_CLEAR)) continue;
    addLamp({ x, z, yaw: yawTowards((bx - ax) / len, (bz - az) / len), kind: 2 });
    counts[2]++;
  }
}

// 3. Posts along the kerbs, on the footway, where no lamp lights the street yet
for (const line of ROADWAY ? ROADWAY.kerbs : []) {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
  if (total < 12) continue; // (the islands' and the corners' short kerbs)
  let next = Math.min(SPACING / 2, total / 2), run = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.01) continue;
    const ox = (b.z - a.z) / len, oz = -(b.x - a.x) / len;
    while (next <= run + len) {
      const t = (next - run) / len;
      const x = a.x + (b.x - a.x) * t + ox * SETBACK, z = a.z + (b.z - a.z) * t + oz * SETBACK;
      next += SPACING;
      if (onRoad(x, z) || inBuilding(x, z) || inWater(x, z) || inBuilding(x + ox * 0.6, z + oz * 0.6)) continue;
      if (lampWithin(x, z, CLEAR)) continue;
      addLamp({ x, z, yaw: yawTowards(-ox, -oz), kind: 0 });
      counts[0]++;
    }
    run += len;
  }
}

// --- The overhead lines ---------------------------------------------------------------------------------------------------
const masts = (read('sitg_tpg_mats.json')?.features || []).filter((f) => f.ETAT !== 'Hors_service').map((f) => toWorld([f.E, f.N]));
const lines = [];
for (const f of read('sitg_tpg_lignes_contact.json')?.features || []) for (const p of f.paths || []) if (p.length >= 2) lines.push({ kind: 0, pts: p.map(toWorld) });
for (const pts of spans) lines.push({ kind: 1, pts });
const droppers = [];
for (const f of read('sitg_tpg_suspensions.json')?.features || []) for (const p of f.paths || []) if (p.length) droppers.push(toWorld(p[0]));

// --- Write ---------------------------------------------------------------------------------------------------------------
const nLinePts = lines.reduce((n, l) => n + l.pts.length, 0);
const pad4 = (n) => (n + 3) & ~3;
const size = 28 + lamps.length * 16 + masts.length * 8 + (lines.length + 1) * 4 + pad4(lines.length) + nLinePts * 8 + droppers.length * 8;
const buf = Buffer.alloc(size);
let o = 0;
for (const v of [0x544c5347, 1, lamps.length, masts.length, lines.length, nLinePts, droppers.length]) { buf.writeInt32LE(v, o); o += 4; }
for (const l of lamps) for (const v of [l.x, l.z, l.yaw, l.kind]) { buf.writeFloatLE(v, o); o += 4; }
for (const [x, z] of masts) { buf.writeFloatLE(x, o); buf.writeFloatLE(z, o + 4); o += 8; }
let first = 0;
for (const l of lines) { buf.writeUInt32LE(first, o); o += 4; first += l.pts.length; }
buf.writeUInt32LE(first, o); o += 4;
lines.forEach((l, i) => buf.writeUInt8(l.kind, o + i)); o += pad4(lines.length);
for (const l of lines) for (const [x, z] of l.pts) { buf.writeFloatLE(x, o); buf.writeFloatLE(z, o + 4); o += 8; }
for (const [x, z] of droppers) { buf.writeFloatLE(x, o); buf.writeFloatLE(z, o + 4); o += 8; }
fs.writeFileSync(OUT, buf);
log(`lamps: ${counts[1]} posts and ${counts[3]} lanterns mapped by OSM, ${counts[2]} hung from the span wires, ${counts[0]} posts along the kerbs`);
log(`overhead: ${masts.length} masts, ${lines.filter((l) => !l.kind).length} contact wires, ${spans.length} span wire pieces, ${droppers.length} droppers -> ` +
  `${path.relative(process.cwd(), OUT)} (${(size / 1e6).toFixed(2)} MB)`);
