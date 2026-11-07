import * as THREE from 'three/webgpu';
import { texture, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { parseTerrain, gridHeight } from './terrain-grid.js';
import { setOuterGround, drapeOverlay, TERRAIN } from './terrain.js';
import { surroundingsHeight, setFineGround, curvature } from './surroundings.js';
import { FRAME } from './geneva-frame.js';
import { parseRoadway } from './roadway.js';
import { parseRoadMarks, buildRoadMarkTile, createRoadMarksMaterial } from './road-marks.js';
import { kerbGeometry, KERB_TOP } from './city-grid.js';
import { genevaPolygonGeometry } from './geneva-geometry.js';
import { createRoadSurfaceMaterial, createSidewalkMaterial, createCurbMaterial } from './tsl-materials.js';
import { createTreeField } from './trees.js';
import { PHENO } from './phenology.js';

// js/canton-ground.js
// The canton beyond the city in 1 km tiles (data/canton/<E>-<N>/, tools/build-canton-layers.mjs, the formats of the
// city's own files): the 4 m terrain under its 1 m orthophoto, and near the camera the street space (carriageways,
// islands, kerbs), the surveyed road markings and the inventory's trees. Streamed around the camera: the ground within
// a reach growing with the camera's height (4 m mesh near, 16 m beyond), the details within DETAIL_REACH.
// - terrain.js groundHeight answers beyond the city from here (the tiles, else the surroundings' relief), so whatever
//   stands on the ground stands on these tiles (the markings, the trees, the canton's buildings, the helicopter);
// - js/surroundings.js hides its coarse relief under the tiles shown (setFineGround);
// - the canton's buildings wait for their tile's ground before they bake (groundReady), so they stand on it.
// The tiles' heights take the surroundings' curvature drop, as the relief and the buildings around them do.

const INDEX_URL = new URL('../data/canton/index.json', import.meta.url);
const tileUrl = (key, file) => new URL(`../data/canton/${key}/${file}`, import.meta.url);
const DETAIL_REACH = 1600; // m: street space, markings, trees
const DETAIL_DROP = 3200; // m: beyond, a tile's details are released (rebuilt when the camera comes back)
const FINE_REACH = 1500; // m: the 4 m mesh (16 m beyond)
const groundReach = (y) => Math.min(5000, 2000 + Math.max(0, y) * 8); // m, like the canton's buildings (+ 500 m)
const FILES = { terrain: 'terrain.bin', ortho: 'ortho.jpg', roadway: 'roadway.bin', roadmarks: 'roadmarks.bin', trees: 'trees.json' };

const tiles = new Map(); // "E-N" -> tile
// The city draws its own ground: a tile straddling its edge leaves out what lies on the city's terrain grid
const inCity = (x, z) => x >= TERRAIN.minX && x <= TERRAIN.maxX && z >= TERRAIN.minZ && z <= TERRAIN.maxZ;
const centre = (pts) => { let x = 0, z = 0; for (const p of pts) { x += p.x; z += p.z; } return { x: x / pts.length, z: z / pts.length }; };
const outsideCity = (pts) => { const c = centre(pts); return !inCity(c.x, c.z); };
let indexReady = null;
const keyAt = (x, z) => `${Math.floor((x + FRAME.E0) / 1000)}-${Math.floor((FRAME.N0 - z) / 1000)}`;

// Beyond the city: the tile's terrain where loaded, else the surroundings' relief (NaN before it is in)
function outerGround(x, z) {
  const t = tiles.get(keyAt(x, z));
  if (t?.grid) return gridHeight(t.grid, x, z) - curvature(x, z);
  return surroundingsHeight ? surroundingsHeight(x, z) : NaN;
}

/** Resolves once the ground under (x, z) is final: its tile's terrain loaded, or no tile there */
export async function groundReady(x, z) {
  await indexReady;
  const t = tiles.get(keyAt(x, z));
  if (t) await t.groundLoaded;
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
}

// The terrain mesh over the tile, every `step` grid cells, with the photo
function terrainGeometry(t, step) {
  const g = t.grid, n = Math.floor((g.cols - 1) / step) + 1;
  const pos = new Float32Array(n * n * 3), uvs = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = g.minX + i * step * g.cell, z = g.minZ + j * step * g.cell, k = j * n + i;
      pos[k * 3] = x; pos[k * 3 + 1] = g.heights[j * step * g.cols + i * step] - curvature(x, z); pos[k * 3 + 2] = z;
      uvs[k * 2] = (x - t.x0) / 1000; uvs[k * 2 + 1] = (z - t.z0) / 1000; // row 0 of the photo: the north edge (z0)
    }
  }
  const index = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      if (inCity(pos[a * 3], pos[a * 3 + 2]) && inCity(pos[d * 3], pos[d * 3 + 2])) continue; // (the city's own ground)
      index.push(a, c, d, a, d, b); // (the diagonal of terrain-grid.js: (i, j) to (i + 1, j + 1))
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// --- Street space, markings, trees ------------------------------------------------------------------------------------------
let materials = null;
const sharedMaterials = () => (materials ??= {
  road: createRoadSurfaceMaterial(), island: createSidewalkMaterial(), kerb: createCurbMaterial(), marks: createRoadMarksMaterial()
});
let treeShare = null; // the first tile's tree field lends the others its leaf atlas and material

