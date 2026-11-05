import * as THREE from 'three/webgpu';
import { float, vec2, vec3, sin, cos, mix, clamp, texture, uv, time, attribute, positionLocal, transformNormalToView, normalize } from 'three/tsl';
import { GENEVA_DATA } from './geneva-geodata.js';
import { deckHeight, inWater } from './terrain.js';
import { cityUniforms } from './tsl-materials.js';

// js/rade-flags.js
// The flags of the Pont du Mont-Blanc: fixed white flagpoles line both parapets the length of the bridge, raked out
// over the water from the railing, the Geneva and the Swiss flags in turn hung along their upper part, the cloth
// falling below the pole (so the cross and the eagle lean with it). The cloth ripples with the weather's wind
// (js/weather.js: cityUniforms.uWindStrength), across the bridge's axis.

const SPACING = 9; // m between poles along a parapet
const POLE_L = 7.5; // m, the pole's length
const RAKE = (44 * Math.PI) / 180; // the pole's lean from the vertical, outwards
const FOOT = 0.9; // m above the deck, where the pole leaves the railing
const FLAG = 2.3; // m, square (the Swiss and the cantonal flags are square)
const HOIST_FROM_TIP = 0.25; // m between the pole's tip and the flag's top corner
const INSET = 0.15; // m in from the bridge's outer edge (on the railing)

