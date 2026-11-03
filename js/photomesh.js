import * as THREE from 'three/webgpu';
import { attribute, cross, dFdx, dFdy, dot, float, mix, normalize, positionWorld, pow, smoothstep, step, texture, uv, vec3 } from 'three/tsl';
import { orthoAt } from './orthophoto.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { cityUniforms } from './tsl-materials.js';

// The SITG's textured photomesh (Photomaillage 3D 2019, État de Genève) over test areas, converted by
// tools/build-photomesh.mjs into data/photomesh/<area>/ (glTF tiles in world coordinates). Inside an area the real city
// replaces the engine's own buildings and ground (hidden there: insidePhotomesh / photomeshMask); its tree crowns are
// flattened out (tools/build-photomesh.mjs) for the engine's own trees;
// streets, vehicles and people keep running on top of it.
// Areas: [name, minX, minZ, maxX, maxZ] in world coordinates (the bounds of data/photomesh/<name>/index.json)
export const PHOTOMESH_AREAS = [
  ['plainpalais', -400, 700, 0, 1200],
  ['vieilleville', 0, 100, 800, 900]
];

export function insidePhotomesh(x, z, margin = 0) {
  return PHOTOMESH_AREAS.some(([, x0, z0, x1, z1]) => x > x0 - margin && x < x1 + margin && z > z0 - margin && z < z1 + margin);
}

/** TSL: 1 inside a photomesh area at a world position node, else 0 */
export function photomeshMask(position = positionWorld) {
  return PHOTOMESH_AREAS.reduce((acc, [, x0, z0, x1, z1]) => acc.max(
    step(x0, position.x).mul(step(position.x, x1)).mul(step(z0, position.z)).mul(step(position.z, z1))
  ), float(0));
}

/** Hides a material's surface inside the photomesh areas (cut-out; transparent decals just fade) */
export function hideInPhotomesh(material) {
  if (!PHOTOMESH_AREAS.length || material.userData.photomeshHidden) return material;
  const keep = float(1).sub(photomeshMask());
  material.opacityNode = material.opacityNode ? material.opacityNode.mul(keep) : keep;
  if (!material.transparent) material.alphaTest = 0.5;
  material.userData.photomeshHidden = true;
  return material;
}

// Unlit (the photographs carry their own light). The renderer's ACES tone mapping washes out and desaturates colours
// that were never lit: the photos are graded against it (a little more contrast & saturation, a little darker), take
// a touch of the sun's colour (golden hour) and dim after dusk.
// The coarse tiles carry the photo as vertex colours (no texture): their roofs and ground, facing up, take the
// orthophoto instead, much sharper from the air.
function createMaterial(map) {
  const m = new THREE.MeshBasicNodeMaterial();
  const night = smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow);
  // Tree crowns were flattened out of the mesh at build time (_ORTHO = 1): there the ground is the orthophoto, without
  // its trees; the engine's own trees stand on it
  let flattened = attribute('_ortho', 'float');
  let base;
  if (map) {
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    base = texture(map, uv()).rgb;
  } else {
    // (the walls' colours average the photo's shade and sky light: lifted a little, and a little less blue)
    const raw = attribute('color', 'vec3');
    base = mix(vec3(dot(raw, vec3(0.2126, 0.7152, 0.0722))), raw, 0.75).mul(vec3(1.3, 1.25, 1.12));
    const faceNormal = normalize(cross(dFdx(positionWorld), dFdy(positionWorld)));
    flattened = flattened.max(smoothstep(0.7, 0.85, faceNormal.y.abs()));
  }
  const photo = pow(mix(base, orthoAt(positionWorld).color, flattened), vec3(1.18)).mul(0.9);
  const grey = dot(photo, vec3(0.2126, 0.7152, 0.0722));
  const graded = mix(vec3(grey), photo, 1.22).max(0);
  const sun = cityUniforms.uSunColor.div(dot(cityUniforms.uSunColor, vec3(0.2126, 0.7152, 0.0722)).max(0.05)).min(1.6);
  m.colorNode = graded.mul(mix(vec3(1), sun, 0.18)).mul(mix(float(1), float(0.16), night));
  return m;
}

