// tools/build-geneva-recent-buildings.mjs — writes data/geneva-recent-buildings.json: the city's buildings newer than
// swissBUILDINGS3D. swisstopo's 3D buildings of Geneva come from surveys of 2015 (2020 in places), and SITG's own 3D
// model stops in 2023; the cadastre (SITG CAD_BATIMENT_HORSOL: every building's footprint, height, storeys and year,
// kept up to date) has what was built since: the Vernets towers, the new offices of the international organisations...
// For every cadastral footprint built since MIN_YEAR (ANNEE_CONSTRUCTION, or its period) that swissBUILDINGS3D does not
// show yet (no 3D building surveyed after its construction on it or within NEIGHBOURHOOD m), the file gives:
//   added   the footprint (world coordinates), its height, storeys, year, facade style: js/swissbuildings3d.js extrudes
//           it in the city's facade material
//   hidden  per stored tile, the batch ids of the older 3D buildings standing on it (the barracks the tower replaced):
//           folded away when the tile is baked
// Output: { source, fetched, minYear, added: [{ egid, ring: [[x, z], ...], h, levels, year, style, dest }],
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
const log = (...a) => console.log('[recent-buildings]', ...a);

// --- The cadastre over the frame --------------------------------------------------------------------------------------
const [minE, minN, maxE, maxN] = FRAME.lv95;
async function fetchFootprints() {
  const all = [];
  for (let offset = 0; ; offset += 2000) {
    const params = new URLSearchParams({
      where: '1=1', geometry: `${minE},${minN},${maxE},${maxN}`, geometryType: 'esriGeometryEnvelope', inSR: '2056',
      outSR: '2056', spatialRel: 'esriSpatialRelIntersects', orderByFields: 'OBJECTID', resultOffset: String(offset),
      resultRecordCount: '2000', returnGeometry: 'true', f: 'json',
      outFields: 'EGID,ANNEE_CONSTRUCTION,EPOQUE_CONSTRUCTION,NIVEAUX_HORSOL,HAUTEUR,DESTINATION,SURFACE'
    });
    let data;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(SERVICE, { method: 'POST', body: params, headers: { 'User-Agent': 'slop-geneva data tools' } });
        data = await res.json();
        if (data.features) break;
        throw new Error(JSON.stringify(data.error || data).slice(0, 200));
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
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

// --- swissBUILDINGS3D: every stored building's point and survey year ------------------------------------------------------
function readBuildings() {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'swissbuildings3d', 'index.json'), 'utf8'));
  const out = [];
  for (const t of index.tiles) {
    const b = fs.readFileSync(path.join(ROOT, 'data', 'swissbuildings3d', index.base, t.u));
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const ftj = v.getUint32(12, true), ftb = v.getUint32(16, true), btj = v.getUint32(20, true);
    const bt = JSON.parse(b.subarray(28 + ftj + ftb, 28 + ftj + ftb + btj).toString());
    (bt.Latitude || []).forEach((lat, i) => {
      const p = wgs84ToLv95(bt.Longitude[i], lat);
      out.push({ u: t.u, b: i, E: p.E, N: p.N, year: (bt.HERKUNFT_JAHR || [])[i] || 0 });
    });
  }
  return out;
}

const footprints = await fetchFootprints();
log(`${footprints.length} cadastral footprints over the frame`);
const buildings = readBuildings();
log(`${buildings.length} swissBUILDINGS3D buildings`);
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
  added.push({
    egid: f.EGID || null,
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
  source: 'SITG, cadastre (CAD_BATIMENT_HORSOL): the buildings newer than swissBUILDINGS3D',
  fetched: new Date().toISOString().slice(0, 10),
  minYear: MIN_YEAR,
  added,
  hidden
}));
const nHidden = Object.values(hidden).reduce((a, l) => a + l.length, 0);
log(`${added.length} recent buildings added (tallest ${added.slice(0, 3).map((a) => `${a.h} m ${a.year}`).join(', ')}), ` +
  `${nHidden} older 3D buildings hidden, ${upToDate} recent ones already in swissBUILDINGS3D`);
