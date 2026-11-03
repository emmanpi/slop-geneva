// tools/build-geneva-facades.mjs — writes data/geneva-facades.json: a facade style and a storey height for every
// building of the stored swissBUILDINGS3D tiles, from the Federal Register of Buildings and Dwellings (RegBL / GWR,
// Federal Statistical Office, open data: https://public.madd.bfs.admin.ch/ge.zip, unpacked into tools/data/cache/gwr/).
// Each building (its batch table's Latitude/Longitude) takes the nearest RegBL building point within 30 m: its year or
// period of construction (GBAUJ, GBAUP), storeys (GASTW) and class (GKLAS). js/swissbuildings3d.js draws the facades
// from these (window rhythm, shutters, balconies, cornices, materials).
// Facade archetypes: the buildings measured in the photomesh (tools/sample-photomesh-facades.mjs: wall colour, share
// of windows, ground floor) are grouped into ARCHETYPES by k-means; every other building takes the archetype most
// common among the measured buildings most like it (RegBL style, year and storeys, and nearby). A measured building
// keeps its own colour, the others their archetype's (a little varied).
// Output: { styles, archetypes: [{ rgb, win, shop, n }], tiles: { "<tile uri>": "s,f,a,RRGGBB;…" } } per batch id: s
// the style index, f the storey height in dm, a the archetype, RRGGBB the wall colour (sRGB, white-balanced).
// usage: node tools/build-geneva-facades.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME } from '../js/geneva-frame.js';
import { wgs84ToLv95 } from '../js/swiss-projection.js';
import { GENEVA_DATA } from '../js/geneva-geodata.js';
import { lv95ToWorld } from '../js/geneva-frame.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const GWR = path.join(DIR, 'data', 'cache', 'gwr', 'gebaeude_batiment_edificio.csv');
const OUT = path.join(ROOT, 'data', 'geneva-facades.json');
const SAMPLES = path.join(DIR, 'data', 'cache', 'facade_samples.json');
const ARCHETYPES = 20;
const log = (...a) => console.log('[geneva-facades]', ...a);

// Facade styles (js/swissbuildings3d.js draws them in this order)
export const STYLES = ['ancien', 'xixe', 'moderne', 'contemporain', 'bureaux', 'inconnu'];
const S = Object.fromEntries(STYLES.map((s, i) => [s, i]));
// Middle year of each RegBL construction period (GBAUP)
const PERIOD = { 8011: 1890, 8012: 1932, 8013: 1953, 8014: 1965, 8015: 1975, 8016: 1983, 8017: 1988, 8018: 1993, 8019: 1998, 8020: 2003, 8021: 2008, 8022: 2013, 8023: 2019 };
// The Vieille-Ville on its hill (LV95): the "before 1919" buildings there are the old town's, elsewhere mostly the
// 19th-century city that replaced the fortifications (the Fazy ring, the Pâquis, Plainpalais, the Eaux-Vives)
const VIEILLE_VILLE = [[2500020, 1117560], [2500200, 1117700], [2500560, 1117620], [2500680, 1117420], [2500520, 1117180], [2500200, 1117170], [2500030, 1117320]];
const inPoly = (poly, x, y) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i][1] > y) !== (poly[j][1] > y) && x < ((poly[j][0] - poly[i][0]) * (y - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) inside = !inside;
  }
  return inside;
};

function styleOf(g, E, N) {
  if (!g) return S.inconnu;
  const year = g.year ?? PERIOD[g.period] ?? null;
  if (g.klass === 1272) return S.ancien; // churches and temples: stone
  if (year == null) return S.inconnu;
  const office = g.klass === 1220 || g.klass === 1230 || g.klass === 1231;
  if (year < 1919 && g.period === 8011 && g.year == null) return inPoly(VIEILLE_VILLE, E, N) ? S.ancien : S.xixe;
  if (year < 1840) return S.ancien;
  if (year < 1935) return S.xixe;
  if (office && year >= 1960) return S.bureaux;
  if (year < 1980) return S.moderne;
  return office ? S.bureaux : S.contemporain;
}
const DEFAULT_STOREY = [3.1, 3.4, 2.9, 3.0, 3.6, 3.1];

