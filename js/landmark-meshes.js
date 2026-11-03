import * as THREE from 'three/webgpu';
import { abs, float, floor, fract, mix, mx_noise_float, normalWorld, positionWorld, smoothstep, step, uniform, vec2, vec3, vertexColor } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cityUniforms } from './tsl-materials.js';
import { groundHeight } from './terrain.js';

// Geneva's landmarks: the cathedral, the station, the churches, the theatres and palaces. tools/build-landmarks.mjs
// cut each out of the SITG photomesh and made it clean massing in Blender (one solid, large flat faces), its faces in
// the few colours the photos show (stone, tiles, copper, slate). Drawn here lit like the rest of the city, in dressed
// stone (courses and joints on the walls, a fine grain), in place of the procedural buildings (js/swissbuildings3d.js
// folds those away), and floodlit warm from below after dusk.

const INDEX_URL = new URL('../data/landmarks/index.json', import.meta.url);

function landmarkMaterial(base) {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: true, side: THREE.DoubleSide });
  const wall = step(normalWorld.y.abs(), 0.45);
  const along = positionWorld.x.mul(normalWorld.z.abs()).add(positionWorld.z.mul(normalWorld.x.abs()));
  const course = floor(positionWorld.y.div(0.55));
  const block = fract(along.div(1.2).add(course.mul(0.5)));
  const joint = step(fract(positionWorld.y.div(0.55)), 0.035).max(step(block, 0.02)).mul(wall);
  const tone = mx_noise_float(vec2(floor(along.div(1.2).add(course.mul(0.5))), course).mul(2.7)).mul(0.07).add(0.97);
  const grain = mx_noise_float(positionWorld.mul(1.9)).mul(0.08).add(0.96);
  const col = vertexColor().rgb.mul(mix(float(1), tone, wall)).mul(grain);
  m.colorNode = mix(col, col.mul(0.72), joint.mul(0.8));
  m.roughnessNode = mix(float(0.7), float(0.9), wall);
  // after dusk: floodlit from the foot of the walls, fading up them
  const night = smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow);
  const flood = smoothstep(45, 2, positionWorld.y.sub(base)).mul(wall.mul(0.8).add(0.2));
  m.emissiveNode = vertexColor().rgb.mul(vec3(1.2, 0.95, 0.65)).mul(flood).mul(night).mul(0.55);
  return m;
}

export function buildLandmarkMeshes(scene) {
  const group = new THREE.Group();
  group.name = 'LandmarkMeshes';
  group.userData.terrain = 'absolute';
  scene.add(group);
  const stats = { landmarks: 0, triangles: 0, names: [] };
  group.userData.stats = stats;
  const loader = new GLTFLoader();
  const done = (async () => {
    const index = await (await fetch(INDEX_URL)).json();
    await Promise.all(index.landmarks.map(async (l) => {
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const gltf = await loader.loadAsync(new URL(l.file, INDEX_URL).href);
          let base = Infinity;
          for (let i = 0; i < l.ring.length; i += 2) base = Math.min(base, groundHeight(l.ring[i], l.ring[i + 1]));
          const material = landmarkMaterial(base);
          gltf.scene.traverse((o) => {
            if (!o.isMesh) return;
            o.material = material;
            o.castShadow = o.receiveShadow = true;
          });
          gltf.scene.name = l.name;
          gltf.scene.userData.terrain = 'absolute';
          group.add(gltf.scene);
          stats.landmarks++;
          stats.triangles += l.triangles;
          stats.names.push(l.name);
          return;
        } catch (error) {
          if (attempt === 4) console.warn('[landmarks]', l.name, error);
          else await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }));
  })();
  return { group, done, stats };
}
