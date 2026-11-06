import * as THREE from 'three/webgpu';
import { loadSwissTile, bakeFootprints } from './swissbuildings3d.js';
import { surroundingsHeight } from './surroundings.js';

// The canton's buildings beyond the mapped city: swissBUILDINGS3D 3.0 tiles (data/geneva-canton-buildings.json, from
// tools/build-geneva-canton.mjs) streamed straight from swisstopo's 3D Tiles service around the camera, nearest first,
// and released again once the camera has moved on. The reach grows with the camera's height: ~1.5 km from the street
// (only the frame's edges look out that far), up to 4.5 km from the helicopter. They stand on the surroundings' relief
// (js/surroundings.js) in the city's facade material. Their facades (style, storey height, wall colour, windows) come
// from data/geneva-canton-facades.json when it is there (same format as data/geneva-facades.json, per canton tile:
// tools/build-geneva-canton-facades.mjs); without it they stay unknown (style "inconnu", a generic colour).

const INDEX_URL = new URL('../data/geneva-canton-buildings.json', import.meta.url);
const FACADES_URL = new URL('../data/geneva-canton-facades.json', import.meta.url);
// The buildings newer than swissBUILDINGS3D (tools/build-geneva-recent-buildings.mjs): each canton tile hides the older
// 3D buildings they replaced and brings the new ones standing near it, extruded from the cadastre
const RECENT_URL = new URL('../data/geneva-recent-buildings.json', import.meta.url);
const MAX_TILES = 1400, CONCURRENCY = 6;

export function buildCanton(scene) {
  const group = new THREE.Group();
  group.name = 'CantonBuildings';
  group.userData.terrain = 'absolute';
  scene.add(group);
  const stats = { tiles: 0, loaded: 0, loading: 0, failed: 0 };
  group.userData.stats = stats;
  let tiles = [], origin = '', facades = null;
  const bake = { offsets: [], ground: null };
  fetch(FACADES_URL).then((r) => (r.ok ? r.json() : null)).then((f) => { facades = f; }).catch(() => {});
  let recent = null; // { hidden: { uri: [batch ids] }, byTile: Map(uri -> [footprints]) }
  const recentReady = fetch(RECENT_URL).then((r) => (r.ok ? r.json() : null)).then((data) => {
    if (!data) return;
    const byTile = new Map();
    for (const a of data.added) if (a.tile) (byTile.get(a.tile) || byTile.set(a.tile, []).get(a.tile)).push(a);
    recent = { hidden: data.hidden, byTile };
  }).catch(() => {});
  fetch(INDEX_URL).then((r) => (r.ok ? r.json() : null)).then((index) => {
    if (!index) return;
    origin = index.origin;
    tiles = index.tiles.map(([u, x, z], i) => ({ u, x, z, seed: 50000 + i * 977, mesh: null, busy: false, want: false }));
    stats.tiles = tiles.length;
  }).catch((error) => console.warn('[canton] no tile index:', error));

  // a tile's geometries (its own and its recent buildings'), the shared material stays
  const dispose = (mesh) => mesh.traverse((o) => o.geometry?.dispose());
  let loading = 0, next = 0;
  async function load(t) {
    t.busy = true;
    loading++;
    try {
      await recentReady; // (a tile baked before the list would keep the buildings it replaces)
      const mesh = await loadSwissTile(origin + t.u, { seed: t.seed, stats: bake, facades: facades?.tiles?.[t.u], archetypes: facades?.archetypes, hidden: recent?.hidden?.[t.u] });
      // its recent buildings, on the same ground, in the same material
      const added = recent?.byTile.get(t.u);
      if (mesh && added?.length && bake.ground) {
        const extra = new THREE.Mesh(bakeFootprints(added, bake.ground), mesh.material);
        extra.name = 'RecentBuildings';
        extra.castShadow = extra.receiveShadow = true;
        extra.matrixAutoUpdate = false;
        mesh.add(extra);
      }
      if (mesh && t.want) {
        mesh.name = t.u;
        mesh.matrixAutoUpdate = false;
        t.mesh = mesh;
        group.add(mesh);
      } else if (mesh) dispose(mesh);
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
        dispose(t.mesh);
        t.mesh = null;
        t.want = false;
      }
    }
    order.sort((a, b) => a[0] - b[0]);
    let kept = 0;
    for (const [, t] of order) {
      if (kept++ >= MAX_TILES) {
        if (t.mesh) { group.remove(t.mesh); dispose(t.mesh); t.mesh = null; }
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
