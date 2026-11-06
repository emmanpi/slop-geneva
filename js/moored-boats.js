import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { waterSurfaceHeight } from './terrain.js';
import { MOORINGS } from './geneva-moorings.js';

// js/moored-boats.js
// The boats moored in the Rade all year (js/geneva-moorings.js, from the canton's mooring places): white or coloured
// hulls with a teak deck, motor boats with their console, sailing boats with cabin, mast and the sail's blue cover
// on the boom, motor boats under their winter tarps; bobbing at their moorings near the camera. And the paddle
// steamers: « Genève » at the quai Gustave-Ador, and a CGN Belle Époque steamer alongside each CGN pier (white hull
// and saloons, paddle boxes, ochre funnel, wooden upper deck under its awning).

const REF = 8; // m: a boat's parts are drawn for this length; heights scale with the boat's length over it
const NEAR = 260; // m: boats bob within this distance of the camera
const HULL_COLOURS = [0xf4f4f0, 0xf4f4f0, 0xf4f4f0, 0xf1efe6, 0x1f2f4f, 0x24493a, 0x8c1c22, 0xd9d2bf].map((c) => new THREE.Color(c));
const TARP_COLOURS = [0x24467a, 0x2e5d9c, 0x6f767c, 0x1d2c44, 0xc9c1ab].map((c) => new THREE.Color(c));

// A box in the unit frame (x along the boat from -0.5 stern to 0.5 bow, z across from -0.5 to 0.5, y in metres for
// a REF m boat), coloured
function box(x0, x1, y0, y1, z0, z1, colour) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2).toNonIndexed();
  return paint(g, colour);
}
function paint(g, colour) {
  const c = new THREE.Color(colour), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}
// A hull outline (top view, x along, z across) extruded from y0 to y1
function hullGeometry(outline, y0, y1) {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(Math.PI / 2).translate(0, y1, 0); // (the shape's y becomes z; extruded downwards from y1)
  return g.toNonIndexed();
}
const SMALL_HULL = [[-0.5, -0.44], [0.15, -0.5], [0.36, -0.36], [0.47, -0.14], [0.5, 0], [0.47, 0.14], [0.36, 0.36], [0.15, 0.5], [-0.5, 0.44]];

function smallBoatParts() {
  const hull = hullGeometry(SMALL_HULL, -0.35, 0.8);
  hull.deleteAttribute('uv');
  // narrower at the keel than at the gunwale
  { const p = hull.attributes.position; for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) { p.setZ(i, p.getZ(i) * 0.55); p.setX(i, p.getX(i) * 0.94); } }
  const deck = paint(hullGeometry(SMALL_HULL.map(([x, z]) => [x * 0.96, z * 0.9]), 0.8, 0.84), 0xb48a5a);
  deck.deleteAttribute('uv');
  const white = 0xf2f2ee, glass = 0x1d252b, navy = 0x23406e, steel = 0xc8ccd0;
  const motor = mergeGeometries([
    box(-0.06, 0.16, 0.84, 1.45, -0.3, 0.3, white), // console
    box(0.1, 0.17, 1.45, 1.75, -0.28, 0.28, glass), // windscreen
    box(-0.4, -0.18, 0.84, 1.25, -0.4, 0.4, 0xe9e4d8) // bench aft
  ]);
  const sail = mergeGeometries([
    box(-0.26, 0.14, 0.84, 1.35, -0.28, 0.28, white), // cabin
    box(-0.22, 0.1, 1.08, 1.22, -0.285, 0.285, glass), // its windows
    box(0.11, 0.125, 0.84, 11.5, -0.012, 0.012, steel), // mast
    box(-0.36, 0.12, 1.85, 2.15, -0.035, 0.035, navy), // boom with the furled sail's cover
    box(-0.46, 0.14, 0.95, 0.98, -0.47, -0.465, steel), box(-0.46, 0.14, 0.95, 0.98, 0.465, 0.47, steel) // guard rails
  ]);
  // a tarp over the motor boat, ridged along its middle
  const tarpShape = [[-0.47, -0.42], [0.2, -0.46], [0.4, -0.3], [0.45, 0], [0.4, 0.3], [0.2, 0.46], [-0.47, 0.42]];
  const tarp = hullGeometry(tarpShape, 0.84, 1.3);
  tarp.deleteAttribute('uv');
  const p = tarp.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 1.0) p.setY(i, 1.0 + 0.45 * (1 - Math.min(1, Math.abs(p.getZ(i)) / 0.46)));
  tarp.computeVertexNormals();
  hull.computeVertexNormals(); deck.computeVertexNormals();
  return { hull, deck, motor, sail, tarp };
}