// Streaming: every tile's coarse level (~12% of the triangles, 256 px) loads with the city; the full tiles (1024 px)
// within NEAR of the camera stream in, nearest first (MAX_FULL at most), and are released again beyond FAR (their GPU
// memory with them).
const NEAR = 240, FAR = 340, MAX_LOADING = 3, MAX_FULL = 28; // ~5 MB of GPU memory per full tile

export function buildPhotomesh(scene) {
  const group = new THREE.Group();
  group.name = 'Photomesh';
  group.userData.terrain = 'absolute'; // already in world heights
  scene.add(group);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const tiles = [];
  let loading = 0;
  const stats = { tiles: 0, full: 0, loading: 0 };
  group.userData.stats = stats;

  async function load(url) {
    // (a few retries: a busy static server may drop a connection while the city streams in)
    for (let attempt = 1; ; attempt++) {
      try {
        const gltf = await loader.loadAsync(url);
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          o.material = createMaterial(o.material.map);
          o.castShadow = true;
          o.receiveShadow = false;
          o.userData.terrain = 'absolute';
        });
        gltf.scene.userData.terrain = 'absolute';
        gltf.scene.matrixAutoUpdate = false;
        gltf.scene.updateMatrixWorld(true);
        return gltf.scene;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  function release(root) {
    group.remove(root);
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      o.material.map?.dispose();
      o.material.dispose();
    });
  }

  const done = Promise.all(PHOTOMESH_AREAS.map(async ([name]) => {
    const base = new URL(`../data/photomesh/${name}/`, import.meta.url);
    const index = await (await fetch(new URL('index.json', base))).json();
    await Promise.all(index.tiles.map(async (t) => {
      const tile = { name: t.file, base, file: t.file, min: t.min, max: t.max, lo: null, hi: null, wantHi: false, busy: false };
      tiles.push(tile);
      try {
        tile.lo = await load(new URL(t.lo || t.file, base).href);
        if (!tile.hi) group.add(tile.lo);
      } catch (error) {
        console.warn('[photomesh]', name, t.lo, error);
      }
    }));
    stats.tiles = tiles.length;
    console.info(`[photomesh] ${name}: ${index.tiles.length} tiles`);
  }));

  async function loadFull(tile) {
    tile.busy = true;
    loading++;
    try {
      const hi = await load(new URL(tile.file, tile.base).href);
      if (tile.wantHi) {
        tile.hi = hi;
        group.add(hi);
        if (tile.lo) group.remove(tile.lo);
      } else release(hi);
    } catch (error) {
      console.warn('[photomesh]', tile.file, error);
    } finally {
      tile.busy = false;
      loading--;
    }
  }

  // Distance from the camera to a tile's box
  const distance = (tile, p) => Math.hypot(
    Math.max(tile.min[0] - p.x, 0, p.x - tile.max[0]), Math.max(tile.min[1] - p.y, 0, p.y - tile.max[1]), Math.max(tile.min[2] - p.z, 0, p.z - tile.max[2]));
  let next = 0;
  function update(cameraPosition, now = performance.now()) {
    if (now < next || !tiles.length) return;
    next = now + 250;
    const order = tiles.map((t) => ({ t, d: distance(t, cameraPosition) })).sort((a, b) => a.d - b.d);
    let full = 0;
    for (const { t, d } of order) {
      if (d < NEAR && full++ < MAX_FULL) {
        t.wantHi = true;
        if (!t.hi && !t.busy && loading < MAX_LOADING) loadFull(t);
      } else if (d > FAR || full > MAX_FULL) {
        t.wantHi = false;
        if (t.hi) {
          release(t.hi);
          t.hi = null;
          if (t.lo) group.add(t.lo);
        }
      }
    }
    stats.full = tiles.filter((t) => t.hi).length;
    stats.loading = loading;
  }

  return { group, done, update };
}
