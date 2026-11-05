// tools/fetch-sitg-roadway.mjs — writes tools/data/cache/sitg_<layer>.json from the Office cantonal des transports'
// surveys on the SITG open data portal (opendata.swiss, terms "open use, must provide the source": SITG), clipped to
// the world frame:
//   OTC_SL_EQUIPEMENT_BOITEFEUX  every signal head (vehicle, tram, pedestrian, cyclist...) with its type and bearing
//   OTC_SL_RESEAU_MAT            the poles carrying them
//   OTC_SL_EQUIPEMENT_CARREFOUR  the signalled junctions (numbers, kind)
//   OTC_MARQUAGE_LIGNE           the road markings: lines, dashes and painted outlines (tools/build-geneva-roadmarks.mjs)
//   OTC_MARQUAGE_SURFACE         the coloured surfacing (red, green, ochre)
//   CAD_DOMROUTIER_OBJETS_NIV0   the road domain by object: carriageways, footways, islands (build-geneva-roadway.mjs)
//   TPG_MATS, TPG_HAUBANS, TPG_SUSPENSIONS, TPG_LIGNES_CONTACT  the tram & trolleybus overhead lines
// Features keep their attributes and their LV95 geometry (points: E, N; lines: paths [[E, N], ...]).
// The ArcGIS services refuse large envelopes, so the frame is read in 500 m tiles, each paged.
// usage: node tools/fetch-sitg-roadway.mjs [LAYER ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME } from '../js/geneva-frame.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'data', 'cache');
const SERVICES = 'https://vector.sitg.ge.ch/arcgis/rest/services';
const LAYERS = ['OTC_SL_EQUIPEMENT_BOITEFEUX', 'OTC_SL_RESEAU_MAT', 'OTC_SL_EQUIPEMENT_CARREFOUR', 'OTC_MARQUAGE_LIGNE', 'OTC_MARQUAGE_SURFACE', 'CAD_DOMROUTIER_OBJETS_NIV0',
  'TPG_MATS', 'TPG_HAUBANS', 'TPG_SUSPENSIONS', 'TPG_LIGNES_CONTACT'];
const TILE = 500, PAGE = 1000;
const [minE, minN, maxE, maxN] = FRAME.lv95;
const log = (...a) => console.log('[sitg-roadway]', ...a);
const r2 = (v) => Math.round(v * 100) / 100;

async function query(layer, params) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${SERVICES}/${layer}/MapServer/0/query?${new URLSearchParams({ f: 'json', ...params })}`);
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(JSON.stringify(json.error || res.status));
      return json;
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

for (const layer of process.argv.length > 2 ? process.argv.slice(2) : LAYERS) {
  const seen = new Set();
  const features = [];
  for (let e = minE; e < maxE; e += TILE) {
    for (let n = minN; n < maxN; n += TILE) {
      for (let offset = 0; ; offset += PAGE) {
        const page = await query(layer, {
          where: '1=1', geometry: `${e},${n},${Math.min(e + TILE, maxE)},${Math.min(n + TILE, maxN)}`,
          geometryType: 'esriGeometryEnvelope', inSR: '2056', outSR: '2056', spatialRel: 'esriSpatialRelIntersects',
          outFields: '*', orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(PAGE)
        });
        for (const { attributes, geometry: g } of page.features) {
          if (!g || seen.has(attributes.OBJECTID)) continue;
          seen.add(attributes.OBJECTID);
          const props = Object.fromEntries(Object.entries(attributes).filter(([k, v]) => v !== null && !/^(SHAPE|Shape__)/.test(k)));
          if ('x' in g) features.push({ ...props, E: r2(g.x), N: r2(g.y) });
          else if (g.paths) features.push({ ...props, paths: g.paths.map((p) => p.map(([x, y]) => [r2(x), r2(y)])) });
          else if (g.rings) features.push({ ...props, rings: g.rings.map((p) => p.map(([x, y]) => [r2(x), r2(y)])) });
        }
        if (!page.exceededTransferLimit && page.features.length < PAGE) break;
      }
    }
  }
  const out = path.join(CACHE, `sitg_${layer.toLowerCase()}.json`);
  fs.writeFileSync(out, JSON.stringify({ layer, source: 'SITG (État de Genève), Office cantonal des transports', fetched: new Date().toISOString().slice(0, 10), features }));
  log(`${layer}: ${features.length} features -> ${path.relative(process.cwd(), out)}`);
}