// A paddle steamer, length L and beam B, x along it (stern -L/2, bow +L/2), y up from the water line
function steamerGeometry(L, B) {
  const parts = [];
  const white = 0xf5f3ec, glass = 0x1c252c, wood = 0x8a6440, ochre = 0xd9a441, black = 0x1a1a1a, gold = 0xc9a43a, navy = 0x1f2c3f;
  const outline = [[-0.5, -0.36], [-0.47, -0.46], [-0.4, -0.5], [0.28, -0.5], [0.4, -0.38], [0.47, -0.18], [0.5, 0], [0.47, 0.18], [0.4, 0.38], [0.28, 0.5], [-0.4, 0.5], [-0.47, 0.46], [-0.5, 0.36]]
    .map(([x, z]) => [x * L, z * B]);
  const hull = paint(hullGeometry(outline, -1.4, 1.9), white);
  hull.deleteAttribute('uv');
  parts.push(hull);
  const band = (y0, y1, colour, grow) => { const g = paint(hullGeometry(outline.map(([x, z]) => [x * (1 + grow / L), z * (1 + grow / B)]), y0, y1), colour); g.deleteAttribute('uv'); parts.push(g); };
  band(-0.6, 0.25, navy, 0.04); // the water line
  band(1.55, 1.65, gold, 0.04); // the gilt line
  const b = (x0, x1, y0, y1, w, colour, zc = 0) => parts.push(box(x0 * L, x1 * L, y0, y1, zc - w / 2, zc + w / 2, colour));
  // main deck saloons, windows all along
  b(-0.44, 0.3, 1.9, 4.2, B * 0.86, white);
  b(-0.42, 0.28, 2.55, 3.65, B * 0.87, glass);
  // the upper deck, its first-class saloon and the wheelhouse, the awning aft
  b(-0.47, 0.33, 4.2, 4.38, B * 0.98, wood);
  b(-0.36, -0.04, 4.38, 6.3, B * 0.7, white);
  b(-0.34, -0.06, 4.9, 5.9, B * 0.71, glass);
  b(0.07, 0.15, 4.38, 6.7, B * 0.42, white);
  b(0.08, 0.14, 5.7, 6.4, B * 0.43, glass);
  b(-0.47, -0.02, 6.55, 6.7, B * 0.96, 0xf8f6ef);
  for (const x of [-0.46, -0.3, -0.14, -0.03]) for (const z of [-0.46, 0.46]) b(x, x + 0.004, 4.38, 6.55, 0.1, white, z * B);
  // the paddle boxes, either side amidships
  for (const side of [-1, 1]) {
    const g = new THREE.CylinderGeometry(3.1, 3.1, 2.0, 20, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0.02 * L, 0.6, side * (B / 2 + 0.95)).toNonIndexed();
    g.deleteAttribute('uv');
    parts.push(paint(g, white));
    // its gilt rim and fan of rays on the outer face
    const rim = new THREE.TorusGeometry(3.05, 0.09, 4, 20, Math.PI).translate(0.02 * L, 0.6, side * (B / 2 + 1.97)).toNonIndexed();
    rim.deleteAttribute('uv');
    parts.push(paint(rim, gold));
    for (let r = 1; r < 8; r++) {
      const a = (r / 8) * Math.PI, ray = new THREE.BoxGeometry(2.6, 0.08, 0.06).translate(1.4, 0, 0).rotateZ(a).translate(0.02 * L, 0.6, side * (B / 2 + 1.98)).toNonIndexed();
      ray.deleteAttribute('uv');
      parts.push(paint(ray, gold));
    }
  }
  // funnel, masts
  const funnel = new THREE.CylinderGeometry(0.85, 0.9, 5.2, 16).translate(0.0, 4.38 + 2.6, 0).toNonIndexed();
  funnel.deleteAttribute('uv'); parts.push(paint(funnel, ochre));
  const top = new THREE.CylinderGeometry(0.88, 0.88, 0.45, 16).translate(0.0, 4.38 + 5.0, 0).toNonIndexed();
  top.deleteAttribute('uv'); parts.push(paint(top, black));
  b(0.38, 0.385, 1.9, 11, 0.16, black);
  b(-0.495, -0.49, 1.9, 8, 0.1, black);
  const g = mergeGeometries(parts.map((p) => (p.attributes.normal ? p : (p.computeVertexNormals(), p))));
  g.computeVertexNormals();
  return g;
}

