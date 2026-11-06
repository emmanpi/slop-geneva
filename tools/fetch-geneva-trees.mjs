// tools/fetch-geneva-trees.mjs — writes tools/data/cache/geneva_trees.json from the Inventaire cantonal des arbres
// isolés (ICA, Office cantonal de l'agriculture et de la nature, open data SITG:
// https://ckan.opendata.swiss/dataset/inventaire-cantonal-des-arbres-isoles), clipped to the world frame.
// Each living tree keeps its LV95 position, crown diameter, total height, planting year, species and situation.
// The ArcGIS service refuses large envelopes, so the extent is read in 500 m tiles, each paged by 2000 records.
// Optional arguments (see tools/args.mjs): --extent minE,minN,maxE,maxN, --cache-suffix <dir>.
// usage: node tools/fetch-geneva-trees.mjs [--extent ...] [--cache-suffix ...]
import fs from 'node:fs';
import path from 'node:path';
import { FRAME } from '../js/geneva-frame.js';
import { CACHE, parseArgs, parseExtent, cacheFile } from './args.mjs';

const SERVICE = 'https://vector.sitg.ge.ch/arcgis/rest/services/SIPV_ICA_ARBRE_ISOLE/MapServer/0/query';
const FIELDS = 'ID_ARBRE,NOM_COMPLET,SITUATION,STATUT,HAUTEUR_TOTALE,DIAMETRE_COURONNE,DATE_PLANTATION';
const TILE = 500, PAGE = 2000;
const args = parseArgs(process.argv.slice(2));
const [minE, minN, maxE, maxN] = parseExtent(args.extent) ?? FRAME.lv95;
const log = (...a) => console.log('[geneva-trees]', ...a);

async function query(params) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${SERVICE}?${new URLSearchParams({ f: 'json', ...params })}`);
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(JSON.stringify(json.error || res.status));
      return json;
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

const seen = new Set();
const trees = [];
let gone = 0;
for (let e = minE; e < maxE; e += TILE) {
  for (let n = minN; n < maxN; n += TILE) {
    for (let offset = 0; ; offset += PAGE) {
      const { features, exceededTransferLimit } = await query({
        where: '1=1', geometry: `${e},${n},${Math.min(e + TILE, maxE)},${Math.min(n + TILE, maxN)}`,
        geometryType: 'esriGeometryEnvelope', inSR: '2056', outSR: '2056', spatialRel: 'esriSpatialRelIntersects',
        outFields: FIELDS, orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(PAGE)
      });
      for (const { attributes: a, geometry: g } of features) {
        const id = a.ID_ARBRE ?? `${g.x},${g.y}`;
        if (seen.has(id)) continue;
        seen.add(id);
        // The inventory also keeps the trees that were felled or have disappeared
        if (/dispar|abatt|mort|souche/i.test(a.STATUT || '')) { gone++; continue; }
        trees.push({
          E: Math.round(g.x * 10) / 10, N: Math.round(g.y * 10) / 10,
          crown: a.DIAMETRE_COURONNE || null, height: a.HAUTEUR_TOTALE || null,
          planted: a.DATE_PLANTATION ? new Date(a.DATE_PLANTATION).getUTCFullYear() : null,
          genus: (a.NOM_COMPLET || '').split(' ')[0], situation: a.SITUATION || ''
        });
      }
      if (!exceededTransferLimit && features.length < PAGE) break;
    }
  }
  log(`${trees.length} trees up to E ${Math.min(e + TILE, maxE)}`);
}
log(`${trees.length} living trees (${gone} felled or gone skipped)`);
const situations = {};
for (const t of trees) situations[t.situation] = (situations[t.situation] || 0) + 1;
log('situations:', JSON.stringify(situations));
const OUT = cacheFile(args.cacheSuffix, 'geneva_trees.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ source: SERVICE, fetched: new Date().toISOString().slice(0, 10), trees }));
log(`wrote ${OUT}`);
