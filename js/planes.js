import * as THREE from 'three/webgpu';
import { abs, attribute, mix, positionGeometry, smoothstep, step, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lonLatToWorld } from './geneva-frame.js';
import { simClock } from './sim-clock.js';
import { cityUniforms } from './tsl-materials.js';

// Genève Aéroport (Cointrin): airliners landing and taking off on its 3,900 m runway (OSM aeroway=runway, 04/22) a
// few kilometres north-west of the city. A movement every 2-3 minutes from 6:00 to 23:00 (none at night),
// arrivals and departures in turn. The runway in use follows the wind (js/weather.js): into the bise (from the
// north-east) they land and take off towards the north-east, coming in over the French countryside; otherwise towards
// the south-west, coming in over the lake and Versoix on a 3° glide path.

const RUNWAY = { ne: lonLatToWorld(6.1270817, 46.2504045), sw: lonLatToWorld(6.090765, 46.2256501), y: 411 - 372 };
const MAX_PLANES = 6;
const APPROACH = 16000; // m out, where an arrival appears
const GLIDE = Math.tan((3 * Math.PI) / 180);
const CLIMB = Math.tan((9 * Math.PI) / 180);
const OUT = 18000; // m past the runway end, where a departure disappears

// --- An airliner (~38 m, A320-sized), nose towards +z, wheels at y = 0 ----------------------------------------------------
function planeGeometry() {
  const parts = [];
  const tag = (g, part) => {
    const n = g.attributes.position.count;
    g.setAttribute('part', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1));
    return g.index ? g.toNonIndexed() : g;
  };
  const fuselage = new THREE.CylinderGeometry(1.95, 1.95, 30, 16, 1);
  fuselage.rotateX(Math.PI / 2);
  fuselage.translate(0, 3.6, 0);
  parts.push(tag(fuselage, 0));
  const nose = new THREE.SphereGeometry(1.95, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  nose.rotateX(Math.PI / 2); // the cap (+y) forwards (+z), then drawn out
  nose.scale(1, 1, 2.2);
  nose.translate(0, 3.6, 15);
  parts.push(tag(nose, 0));
  const tail = new THREE.ConeGeometry(1.95, 7, 16, 1);
  tail.rotateX(-Math.PI / 2);
  tail.translate(0, 4.0, -18.5);
  parts.push(tag(tail, 0));
  // wings: swept slabs
  for (const side of [-1, 1]) {
    const wing = new THREE.BoxGeometry(16.5, 0.45, 4.2);
    const p = wing.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = side > 0 ? (p.getX(i) + 8.25) / 16.5 : (8.25 - p.getX(i)) / 16.5; // 0 root .. 1 tip
      p.setZ(i, p.getZ(i) * (1 - 0.55 * t) - t * 5.5);
      p.setY(i, p.getY(i) + t * 1.0);
    }
    wing.translate(side * 9.9, 2.6, 0.5);
    parts.push(tag(wing, 1));
    const engine = new THREE.CylinderGeometry(1.0, 0.9, 4.2, 12);
    engine.rotateX(Math.PI / 2);
    engine.translate(side * 5.8, 1.6, 2.6);
    parts.push(tag(engine, 2));
    const stab = new THREE.BoxGeometry(6, 0.3, 2.6);
    stab.translate(side * 3.4, 4.6, -18.2);
    parts.push(tag(stab, 1));
    // nav light at the wing tip (red left, green right)
    const light = new THREE.SphereGeometry(0.35, 6, 4);
    light.translate(side * 17.8, 3.7, -5.6);
    parts.push(tag(light, side < 0 ? 4 : 5));
  }
  const fin = new THREE.BoxGeometry(0.35, 6.2, 4.6);
  const fp = fin.attributes.position;
  for (let i = 0; i < fp.count; i++) if (fp.getY(i) > 0) fp.setZ(i, fp.getZ(i) - 2.4);
  fin.translate(0, 8.5, -17.6);
  parts.push(tag(fin, 3));
  // landing gear (shown low down)
  for (const [x, z] of [[0, 11.5], [-3.2, -1], [3.2, -1]]) {
    const leg = new THREE.CylinderGeometry(0.18, 0.18, 1.6, 6);
    leg.translate(x, 0.8, z);
    parts.push(tag(leg, 2));
  }
  for (const g of parts) for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'part'].includes(k)) g.deleteAttribute(k);
  return mergeGeometries(parts);
}

function planeMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.2 });
  const part = attribute('part', 'float');
  const y = positionGeometry.y;
  const white = vec3(0.86, 0.87, 0.88), grey = vec3(0.45, 0.47, 0.5), belly = vec3(0.62, 0.64, 0.67);
  const windows = step(0.55, abs(positionGeometry.x).div(1.95)).mul(smoothstep(4.15, 4.2, y)).mul(smoothstep(4.55, 4.5, y)).mul(step(abs(positionGeometry.z), 13.5));
  const fuselage = mix(mix(belly, white, smoothstep(2.6, 3.3, y)), vec3(0.05, 0.06, 0.08), windows.mul(0.8));
  const isWing = step(0.5, part).mul(step(part, 1.5));
  const isEngine = step(1.5, part).mul(step(part, 2.5));
  const isFin = step(2.5, part).mul(step(part, 3.5));
  const tailColour = vec3(0.04, 0.16, 0.42);
  let col = mix(fuselage, grey, isWing);
  col = mix(col, vec3(0.75, 0.76, 0.78), isEngine);
  col = mix(col, tailColour, isFin);
  const red = step(3.5, part).mul(step(part, 4.5)), green = step(4.5, part);
  col = mix(col, vec3(0.9, 0.05, 0.05), red);
  col = mix(col, vec3(0.05, 0.9, 0.2), green);
  m.colorNode = col;
  // nav lights glow, brighter after dusk
  const night = smoothstep(0.5, 1.2, cityUniforms.uInteriorGlow).mul(4).add(1);
  m.emissiveNode = vec3(red.mul(3), green.mul(3), green.mul(0.6)).mul(night);
  return m;
}

// --- Movements -------------------------------------------------------------------------------------------------------------
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
// Movement k of the day: its start time (s since midnight) and kind (arrival or departure)
const SLOT = 150;
function movementsAround(now) {
  const list = [];
  const k0 = Math.floor((now - 600) / SLOT), k1 = Math.floor((now + 60) / SLOT);
  for (let k = k0; k <= k1; k++) {
    const t = k * SLOT + hash(k) * 60;
    const hour = (((t / 3600) % 24) + 24) % 24;
    if (hour < 6 || hour >= 23) continue;
    if (hash(k + 0.5) < 0.12) continue; // a quiet slot now and then
    list.push({ k, t, arrival: k % 2 === 0 });
  }
  return list;
}

export function buildPlanes(scene) {
  const mesh = new THREE.InstancedMesh(planeGeometry(), planeMaterial(), MAX_PLANES);
  mesh.name = 'Airliners';
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  mesh.count = 0;
  const group = new THREE.Group();
  group.name = 'GenevaAirport';
  group.userData.terrain = 'absolute';
  group.add(mesh);
  scene.add(group);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const state = { runway: '22', planes: [] };
  let towardNE = false;

  /** `wind`: the weather (js/weather.js state.current): into the bise, runway 04 (towards the north-east) */
  function setWind(w) {
    if (!w) return;
    const fromNE = w.dir >= 0 && w.dir <= 110 && w.wind > 1.5;
    towardNE = fromNE;
    state.runway = fromNE ? '04' : '22';
  }

  function update() {
    const now = simClock.seconds;
    // the runway in use: from its threshold (a) towards its far end (b)
    const a = towardNE ? RUNWAY.sw : RUNWAY.ne, b = towardNE ? RUNWAY.ne : RUNWAY.sw;
    const L = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
    const heading = Math.atan2(ux, uz);
    let n = 0;
    state.planes.length = 0;
    for (const mv of movementsAround(now)) {
      if (n >= MAX_PLANES) break;
      const t = now - mv.t;
      let u, h, pitch = 0, speed;
      if (mv.arrival) {
        // 70 m/s down the glide path to the touchdown zone (400 m past the threshold), then braking to taxi speed
        const tApproach = (APPROACH + 400) / 70;
        if (t < 0) continue;
        if (t < tApproach) {
          u = -APPROACH + t * 70;
          h = Math.max(0, (400 - u) * GLIDE);
          pitch = -0.04;
          speed = 70;
        } else {
          const tr = t - tApproach;
          if (tr > 50) continue; // turned off the runway
          u = 400 + 70 * tr - 0.65 * tr * tr;
          h = 0;
          speed = 70 - 1.3 * tr;
        }
      } else {
        // lined up at the threshold, 2 m/s² to 80 m/s, rotating and climbing at 9°
        if (t < 0) continue;
        const tRoll = 40;
        if (t < tRoll) { u = 0.5 * 2 * t * t; h = 0; speed = 2 * t; pitch = 0; }
        else {
          const tc = t - tRoll;
          u = 1600 + 80 * tc;
          h = u > 1600 ? (u - 1600) * CLIMB : 0;
          pitch = Math.min(0.2, tc * 0.08);
          speed = 80;
        }
        if (u > L + OUT) continue;
      }
      const x = a.x + ux * u, z = a.z + uz * u;
      euler.set(-pitch, heading, 0);
      q.setFromEuler(euler);
      mesh.setMatrixAt(n++, m4.compose(pos.set(x, RUNWAY.y + h, z), q, one));
      state.planes.push({ x, y: RUNWAY.y + h, z, arrival: mv.arrival, speed });
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }
  return { group, update, setWind, state, runway: RUNWAY };
}
