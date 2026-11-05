import * as THREE from 'three/webgpu';
import { createRoadPaintMaterial } from './tsl-materials.js';
import { hideInPhotomesh } from './photomesh.js';
import { surfaceHeight, drapeOverlay, ROAD_TOP } from './terrain.js';

// js/road-marks.js
// The road markings as the canton surveyed them (SITG, Office cantonal des transports; data/geneva-roadmarks.bin from
// tools/build-geneva-roadmarks.mjs): every lane line and dash, stop line, yellow crossing, arrow, BUS / TAXI letters,
// cycle symbol, parking bay and red or green surfacing, where it is painted. Lines are strips along their middle;
// painted shapes are filled; one mesh per 256 m tile, laid on the relief (and the bridge decks), shown near the camera.

const URL_DATA = new URL('../data/geneva-roadmarks.bin', import.meta.url);
const COLOURS = [0xe9e6dc, 0xf2c200, 0x2f6fd0, 0xa8382c, 0x3f8c4a, 0xc48a3a].map((c) => new THREE.Color(c));
const WIDTHS = [0.15, 0.12, 0.10];
const LINE_LIFT = ROAD_TOP + 0.014, SURFACE_LIFT = ROAD_TOP + 0.008; // on the carriageway (ROAD_TOP above the ground)
const STEP = 4; // m: lines are laid on the relief at least this often
const SHOW = 900; // m from the camera within which a tile is drawn

function parse(buffer) {
  const head = new Int32Array(buffer, 0, 6);
  if (head[0] !== 0x4b4d5247) throw new Error('road marks: bad magic');
  const [, , tile, nTiles, nShapes, nPts] = head;
  const tiles = new Int32Array(buffer, 24, nTiles * 4);
  let o = 24 + nTiles * 16;
  const pad = (nShapes + 3) & ~3;
  const codes = new Uint8Array(buffer, o, nShapes); o += pad;
  const flags = new Uint8Array(buffer, o, nShapes); o += pad;
  const starts = new Uint32Array(buffer, o, nShapes + 1); o += (nShapes + 1) * 4;
  const pts = new Int16Array(buffer, o, nPts * 2);
  return { tile, nTiles, tiles, codes, flags, starts, pts };
}