function mergeInto(group, geometries, material, { shadow = true, order = 0 } = {}) {
  const list = geometries.filter(Boolean);
  if (!list.length) return;
  let merged = null;
  try { merged = mergeGeometries(list, false); } catch { merged = null; }
  for (const g of merged ? [merged] : list) {
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = shadow;
    mesh.renderOrder = order;
    mesh.userData.terrain = 'absolute';
    group.add(mesh);
  }
  if (merged) for (const g of list) g.dispose();
}

async function loadDetails(t, scene) {
  const m = sharedMaterials();
  const group = new THREE.Group();
  group.name = `CantonDetails_${t.key}`;
  group.userData.terrain = 'absolute';
  const has = (layer) => t.layers.includes(layer);
  // the carriageways and islands draped on the tile's ground, the kerbs along them (as the city does: city-grid.js)
  if (has('roadway')) {
    const rw = parseRoadway(await fetchBuffer(tileUrl(t.key, FILES.roadway)));
    if (rw) {
      const lay = (c, y) => { const flat = genevaPolygonGeometry(c.ring, c.holes, y); const g = drapeOverlay(flat, { maxEdge: 6, lift: 0.05 }); flat.dispose(); return g; };
      mergeInto(group, rw.carriageways.filter((c) => outsideCity(c.ring)).map((c) => lay(c, 0.06)), m.road);
      mergeInto(group, rw.islands.filter((c) => outsideCity(c.ring)).map((c) => lay(c, KERB_TOP - 0.06)), m.island);
      mergeInto(group, rw.kerbs.filter((line) => line.length > 1 && outsideCity(line)).map((line) => kerbGeometry(line)), m.kerb);
    }
  }
  if (has('roadmarks')) {
    const d = parseRoadMarks(await fetchBuffer(tileUrl(t.key, FILES.roadmarks)));
    const lines = [], areas = [];
    for (let k = 0; k < d.nTiles; k++) {
      if (inCity((d.tiles[k * 4] + 0.5) * d.tile, (d.tiles[k * 4 + 1] + 0.5) * d.tile)) continue;
      const { lineGeo, areaGeo } = buildRoadMarkTile(d, k);
      if (lineGeo) lines.push(lineGeo);
      if (areaGeo) areas.push(areaGeo);
    }
    mergeInto(group, areas, m.marks, { order: -2 });
    mergeInto(group, lines, m.marks, { order: -1 });
  }
  // the inventory's trees, as the city plants its own (city-grid.js): their genus picks the crown and the calendar
  if (has('trees')) {
    const trees = (await (await fetch(tileUrl(t.key, FILES.trees))).json()).filter((tree) => !inCity(tree.x, tree.z));
    const sites = trees.map((tree) => {
      const h = Math.abs(Math.sin(tree.x * 1.9 + tree.z * 8.1));
      const pheno = tree.g ?? 0;
      return {
        x: tree.x, z: tree.z, y: 0.09, scale: tree.h ? Math.max(0.45, Math.min(1.8, tree.h / 13)) : 0.66 + h * 0.62,
        species: tree.g != null ? (PHENO[pheno].shape === 2 && h < 0.3 ? 0 : PHENO[pheno].shape) : h < 0.42 ? 0 : h < 0.65 ? 1 : 2,
        yaw: h * Math.PI * 2, pheno
      };
    });
    if (sites.length) {
      const field = createTreeField(scene, sites, treeShare);
      treeShare ??= { atlas: field.atlas, material: field.material };
      group.add(field.group);
      group.userData.trees = field;
    }
  }
  return group;
}

// A tile's details released: their geometries (the shared materials stay) and its tree field
function disposeDetails(g) {
  g.userData.trees?.dispose();
  g.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  g.removeFromParent();
}

