import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { register } from 'node:module';
import { wgs84ToLv95, lv95ToWgs84 } from '../js/swiss-projection.js';
import { FRAME, WORLD_BOUNDS, lv95ToWorld } from '../js/geneva-frame.js';
import { parseTerrain, gridHeight } from '../js/terrain-grid.js';
import { GENEVA_DATA } from '../js/geneva-geodata.js';
import { PHENO, phenoClass, phenoState } from '../js/phenology.js';

const terrainFile = fs.readFileSync(new URL('../data/geneva-terrain.bin', import.meta.url));
const TERRAIN = parseTerrain(terrainFile.buffer.slice(terrainFile.byteOffset, terrainFile.byteOffset + terrainFile.byteLength));
const heightAt = (E, N) => { const p = lv95ToWorld(E, N); return gridHeight(TERRAIN, p.x, p.z) + FRAME.H0; };

test('WGS84 -> LV95 matches swisstopo REFRAME to the millimetre, and round-trips', () => {
  // https://geodesy.geo.admin.ch/reframe/wgs84tolv95
  for (const [lon, lat, E, N] of [[8.54, 47.37, 2683186.285581739, 1247156.7439824815], [8.505, 47.361, 2680556.51552824, 1246119.6876790135]]) {
    const p = wgs84ToLv95(lon, lat);
    assert.ok(Math.abs(p.E - E) < 0.002 && Math.abs(p.N - N) < 0.002, `${lon}, ${lat}: ${p.E}, ${p.N}`);
    const back = lv95ToWgs84(p.E, p.N);
    assert.ok(Math.abs(back.lon - lon) < 1e-7 && Math.abs(back.lat - lat) < 1e-7);
  }
});

test('the terrain grid covers the frame with plausible Geneva heights', () => {
  const [minX, minZ, maxX, maxZ] = WORLD_BOUNDS;
  assert.equal(TERRAIN.minX, minX);
  assert.equal(TERRAIN.minZ, minZ);
  assert.equal(TERRAIN.maxX, maxX);
  assert.equal(TERRAIN.maxZ, maxZ);
  // Lake level, the old town's hill, the Rhône below the Seujet dam, the Nations' plateau (swissALTI3D, m a.s.l.)
  assert.ok(Math.abs(heightAt(2501200, 1118500) - 372) < 0.5, 'Léman');
  assert.ok(heightAt(2500411, 1117448) > 395, 'Cathédrale Saint-Pierre on its hill');
  assert.ok(heightAt(2499560, 1117900) < 372, 'the Rhône below the lake');
  assert.ok(heightAt(2499848, 1120281) > 410, 'Palais des Nations above the lake');
});

test('every bridge has a deck height per point, never below the terrain it spans', () => {
  for (const r of [...GENEVA_DATA.roads, ...GENEVA_DATA.railways]) {
    if (!r.bridge) continue;
    assert.equal(r.ys?.length, r.pts.length / 2, `${r.id} ${r.name}`);
    // (points are rounded to 0.1 m, so the terrain is sampled a few centimetres off on slopes)
    r.ys.forEach((y, i) => assert.ok(y >= gridHeight(TERRAIN, r.pts[i * 2], r.pts[i * 2 + 1]) - 0.1, `${r.id} ${r.name} point ${i}`));
  }
});

test('the Rhône bridges stay near the water; the Arve bridges clear it', () => {
  for (const name of ['Pont du Mont-Blanc', 'Pont de la Machine', 'Pont des Bergues']) {
    const spans = GENEVA_DATA.roads.filter((q) => q.name === name && q.bridge);
    assert.ok(spans.length, name);
    for (const r of spans) assert.ok(Math.max(...r.ys) < 6, `${name} at most a few metres above the lake level`);
  }
  const acacias = GENEVA_DATA.roads.filter((q) => q.name === 'Pont des Acacias' && q.bridge);
  const clearance = Math.max(...acacias.flatMap((r) => r.ys.map((y, i) => y - gridHeight(TERRAIN, r.pts[i * 2], r.pts[i * 2 + 1]))));
  assert.ok(clearance > 4, `Pont des Acacias clearance ${clearance.toFixed(1)} m`);
});

