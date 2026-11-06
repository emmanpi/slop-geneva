// tools/build-geneva-recent-buildings.mjs — writes data/geneva-recent-buildings.json: the canton's buildings newer than
// swissBUILDINGS3D, in the city and beyond it. swisstopo's 3D buildings of Geneva come from surveys of 2015 (2020 in places), and SITG's own 3D
// model stops in 2023; the cadastre (SITG CAD_BATIMENT_HORSOL: every building's footprint, height, storeys and year,
// kept up to date) has what was built since: the Vernets towers, the new offices of the international organisations...
// For every cadastral footprint built since MIN_YEAR (ANNEE_CONSTRUCTION, or its period) that swissBUILDINGS3D does not
// show yet (no 3D building surveyed after its construction on it or within NEIGHBOURHOOD m), the file gives:
//   added   the footprint (world coordinates), its height, storeys, year, facade style: js/swissbuildings3d.js extrudes
//           it in the city's facade material; `tile`: the canton tile (data/geneva-canton-buildings.json) it comes with
//           beyond the city (js/canton.js), null within the city's stored tiles
//   hidden  per tile (the city's stored ones and the canton's), the batch ids of the older 3D buildings standing on it
//           (the barracks the tower replaced): folded away when the tile is baked
// The canton's tiles are read where it matters only: the feature and batch tables (HTTP ranges) of those within 150 m
// of a recent footprint, cached in tools/data/cache/recent_batches/.
// Output: { source, fetched, minYear, added: [{ egid, ring: [[x, z], ...], h, levels, year, style, dest, tile }],
//           hidden: { "<tile uri>": [batch ids] } }
// usage: node tools/build-geneva-recent-buildings.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME } from '../js/geneva-frame.js';
import { wgs84ToLv95 } from '../js/swiss-projection.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const OUT = path.join(ROOT, 'data', 'geneva-recent-buildings.json');
const SERVICE = 'https://vector.sitg.ge.ch/arcgis/rest/services/CAD_BATIMENT_HORSOL/FeatureServer/0/query';
const MIN_YEAR = 2013; // swissBUILDINGS3D's Geneva surveys: 2015, 2020 in places
const NEIGHBOURHOOD = 40; // m: 3D buildings surveyed after a construction this close: the area is up to date
const CACHE = path.join(DIR, 'data', 'cache', 'recent_batches');
const log = (...a) => console.log('[recent-buildings]', ...a);

// --- The cadastre's recent footprints over the canton -------------------------------------------------------------------
const [minE, minN, maxE, maxN] = FRAME.lv95;
const inFrame = (E, N) => E >= minE && E <= maxE && N >= minN && N <= maxN;
async function query(params) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(SERVICE, { method: 'POST', body: new URLSearchParams(params), headers: { 'User-Agent': 'slop-geneva data tools' } });
      const data = await res.json();
      if (data.features) return data;
      throw new Error(JSON.stringify(data.error || data).slice(0, 200));
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
}
async function fetchFootprints() {
  const all = [];
  for (let offset = 0; ; offset += 2000) {
    const data = await query({
      where: `ANNEE_CONSTRUCTION >= ${MIN_YEAR} OR EPOQUE_CONSTRUCTION LIKE 'Période de 201%' OR EPOQUE_CONSTRUCTION LIKE 'Période de 202%'`,
      outSR: '2056', orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: '2000', returnGeometry: 'true',
      outFields: 'EGID,ANNEE_CONSTRUCTION,EPOQUE_CONSTRUCTION,NIVEAUX_HORSOL,HAUTEUR,DESTINATION,SURFACE', f: 'json'
    });
    for (const f of data.features) all.push({ ...f.attributes, rings: f.geometry.rings });
    if (!data.exceededTransferLimit && data.features.length < 2000) break;
  }
  return all;
}

