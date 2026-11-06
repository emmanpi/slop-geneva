import * as THREE from 'three/webgpu';
import { float, texture, uv } from 'three/tsl';
import { GENEVA_DATA } from './geneva-geodata.js';
import { deckHeight, groundHeight, surfaceHeight, ROAD_TOP } from './terrain.js';
import { hideInPhotomesh } from './photomesh.js';

// Geneva's cycle network (OSM): the separate cycle tracks (highway=cycleway, among them the two-way track along the
// lake's quays) and the cycle lanes along the streets (js/geneva-geodata.js `cyc`: [left, right] of each way).
//  - Markings in Swiss yellow: the lanes' edge line (solid; dashed where advisory), bicycle pictograms along lanes and
//    tracks, a dashed centre line on the two-way tracks. Unlike the other markings these stay crisp over the
//    orthophoto.
//  - Cyclists riding the network around the camera, on the right of the tracks and in the lanes' direction, turning
//    onto the connected tracks and lanes at their ends.

const YELLOW = 0xf2c200;
const LANE_W = 1.5; // m, a cycle lane's width from the kerb
const RIDERS = 70;
const RANGE = 320; // m around the camera

// --- The network: polylines with a direction (1 along, -1 against, 0 both) -----------------------------------------------
function offsetLine(pts, o) {
  // the polyline offset `o` to the right of its direction (x east, z south: right of (dx, dz) is (-dz, dx))
  const out = [];
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dx = pts[b * 2] - pts[a * 2], dz = pts[b * 2 + 1] - pts[a * 2 + 1], L = Math.hypot(dx, dz) || 1;
    out.push(pts[i * 2] - (dz / L) * o, pts[i * 2 + 1] + (dx / L) * o);
  }
  return out;
}
function polyline(flat, dir, kind, onDeck) {
  const cum = [0];
  for (let i = 2; i < flat.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1]));
  return { pts: flat, cum, len: cum[cum.length - 1], dir, kind, onDeck };
}
function buildNetwork() {
  const lines = [];
  for (const r of GENEVA_DATA.roads) {
    if (r.tunnel) continue;
    if (r.kind === 'cycleway') {
      if (r.pts.length < 4) continue;
      lines.push(polyline(r.pts, r.oneway ? (r.reverse ? -1 : 1) : 0, 'track', !!r.bridge));
      continue;
    }
    if (!r.cyc) continue;
    const half = (r.width || 7) / 2;
    const flow = r.reverse ? -1 : 1;
    [['left', r.cyc[0]], ['right', r.cyc[1]]].forEach(([side, c]) => {
      if (!c || c === '-' || /[Bb]/.test(c)) return; // (a shared bus lane: the buses' lane, no markings of its own)
      const track = /[Tt]/.test(c);
      const sign = side === 'right' ? 1 : -1;
      // the lane's centre, LANE_W / 2 in from the kerb (a track: beside the kerb, on the sidewalk)
      const o = sign * (track ? half + 1.0 : half - LANE_W / 2);
      // its direction: the right lane runs with the traffic, the left one against it on a two-way street, with it on a
      // one-way street; lowercase codes run against the way
      let dir = side === 'right' ? 1 : r.oneway ? 1 : -1;
      if (c === c.toLowerCase()) dir = -dir;
      lines.push({ ...polyline(offsetLine(r.pts, o), dir * flow, track ? 'track' : c.toUpperCase() === 'A' ? 'advisory' : 'lane', !!r.bridge), road: r, sign, half });
    });
  }
  // ends meeting (within 4 m) connect
  const CELL = 8, ends = new Map();
  const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  lines.forEach((l, i) => {
    for (const end of [0, 1]) {
      const x = l.pts[end ? l.pts.length - 2 : 0], z = l.pts[end ? l.pts.length - 1 : 1];
      const k = key(x, z);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ i, end, x, z });
    }
  });
  const near = (x, z) => {
    const out = [];
    const i0 = Math.floor(x / CELL), j0 = Math.floor(z / CELL);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
      for (const e of ends.get(`${i},${j}`) || []) if (Math.hypot(e.x - x, e.z - z) < 4) out.push(e);
    }
    return out;
  };
  return { lines, near };
}

