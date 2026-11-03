import * as THREE from 'three/webgpu';
import { loadSwissTile } from './swissbuildings3d.js';
import { surroundingsHeight } from './surroundings.js';

// The canton's buildings beyond the mapped city: swissBUILDINGS3D 3.0 tiles (data/geneva-canton-buildings.json, from
// tools/build-geneva-canton.mjs) streamed straight from swisstopo's 3D Tiles service around the camera, nearest first,
// and released again once the camera has moved on. The reach grows with the camera's height: ~1.5 km from the street
// (only the frame's edges look out that far), up to 4.5 km from the helicopter. They stand on the surroundings' relief
// (js/surroundings.js) in the city's facade material, unlit by the RegBL (style "inconnu").

const INDEX_URL = new URL('../data/geneva-canton-buildings.json', import.meta.url);
const MAX_TILES = 1400, CONCURRENCY = 6;

export function buildCanton(scene) {
  const group = new THREE.Group();
  group.name = 'CantonBuildings';
  group.userData.terrain = 'absolute';
  scene.add(group);
  const stats = { tiles: 0, loaded: 0, loading: 0, failed: 0 };
  group.userData.stats = stats;
  let tiles = [], origin = '';
  const bake = { offsets: [], ground: null };
  fetch(INDEX_URL).then((r) => (r.ok ? r.json() : null)).then((index) => {
    if (!index) return;
    origin = index.origin;
    tiles = index.tiles.map(([u, x, z], i) => ({ u, x, z, seed: 50000 + i * 977, mesh: null, busy: false, want: false }));
    stats.tiles = tiles.length;
  }).catch((error) => console.warn('[canton] no tile index:', error));

  let loading = 0, next = 0;
  async function load(t) {
    t.busy = true;
    loading++;
    try {
      const mesh = await loadSwissTile(origin + t.u, { seed: t.seed, stats: bake });
      if (mesh && t.want) {
        mesh.name = t.u;
        mesh.matrixAutoUpdate = false;
        t.mesh = mesh;
        group.add(mesh);
      } else if (mesh) mesh.geometry.dispose();
    } catch (error) {
      stats.failed++;
      if (stats.failed <= 3) console.warn('[canton]', t.u, error);
    } finally {
      t.busy = false;
      loading--;
      pump();
    }
  }
  // Keep CONCURRENCY downloads going through the wanted tiles, nearest first
  let queue = [];
  function pump() {
    while (loading < CONCURRENCY && queue.length) {
      const t = queue.shift();
      if (t.want && !t.mesh && !t.busy) load(t);
    }
  }

  function update(camera, now = performance.now()) {
    if (now < next || !tiles.length || !surroundingsHeight) return;
    next = now + 400;
    bake.ground ??= surroundingsHeight;
    const p = camera.position;
    const reach = Math.min(4500, 1500 + Math.max(0, p.y) * 8);
    const order = [];
    for (const t of tiles) {
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      if (d < reach) order.push([d, t]);
      else if (t.mesh && d > reach * 1.25 + 200) {
        group.remove(t.mesh);
        t.mesh.geometry.dispose();
        t.mesh = null;
        t.want = false;
      }
    }
    order.sort((a, b) => a[0] - b[0]);
    let kept = 0;
    for (const [, t] of order) {
      if (kept++ >= MAX_TILES) {
        if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
        t.want = false;
        continue;
      }
      t.want = true;
    }
    queue = order.map(([, t]) => t).filter((t) => t.want && !t.mesh && !t.busy);
    pump();
    stats.loaded = group.children.length;
    stats.loading = loading;
  }

  return { group, update };
}