test('one stands on the Pont du Mont-Blanc over the water, never under it', async () => {
  // js/terrain.js only draws with three.js inside its functions: an empty stand-in lets Node load its height functions
  const three = encodeURIComponent('export class Box3 {} export class Vector3 {} export class Matrix4 {}');
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) { return s === 'three/webgpu' ? { url: 'data:text/javascript,${three}', shortCircuit: true } : next(s, c); }`)}`);
  const { groundHeight, deckHeight, surfaceHeight } = await import('../js/terrain.js');
  const span = GENEVA_DATA.roads.filter((r) => r.name === 'Pont du Mont-Blanc' && r.bridge).sort((a, b) => b.pts.length - a.pts.length)[0];
  const n = span.pts.length / 2, i = Math.max(0, (n >> 1) - 1);
  const q = { x: (span.pts[i * 2] + span.pts[i * 2 + 2]) / 2, z: (span.pts[i * 2 + 1] + span.pts[i * 2 + 3]) / 2 };
  const deck = deckHeight(q.x, q.z), water = groundHeight(q.x, q.z);
  assert.ok(deck - water > 1.5, `the bridge clears the water (${(deck - water).toFixed(1)} m)`);
  assert.equal(surfaceHeight(q.x, q.z, water), deck, 'from the water level, the deck');
});

test('the city keeps its landmarks, quarters, trees and road graph', () => {
  for (const name of ['Cathédrale Saint-Pierre', 'Gare Cornavin', 'Palais des Nations', 'Hôtel de Ville', 'Grand Théâtre', 'Bâtiment des Forces Motrices']) {
    assert.ok(GENEVA_DATA.landmarks[name], name);
  }
  const quarters = GENEVA_DATA.meta.areas.map((a) => a.name);
  for (const name of ['Cité', 'Pâquis', 'Eaux-Vives', 'Plainpalais', 'Jonction', 'Grottes et Saint-Gervais']) assert.ok(quarters.includes(name), name);
  assert.ok(GENEVA_DATA.trees.length > 20000, 'cantonal tree inventory');
  const { nodes, links } = GENEVA_DATA.roadGraph;
  for (const l of links) assert.ok(l[0] * 2 < nodes.length && l[1] * 2 < nodes.length);
  assert.ok(!GENEVA_DATA.roads.some((r) => r.kind === 'footway' && /crossing/.test(r.name)), 'no crosswalk ways');
});

test('the swissBUILDINGS3D tiles are stored in the repository, complete', () => {
  const dir = new URL('../data/swissbuildings3d/', import.meta.url);
  const index = JSON.parse(fs.readFileSync(new URL('index.json', dir), 'utf8'));
  assert.match(index.release, /^\d{8}$/);
  assert.ok(index.tiles.length > 500);
  for (const t of index.tiles) {
    const buf = fs.readFileSync(new URL(index.base + t.u, dir));
    assert.equal(buf.toString('ascii', 0, 4), 'b3dm', t.u);
    assert.equal(buf.readUInt32LE(8), buf.length, `${t.u} is complete`);
  }
});

test('the Jet d\'eau stands in the lake at the tip of the Jetée des Eaux-Vives', async () => {
  const jet = GENEVA_DATA.fountains.find((f) => f.name === "Jet d'eau");
  assert.ok(jet, 'OSM fountain node');
  const p = lv95ToWorld(2500986, 1118137);
  assert.ok(Math.hypot(jet.x - p.x, jet.z - p.z) < 40, 'near its surveyed position');
  assert.ok(Math.abs(gridHeight(TERRAIN, jet.x, jet.z)) < 1, 'at lake level');
});

