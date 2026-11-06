import * as THREE from 'three/webgpu';
import { attribute, cross, dFdx, dFdy, dot, float, length, mix, normalize, positionWorld, pow, smoothstep, step, texture, uniform, uv, vec2, vec3 } from 'three/tsl';
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

// The Photomesh button (js/main.js): 1 while the real city is shown in its areas; 0 unloads it, and the engine's own
// buildings, ground and markings come back there (they are only folded away while it shows: see photomeshMask)
export const photomeshOn = uniform(1);

// Street level: the photomesh, made from the air, is poor up close (smeared ground floors, narrow streets). With the
// camera near the ground, the procedural city (its facades coloured from the photos) takes over within streetRadius
// of it; the photomesh stays beyond. Rising, the radius closes (12-35 m above the ground): the air view is all photo.
export const streetCamera = uniform(new THREE.Vector2(1e6, 1e6));
export const streetRadius = uniform(0);
const STREET_RADIUS = 350;
/** TSL: 1 beyond the street view's circle (where the photomesh shows) */
export const outsideStreetView = (xz) => step(streetRadius, length(xz.sub(streetCamera)));
/** Sets the street view from the camera (x, z) and its height above the ground; returns the radius */
export function setStreetView(x, z, aboveGround) {
  streetCamera.value.set(x, z);
  const t = Math.min(1, Math.max(0, (aboveGround - 12) / 23));
  streetRadius.value = STREET_RADIUS * (1 - t * t * (3 - 2 * t));
  return streetRadius.value;
}

export function insidePhotomesh(x, z, margin = 0) {
  return PHOTOMESH_AREAS.some(([, x0, z0, x1, z1]) => x > x0 - margin && x < x1 + margin && z > z0 - margin && z < z1 + margin);
}

/** TSL: 1 inside a photomesh area at a world position node while the photomesh shows, else 0 */
export function photomeshMask(position = positionWorld) {
  return PHOTOMESH_AREAS.reduce((acc, [, x0, z0, x1, z1]) => acc.max(
    step(x0, position.x).mul(step(position.x, x1)).mul(step(z0, position.z)).mul(step(position.z, z1))
  ), float(0)).mul(photomeshOn).mul(outsideStreetView(vec2(position.x, position.z)));
}

/** Hides a material's surface inside the photomesh areas (cut-out; transparent decals just fade) */
export function hideInPhotomesh(material) {
  if (!PHOTOMESH_AREAS.length || material.userData.photomeshHidden) return material;
  const keep = float(1).sub(photomeshMask());
  material.opacityNode = material.opacityNode ? material.opacityNode.mul(keep) : keep;
  // (an alphaTestNode, not `alphaTest`: an alpha-tested shadow caster made three.js re-hash every caster's node graph
  // each frame, see createTreeMaterial in tsl-materials.js)
  if (!material.transparent) material.alphaTestNode = float(0.5);
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
  // cut away (and casting no shadow) within the street view's circle
  const shown = outsideStreetView(positionWorld.xz);
  m.opacityNode = shown;
  m.alphaTestNode = float(0.5); // (alphaTestNode, not alphaTest: see createTreeMaterial (tsl-materials.js))
  m.maskShadowNode = shown.greaterThan(0.5);
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

  let enabled = photomeshOn.value > 0.5;
  let generation = 0; // bumped by every switch, so loads finishing after one are dropped
  async function loadCoarse(tile) {
    const gen = generation;
    try {
      const lo = await load(new URL(tile.loFile, tile.base).href);
      if (gen !== generation || !enabled) { release(lo); return; }
      tile.lo = lo;
      if (!tile.hi) group.add(lo);
    } catch (error) {
      console.warn('[photomesh]', tile.loFile, error);
    }
  }
  const done = Promise.all(PHOTOMESH_AREAS.map(async ([name]) => {
    const base = new URL(`../data/photomesh/${name}/`, import.meta.url);
    const index = await (await fetch(new URL('index.json', base))).json();
    const mine = index.tiles.map((t) => ({ name: t.file, base, file: t.file, loFile: t.lo || t.file, min: t.min, max: t.max, lo: null, hi: null, wantHi: false, busy: false }));
    tiles.push(...mine);
    if (enabled) await Promise.all(mine.map(loadCoarse));
    stats.tiles = tiles.length;
    console.info(`[photomesh] ${name}: ${index.tiles.length} tiles`);
  }));

  /** Shows (loading the coarse tiles again) or unloads the photomesh; the engine's city fills its areas when off */
  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return;
    enabled = on;
    generation++;
    photomeshOn.value = on ? 1 : 0;
    group.visible = on;
    if (!on) {
      for (const t of tiles) {
        t.wantHi = false;
        if (t.hi) { release(t.hi); t.hi = null; }
        if (t.lo) { release(t.lo); t.lo = null; }
      }
      stats.full = 0;
    } else for (const t of tiles) loadCoarse(t);
  }

  async function loadFull(tile) {
    tile.busy = true;
    loading++;
    const gen = generation;
    try {
      const hi = await load(new URL(tile.file, tile.base).href);
      if (tile.wantHi && enabled && gen === generation) {
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
    if (now < next || !tiles.length || !enabled) return;
    next = now + 250;
    const order = tiles.map((t) => ({ t, d: distance(t, cameraPosition) })).sort((a, b) => a.d - b.d);
    // tiles wholly inside the street view's circle show nothing: no full level for them
    const r = streetRadius.value, cx = streetCamera.value.x, cz = streetCamera.value.y;
    const hidden = (t) => r > 0 && Math.max(Math.hypot(t.min[0] - cx, t.min[2] - cz), Math.hypot(t.max[0] - cx, t.min[2] - cz), Math.hypot(t.min[0] - cx, t.max[2] - cz), Math.hypot(t.max[0] - cx, t.max[2] - cz)) < r - 5;
    let full = 0;
    for (const { t, d } of order) {
      if (d < NEAR && !hidden(t) && full++ < MAX_FULL) {
        t.wantHi = true;
        if (!t.hi && !t.busy && loading < MAX_LOADING) loadFull(t);
      } else if (d > FAR || full > MAX_FULL || hidden(t)) {
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

  return { group, done, update, setEnabled, get enabled() { return enabled; } };
}
