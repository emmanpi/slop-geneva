import * as THREE from 'three/webgpu';
import { float, mix, positionGeometry, smoothstep, step, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { inWater, waterSurfaceHeight } from './terrain.js';
import { loadTransit } from './transit-data.js';
import { simClock } from './sim-clock.js';

// The Mouettes genevoises (lines M1-M4) shuttling across the Rade on their timetable (js/transit-data.js): each line's
// trips are chained into boats (a boat sails the next trip from the pier it reached), docked at the pier between
// trips, crossing on a smooth course over the water in between (around the jetties), rocking on the swell with a wake.

const MAX_BOATS = 10;
const LENGTH = 13.5, BEAM = 4.2;

// --- Geometry & material ---------------------------------------------------------------------------------------------------
function boatGeometry() {
  const parts = [];
  // hull: a box with a pointed bow (the front vertices pulled in)
  const hull = new THREE.BoxGeometry(BEAM, 1.3, LENGTH, 2, 1, 6);
  const p = hull.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i), y = p.getY(i);
    if (z > LENGTH / 2 - 3) {
      const t = (z - (LENGTH / 2 - 3)) / 3;
      p.setX(i, p.getX(i) * (1 - 0.85 * t * t));
    }
    if (y < 0) p.setX(i, p.getX(i) * 0.82);
  }
  hull.computeVertexNormals();
  hull.translate(0, 0.25, 0);
  parts.push(hull);
  // cabin & roof
  const cabin = new THREE.BoxGeometry(BEAM - 0.7, 1.9, LENGTH - 5);
  cabin.translate(0, 0.9 + 0.95, -0.6);
  parts.push(cabin);
  const roof = new THREE.BoxGeometry(BEAM - 0.3, 0.18, LENGTH - 4.2);
  roof.translate(0, 0.9 + 1.9 + 0.09, -0.6);
  parts.push(roof);
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

// White hull with a yellow band, yellow roof, glazed cabin (colours in linear space)
function boatMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.05 });
  const y = positionGeometry.y;
  const white = vec3(0.86, 0.86, 0.84), yellow = vec3(0.95, 0.62, 0.02), dark = vec3(0.02, 0.03, 0.04);
  const band = smoothstep(0.42, 0.46, y).mul(smoothstep(0.78, 0.74, y));
  const roof = step(2.75, y);
  const glazing = smoothstep(1.35, 1.4, y).mul(smoothstep(2.5, 2.45, y));
  const hullCol = mix(white, yellow, band);
  m.colorNode = mix(mix(hullCol, dark, glazing), yellow, roof);
  m.roughnessNode = mix(float(0.45), float(0.1), glazing);
  return m;
}

function wakeMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const u = positionGeometry.x.abs().div(6), v = positionGeometry.z.negate().div(40); // 0 at the stern .. 1 far behind
  const foam = smoothstep(1, 0, v).mul(smoothstep(0.15 + 0.0, 1.0, float(1).sub(u.sub(v.mul(0.6)).abs().mul(2))));
  m.colorNode = vec3(0.9, 0.93, 0.95);
  m.opacityNode = foam.mul(0.55);
  return m;
}

// --- Courses ---------------------------------------------------------------------------------------------------------------
// Where a boat lies at a pier: the open water nearest the pier's point
function dockPoint(x, z) {
  if (inWater(x, z)) return { x, z };
  for (let r = 4; r <= 60; r += 4) {
    for (let a = 0; a < 16; a++) {
      const px = x + Math.cos((a / 16) * Math.PI * 2) * r, pz = z + Math.sin((a / 16) * Math.PI * 2) * r;
      if (inWater(px, pz)) return { x: px, z: pz };
    }
  }
  return { x, z };
}

// Catmull-Rom through points, as a polyline with cumulative lengths
function smoothCourse(points) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal');
  const pts = curve.getSpacedPoints(Math.max(8, Math.round(curve.getLength() / 6))).map((v) => ({ x: v.x, z: v.z }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum[cum.length - 1] };
}
const onWater = (a, b) => {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 8);
  for (let i = 1; i < n; i++) if (!inWater(a.x + ((b.x - a.x) * i) / n, a.z + ((b.z - a.z) * i) / n)) return false;
  return true;
};
// From pier A to pier B over open water: straight out of the pier, then direct, or round the jetty in the way
function course(A, B) {
  const a = dockPoint(A.x, A.z), b = dockPoint(B.x, B.z);
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz), nx = -dz / L, nz = dx / L;
  let via = [];
  if (!onWater(a, b)) {
    // one detour point, as close to the line as will clear the land
    found: for (let off = 40; off <= 600; off += 30) {
      for (const sgn of [1, -1]) for (const f of [0.5, 0.35, 0.65]) {
        const m = { x: a.x + dx * f + nx * off * sgn, z: a.z + dz * f + nz * off * sgn };
        if (inWater(m.x, m.z) && onWater(a, m) && onWater(m, b)) { via = [m]; break found; }
      }
    }
  }
  return smoothCourse([a, ...via, b]);
}