test('every stored building tile has its facade styles from the RegBL', () => {
  const index = JSON.parse(fs.readFileSync(new URL('../data/swissbuildings3d/index.json', import.meta.url), 'utf8'));
  const facades = JSON.parse(fs.readFileSync(new URL('../data/geneva-facades.json', import.meta.url), 'utf8'));
  assert.deepEqual(facades.styles, ['ancien', 'xixe', 'moderne', 'contemporain', 'bureaux', 'inconnu']);
  let known = 0, total = 0;
  for (const t of index.tiles) {
    const entries = facades.tiles[t.u];
    assert.ok(typeof entries === 'string', t.u);
    for (const e of entries.split(';').filter(Boolean)) {
      const [style, storey] = e.split(',').map(Number);
      assert.ok(style >= 0 && style < facades.styles.length && storey >= 24 && storey <= 50, `${t.u}: ${e}`);
      total++; if (style !== 5) known++;
    }
  }
  assert.ok(known / total > 0.8, `${known}/${total} buildings with a known style`);
});

test('the orthophoto covers the frame at 1 m per pixel', () => {
  const meta = JSON.parse(fs.readFileSync(new URL('../data/geneva-ortho.json', import.meta.url), 'utf8'));
  assert.deepEqual(meta.lv95, FRAME.lv95);
  assert.equal(meta.width, FRAME.lv95[2] - FRAME.lv95[0]);
  assert.equal(meta.height, FRAME.lv95[3] - FRAME.lv95[1]);
  const jpg = fs.readFileSync(new URL('../data/geneva-ortho.jpg', import.meta.url));
  assert.equal(jpg.readUInt16BE(0), 0xffd8, 'a JPEG');
});

test('every photomesh area in js/photomesh.js has its converted tiles, with the same bounds', () => {
  const source = fs.readFileSync(new URL('../js/photomesh.js', import.meta.url), 'utf8');
  const areas = [...source.matchAll(/\['([a-z-]+)', (-?\d+), (-?\d+), (-?\d+), (-?\d+)\]/g)].map((m) => [m[1], ...m.slice(2).map(Number)]);
  assert.ok(areas.length > 0);
  for (const [name, ...bounds] of areas) {
    const dir = new URL(`../data/photomesh/${name}/`, import.meta.url);
    const index = JSON.parse(fs.readFileSync(new URL('index.json', dir), 'utf8'));
    assert.deepEqual(index.bounds, bounds, name);
    assert.ok(index.tiles.length > 0, name);
    for (const t of index.tiles) {
      const glb = fs.readFileSync(new URL(t.file, dir));
      assert.equal(glb.toString('ascii', 0, 4), 'glTF', t.file);
      // the mesh sits at the city's heights (a few metres around the lake level here, never hundreds)
      assert.ok(t.min[1] > -20 && t.max[1] < 150, `${t.file} heights ${t.min[1]}..${t.max[1]}`);
    }
  }
});

test('trees follow their genus through the seasons', () => {
  const trees = GENEVA_DATA.trees;
  assert.ok(trees.every((t) => Number.isInteger(t.g) && PHENO[t.g]), 'every inventory tree has a phenology class');
  assert.ok(trees.filter((t) => PHENO[t.g].evergreen).length > 3000, 'pines, yews, cedars stay green');
  assert.equal(phenoClass('Acer'), 2);
  assert.equal(phenoClass('Platanus'), 3);
  assert.ok(PHENO[phenoClass('Pinus')].evergreen);
  // Maple: bare in January, in leaf in July, turned by early November, still bare at Christmas; pines always green
  const maple = phenoClass('Acer');
  assert.ok(phenoState(maple, 15).leaves < 0.01);
  assert.ok(phenoState(maple, 195).leaves > 0.99 && phenoState(maple, 195).turned < 0.01);
  assert.ok(phenoState(maple, 300).turned > 0.4);
  assert.ok(phenoState(maple, 358).leaves < 0.01);
  // Horse chestnuts brown before the planes
  assert.ok(phenoState(phenoClass('Aesculus'), 280).turned > phenoState(phenoClass('Platanus'), 280).turned);
  assert.deepEqual(phenoState(phenoClass('Pinus'), 15), { leaves: 1, turned: 0 });
});
