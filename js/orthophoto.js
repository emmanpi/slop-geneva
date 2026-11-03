import * as THREE from 'three/webgpu';
import { step, texture, uniform, vec2 } from 'three/tsl';
import { FRAME } from './geneva-frame.js';

// The SWISSIMAGE orthophoto of the world frame (data/geneva-ortho.jpg, tools/build-geneva-ortho.mjs): 1 m per pixel,
// row 0 at the frame's north edge, column 0 at its west edge. One texture shared by the materials that sample it (the
// swissBUILDINGS3D roofs, the ground seen from afar); it streams in while the city loads (black until then, so the
// materials fade it in with orthoReady).

const [minE, minN, maxE, maxN] = FRAME.lv95;
const MIN_X = minE - FRAME.E0, MIN_Z = FRAME.N0 - maxN;
const SIZE_X = maxE - minE, SIZE_Z = maxN - minN;

let orthoTexture = null;
const ready = uniform(0); // 1 once the photo has loaded

function loadTexture() {
  if (orthoTexture) return orthoTexture;
  orthoTexture = new THREE.TextureLoader().load(new URL('../data/geneva-ortho.jpg', import.meta.url).href, () => {
    ready.value = 1;
  }, undefined, (error) => console.warn('[orthophoto] not loaded:', error));
  orthoTexture.colorSpace = THREE.SRGBColorSpace;
  orthoTexture.flipY = false; // uv.y = 0 is the first row: the north edge
  orthoTexture.wrapS = orthoTexture.wrapT = THREE.ClampToEdgeWrapping;
  orthoTexture.anisotropy = 8;
  orthoTexture.generateMipmaps = true;
  orthoTexture.minFilter = THREE.LinearMipmapLinearFilter;
  return orthoTexture;
}

/**
 * TSL nodes for the orthophoto at a world position (a vec3 node, e.g. positionWorld):
 *  - color: the photo's colour (linear);
 *  - weight: 1 inside the frame once the photo has loaded, 0 outside or before.
 */
export function orthoAt(position) {
  const uv = vec2(position.x.sub(MIN_X).div(SIZE_X), position.z.sub(MIN_Z).div(SIZE_Z));
  const inside = step(0.0, uv.x).mul(step(uv.x, 1.0)).mul(step(0.0, uv.y)).mul(step(uv.y, 1.0));
  return { color: texture(loadTexture(), uv).rgb, weight: inside.mul(ready) };
}

export const ORTHO_FRAME = { minX: MIN_X, minZ: MIN_Z, sizeX: SIZE_X, sizeZ: SIZE_Z, ready };
