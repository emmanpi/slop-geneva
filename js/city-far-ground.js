import * as THREE from 'three/webgpu';
import { positionWorld } from 'three/tsl';
import { TERRAIN, groundHeight } from './terrain.js';
import { orthoAt } from './orthophoto.js';

// js/city-far-ground.js
// The city's ground seen from above. It is built for the street: a 4 m terrain and the carriageways, footways, lawns and
// paint draped over it, ~8 M triangles, all of them in view from the helicopter (6 ms of a ~19 ms frame over the old
// town). From AIRBORNE m above the ground, the detailed ground meshes farther than reach(height) from the camera step
// aside for a light one: the terrain every 16 m under the city's 1 m orthophoto (~150 k triangles), laid DROP below so
// that it never shows through where the detailed ground is drawn. The water stays detailed. At street level nothing
// changes.

const AIRBORNE = 40; // m above the ground
const reach = (height) => Math.max(450, height * 5); // m: the detailed ground around the camera
const STEP = 4; // terrain nodes: every 4th (16 m)
const DROP = 1.5; // m
const TILE = 64; // terrain cells per far-ground tile (256 m)

function farTile(i0, j0, material) {
  const { cols, rows, cell, minX, minZ, heights } = TERRAIN;
  const i1 = Math.min(cols - 1, i0 + TILE), j1 = Math.min(rows - 1, j0 + TILE);
  const xs = [], zs = [];
  for (let i = i0; i < i1; i += STEP) xs.push(i);
  xs.push(i1);
  for (let j = j0; j < j1; j += STEP) zs.push(j);
  zs.push(j1);
  const pos = new Float32Array(xs.length * zs.length * 3);
  let k = 0;
  for (const j of zs) for (const i of xs) {
    pos[k++] = minX + i * cell; pos[k++] = heights[j * cols + i] - DROP; pos[k++] = minZ + j * cell;
  }
  const index = [];
  for (let r = 0; r < zs.length - 1; r++) for (let c = 0; c < xs.length - 1; c++) {
    const a = r * xs.length + c, b = a + 1, d = a + xs.length, e = d + 1;
    index.push(a, d, e, a, e, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.name = 'CityFarGround';
  mesh.userData.terrain = 'absolute';
  mesh.visible = false;
  return mesh;
}

// horizontal distance from (x, z) to a box
const boxDistance = (b, x, z) => Math.hypot(Math.max(b.min.x - x, 0, x - b.max.x), Math.max(b.min.z - z, 0, z - b.max.z));

/**
 * `cityGrid`: the city's ground group (city-grid.js, GenevaCityGrid). Returns { group, update(camera) }.
 */
export function buildCityFarGround(scene, cityGrid) {
  const group = new THREE.Group();
  group.name = 'CityFarGround';
  group.userData.terrain = 'absolute';
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  material.colorNode = orthoAt(positionWorld).color;
  const tiles = [];
  for (let j0 = 0; j0 < TERRAIN.rows - 1; j0 += TILE) for (let i0 = 0; i0 < TERRAIN.cols - 1; i0 += TILE) {
    const mesh = farTile(i0, j0, material);
    tiles.push({ mesh, box: mesh.geometry.boundingBox });
    group.add(mesh);
  }
  scene.add(group);

  // the detailed ground: the city grid's meshes but its water (and anything see-through: the water's glints)
  const detailed = [];
  for (const o of cityGrid?.children || []) {
    if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material) || o.material.name === 'CityWater' || o.material.transparent) continue;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    detailed.push({ mesh: o, box: o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld) });
  }

  let next = 0, aloft = false;
  function update(camera, now = performance.now()) {
    if (now < next) return;
    next = now + 200;
    const p = camera.position, height = p.y - groundHeight(p.x, p.z);
    if (height < AIRBORNE) {
      if (aloft) {
        for (const d of detailed) d.mesh.visible = true;
        for (const t of tiles) t.mesh.visible = false;
        aloft = false;
      }
      return;
    }
    aloft = true;
    const r = reach(height);
    for (const d of detailed) d.mesh.visible = boxDistance(d.box, p.x, p.z) < r;
    // the light ground where the detailed one may be hidden (not right under the camera: no showing through there)
    for (const t of tiles) t.mesh.visible = boxDistance(t.box, p.x, p.z) > r - 400;
  }
  return { group, update, stats: { tiles: tiles.length, detailed: detailed.length } };
}
