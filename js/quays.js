import * as THREE from 'three/webgpu';
import { attribute, float, floor, fract, mix, mx_noise_float, positionWorld, smoothstep, step, time, vec2, vec3 } from 'three/tsl';
import { GENEVA_DATA } from './geneva-geodata.js';
import { WORLD_BOUNDS } from './geneva-frame.js';
import { groundHeight, inWater, waterSurfaceHeight } from './terrain.js';
import { hideInPhotomesh } from './photomesh.js';

// Where the city meets the Léman and the Rhône: along every shore of the lake and the rivers (the water polygons'
// edges with land on one side) —
//  - where the bank stands high (a quay): a dressed-stone quay wall from below the water up to the quay, wet and
//    darker at the waterline with a line of algae, a coping stone along its top, the bank's paving laid flat up to the
//    wall (over the terrain model's slope), and a painted iron railing on the high quays;
//  - everywhere: a line of foam lapping at the foot of the wall or the beach.

const STEP = 3; // m, the shore's segments
const BAND = 4; // m inland the bank is laid flat at quay height (the terrain model's last cell slopes down)
const QUAY = 0.7; // m above the water: a quay wall (lower: a beach, a lawn running down to the water)
const RAILING = 1.4; // m above the water: a railing

function shoreSegments() {
  const [minX, minZ, maxX, maxZ] = WORLD_BOUNDS;
  const inFrame = (x, z) => x > minX + 6 && x < maxX - 6 && z > minZ + 6 && z < maxZ - 6;
  const segs = [];
  for (const w of GENEVA_DATA.water) {
    if (/^(pond|basin|reservoir|fountain)$/.test(w.kind || '')) continue;
    for (const ring of [w.ring, ...(w.holes || [])]) {
      if (ring.length < 8) continue;
      for (let i = 0; i < ring.length; i += 2) {
        const ax = ring[i], az = ring[i + 1], bx = ring[(i + 2) % ring.length], bz = ring[(i + 3) % ring.length];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.2) continue;
        const n = Math.max(1, Math.ceil(L / STEP));
        const ux = (bx - ax) / L, uz = (bz - az) / L;
        for (let k = 0; k < n; k++) {
          const x0 = ax + ((bx - ax) * k) / n, z0 = az + ((bz - az) * k) / n;
          const x1 = ax + ((bx - ax) * (k + 1)) / n, z1 = az + ((bz - az) * (k + 1)) / n;
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          // land on exactly one side
          const left = inWater(mx - uz * 2.5, mz + ux * 2.5), right = inWater(mx + uz * 2.5, mz - ux * 2.5);
          if (left === right) continue;
          const nx = left ? uz : -uz, nz = left ? -ux : ux; // towards the land
          if (!inFrame(mx + nx * BAND, mz + nz * BAND)) continue; // the frame's cut, not a shore
          segs.push({ x0, z0, x1, z1, nx, nz, water: waterSurfaceHeight(mx - nx * 3, mz - nz * 3) });
        }
      }
    }
  }
  return segs;
}

// Dressed limestone in courses, wet and darker near the waterline, algae at it (uv: x along the wall, y above water)
function wallMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  const p = attribute('aQuay', 'vec2');
  const along = p.x, above = p.y;
  const course = floor(above.div(0.48));
  const blockU = fract(along.div(1.15).add(course.mul(0.5)));
  const joint = step(fract(above.div(0.48)), 0.04).max(step(blockU, 0.025));
  const tone = mx_noise_float(vec2(floor(along.div(1.15).add(course.mul(0.5))), course).mul(3.1)).mul(0.08).add(0.92);
  const stone = vec3(0.62, 0.59, 0.53).mul(tone).mul(mx_noise_float(positionWorld.mul(2.2)).mul(0.06).add(0.97));
  const wet = smoothstep(0.55, 0.0, above);
  const algae = smoothstep(0.18, -0.05, above).mul(smoothstep(-0.9, -0.2, above));
  let col = mix(stone, stone.mul(0.45), wet);
  col = mix(col, vec3(0.13, 0.17, 0.08), algae.mul(0.75));
  m.colorNode = mix(col, col.mul(0.6), joint);
  m.roughnessNode = mix(float(0.85), float(0.3), wet);
  return hideInPhotomesh(m);
}

function copingMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
  const joint = step(fract(attribute('aQuay', 'vec2').x.div(1.6)), 0.02);
  const stone = vec3(0.56, 0.54, 0.5).mul(mx_noise_float(positionWorld.mul(1.7)).mul(0.07).add(0.96));
  m.colorNode = mix(stone, stone.mul(0.65), joint);
  return hideInPhotomesh(m);
}