/** Is there a cycle track or lane along (x, z), running about the direction (dx, dz)? For js/traffic.js: its bicycles
 * keep off the streets the cyclists of the cycle network ride (lazily indexed on 20 m cells) */
let alongIndex = null;
export function cycleRouteAlong(x, z, dx, dz) {
  if (!alongIndex) {
    alongIndex = new Map();
    for (const l of buildNetwork().lines) {
      for (let i = 2; i < l.pts.length; i += 2) {
        const ax = l.pts[i - 2], az = l.pts[i - 1], bx = l.pts[i], bz = l.pts[i + 1], L = Math.hypot(bx - ax, bz - az) || 1;
        const seg = { ax, az, bx, bz, ux: (bx - ax) / L, uz: (bz - az) / L, L };
        for (let t = 0; t <= L; t += 10) {
          const k = `${Math.floor((ax + seg.ux * t) / 20)},${Math.floor((az + seg.uz * t) / 20)}`;
          if (!alongIndex.has(k)) alongIndex.set(k, new Set());
          alongIndex.get(k).add(seg);
        }
      }
    }
  }
  const i0 = Math.floor(x / 20), j0 = Math.floor(z / 20);
  for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
    for (const s of alongIndex.get(`${i},${j}`) || []) {
      if (Math.abs(s.ux * dx + s.uz * dz) < 0.85) continue;
      const t = Math.max(0, Math.min(s.L, (x - s.ax) * s.ux + (z - s.az) * s.uz));
      if (Math.hypot(s.ax + s.ux * t - x, s.az + s.uz * t - z) < 12) return true;
    }
  }
  return false;
}

function at(l, s, out) {
  s = Math.max(0, Math.min(l.len, s));
  let lo = 0, hi = l.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (l.cum[m] <= s) lo = m; else hi = m; }
  const seg = l.cum[hi] - l.cum[lo] || 1e-6, t = (s - l.cum[lo]) / seg;
  const ax = l.pts[lo * 2], az = l.pts[lo * 2 + 1], bx = l.pts[hi * 2], bz = l.pts[hi * 2 + 1];
  out.x = ax + (bx - ax) * t; out.z = az + (bz - az) * t;
  out.dx = (bx - ax) / seg; out.dz = (bz - az) / seg;
  return out;
}
// The surface a line rides on: the deck of its bridge, else the ground (the road's top on a carriageway)
const heightOn = (l, x, z) => {
  if (l.onDeck) { const d = deckHeight(x, z); if (d === d) return d + ROAD_TOP; }
  return (l.road && l.kind !== 'track' ? groundHeight(x, z) + ROAD_TOP : surfaceHeight(x, z)) + (l.kind === 'track' && !l.road ? 0.055 : 0);
};

