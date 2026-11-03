// tools/build-geneva-facades.mjs — writes data/geneva-facades.json: a facade style and a storey height for every
// building of the stored swissBUILDINGS3D tiles, from the Federal Register of Buildings and Dwellings (RegBL / GWR,
// Federal Statistical Office, open data: https://public.madd.bfs.admin.ch/ge.zip, unpacked into tools/data/cache/gwr/).
// Each building (its batch table's Latitude/Longitude) takes the nearest RegBL building point within 30 m: its year or
// period of construction (GBAUJ, GBAUP), storeys (GASTW) and class (GKLAS). js/swissbuildings3d.js draws the facades
// from these (window rhythm, shutters, balconies, cornices, materials).
// Output: { styles, tiles: { "<tile uri>": "s,f;s,f;…" } } per batch id, s the style index, f the storey height in dm.
// usage: node tools/build-geneva-facades.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME } from '../js/geneva-frame.js';
import { wgs84ToLv95 } from '../js/swiss-projection.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const GWR = path.join(DIR, 'data', 'cache', 'gwr', 'gebaeude_batiment_edificio.csv');
const OUT = path.join(ROOT, 'data', 'geneva-facades.json');
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

// --- Every building of the stored tiles ------------------------------------------------------------------------------------
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'swissbuildings3d', 'index.json'), 'utf8'));
const tiles = {};
const tally = new Array(STYLES.length).fill(0);
let matched = 0, total = 0;
for (const t of index.tiles) {
  const b = fs.readFileSync(path.join(ROOT, 'data', 'swissbuildings3d', index.base, t.u));
  const ftJ = b.readUInt32LE(12), ftB = b.readUInt32LE(16), btJ = b.readUInt32LE(20);
  const bt = btJ ? JSON.parse(b.toString('utf8', 28 + ftJ + ftB, 28 + ftJ + ftB + btJ)) : {};
  const lat = bt.Latitude || [], lon = bt.Longitude || [], height = bt.Height || [];
  const out = [];
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
    out.push(`${s},${Math.round(storey * 10)}`);
    tally[s]++; total++; if (g) matched++;
  }
  tiles[t.u] = out.join(';');
}
fs.writeFileSync(OUT, JSON.stringify({ source: 'OFS, Registre fédéral des bâtiments et des logements (RegBL), canton de Genève', styles: STYLES, fetched: new Date().toISOString().slice(0, 10), tiles }));
log(`${matched}/${total} buildings matched;`, STYLES.map((s, i) => `${s} ${tally[i]}`).join(', '));
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
