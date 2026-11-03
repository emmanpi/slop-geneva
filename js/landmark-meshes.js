import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createMaterial } from './photomesh.js';
import { groundHeight } from './terrain.js';

// Geneva's landmarks as photographed: the cathedral, the station, the churches, the theatres and palaces, cut out of the
// SITG photomesh by tools/build-landmarks.mjs (data/landmarks/). They stand in place of the procedural buildings
// (js/swissbuildings3d.js folds those away: LANDMARK_RINGS), at street level too; inside the photomesh areas, where
// the area tiles show the city from the air, they give way to those. Floodlit after dusk.

const INDEX_URL = new URL('../data/landmarks/index.json', import.meta.url);

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
          gltf.scene.traverse((o) => {
            if (!o.isMesh) return;
            o.material = createMaterial(o.material.map, { landmark: true, base });
            o.castShadow = true;
            o.receiveShadow = false;
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