// --- RegBL buildings in the frame, on a 50 m grid -------------------------------------------------------------------------
const [minE, minN, maxE, maxN] = FRAME.lv95;
const lines = fs.readFileSync(GWR, 'utf8').split('\n');
const head = lines[0].split('\t');
const col = (name) => head.indexOf(name);
const C = { E: col('GKODE'), N: col('GKODN'), year: col('GBAUJ'), period: col('GBAUP'), floors: col('GASTW'), klass: col('GKLAS'), status: col('GSTAT') };
const CELL = 50, grid = new Map();
let count = 0;
for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split('\t');
  const E = +f[C.E], N = +f[C.N];
  if (!(E >= minE - 50 && E <= maxE + 50 && N >= minN - 50 && N <= maxN + 50)) continue;
  if (f[C.status] && f[C.status] !== '1004') continue; // existing buildings only
  const g = { E, N, year: f[C.year] ? +f[C.year] : null, period: f[C.period] ? +f[C.period] : null, floors: f[C.floors] ? +f[C.floors] : null, klass: f[C.klass] ? +f[C.klass] : null };
  const key = `${Math.floor(E / CELL)},${Math.floor(N / CELL)}`;
  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push(g);
  count++;
}
log(`${count} RegBL buildings around the frame`);
const nearest = (E, N, max = 30) => {
  let best = null, d = max;
  const i0 = Math.floor(E / CELL), j0 = Math.floor(N / CELL);
  for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
    for (const g of grid.get(`${i},${j}`) || []) { const dd = Math.hypot(g.E - E, g.N - N); if (dd < d) { d = dd; best = g; } }
  }
  return best;
};

// --- OSM footprints (the photomesh samples are per footprint) ---------------------------------------------------------------
const FCELL = 20, fgrid = new Map();
GENEVA_DATA.buildings.forEach((b, index) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < b.ring.length; i += 2) { x0 = Math.min(x0, b.ring[i]); x1 = Math.max(x1, b.ring[i]); z0 = Math.min(z0, b.ring[i + 1]); z1 = Math.max(z1, b.ring[i + 1]); }
  const item = { index, ring: b.ring, x0, x1, z0, z1 };
  for (let i = Math.floor(x0 / FCELL); i <= Math.floor(x1 / FCELL); i++) for (let j = Math.floor(z0 / FCELL); j <= Math.floor(z1 / FCELL); j++) {
    const k = `${i},${j}`;
    if (!fgrid.has(k)) fgrid.set(k, []);
    fgrid.get(k).push(item);
  }
});
const footprintAt = (x, z) => (fgrid.get(`${Math.floor(x / FCELL)},${Math.floor(z / FCELL)}`) || []).find((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && inPoly2(b.ring, x, z));
function inPoly2(r, x, z) { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { if ((r[i + 1] > z) !== (r[j + 1] > z) && x < ((r[j] - r[i]) * (z - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c; } return c; }
const samples = fs.existsSync(SAMPLES) ? JSON.parse(fs.readFileSync(SAMPLES, 'utf8')) : {};

// --- Every building of the stored tiles ------------------------------------------------------------------------------------
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'swissbuildings3d', 'index.json'), 'utf8'));
const records = [];
const tally = new Array(STYLES.length).fill(0);
let matched = 0, total = 0;
for (const t of index.tiles) {
  const b = fs.readFileSync(path.join(ROOT, 'data', 'swissbuildings3d', index.base, t.u));
  const ftJ = b.readUInt32LE(12), ftB = b.readUInt32LE(16), btJ = b.readUInt32LE(20);
  const bt = btJ ? JSON.parse(b.toString('utf8', 28 + ftJ + ftB, 28 + ftJ + ftB + btJ)) : {};
  const lat = bt.Latitude || [], lon = bt.Longitude || [], height = bt.Height || [];
  for (let k = 0; k < lat.length; k++) {
    const p = wgs84ToLv95(lon[k], lat[k]);
    const g = nearest(p.E, p.N);
    const s = styleOf(g, p.E, p.N);
    // Storey height: the building's height over its storeys when both are known and plausible
    let storey = DEFAULT_STOREY[s];
    if (g?.floors && height[k] > 4) {
      const v = height[k] / g.floors;
      if (v > 2.5 && v < 5) storey = v;
    }
    const { x, z } = lv95ToWorld(p.E, p.N);
    const fp = footprintAt(x, z);
    const m = fp && samples[fp.index];
    records.push({ u: t.u, k, s, storey, x, z, year: g?.year ?? PERIOD[g?.period] ?? null, floors: g?.floors ?? (height[k] > 0 ? Math.round(height[k] / storey) : null), m });
    tally[s]++; total++; if (g) matched++;
  }
}

// --- White balance: the photos' walls stand half in shade under a blue sky; their median goes to a warm grey -----------------
const measured = records.filter((r) => r.m);
const med = (a) => { const x = [...a].sort((p, q) => p - q); return x[Math.floor(x.length / 2)] || 1; };
const gm = [0, 1, 2].map((c) => med(measured.map((r) => r.m.rgb[c])));
const TARGET = [1.03, 1.0, 0.88]; // Geneva's molasse and plaster: a warm grey
const gl = (gm[0] + gm[1] + gm[2]) / 3;
const wb = gm.map((v, c) => (gl * TARGET[c]) / v);
const LIFT = 1.12; // the photos' walls are darker than their albedo (shade, grime)
const balance = (rgb) => rgb.map((v, c) => Math.min(255, Math.round(v * wb[c] * LIFT)));
for (const r of measured) r.rgb = balance(r.m.rgb);
log(`white balance x[${wb.map((v) => v.toFixed(2)).join(', ')}] from the median wall [${gm.join(', ')}]`);

// --- Archetypes: k-means over colour (Lab), windows and ground floor --------------------------------------------------------
const toLab = ([r, g, b]) => {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.9505, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.089;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const feature = (r) => { const [L, A, B] = toLab(r.rgb); return [L, A * 1.5, B * 1.5, r.m.win * 60, Math.min(1.3, r.m.ground) * 30]; };
let seed = 20261103;
const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) + 1) >>> 0) / 4294967296;
const pts = measured.map(feature);
const d2 = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);
// k-means++ seeding, then Lloyd
const centres = [pts[Math.floor(rnd() * pts.length)]];
while (centres.length < Math.min(ARCHETYPES, pts.length)) {
  const w = pts.map((p) => Math.min(...centres.map((c) => d2(p, c))));
  let r = rnd() * w.reduce((a, b) => a + b, 0);
  centres.push(pts[w.findIndex((v) => (r -= v) <= 0)] || pts[0]);
}
let assign = new Array(pts.length).fill(0);
for (let it = 0; it < 40; it++) {
  assign = pts.map((p) => centres.reduce((best, c, i) => (d2(p, c) < d2(p, centres[best]) ? i : best), 0));
  for (let i = 0; i < centres.length; i++) {
    const mine = pts.filter((_, j) => assign[j] === i);
    if (mine.length) centres[i] = mine[0].map((_, k) => mine.reduce((a, p) => a + p[k], 0) / mine.length);
  }
}
measured.forEach((r, j) => { r.a = assign[j]; });
const archetypes = centres.map((_, i) => {
  const mine = measured.filter((r) => r.a === i);
  return {
    rgb: [0, 1, 2].map((c) => Math.round(med(mine.map((r) => r.rgb[c])))),
    win: Math.round(med(mine.map((r) => r.m.win)) * 1000) / 1000,
    shop: Math.round((mine.filter((r) => r.m.ground < 0.8).length / Math.max(1, mine.length)) * 100) / 100,
    n: mine.length
  };
});