function at(route, s, out) {
  s = Math.max(0, Math.min(route.len, s));
  let i = 1;
  while (i < route.cum.length - 1 && route.cum[i] < s) i++;
  const a = route.pts[i - 1], b = route.pts[i], seg = route.cum[i] - route.cum[i - 1] || 1e-6, t = (s - route.cum[i - 1]) / seg;
  out.x = a.x + (b.x - a.x) * t; out.z = a.z + (b.z - a.z) * t;
  out.heading = Math.atan2(b.x - a.x, b.z - a.z);
  return out;
}

// --- Fleet -----------------------------------------------------------------------------------------------------------------
export function buildBoats(scene) {
  const group = new THREE.Group();
  group.name = 'Mouettes';
  group.userData.terrain = 'absolute';
  scene.add(group);
  const hulls = new THREE.InstancedMesh(boatGeometry(), boatMaterial(), MAX_BOATS);
  hulls.castShadow = hulls.receiveShadow = true;
  hulls.frustumCulled = false;
  hulls.count = 0;
  const wakeGeo = new THREE.PlaneGeometry(12, 40, 1, 8).rotateX(-Math.PI / 2).translate(0, 0.06, -20 - LENGTH / 2 + 1);
  const wakes = new THREE.InstancedMesh(wakeGeo, wakeMaterial(), MAX_BOATS);
  wakes.frustumCulled = false;
  wakes.count = 0;
  wakes.renderOrder = 1;
  group.add(hulls, wakes);

  let blocks = [];
  const courses = new Map();
  loadTransit().then((data) => {
    if (!data) return;
    // trips: { line, from, to, dep, arr }
    const trips = data.trips.filter((t) => data.lines[t[0]]?.kind === 'boat').map((t) => {
      const f = t[3];
      return { line: t[0], from: f[0], dep: f[2], to: f[f.length - 3], arr: f[f.length - 2] };
    }).sort((p, q) => p.dep - q.dep);
    // chain into boats: the next trip of the line leaving the pier this one reached
    const used = new Set();
    for (const t of trips) {
      if (used.has(t)) continue;
      const block = [t];
      used.add(t);
      for (let cur = t; ;) {
        const next = trips.find((n) => !used.has(n) && n.line === cur.line && n.from === cur.to && n.dep >= cur.arr + 60);
        if (!next || next.dep - cur.arr > 3 * 3600) break;
        block.push(next); used.add(next); cur = next;
      }
      blocks.push(block);
    }
    for (const t of trips) {
      const key = `${t.from}>${t.to}`;
      if (!courses.has(key)) courses.set(key, course({ x: data.stops[t.from][1], z: data.stops[t.from][2] }, { x: data.stops[t.to][1], z: data.stops[t.to][2] }));
      t.course = courses.get(key);
    }
    group.userData.stats = { boats: blocks.length, trips: trips.length, courses: courses.size };
  });

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const p = {};
  const state = [];
  function update(dt, elapsed) {
    const now = simClock.seconds;
    let k = 0;
    state.length = 0;
    for (const block of blocks) {
      if (k >= MAX_BOATS) break;
      if (now < block[0].dep - 900 || now > block[block.length - 1].arr + 600) continue;
      // the trip under way, or the pier it waits at
      let speed = 0;
      let t = block.find((b) => now >= b.dep && now <= b.arr);
      if (t) {
        // ease out of the pier and into the next: s(t) smooth over the crossing
        const f = (now - t.dep) / Math.max(1, t.arr - t.dep);
        const e = f * f * (3 - 2 * f);
        at(t.course, e * t.course.len, p);
        speed = (6 * f * (1 - f) * t.course.len) / Math.max(1, t.arr - t.dep);
      } else {
        const prev = [...block].reverse().find((b) => b.arr < now);
        t = prev || block[0];
        at(t.course, prev ? t.course.len : 0, p);
      }
      const y = waterSurfaceHeight(p.x, p.z);
      const bob = Math.sin(elapsed * 1.3 + k * 2.1) * 0.06;
      euler.set(Math.sin(elapsed * 0.9 + k) * 0.015 - Math.min(0.03, speed * 0.004), p.heading, Math.sin(elapsed * 1.1 + k * 1.7) * 0.025);
      q.setFromEuler(euler);
      hulls.setMatrixAt(k, m4.compose(pos.set(p.x, y + 0.05 + bob, p.z), q, one));
      wakes.setMatrixAt(k, m4.compose(pos.set(p.x, y, p.z), q, one.set(1, 1, Math.min(1, speed / 5))));
      one.set(1, 1, 1);
      state.push({ x: p.x, z: p.z, heading: p.heading, speed, line: t.line });
      k++;
    }
    hulls.count = k;
    wakes.count = k;
    hulls.instanceMatrix.needsUpdate = true;
    wakes.instanceMatrix.needsUpdate = true;
  }
  return { group, update, boats: state };
}
