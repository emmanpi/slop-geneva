import * as THREE from 'three/webgpu';
import { attribute, dot, float, mix, positionWorld, pow, smoothstep, step, texture, uv, vec3 } from 'three/tsl';
import { orthoAt } from './orthophoto.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cityUniforms } from './tsl-materials.js';

// The SITG's textured photomesh (Photomaillage 3D 2019, État de Genève) over test areas, converted by
// tools/build-photomesh.mjs into data/photomesh/<area>/ (glTF tiles in world coordinates). Inside an area the real city
// replaces the engine's own buildings and ground (hidden there: insidePhotomesh / photomeshMask); its tree crowns are
// flattened out (tools/build-photomesh.mjs) for the engine's own trees;
// streets, vehicles and people keep running on top of it.
// Areas: [name, minX, minZ, maxX, maxZ] in world coordinates (the bounds of data/photomesh/<name>/index.json)
export const PHOTOMESH_AREAS = [
  ['plainpalais', -400, 700, 0, 1200]
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
function createMaterial(map) {
  const m = new THREE.MeshBasicNodeMaterial();
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const night = smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow);
  // Tree crowns were flattened out of the mesh at build time (_ORTHO = 1): there the ground is the orthophoto, without
  // its trees; the engine's own trees stand on it
  const flattened = attribute('_ortho', 'float');
  const photo = pow(mix(texture(map, uv()).rgb, orthoAt(positionWorld).color, flattened), vec3(1.18)).mul(0.9);
  const grey = dot(photo, vec3(0.2126, 0.7152, 0.0722));
  const graded = mix(vec3(grey), photo, 1.22).max(0);
  const sun = cityUniforms.uSunColor.div(dot(cityUniforms.uSunColor, vec3(0.2126, 0.7152, 0.0722)).max(0.05)).min(1.6);
  m.colorNode = graded.mul(mix(vec3(1), sun, 0.18)).mul(mix(float(1), float(0.16), night));
  return m;
}

export function buildPhotomesh(scene) {
  const group = new THREE.Group();
  group.name = 'Photomesh';
  group.userData.terrain = 'absolute'; // already in world heights
  scene.add(group);
  const loader = new GLTFLoader();
  const done = Promise.all(PHOTOMESH_AREAS.map(async ([name]) => {
    const base = new URL(`../data/photomesh/${name}/`, import.meta.url);
    const index = await (await fetch(new URL('index.json', base))).json();
    await Promise.all(index.tiles.map(async (t) => {
      try {
        // (a few retries: a busy static server may drop a connection while the city streams in)
        let gltf;
        for (let attempt = 1; ; attempt++) {
          try { gltf = await loader.loadAsync(new URL(t.file, base).href); break; }
          catch (error) { if (attempt >= 4) throw error; await new Promise((r) => setTimeout(r, 500 * attempt)); }
        }
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          o.material = createMaterial(o.material.map);
          o.castShadow = true;
          o.receiveShadow = false;
          o.userData.terrain = 'absolute';
        });
        gltf.scene.userData.terrain = 'absolute';
        group.add(gltf.scene);
      } catch (error) {
        console.warn('[photomesh]', name, t.file, error);
      }
    }));
    console.info(`[photomesh] ${name}: ${index.tiles.length} tiles`);
  }));
  return { group, done };
}