export function buildMooredBoats(scene) {
  const group = new THREE.Group();
  group.name = 'MooredBoats';
  group.userData.terrain = 'absolute';
  scene.add(group);
  const data = MOORINGS.boats, n = data.length / 6;
  const parts = smallBoatParts();
  const lit = (opts) => new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.05, ...opts });
  const byKind = [[], [], []];
  // In 100 m squares (row by row), so the boats bobbing near the camera have neighbouring slots: update() uploads
  // just their span of each instance buffer
  const square = (i) => Math.floor(data[i * 6 + 1] / 100) * 1e4 + Math.floor(data[i * 6] / 100);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => square(a) - square(b) || a - b);
  for (const i of order) byKind[data[i * 6 + 5]].push(i);
  const make = (geo, mat, list) => {
    const inst = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    inst.count = list.length;
    inst.castShadow = true; inst.receiveShadow = true;
    inst.userData.terrain = 'absolute';
    group.add(inst);
    return { inst, list };
  };
  const meshes = [
    make(parts.hull, lit({ roughness: 0.35 }), order),
    make(parts.deck, lit({ vertexColors: true, roughness: 0.8 }), order),
    make(parts.motor, lit({ vertexColors: true }), byKind[0]),
    make(parts.sail, lit({ vertexColors: true }), byKind[1]),
    make(parts.tarp, lit({ roughness: 0.9 }), byKind[2])
  ];
  const hash = (k) => { const s = Math.sin(k * 91.7 + 3.1) * 43758.5453; return s - Math.floor(s); };
  order.forEach((i, k) => meshes[0].inst.setColorAt(k, HULL_COLOURS[Math.floor(hash(i) * HULL_COLOURS.length)]));
  byKind[2].forEach((i, k) => meshes[4].inst.setColorAt(k, TARP_COLOURS[Math.floor(hash(i + 7) * TARP_COLOURS.length)]));
  // each boat's index in each mesh
  const slots = meshes.map(({ list }) => { const m = new Map(); list.forEach((i, k) => m.set(i, k)); return m; });
  const water = new Float32Array(n);
  for (let i = 0; i < n; i++) water[i] = waterSurfaceHeight(data[i * 6], data[i * 6 + 1]);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const place = (i, t) => {
    const x = data[i * 6], z = data[i * 6 + 1], heading = data[i * 6 + 2], len = data[i * 6 + 3], beam = data[i * 6 + 4];
    const ph = hash(i) * 6.283, small = 6 / Math.max(4, len);
    const bob = t === null ? 0 : Math.sin(t * 1.1 + ph) * 0.05 * small;
    const roll = t === null ? 0 : Math.sin(t * 0.9 + ph * 1.7) * 0.035 * small, pitch = t === null ? 0 : Math.sin(t * 0.7 + ph) * 0.012 * small;
    p.set(x, water[i] + bob, z);
    e.set(roll, heading, pitch, 'YXZ'); q.setFromEuler(e);
    s.set(len, len / REF, beam);
    m4.compose(p, q, s);
    for (let k = 0; k < meshes.length; k++) { const slot = slots[k].get(i); if (slot !== undefined) meshes[k].inst.setMatrixAt(slot, m4); }
  };
  for (let i = 0; i < n; i++) place(i, null);
  for (const { inst } of meshes) { inst.instanceMatrix.needsUpdate = true; if (inst.instanceColor) inst.instanceColor.needsUpdate = true; inst.computeBoundingSphere(); }

  // The steamers
  const steamerMat = lit({ vertexColors: true, roughness: 0.45 });
  for (const st of MOORINGS.steamers) {
    const mesh = new THREE.Mesh(steamerGeometry(st.length, st.beam), steamerMat);
    mesh.position.set(st.x, waterSurfaceHeight(st.x, st.z), st.z);
    mesh.rotation.y = st.heading;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = st.name;
    mesh.userData.terrain = 'absolute';
    group.add(mesh);
  }
  console.log(`[moored-boats] ${n} boats at their moorings (${byKind[0].length} motor, ${byKind[1].length} sailing, ${byKind[2].length} covered); ` +
    `steamers: ${MOORINGS.steamers.map((st) => st.name).join(', ')}`);

  // Bobbing: the boats near the camera, a quarter of them per frame
  const near = [];
  const lo = new Float64Array(meshes.length), hi = new Float64Array(meshes.length); // slots moved this frame, per mesh
  let frame = 0;
  function update(elapsed, camera) {
    if ((frame++ & 15) === 0) {
      near.length = 0;
      const cx = camera.position.x, cz = camera.position.z;
      for (let i = 0; i < n; i++) if (Math.abs(data[i * 6] - cx) < NEAR && Math.abs(data[i * 6 + 1] - cz) < NEAR) near.push(i);
    }
    if (!near.length) return;
    lo.fill(Infinity);
    hi.fill(-1);
    for (let k = frame & 3; k < near.length; k += 4) {
      const i = near[k];
      place(i, elapsed);
      for (let j = 0; j < meshes.length; j++) {
        const slot = slots[j].get(i);
        if (slot === undefined) continue;
        if (slot < lo[j]) lo[j] = slot;
        if (slot > hi[j]) hi[j] = slot;
      }
    }
    // Upload only the span of the instances moved, not the whole buffer of every mesh (~5000 boats: ~0.5 MB a frame,
    // which stalled the GPU queue in hitches over the Rade). (main.js swaps instanceMatrix for a storage attribute:
    // looked up here every time.)
    for (let j = 0; j < meshes.length; j++) {
      if (hi[j] < 0) continue;
      const attr = meshes[j].inst.instanceMatrix;
      attr.clearUpdateRanges();
      attr.addUpdateRange(lo[j] * 16, (hi[j] - lo[j] + 1) * 16);
      attr.needsUpdate = true;
    }
  }
  return { group, update, stats: { boats: n, steamers: MOORINGS.steamers.length } };
}
