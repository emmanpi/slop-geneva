import * as THREE from 'three/webgpu';
import { attribute, float, floor, fract, mix, mx_noise_float, normalWorld, positionWorld, smoothstep, step, time, uv, vec2, vec3 } from 'three/tsl';
import { QUAY, SHORE } from './terrain.js';
import { hideInPhotomesh } from './photomesh.js';

// Where the city meets the Léman and the Rhône: along every shore of the lake and the rivers (the water polygons'
// edges with land on one side) —
//  - where the bank stands high (a quay): a dressed-stone quay wall from below the water up to the quay, wet and
//    darker at the waterline with a line of algae, a coping stone along its top, the bank's paving laid flat up to the
//    wall (over the terrain model's slope), and a painted iron railing on the high quays;
//  - everywhere: a line of foam lapping at the foot of the wall or the beach.

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
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x1f2a24, roughness: 0.45, metalness: 0.6, side: THREE.DoubleSide });
  const along = positionWorld.x.mul(normalWorld.z.abs()).add(positionWorld.z.mul(normalWorld.x.abs()));
  const v = uv().y;
  const bar = step(fract(along.div(0.13)), 0.2);
  const rails = step(0.9, v).add(step(v, 0.07)).add(step(v.sub(0.5).abs(), 0.025));
  const post = step(fract(along.div(2.2)), 0.04);
  m.opacityNode = bar.add(rails).add(post).min(1);
  m.alphaTest = 0.5;
  return hideInPhotomesh(m);
}

export function buildQuays(scene) {
  const group = new THREE.Group();
  group.name = 'Quays';
  group.userData.terrain = 'absolute';
  const segs = SHORE;
  const { BAND, RAILING } = QUAY;
  const wall = { pos: [], q: [] }, coping = { pos: [], q: [] }, bank = { pos: [] }, foam = { pos: [], q: [] }, rail = [];
  const quad = (t, a, b, c, d, qa, qb, qc, qd) => {
    t.pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    if (t.q) t.q.push(...qa, ...qb, ...qc, ...qa, ...qc, ...qd);
  };
  let along = 0, walls = 0, beaches = 0;
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    const L = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    const { top0, top1, drop, underDeck } = s;
    const band = s.band ?? BAND;
    const w = s.water;
    // the foam, out over the water from the shore
    const o = 1.8, fy = w + 0.07;
    quad(foam, [s.x0, fy, s.z0], [s.x1, fy, s.z1], [s.x1 - s.nx * o, fy, s.z1 - s.nz * o], [s.x0 - s.nx * o, fy, s.z0 - s.nz * o],
      [along, 0], [along + L, 0], [along + L, 1], [along, 1]);
    if (s.wall) {
      walls++;
      // the wall (its face towards the water), from 1.5 m under the surface; a little longer to close the corners
      const ex = ((s.x1 - s.x0) / L) * 0.08, ez = ((s.z1 - s.z0) / L) * 0.08;
      const a = [s.x0 - ex, w - 1.5, s.z0 - ez], b = [s.x1 + ex, w - 1.5, s.z1 + ez], c = [s.x1 + ex, top1, s.z1 + ez], d = [s.x0 - ex, top0, s.z0 - ez];
      quad(wall, b, a, d, c, [along + L, -1.5], [along, -1.5], [along, top0 - w], [along + L, top1 - w]);
      // the coping stone: 0.5 m deep, 0.1 over the water, 0.08 proud of the bank
      const cy0 = top0 + 0.08, cy1 = top1 + 0.08;
      const p0 = [s.x0 - s.nx * 0.1, cy0, s.z0 - s.nz * 0.1], p1 = [s.x1 - s.nx * 0.1, cy1, s.z1 - s.nz * 0.1];
      const i0 = [s.x0 + s.nx * 0.45, cy0, s.z0 + s.nz * 0.45], i1 = [s.x1 + s.nx * 0.45, cy1, s.z1 + s.nz * 0.45];
      if (!underDeck) {
        quad(coping, p0, p1, i1, i0, [along, 0], [along + L, 0], [along + L, 0], [along, 0]);
        quad(coping, [p1[0], top1 - 0.1, p1[2]], [p0[0], top0 - 0.1, p0[2]], p0, p1, [along + L, 0], [along, 0], [along, 0], [along + L, 0]);
        // the bank laid flat behind it
        quad(bank, i0, i1, [s.x1 + s.nx * band, top1, s.z1 + s.nz * band], [s.x0 + s.nx * band, top0, s.z0 + s.nz * band]);
      }
      // a railing on the high quays: posts every ~2.2 m, two rails
      if ((s.railing || drop > RAILING) && !underDeck) rail.push({ x0: s.x0 + s.nx * 0.25, z0: s.z0 + s.nz * 0.25, x1: s.x1 + s.nx * 0.25, z1: s.z1 + s.nz * 0.25, y0: cy0, y1: cy1, L });
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

  // Railings: the same iron balustrade as the bridges' (js/city-grid.js), so the two meet at the corner: a thin panel
  // cut into bars between a handrail and a bottom rail, with a post every 2.2 m
  if (rail.length) {
    const pos = [], uvs = [];
    for (const r of rail) {
      const h = 1.05;
      pos.push(r.x0, r.y0, r.z0, r.x1, r.y1, r.z1, r.x1, r.y1 + h, r.z1, r.x0, r.y0, r.z0, r.x1, r.y1 + h, r.z1, r.x0, r.y0 + h, r.z0);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.computeVertexNormals();
    const railMesh = new THREE.Mesh(g, railingMaterial());
    railMesh.castShadow = true;
    railMesh.userData.terrain = 'absolute';
    group.add(railMesh);
  }
  // The railings are solid: one oriented box per piece (0.25 m in from the edge, 1.05 m high), for the player
  const colliders = rail.map((r) => {
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, L = Math.hypot(r.x1 - r.x0, r.z1 - r.z0) || 1e-6;
    const ux = (r.x1 - r.x0) / L, uz = (r.z1 - r.z0) / L;
    const hx = L / 2 + 0.05, hz = 0.12, cs = ux, sn = -uz;
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    const y = Math.min(r.y0, r.y1);
    return { minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, baseY: y, minY: y - 0.5, maxY: Math.max(r.y0, r.y1) + 1.05, obb: { cx, cz, hx, hz, cs, sn } };
  });
  group.userData.colliders = colliders;
  group.userData.stats = { segments: segs.length, walls, beaches, railings: rail.length };
  scene.add(group);
  return group;
}