// The bank laid flat: the quay's paving (granite setts; the orthophoto there still shows the water's glare)
function bankMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const sett = step(fract(positionWorld.x.mul(2.4)), 0.06).max(step(fract(positionWorld.z.mul(2.4)), 0.06));
  const tone = mx_noise_float(floor(positionWorld.xz.mul(2.4)).mul(0.9)).mul(0.1).add(0.95);
  const paving = vec3(0.29, 0.28, 0.265).mul(tone);
  m.colorNode = mix(paving, paving.mul(0.7), sett).mul(mx_noise_float(positionWorld.mul(0.5)).mul(0.08).add(0.96));
  return hideInPhotomesh(m);
}

function foamMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const p = attribute('aQuay', 'vec2'); // x along, y out from the shore (0..1)
  const lap = mx_noise_float(vec2(p.x.mul(0.35), p.y.mul(3).sub(time.mul(0.45)))).mul(0.5).add(0.5);
  const streaks = mx_noise_float(vec2(p.x.mul(1.4).add(time.mul(0.2)), p.y.mul(9))).mul(0.5).add(0.5);
  const edge = smoothstep(1, 0.05, p.y).mul(smoothstep(0, 0.06, p.y));
  m.colorNode = vec3(0.86, 0.9, 0.92);
  m.opacityNode = edge.mul(smoothstep(0.42, 0.75, lap.mul(0.6).add(streaks.mul(0.4)))).mul(0.55);
  return m;
}

function railingMaterial() {
  return hideInPhotomesh(new THREE.MeshStandardNodeMaterial({ color: 0x23302a, roughness: 0.5, metalness: 0.5 }));
}

