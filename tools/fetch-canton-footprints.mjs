// tools/fetch-canton-footprints.mjs — downloads the SITG cadastral building footprints of the canton (CAD_BATIMENT_HORSOL,
// État de Genève, open data, ArcGIS REST) as LV95 (EPSG:2056) polygons into tools/data/cache/canton_footprints.json, one
// object per building: { egid, ring: [[E, N], ...], epoque, annee, niveaux, hauteur, destination }. They are the ground
// truth the canton facade builder links every swissBUILDINGS3D batch to (by its Latitude/Longitude, since the canton
// tiles' batch tables carry no EGID), and the EGID key into the RegBL (year, period, storeys, class).
// With --area <BFS> only the footprints intersecting that commune (plus a 100 m margin) are kept; otherwise the whole
// canton (83,089 footprints) is paginated. Resumable/cached: skips when the file is present for the same area.
// usage: node tools/fetch-canton-footprints.mjs [--area 6640] [--limit N]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCommune, ringsBbox, pointInRings, pointNearRings } from './lib/canton-area.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'data', 'cache', 'canton_footprints.json');
const META = path.join(DIR, 'data', 'cache', 'canton_footprints.meta.json');
const SERVICE = 'https://vector.sitg.ge.ch/arcgis/rest/services/CAD_BATIMENT_HORSOL/FeatureServer/0/query';
const FIELDS = 'EGID,EPOQUE_CONSTRUCTION,ANNEE_CONSTRUCTION,NIVEAUX_HORSOL,HAUTEUR,DESTINATION';
const PAGE = 4000, MARGIN = 100;
const log = (...a) => console.log('[canton-footprints]', ...a);

const args = process.argv.slice(2);
const area = args.includes('--area') ? +args[args.indexOf('--area') + 1] : null;
const limit = args.includes('--limit') ? +args[args.indexOf('--limit') + 1] : null;

async function fetchRetry(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url).catch((error) => ({ ok: false, status: error.message }));
    if (res.ok) return res;
    if (attempt === 4) throw new Error(`${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
}

// The footprint kept is the largest ring of a (possibly multipart) polygon
const largestRing = (rings) => rings.reduce((best, r) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) > (best.area ?? 0) ? { ring: r, area: Math.abs(a) } : best;
}, {}).ring;

async function fetchPage(where, geometry, geometryType, offset) {
  const params = new URLSearchParams({ where, outFields: FIELDS, returnGeometry: 'true', outSR: '2056', f: 'json', resultOffset: String(offset), resultRecordCount: String(PAGE) });
  if (geometry) { params.set('geometry', geometry); params.set('geometryType', geometryType); params.set('inSR', '2056'); params.set('spatialRel', 'esriSpatialRelIntersects'); }
  const body = await (await fetchRetry(`${SERVICE}?${params}`)).json();
  if (body.error) throw new Error(`SITG: ${body.error.message}`);
  return body;
}

const commune = area ? await fetchCommune(area) : null;
if (commune) log(`area: ${commune.name} (${commune.bfs})`);
const meta = fs.existsSync(META) ? JSON.parse(fs.readFileSync(META, 'utf8')) : null;
if (fs.existsSync(OUT) && meta && (meta.area?.bfs ?? null) === (commune?.bfs ?? null)) {
  log(`${meta.count} footprints already cached (${meta.area ? meta.area.name : 'canton-wide'}), skipping`);
  process.exit(0);
}

const where = '1=1';
const geometry = commune ? ringsBbox(commune.rings, MARGIN).join(',') : null;
const geometryType = commune ? 'esriGeometryEnvelope' : null;
const footprints = [];
for (let offset = 0; ; offset += PAGE) {
  const body = await fetchPage(where, geometry, geometryType, offset);
  for (const f of body.features || []) {
    const a = f.attributes || {};
    const rings = f.geometry?.rings;
    if (!rings?.length) continue;
    const ring = largestRing(rings).map(([e, n]) => [Math.round(e * 100) / 100, Math.round(n * 100) / 100]);
    if (commune && !(ring.some(([e, n]) => pointInRings(commune.rings, e, n)) || ring.some(([e, n]) => pointNearRings(commune.rings, e, n, MARGIN)))) continue;
    footprints.push({ egid: a.EGID ?? null, ring, epoque: a.EPOQUE_CONSTRUCTION ?? null, annee: a.ANNEE_CONSTRUCTION ?? null, niveaux: a.NIVEAUX_HORSOL ?? null, hauteur: a.HAUTEUR ?? null, destination: a.DESTINATION ?? null });
    if (limit && footprints.length >= limit) break;
  }
  const more = body.exceededTransferLimit === true;
  log(`  ${footprints.length} footprints (offset ${offset})`);
  if (!more || (limit && footprints.length >= limit)) break;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(footprints));
fs.writeFileSync(META, JSON.stringify({ area: commune ? { bfs: commune.bfs, name: commune.name } : null, count: footprints.length }));
log(`wrote ${footprints.length} footprints -> ${OUT}`);
