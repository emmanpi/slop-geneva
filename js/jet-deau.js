import * as THREE from 'three/webgpu';
import { GENEVA_DATA } from './geneva-geodata.js';
import { lv95ToWorld } from './geneva-frame.js';
import { groundHeight } from './terrain.js';
import { createJetSprayMaterial } from './tsl-materials.js';

// Geneva's Jet d'eau (1891, its current form 1951): 500 l/s pumped out of the lake at ~200 km/h from the end of the
// Jetée des Eaux-Vives, up to ~140 m. The plume is a GPU particle system (tsl-materials.js, createJetSprayMaterial):
// each sprite flies its own ballistic arc and falls back downwind.
// The position is OSM's fountain node "Jet d'eau" (fountain=jet_water), else its surveyed LV95 position.

const SPRITES = 2600;
// The bise blows from the north-east, down the lake: the spray falls back towards the south-west (x east, z south)
const WIND = new THREE.Vector2(-0.55, 0.42);

export function jetPosition() {
  const node = GENEVA_DATA.fountains.find((f) => /^jet d'eau$/i.test(f.name));
  return node ? { x: node.x, z: node.z } : lv95ToWorld(2500986, 1118137);
}

export function buildJetDeau(scene) {
  const { x, z } = jetPosition();
  const origin = new THREE.Vector3(x, groundHeight(x, z) + 0.6, z);
  const params = new Float32Array(SPRITES * 4);
  // Deterministic, evenly spread phases (golden ratio) so the column never shows gaps
  for (let i = 0; i < SPRITES; i++) {
    const r = (k) => { const v = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
    params[i * 4] = (i * 0.6180339887) % 1; // phase along the flight
    params[i * 4 + 1] = 0.86 + 0.14 * Math.sqrt(r(1)); // speed factor: most water reaches the top (h ∝ v²: 103-140 m)
    params[i * 4 + 2] = r(2); // spread seed (angle & radius)
    params[i * 4 + 3] = 0.7 + 0.6 * r(3); // size factor
  }
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute('aJetParams', new THREE.InstancedBufferAttribute(params, 4));
  const spray = new THREE.Mesh(geometry, createJetSprayMaterial({ origin, wind: WIND }));
  spray.count = SPRITES;
  spray.frustumCulled = false; // positions come from the shader; the plume stands over the whole city
  spray.renderOrder = 2;
  spray.name = 'JetDeauSpray';

  // The nozzle housing at the tip of the jetty, just above the water
  const nozzle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.2, 1.2, 20),
    new THREE.MeshStandardNodeMaterial({ color: 0x5b6066, roughness: 0.55, metalness: 0.4 })
  );
  nozzle.position.set(x, origin.y - 0.6, z);
  nozzle.castShadow = nozzle.receiveShadow = true;

  const group = new THREE.Group();
  group.name = 'JetDeau';
  group.userData.terrain = 'absolute'; // already in world heights (terrain.js placeOnTerrain leaves it alone)
  group.add(spray, nozzle);
  scene.add(group);
  return { group, position: origin, height: 140 };
}