export function buildQuays(scene) {
  const group = new THREE.Group();
  group.name = 'Quays';
  group.userData.terrain = 'absolute';
  const segs = shoreSegments();
  const wall = { pos: [], q: [] }, coping = { pos: [], q: [] }, bank = { pos: [] }, foam = { pos: [], q: [] }, rail = [];
  const quad = (t, a, b, c, d, qa, qb, qc, qd) => {
    t.pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    if (t.q) t.q.push(...qa, ...qb, ...qc, ...qa, ...qc, ...qd);
  };
  // The quay's height: the bank behind each segment, smoothed along the shore (±15 m; the terrain model's cells would
  // make the coping and the railing wave)
  const raw = segs.map((s) => groundHeight((s.x0 + s.x1) / 2 + s.nx * BAND, (s.z0 + s.z1) / 2 + s.nz * BAND) + 0.05);
  const joined = segs.map((s, i) => i > 0 && Math.hypot(s.x0 - segs[i - 1].x1, s.z0 - segs[i - 1].z1) < 0.5);
  const smooth = raw.map((_, i) => {
    let sum = raw[i], n = 1;
    for (let k = i - 1; k >= Math.max(0, i - 5) && joined[k + 1]; k--) { sum += raw[k]; n++; }
    for (let k = i + 1; k <= Math.min(raw.length - 1, i + 5) && joined[k]; k++) { sum += raw[k]; n++; }
    return sum / n;
  });
  const topAt = (i, end) => {
    // each end: midway between this segment's height and its neighbour's (continuous along the chain)
    const j = end ? i + 1 : i - 1;
    const linked = end ? j < segs.length && joined[j] : i > 0 && joined[i];
    return linked ? (smooth[i] + smooth[j]) / 2 : smooth[i];
  };
  let along = 0, walls = 0, beaches = 0;
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    const L = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    const top0 = topAt(si, 0), top1 = topAt(si, 1);
    const drop = (top0 + top1) / 2 - s.water;
    const w = s.water;
    // the foam, out over the water from the shore
    const o = 1.8, fy = w + 0.07;
    quad(foam, [s.x0, fy, s.z0], [s.x1, fy, s.z1], [s.x1 - s.nx * o, fy, s.z1 - s.nz * o], [s.x0 - s.nx * o, fy, s.z0 - s.nz * o],
      [along, 0], [along + L, 0], [along + L, 1], [along, 1]);
    if (drop > QUAY) {
      walls++;
      // the wall (its face towards the water), from 1.5 m under the surface; a little longer to close the corners
      const ex = ((s.x1 - s.x0) / L) * 0.08, ez = ((s.z1 - s.z0) / L) * 0.08;
      const a = [s.x0 - ex, w - 1.5, s.z0 - ez], b = [s.x1 + ex, w - 1.5, s.z1 + ez], c = [s.x1 + ex, top1, s.z1 + ez], d = [s.x0 - ex, top0, s.z0 - ez];
      quad(wall, b, a, d, c, [along + L, -1.5], [along, -1.5], [along, top0 - w], [along + L, top1 - w]);
      // the coping stone: 0.5 m deep, 0.1 over the water, 0.08 proud of the bank
      const cy0 = top0 + 0.08, cy1 = top1 + 0.08;
      const p0 = [s.x0 - s.nx * 0.1, cy0, s.z0 - s.nz * 0.1], p1 = [s.x1 - s.nx * 0.1, cy1, s.z1 - s.nz * 0.1];
      const i0 = [s.x0 + s.nx * 0.45, cy0, s.z0 + s.nz * 0.45], i1 = [s.x1 + s.nx * 0.45, cy1, s.z1 + s.nz * 0.45];
      quad(coping, p0, p1, i1, i0, [along, 0], [along + L, 0], [along + L, 0], [along, 0]);
      quad(coping, [p1[0], top1 - 0.1, p1[2]], [p0[0], top0 - 0.1, p0[2]], p0, p1, [along + L, 0], [along, 0], [along, 0], [along + L, 0]);
      // the bank laid flat behind it
      quad(bank, i0, i1, [s.x1 + s.nx * BAND, top1, s.z1 + s.nz * BAND], [s.x0 + s.nx * BAND, top0, s.z0 + s.nz * BAND]);
      // a railing on the high quays: posts every ~2.2 m, two rails
      if (drop > RAILING) rail.push({ x0: s.x0 + s.nx * 0.25, z0: s.z0 + s.nz * 0.25, x1: s.x1 + s.nx * 0.25, z1: s.z1 + s.nz * 0.25, y0: cy0, y1: cy1, L });
    } else beaches++;
    along += L;
  }
  const mesh = (t, material, castShadow = true) => {
    if (!t.pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
    g.setAttribute('aQuay', new THREE.Float32BufferAttribute(t.q && t.q.length ? t.q : new Array((t.pos.length / 3) * 2).fill(0), 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.castShadow = castShadow;
    m.receiveShadow = true;
    m.userData.terrain = 'absolute';
    group.add(m);
    return m;
  };
  mesh(wall, wallMaterial());
  mesh(coping, copingMaterial());
  mesh(bank, bankMaterial(), false);
  const foamMesh = mesh(foam, foamMaterial(), false);
  if (foamMesh) { foamMesh.renderOrder = 1; foamMesh.receiveShadow = false; }

  // Railings
  if (rail.length) {
    const posts = [], rails = [];
    for (const r of rail) {
      const n = Math.max(1, Math.round(r.L / 2.2));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        posts.push([r.x0 + (r.x1 - r.x0) * t, r.y0 + (r.y1 - r.y0) * t, r.z0 + (r.z1 - r.z0) * t]);
      }
      for (const h of [0.5, 1.02]) rails.push({ ...r, h });
    }
    const postGeo = new THREE.BoxGeometry(0.05, 1.05, 0.05).translate(0, 0.525, 0);
    const mat = railingMaterial();
    const inst = new THREE.InstancedMesh(postGeo, mat, posts.length);
    const m4 = new THREE.Matrix4();
    posts.forEach((p, i) => inst.setMatrixAt(i, m4.makeTranslation(p[0], p[1], p[2])));
    inst.castShadow = true;
    inst.userData.terrain = 'absolute';
    group.add(inst);
    // the rails: thin bars along each segment (one merged mesh)
    const pos = [];
    for (const r of rails) {
      const ax = r.x0, az = r.z0, bx = r.x1, bz = r.z1, ay = r.y0 + r.h, by = r.y1 + r.h;
      const t = r.h > 1 ? 0.045 : 0.025;
      pos.push(ax, ay, az, bx, by, bz, bx, by + t, bz, ax, ay, az, bx, by + t, bz, ax, ay + t, az);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const railMesh = new THREE.Mesh(g, new THREE.MeshStandardNodeMaterial({ color: 0x23302a, roughness: 0.5, metalness: 0.5, side: THREE.DoubleSide }));
    hideInPhotomesh(railMesh.material);
    railMesh.castShadow = true;
    railMesh.userData.terrain = 'absolute';
    group.add(railMesh);
  }
  group.userData.stats = { segments: segs.length, walls, beaches, railings: rail.length };
  scene.add(group);
  return group;
}