function buildTile(d, t) {
  const tx = d.tiles[t * 4], tz = d.tiles[t * 4 + 1], first = d.tiles[t * 4 + 2], count = d.tiles[t * 4 + 3];
  const cx = (tx + 0.5) * d.tile, cz = (tz + 0.5) * d.tile;
  const lines = { position: [], side: [], paint: [], color: [], index: [] };
  const areas = { position: [], side: [], paint: [], color: [], index: [] };
  const point = (k) => [cx + d.pts[k * 2] / 100, cz + d.pts[k * 2 + 1] / 100];
  const vertex = (g, x, z, sx, sz, col, lift) => {
    g.position.push(x + sx, lift === null ? 0.012 : surfaceHeight(x + sx, z + sz) + lift, z + sz);
    g.side.push(sx, sz);
    g.paint.push(0, 1, 1); // solid: one period, all on
    g.color.push(col.r, col.g, col.b);
  };
  for (let s = first; s < first + count; s++) {
    const code = d.codes[s], col = COLOURS[code & 7], flag = d.flags[s];
    if (flag & 2) continue; // holes are read with their outer ring
    const ring = [];
    for (let k = d.starts[s]; k < d.starts[s + 1]; k++) ring.push(point(k));
    if (flag & 1) {
      const holes = [];
      for (let h = s + 1; h < first + count && d.flags[h] & 2; h++) {
        const hole = [];
        for (let k = d.starts[h]; k < d.starts[h + 1]; k++) hole.push(point(k));
        holes.push(hole);
      }
      const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
      const holeVecs = holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
      const tris = THREE.ShapeUtils.triangulateShape(contour, holeVecs);
      const surface = (code & 7) >= 3;
      const g = surface ? areas : lines, base = g.position.length / 3;
      const all = [...ring, ...holes.flat()];
      for (const [x, z] of all) vertex(g, x, z, 0, 0, col, surface ? null : LINE_LIFT);
      // facing up (+y): counter-clockwise seen from above, where x runs east and z south
      for (const [a, b, c] of tris) {
        const cross = (all[b][0] - all[a][0]) * (all[c][1] - all[a][1]) - (all[b][1] - all[a][1]) * (all[c][0] - all[a][0]);
        if (cross < 0) g.index.push(base + a, base + b, base + c);
        else g.index.push(base + a, base + c, base + b);
      }
      continue;
    }
    // a line: one quad per stretch of at most STEP m, its width across it
    const half = WIDTHS[(code >> 3) & 3] / 2;
    for (let k = 1; k < ring.length; k++) {
      const [ax, az] = ring[k - 1], [bx, bz] = ring[k];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const nx = ((az - bz) / len) * half, nz = ((bx - ax) / len) * half;
      const n = Math.ceil(len / STEP);
      const base = lines.position.length / 3;
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n, z = az + ((bz - az) * i) / n;
        vertex(lines, x, z, -nx, -nz, col, LINE_LIFT);
        vertex(lines, x, z, nx, nz, col, LINE_LIFT);
      }
      for (let i = 0; i < n; i++) {
        const v = base + i * 2;
        lines.index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); // (facing up)
      }
    }
  }
  const geometry = (g) => {
    if (!g.index.length) return null;
    const geo = new THREE.BufferGeometry();
    const normal = new Float32Array(g.position.length);
    for (let i = 1; i < normal.length; i += 3) normal[i] = 1;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(g.color, 3));
    geo.setAttribute('side', new THREE.Float32BufferAttribute(g.side, 2));
    geo.setAttribute('paint', new THREE.Float32BufferAttribute(g.paint, 3));
    geo.setIndex(g.position.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(g.index, 1) : new THREE.Uint16BufferAttribute(g.index, 1));
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    return geo;
  };
  const lineGeo = geometry(lines);
  let areaGeo = geometry(areas);
  // the coloured surfaces can be large: draped over the relief like the other ground overlays
  if (areaGeo) { const draped = drapeOverlay(areaGeo, { deck: true, maxEdge: STEP, lift: SURFACE_LIFT }); areaGeo.dispose(); areaGeo = draped; }
  return { lineGeo, areaGeo, cx, cz };
}

/**
 * Loads the surveyed markings and adds them to the scene (asynchronously); `replaces`: groups of generated markings
 * (the OSM cycle lanes' lines and pictograms) hidden once they are in, as the survey has them already.
 * Returns { group, update(camera), state }.
 */
export function buildRoadMarks(scene, { replaces = [] } = {}) {
  const group = new THREE.Group();
  group.name = 'RoadMarksSITG';
  group.userData.terrain = 'absolute'; // laid on the relief here
  scene.add(group);
  const tiles = [];
  const state = { ready: false, tiles: 0, vertices: 0 };
  const material = hideInPhotomesh(createRoadPaintMaterial());
  const add = (geo, order) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.renderOrder = order; // under the other see-through ground effects (contact shadows, headlight beams)
    mesh.userData.terrain = 'absolute';
    group.add(mesh);
    state.vertices += geo.attributes.position.count;
    return mesh;
  };
  fetch(URL_DATA).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`road marks: ${r.status}`)))).then((buffer) => {
    const d = parse(buffer);
    for (let t = 0; t < d.nTiles; t++) {
      const { lineGeo, areaGeo, cx, cz } = buildTile(d, t);
      const meshes = [];
      if (areaGeo) meshes.push(add(areaGeo, -2));
      if (lineGeo) meshes.push(add(lineGeo, -1));
      if (meshes.length) tiles.push({ cx, cz, meshes });
    }
    state.ready = true;
    state.tiles = tiles.length;
    for (const g of replaces) if (g) g.visible = false;
    console.log(`[road-marks] ${tiles.length} tiles, ${state.vertices} vertices (SITG survey)`);
  }).catch((error) => console.warn('[road-marks] not loaded:', error.message));

  function update(camera) {
    const p = camera.position, reach = SHOW + 182; // (a tile's half diagonal)
    for (const t of tiles) {
      const visible = Math.hypot(t.cx - p.x, t.cz - p.z) < reach;
      for (const m of t.meshes) m.visible = visible;
    }
  }
  return { group, update, state };
}