function flagTexture(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
// Switzerland: a white couped cross on red (arms 6 wide and 7 long on a 32 field)
const swiss = (g) => {
  const u = 256 / 32;
  g.fillStyle = '#da291c'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#ffffff';
  g.fillRect(13 * u, 6 * u, 6 * u, 20 * u);
  g.fillRect(6 * u, 13 * u, 20 * u, 6 * u);
};
// Geneva: per pale, or a demi-eagle sable crowned and armed gules issuant from the line, gules a key or in pale with
// its wards outwards (to the fly)
const geneva = (g) => {
  g.fillStyle = '#f9d01c'; g.fillRect(0, 0, 128, 256);
  g.fillStyle = '#d0202a'; g.fillRect(128, 0, 128, 256);
  // the half eagle: head turned to the hoist, a wing spread to the hoist, a leg; body against the partition
  g.fillStyle = '#111111';
  g.beginPath();
  g.moveTo(128, 52); g.lineTo(104, 50); g.quadraticCurveTo(88, 46, 84, 60); g.lineTo(70, 64); g.lineTo(84, 70); // head & beak
  g.quadraticCurveTo(92, 84, 110, 86); g.lineTo(110, 96);
  g.lineTo(22, 70); g.lineTo(34, 92); g.lineTo(16, 98); g.lineTo(36, 116); g.lineTo(20, 126); g.lineTo(46, 140); g.lineTo(34, 152); g.lineTo(70, 156); // wing feathers
  g.lineTo(104, 150); g.lineTo(104, 170); g.lineTo(84, 196); g.lineTo(108, 186); g.lineTo(100, 214); g.lineTo(118, 190); g.lineTo(128, 210); // tail
  g.closePath(); g.fill();
  g.fillRect(90, 156, 12, 30); // leg
  g.fillStyle = '#d0202a'; // beak, tongue, claws and crown in red
  g.beginPath(); g.moveTo(84, 60); g.lineTo(66, 64); g.lineTo(84, 68); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(80, 186); g.lineTo(98, 186); g.lineTo(92, 198); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(96, 46); g.lineTo(100, 32); g.lineTo(108, 42); g.lineTo(116, 30); g.lineTo(122, 44); g.lineTo(128, 34); g.lineTo(128, 48); g.closePath(); g.fill();
  g.fillStyle = '#111111'; g.beginPath(); g.arc(98, 56, 3, 0, Math.PI * 2); g.fillStyle = '#f9d01c'; g.fill(); // eye
  // the key, upright, bow at the top
  g.fillStyle = '#f9d01c'; g.strokeStyle = '#f9d01c'; g.lineWidth = 12;
  g.beginPath(); g.ellipse(184, 66, 24, 28, 0, 0, Math.PI * 2); g.stroke();
  g.fillRect(178, 92, 12, 112); // shank
  g.fillRect(190, 168, 30, 12); g.fillRect(190, 188, 30, 12); g.fillRect(206, 168, 14, 32); // wards, to the fly
  g.fillRect(170, 98, 28, 8); // collar
};

export function buildRadeFlags(scene) {
  const group = new THREE.Group();
  group.name = 'PontDuMontBlancFlags';
  group.userData.terrain = 'absolute';
  scene.add(group);
  // The bridge: its carriageway's ends, and how far its side-by-side ways (footway, cycle track) reach either side
  const deck = (GENEVA_DATA.roads || []).filter((r) => r.bridge && /^Pont du Mont-Blanc$/.test(r.name || '') && /^(primary|secondary|trunk)/.test(r.kind));
  if (!deck.length) return { group };
  let a = null, b = null, far = -1;
  const ends = deck.flatMap((r) => [[r.pts[0], r.pts[1]], [r.pts[r.pts.length - 2], r.pts[r.pts.length - 1]]]);
  for (const p of ends) for (const q of ends) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d > far) { far = d; a = p; b = q; } }
  const L = far, ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, nx = -uz, nz = ux;
  // Poles along both parapets, over the water: the parapets stand where the deck ends (city-grid.js), found here
  // by stepping out from the bridge's axis
  const poles = [], tips = [], flags = [[], []];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
  let k = 0;
  for (const side of [1, -1]) {
    for (let s = SPACING / 2; s < L; s += SPACING) {
      const cx = a[0] + ux * s, cz = a[1] + uz * s, y = deckHeight(cx, cz);
      if (y !== y) continue;
      let edge = 6;
      while (edge < 30) {
        const d = deckHeight(cx + nx * side * (edge + 0.25), cz + nz * side * (edge + 0.25), y);
        if (!(d === d && Math.abs(d - y) < 1.5)) break;
        edge += 0.25;
      }
      const x = cx + nx * side * (edge - INSET), z = cz + nz * side * (edge - INSET);
      if (!inWater(x, z)) continue;
      // the pole from its foot on the railing, leaning out along (ox, oz)
      const ox = nx * side, oz = nz * side;
      const px = Math.sin(RAKE) * ox, py = Math.cos(RAKE), pz = Math.sin(RAKE) * oz;
      const fy = y + FOOT;
      q.setFromUnitVectors(UP, new THREE.Vector3(px, py, pz));
      poles.push(m.compose(new THREE.Vector3(x + (px * POLE_L) / 2, fy + (py * POLE_L) / 2, z + (pz * POLE_L) / 2), q, ONE).clone());
      const tip = { x: x + px * POLE_L, y: fy + py * POLE_L, z: z + pz * POLE_L };
      tips.push(m.makeTranslation(tip.x, tip.y, tip.z).clone());
      flags[k++ % 2].push({ ...tip, ox, oz });
    }
  }
  const instanced = (geo, mat, list, shadows = true) => {
    if (!list.length) return null;
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((mm, i) => inst.setMatrixAt(i, mm));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = shadows; inst.receiveShadow = true;
    inst.userData.terrain = 'absolute';
    group.add(inst);
    return inst;
  };
  const white = new THREE.MeshStandardNodeMaterial({ color: 0xf2f2ee, roughness: 0.4, metalness: 0.3 });
  const gold = new THREE.MeshStandardNodeMaterial({ color: 0xc9a43a, roughness: 0.3, metalness: 0.9 });
  instanced(new THREE.CylinderGeometry(0.04, 0.065, POLE_L, 10), white, poles);
  instanced(new THREE.SphereGeometry(0.08, 10, 8), gold, tips);

  // The flags: one merged mesh per flag, each vertex keeping its pole's tip and lean (anchor, out) and its place on
  // the cloth: x down the pole from the top corner (the hoist), y away from the pole, below it (to the fly). The
  // cloth lies in the pole's vertical plane, square to it; it ripples across that plane, more towards the fly.
  const cloth = new THREE.PlaneGeometry(FLAG, FLAG, 12, 12).translate(FLAG / 2, FLAG / 2, 0).toNonIndexed();
  const flagGeometry = (list) => {
    const n = cloth.attributes.position.count, pos = new Float32Array(list.length * n * 3);
    const anchor = new Float32Array(list.length * n * 3), out = new Float32Array(list.length * n * 2), uvs = new Float32Array(list.length * n * 2);
    list.forEach((f, i) => {
      pos.set(cloth.attributes.position.array, i * n * 3);
      // (texture: the hoist at u = 0 along the pole, the top along the pole's tip side)
      for (let v = 0; v < n; v++) {
        const cu = cloth.attributes.uv.array[v * 2], cv = cloth.attributes.uv.array[v * 2 + 1];
        uvs.set([cv, 1 - cu], (i * n + v) * 2);
        anchor.set([f.x, f.y, f.z], (i * n + v) * 3);
        out.set([f.ox, f.oz], (i * n + v) * 2);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('anchor', new THREE.BufferAttribute(anchor, 3));
    g.setAttribute('out', new THREE.BufferAttribute(out, 2));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
    const box = new THREE.Box3();
    list.forEach((f) => box.expandByPoint(new THREE.Vector3(f.x, f.y, f.z)));
    box.expandByScalar(FLAG * 1.5 + 0.5);
    g.boundingBox = box; g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    return g;
  };
  const material = (map) => {
    const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.85 });
    mat.colorNode = texture(map, uv()).rgb;
    const at = attribute('anchor', 'vec3'), o = attribute('out', 'vec2');
    const sr = Math.sin(RAKE), cr = Math.cos(RAKE);
    // along the pole downwards (towards its foot), square to it downwards (the fly), across (the ripple)
    const down = vec3(o.x.mul(-sr), -cr, o.y.mul(-sr));
    const fly = vec3(o.x.mul(cr), -sr, o.y.mul(cr));
    const across = vec3(o.y.negate(), 0, o.x);
    const strength = clamp(cityUniforms.uWindStrength.abs().div(1.4), 0.1, 1);
    const x = positionLocal.x.add(HOIST_FROM_TIP), y = positionLocal.y, f = y.div(FLAG);
    const phase = at.x.mul(0.37).add(at.z.mul(0.53));
    const arg = f.mul(5.5).add(x.mul(0.9)).sub(time.mul(mix(float(1.8), float(6.5), strength))).add(phase);
    const amp = mix(float(0.06), float(0.24), strength).mul(f.mul(0.9).add(0.1));
    const wave = sin(arg).mul(amp), dWave = cos(arg).mul(amp).mul(5.5 / FLAG);
    mat.positionNode = at.add(down.mul(x)).add(fly.mul(y)).add(across.mul(wave));
    mat.normalNode = transformNormalToView(normalize(across.sub(fly.mul(dWave))));
    return mat;
  };
  for (const [list, draw] of [[flags[0], swiss], [flags[1], geneva]]) {
    if (!list.length) continue;
    const mesh = new THREE.Mesh(flagGeometry(list), material(flagTexture(draw)));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.terrain = 'absolute';
    group.add(mesh);
  }
  console.log(`[rade-flags] Pont du Mont-Blanc: ${poles.length} flagpoles (${flags[0].length} Swiss, ${flags[1].length} Geneva flags)`);
  return { group };
}