// --- Every other building: the archetype of the measured buildings most like it ---------------------------------------------
const likeness = (a, b) => (a.s === b.s ? 0 : 9) + ((a.year ?? 1950) - (b.year ?? 1950)) ** 2 / 625 + ((a.floors ?? 5) - (b.floors ?? 5)) ** 2 / 4 + ((a.x - b.x) ** 2 + (a.z - b.z) ** 2) / 250000;
const hashOf = (r) => { const v = Math.sin(r.x * 12.9898 + r.z * 78.233) * 43758.5453; return v - Math.floor(v); };
for (const r of records) {
  if (r.m) continue;
  if (!measured.length) { r.a = 0; r.rgb = [200, 196, 186]; continue; }
  const near = measured.map((o) => ({ o, d: likeness(r, o) })).sort((p, q) => p.d - q.d).slice(0, 9);
  const votes = new Map();
  for (const { o, d } of near) votes.set(o.a, (votes.get(o.a) || 0) + 1 / (d + 0.5));
  r.a = [...votes].sort((p, q) => q[1] - p[1])[0][0];
  const j = 0.94 + hashOf(r) * 0.12; // a little varied
  r.rgb = archetypes[r.a].rgb.map((v) => Math.min(255, Math.round(v * j)));
}

const tiles = {};
const hex = (rgb) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
for (const r of records) (tiles[r.u] ||= []).push(`${r.s},${Math.round(r.storey * 10)},${r.a},${hex(r.rgb)}`);
for (const u of Object.keys(tiles)) tiles[u] = tiles[u].join(';');
log(`${measured.length} buildings measured in the photomesh -> ${archetypes.length} archetypes:`);
archetypes.forEach((a, i) => log(`  ${String(i).padStart(2)}  #${hex(a.rgb)}  windows ${(a.win * 100).toFixed(0)}%  shops ${(a.shop * 100).toFixed(0)}%  (${a.n})`));
fs.writeFileSync(OUT, JSON.stringify({ source: 'OFS, Registre fédéral des bâtiments et des logements (RegBL), canton de Genève; SITG Photomaillage 3D 2019 (facade archetypes)', styles: STYLES, archetypes, fetched: new Date().toISOString().slice(0, 10), tiles }));
log(`${matched}/${total} buildings matched;`, STYLES.map((s, i) => `${s} ${tally[i]}`).join(', '));
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