// The year a footprint was built: its own, or the end of its period ("Période de 2016 à 2020")
function yearOf(f) {
  if (f.ANNEE_CONSTRUCTION) return f.ANNEE_CONSTRUCTION;
  const m = /(\d{4})\D+(\d{4})/.exec(f.EPOQUE_CONSTRUCTION || '');
  return m && +m[1] >= MIN_YEAR ? +m[2] : null;
}
// Facade style (js/swissbuildings3d.js FACADE_STYLES): all recent; offices and the international organisations in glass
const OFFICE = /bureau|administration|organisation|OIG|ONU|banque|commerce|hôtel|université|école|hôpital/i;
const styleOf = (f) => (OFFICE.test(f.DESTINATION || '') ? 4 : 3);

const inRing = (r, x, y) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
};

// --- swissBUILDINGS3D: every building's point and survey year --------------------------------------------------------------
// The feature and batch tables of a b3dm (its JSON parts: no geometry)
function batchTableOf(buffer) {
  const v = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const ftj = v.getUint32(12, true), ftb = v.getUint32(16, true), btj = v.getUint32(20, true);
  return JSON.parse(buffer.subarray(28 + ftj + ftb, 28 + ftj + ftb + btj).toString());
}
function pointsOf(u, bt, out) {
  (bt.Latitude || []).forEach((lat, i) => {
    const p = wgs84ToLv95(bt.Longitude[i], lat);
    out.push({ u, b: i, E: p.E, N: p.N, year: (bt.HERKUNFT_JAHR || [])[i] || 0 });
  });
}
// The city's stored tiles
function storedBuildings(out) {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'swissbuildings3d', 'index.json'), 'utf8'));
  for (const t of index.tiles) pointsOf(t.u, batchTableOf(fs.readFileSync(path.join(ROOT, 'data', 'swissbuildings3d', index.base, t.u))), out);
}
// A canton tile's batch table from swisstopo: its header, then the JSON parts (HTTP ranges), cached
async function cantonBatchTable(origin, u) {
  const file = path.join(CACHE, u.replace(/\//g, '_') + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const get = async (range) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(origin + u, { headers: { Range: `bytes=${range}`, 'User-Agent': 'slop-geneva data tools' } });
        if (!res.ok) throw new Error(`${u}: ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  };
  let head = await get('0-27');
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const end = 28 + v.getUint32(12, true) + v.getUint32(16, true) + v.getUint32(20, true);
  // (a server ignoring the range sends the whole tile: fine too)
  const buffer = head.length >= end ? head : await get(`0-${end - 1}`);
  const bt = batchTableOf(buffer);
  const keep = { Latitude: bt.Latitude, Longitude: bt.Longitude, HERKUNFT_JAHR: bt.HERKUNFT_JAHR };
  fs.writeFileSync(file, JSON.stringify(keep));
  return keep;
}
async function cantonBuildings(footprints, out) {
  const canton = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'geneva-canton-buildings.json'), 'utf8'));
  const near = new Set(), C = 200;
  for (const f of footprints) {
    const [e, n] = f.rings[0][0];
    if (!inFrame(e, n)) near.add(`${Math.floor((e - FRAME.E0) / C)},${Math.floor((FRAME.N0 - n) / C)}`);
  }
  const wanted = canton.tiles.filter(([, x, z]) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (near.has(`${Math.floor(x / C) + i},${Math.floor(z / C) + j}`)) return true;
    return false;
  });
  fs.mkdirSync(CACHE, { recursive: true });
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < wanted.length) {
      const [u] = wanted[next++];
      pointsOf(u, await cantonBatchTable(canton.origin, u), out);
      if (++done % 200 === 0) log(`  ${done}/${wanted.length} canton tiles read`);
    }
  }));
  log(`${wanted.length} of the canton's ${canton.tiles.length} tiles read (near a recent footprint)`);
  return canton.tiles;
}

const footprints = await fetchFootprints();
log(`${footprints.length} recent cadastral footprints over the canton`);
const buildings = [];
storedBuildings(buildings);
const cantonTiles = await cantonBuildings(footprints, buildings);
log(`${buildings.length} swissBUILDINGS3D buildings around them`);
// the canton tile a building beyond the city comes with: the nearest tile centre
const TILE_CELL = 300, tileGrid = new Map();
for (const t of cantonTiles) {
  const k = `${Math.floor(t[1] / TILE_CELL)},${Math.floor(t[2] / TILE_CELL)}`;
  if (!tileGrid.has(k)) tileGrid.set(k, []);
  tileGrid.get(k).push(t);
}
const nearestTile = (x, z) => {
  let best = null, d = Infinity;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const t of tileGrid.get(`${Math.floor(x / TILE_CELL) + i},${Math.floor(z / TILE_CELL) + j}`) || []) {
      const dd = Math.hypot(t[1] - x, t[2] - z);
      if (dd < d) { d = dd; best = t[0]; }
    }
  }
  return best;
};
const CELL = 50, grid = new Map();
for (const s of buildings) {
  const k = `${Math.floor(s.E / CELL)},${Math.floor(s.N / CELL)}`;
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(s);
}
const near = (E, N, d) => {
  const out = [];
  for (let i = Math.floor((E - d) / CELL); i <= Math.floor((E + d) / CELL); i++) {
    for (let j = Math.floor((N - d) / CELL); j <= Math.floor((N + d) / CELL); j++) out.push(...(grid.get(`${i},${j}`) || []));
  }
  return out;
};

const added = [], hidden = {};
let upToDate = 0;
for (const f of footprints) {
  const year = yearOf(f);
  if (!year || year < MIN_YEAR || !(f.HAUTEUR >= 3) || !(f.SURFACE >= 20)) continue;
  const ring = f.rings[0];
  let E = 0, N = 0;
  for (const [e, n] of ring) { E += e; N += n; }
  E /= ring.length; N /= ring.length;
  const reach = Math.max(...ring.map(([e, n]) => Math.hypot(e - E, n - N)));
  const around = near(E, N, reach + NEIGHBOURHOOD);
  // surveyed after it was built, on it or around it: swissBUILDINGS3D already has it
  if (around.some((s) => s.year >= year && Math.hypot(s.E - E, s.N - N) <= reach + NEIGHBOURHOOD)) { upToDate++; continue; }
  for (const s of around) {
    if (!f.rings.some((r) => inRing(r, s.E, s.N))) continue;
    (hidden[s.u] ??= []).push(s.b);
  }
  const x = E - FRAME.E0, z = FRAME.N0 - N;
  const tile = inFrame(E, N) ? null : nearestTile(x, z);
  if (!inFrame(E, N) && !tile) continue; // beyond the canton's tiles
  added.push({
    egid: f.EGID || null,
    tile,
    ring: ring.map(([e, n]) => [Math.round((e - FRAME.E0) * 10) / 10, Math.round((FRAME.N0 - n) * 10) / 10]),
    h: Math.round(f.HAUTEUR * 10) / 10,
    levels: f.NIVEAUX_HORSOL || null,
    year,
    style: styleOf(f),
    dest: f.DESTINATION || ''
  });
}
for (const u of Object.keys(hidden)) hidden[u] = [...new Set(hidden[u])].sort((a, b) => a - b);
added.sort((a, b) => b.h - a.h);
fs.writeFileSync(OUT, JSON.stringify({
  source: 'SITG, cadastre (CAD_BATIMENT_HORSOL): the canton\'s buildings newer than swissBUILDINGS3D',
  fetched: new Date().toISOString().slice(0, 10),
  minYear: MIN_YEAR,
  added,
  hidden
}));
const nHidden = Object.values(hidden).reduce((a, l) => a + l.length, 0);
log(`${added.filter((a) => !a.tile).length} in the city, ${added.filter((a) => a.tile).length} beyond it`);
log(`${added.length} recent buildings added (tallest ${added.slice(0, 3).map((a) => `${a.h} m ${a.year}`).join(', ')}), ` +
  `${nHidden} older 3D buildings hidden, ${upToDate} recent ones already in swissBUILDINGS3D`);