// --- Markings --------------------------------------------------------------------------------------------------------------
function pictogramTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round';
  // a bicycle seen from the side, riding "up" the canvas once laid on the road (wheels at the top & bottom)
  g.translate(64, 64); g.rotate(-Math.PI / 2); g.translate(-64, -64);
  g.beginPath(); g.arc(32, 82, 20, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(96, 82, 20, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(32, 82); g.lineTo(54, 50); g.lineTo(86, 50); g.lineTo(96, 82); g.moveTo(54, 50); g.lineTo(64, 82); g.lineTo(86, 50); g.stroke();
  g.beginPath(); g.moveTo(48, 42); g.lineTo(62, 42); g.moveTo(84, 50); g.lineTo(80, 36); g.lineTo(92, 34); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function buildMarkings(lines) {
  const pos = [], tri = [];
  const pic = [], picUv = [];
  const quad = (out, a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  const strip = (l, s0, s1, offset, w) => {
    // a strip along line l between s0 and s1, `offset` right of it, w wide, in ~2 m pieces on the surface
    const n = Math.max(1, Math.ceil((s1 - s0) / 2));
    const p = {}, q = {};
    for (let k = 0; k < n; k++) {
      at(l, s0 + ((s1 - s0) * k) / n, p);
      const px = p.x - p.dz * offset, pz = p.z + p.dx * offset, pdx = p.dx, pdz = p.dz;
      at(l, s0 + ((s1 - s0) * (k + 1)) / n, q);
      const qx = q.x - q.dz * offset, qz = q.z + q.dx * offset;
      const ya = heightOn(l, px, pz) + 0.025, yb = heightOn(l, qx, qz) + 0.025;
      const hx = -pdz * (w / 2), hz = pdx * (w / 2);
      quad(tri, [px - hx, ya, pz - hz], [px + hx, ya, pz + hz], [qx + hx, yb, qz + hz], [qx - hx, yb, qz - hz]);
    }
  };
  // a bicycle pictogram at s, `side` metres right of the line, riding `dir`
  const pictogram = (l, s, dir, side = 0) => {
    const p = at(l, s, {});
    const fx = p.dx * dir, fz = p.dz * dir, rx = -fz, rz = fx;
    const cx = p.x + rx * side, cz = p.z + rz * side;
    const y = heightOn(l, cx, cz) + 0.03;
    const L = 0.9, W = 0.6;
    const c = (u, v) => [cx + fx * L * v + rx * W * u, y, cz + fz * L * v + rz * W * u];
    quad(pic, c(-1, -1), c(1, -1), c(1, 1), c(-1, 1));
    picUv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  };
  for (const l of lines) {
    if (l.len < 6) continue;
    if (l.road) {
      // the lane's edge line, on the traffic side (LANE_W from the kerb): solid, dashed where advisory
      if (l.kind !== 'track') {
        const edge = -l.sign * (LANE_W / 2); // from the lane's centre towards the road's centre
        if (l.kind === 'advisory') for (let s = 1; s + 1.5 < l.len; s += 3) strip(l, s, s + 1.5, edge, 0.12);
        else strip(l, 0.5, l.len - 0.5, edge, 0.12);
      }
    } else if (l.dir === 0) {
      // two-way track: dashed centre line
      for (let s = 1; s + 1.5 < l.len; s += 4) strip(l, s, s + 1.5, 0, 0.1);
    }
    // pictograms every ~45 m (riding the line's way; both ways on the two-way tracks, either side of the centre)
    for (let s = 12; s < l.len - 6; s += 45) {
      // (a two-way track: one each way, either side of its centre line)
      if (l.dir === 0) { pictogram(l, s, 1, 0.6); pictogram(l, s + 22, -1, 0.6); } else pictogram(l, s, l.dir);
    }
  }
  const group = new THREE.Group();
  group.name = 'CycleMarkings';
  group.userData.terrain = 'absolute';
  if (tri.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
    g.computeVertexNormals();
    const m = new THREE.MeshStandardNodeMaterial({ color: YELLOW, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, hideInPhotomesh(m));
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  if (pic.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pic, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(picUv, 2));
    g.computeVertexNormals();
    const m = new THREE.MeshStandardNodeMaterial({ color: YELLOW, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide });
    m.opacityNode = texture(pictogramTexture(), uv()).r;
    m.alphaTestNode = float(0.5); // (alphaTestNode, not alphaTest: see createTreeMaterial (tsl-materials.js))
    const mesh = new THREE.Mesh(g, hideInPhotomesh(m));
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  return group;
}

// --- Riders ---------------------------------------------------------------------------------------------------------------
export function buildCycling(scene, bikeParts) {
  const net = buildNetwork();
  const markings = buildMarkings(net.lines);
  scene.add(markings);
  const group = new THREE.Group();
  group.name = 'Cyclists';
  group.userData.terrain = 'absolute';
  scene.add(group);
  const stats = { lines: net.lines.length, km: Math.round(net.lines.reduce((a, l) => a + l.len, 0) / 100) / 10, riders: 0 };
  group.userData.stats = stats;
  if (!bikeParts) return { group, markings, update() {}, stats };

  const { bikeGeo, riderGeo, skinGeo, bikeMat, bikePalette, jacketPalette } = bikeParts;
  const meshes = [bikeGeo, riderGeo, skinGeo].map((g) => {
    const m = new THREE.InstancedMesh(g, bikeMat, RIDERS);
    m.frustumCulled = false;
    m.castShadow = true;
    m.count = 0;
    group.add(m);
    return m;
  });
  const white = new THREE.Color(1, 1, 1);
  for (let i = 0; i < RIDERS; i++) {
    meshes[0].setColorAt(i, bikePalette[(i * 5 + 1) % bikePalette.length]);
    meshes[1].setColorAt(i, jacketPalette[(i * 3 + 2) % jacketPalette.length]);
    meshes[2].setColorAt(i, white);
  }

  const riders = [];
  const p = {};
  const rand = Math.random;
  function place(r, cam) {
    // a line with a stretch within RANGE of the camera
    for (let attempt = 0; attempt < 30; attempt++) {
      const l = net.lines[Math.floor(rand() * net.lines.length)];
      if (l.len < 10) continue;
      const s = rand() * l.len;
      at(l, s, p);
      if (Math.hypot(p.x - cam.x, p.z - cam.z) > RANGE) continue;
      const dir = l.dir || (rand() < 0.5 ? 1 : -1);
      Object.assign(r, { l, s, dir, speed: 4 + rand() * 2.5, lane: l.dir === 0 ? 0.55 : 0, y: undefined });
      return true;
    }
    return false;
  }
  function onward(r) {
    // the end reached: on along a connected line, the right way
    const end = r.dir > 0 ? 1 : 0;
    const x = r.l.pts[end ? r.l.pts.length - 2 : 0], z = r.l.pts[end ? r.l.pts.length - 1 : 1];
    const options = net.near(x, z).filter((e) => net.lines[e.i] !== r.l && (net.lines[e.i].dir === 0 || net.lines[e.i].dir === (e.end === 0 ? 1 : -1)));
    if (!options.length) return false;
    const o = options[Math.floor(rand() * options.length)];
    const l = net.lines[o.i];
    r.l = l; r.dir = o.end === 0 ? 1 : -1; r.s = o.end === 0 ? 0 : l.len; r.lane = l.dir === 0 ? 0.55 : 0;
    return true;
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), euler = new THREE.Euler(0, 0, 0, 'YXZ');
  function update(dt, camera) {
    const cam = camera.position;
    while (riders.length < RIDERS) { const r = {}; if (!place(r, cam)) break; riders.push(r); }
    let k = 0;
    for (const r of riders) {
      r.s += r.speed * dt * r.dir;
      if (r.s < 0 || r.s > r.l.len) { if (!onward(r)) place(r, cam); }
      at(r.l, r.s, p);
      if (Math.hypot(p.x - cam.x, p.z - cam.z) > RANGE + 80) { place(r, cam); at(r.l, r.s, p); }
      const fx = p.dx * r.dir, fz = p.dz * r.dir;
      // keep right on a two-way track
      const x = p.x - fz * r.lane, z = p.z + fx * r.lane;
      const y = heightOn(r.l, x, z);
      r.y = r.y === undefined ? y : r.y + (y - r.y) * Math.min(1, dt * 8);
      euler.set(0, Math.atan2(fx, fz), 0);
      q.setFromEuler(euler);
      m4.compose(pos.set(x, r.y, z), q, one);
      for (const m of meshes) m.setMatrixAt(k, m4);
      k++;
    }
    for (const m of meshes) { m.count = k; m.instanceMatrix.needsUpdate = true; }
    stats.riders = k;
  }
  return { group, markings, update, stats, riders };
}