// --- The tiles around the camera -------------------------------------------------------------------------------------------
export function buildCantonGround(scene) {
  const group = new THREE.Group();
  group.name = 'CantonGround';
  group.userData.terrain = 'absolute';
  scene.add(group);
  const stats = { tiles: 0, ground: 0, details: 0 };
  group.userData.stats = stats;
  setOuterGround(outerGround);

  indexReady = fetch(INDEX_URL).then((r) => (r.ok ? r.json() : null)).then((index) => {
    if (!index) return;
    for (const [key, info] of Object.entries(index.tiles)) {
      const [E, N] = key.split('-').map(Number);
      const t = {
        key, E, N, layers: info.layers, x0: E * 1000 - FRAME.E0, z0: FRAME.N0 - (N + 1) * 1000,
        grid: null, material: null, meshes: { fine: null, coarse: null }, details: null, busy: false, detailsBusy: false
      };
      t.groundLoaded = new Promise((resolve) => { t.resolveGround = resolve; });
      // (a tile without terrain has no ground to wait for)
      if (!t.layers.includes('terrain')) t.resolveGround();
      tiles.set(key, t);
    }
    stats.tiles = tiles.size;
    console.info(`[canton-ground] ${tiles.size} tiles of the canton's ground`);
  }).catch(() => {});

  async function loadGround(t) {
    t.busy = true;
    try {
      const buffer = await fetchBuffer(tileUrl(t.key, FILES.terrain));
      const grid = parseTerrain(buffer);
      const map = t.layers.includes('ortho') ? await new THREE.TextureLoader().loadAsync(tileUrl(t.key, FILES.ortho).href) : null;
      if (map) {
        map.colorSpace = THREE.SRGBColorSpace;
        map.flipY = false;
        map.anisotropy = 8;
        map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
      }
      t.material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
      if (map) t.material.colorNode = texture(map, uv()).rgb;
      t.map = map;
      // (the grid last: a tile with its grid is drawn, and its material must be there by then)
      t.grid = grid;
      setFineGround(t.E, t.N, true);
      stats.ground++;
    } catch (error) {
      console.warn('[canton-ground]', t.key, error.message);
    } finally {
      t.busy = false;
      t.resolveGround();
    }
  }
  function unloadGround(t) {
    for (const k of ['fine', 'coarse']) if (t.meshes[k]) { group.remove(t.meshes[k]); t.meshes[k].geometry.dispose(); t.meshes[k] = null; }
    t.material?.dispose();
    t.map?.dispose();
    t.grid = null; t.material = null; t.map = null;
    setFineGround(t.E, t.N, false);
    t.groundLoaded = new Promise((resolve) => { t.resolveGround = resolve; });
    stats.ground--;
  }
  function showMesh(t, fine) {
    const k = fine ? 'fine' : 'coarse';
    if (!t.meshes[k]) {
      const mesh = new THREE.Mesh(terrainGeometry(t, fine ? 1 : 4), t.material);
      mesh.receiveShadow = true;
      mesh.name = `CantonGround_${t.key}`;
      mesh.userData.terrain = 'absolute';
      t.meshes[k] = mesh;
      group.add(mesh);
    }
    t.meshes[k].visible = true;
    const other = t.meshes[fine ? 'coarse' : 'fine'];
    if (other) other.visible = false;
  }

  let next = 0;
  function update(camera, now = performance.now()) {
    if (now < next || !tiles.size) return;
    next = now + 300;
    const p = camera.position, reach = groundReach(p.y);
    for (const t of tiles.values()) {
      // distance from the camera to the tile's square
      const dx = Math.max(t.x0 - p.x, 0, p.x - (t.x0 + 1000)), dz = Math.max(t.z0 - p.z, 0, p.z - (t.z0 + 1000));
      const d = Math.hypot(dx, dz);
      if (d < reach) {
        if (!t.grid && !t.busy && t.layers.includes('terrain')) loadGround(t);
        if (t.grid) showMesh(t, d < FINE_REACH);
      } else if (t.grid && d > reach + 1000) unloadGround(t);
      // the details: built once near the camera, then shown or hidden (the trees' fields stay: js/trees.js)
      if (t.grid && d < DETAIL_REACH && !t.details && !t.detailsBusy) {
        t.detailsBusy = true;
        loadDetails(t, scene).then((g) => { t.details = g; group.add(g); stats.details++; })
          .catch((error) => console.warn('[canton-ground] details', t.key, error.message))
          .finally(() => { t.detailsBusy = false; });
      }
      if (t.details) {
        t.details.visible = d < DETAIL_REACH + 400;
        if (d > DETAIL_DROP) { disposeDetails(t.details); t.details = null; stats.details--; }
      }
    }
  }

  return { group, update, stats };
}
