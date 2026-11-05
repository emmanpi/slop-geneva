import * as THREE from 'three/webgpu';
import { mx_noise_float, positionLocal, positionWorld, normalWorld, float, smoothstep, fract, floor, sin, abs, step, vertexColor, attribute, vec3, mix, max, min, exp } from 'three/tsl';
import { orthoAt } from './orthophoto.js';
import { insidePhotomesh, photomeshOn, outsideStreetView } from './photomesh.js';
import { cityUniforms } from './tsl-materials.js';
import { createStorefront } from './storefronts.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FRAME } from './geneva-frame.js';
import { ecefToLv95 } from './swiss-projection.js';

// swisstopo swissBUILDINGS3D 3.0: every building of Switzerland with its real roof, as 3D Tiles 1.0 (b3dm with Draco
// glTF, georeferenced in WGS84 ECEF). The tiles overlapping the city are stored in data/swissbuildings3d/ (refreshed
// deliberately from 3d.geo.admin.ch by tools/update-swissbuildings3d.mjs); they stream in nearest first and are baked
// into engine coordinates:
//   x = LV95 east - E0, z = N0 - LV95 north, y = height a.s.l. - H0 (js/geneva-frame.js).
// Each tile gets an exact local affine map (the Jacobian of the rigorous ECEF -> LV95 transformation at its centre: a
// tile spans ~100 m, so the residual is far below a millimetre). Heights come out above the Bessel ellipsoid; the batch
// table's surveyed roof tops (DACH_MAX, metres a.s.l.) calibrate each tile to orthometric heights without a geoid model.

const INDEX_URL = new URL('../data/swissbuildings3d/index.json', import.meta.url);
// Facade style & storey height of every building, from the RegBL (tools/build-geneva-facades.mjs)
const FACADES_URL = new URL('../data/geneva-facades.json', import.meta.url);
// The styles, in the order of data/geneva-facades.json, then the churches and their bell towers (swissBUILDINGS3D's
// OBJEKTART 'Sakrales Gebaeude' and 'Sakraler Turm', whatever the RegBL says)
export const FACADE_STYLES = ['ancien', 'xixe', 'moderne', 'contemporain', 'bureaux', 'inconnu', 'sacre', 'clocher'];
const STYLE = Object.fromEntries(FACADE_STYLES.map((name, i) => [name, i]));

// --- b3dm container ----------------------------------------------------------------------------------------------------
export function parseB3dm(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'b3dm') throw new Error(`not a b3dm tile (${magic})`);
  const ftJson = view.getUint32(12, true), ftBin = view.getUint32(16, true);
  const btJson = view.getUint32(20, true), btBin = view.getUint32(24, true);
  const text = (start, length) => (length ? JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length))) : {});
  const featureTable = text(28, ftJson);
  const batchTable = text(28 + ftJson + ftBin, btJson);
  const glbStart = 28 + ftJson + ftBin + btJson + btBin;
  return { featureTable, batchTable, glb: buffer.slice(glbStart, view.getUint32(8, true)) };
}

// --- Tile frame: glTF (y-up, relative to RTC_CENTER) -> engine ------------------------------------------------------------
const Y_UP_TO_Z_UP = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

// Engine coordinates of a WGS84 ECEF point, heights above the Bessel ellipsoid minus H0 (uncalibrated)
function ecefToEngine(x, y, z) {
  const p = ecefToLv95(x, y, z);
  return [p.E - FRAME.E0, p.h - FRAME.H0, FRAME.N0 - p.N];
}

// Affine Matrix4 mapping ECEF offsets from `center` (an [x, y, z] array) to engine coordinates
export function tileMatrix(center) {
  const [cx, cy, cz] = center;
  const o = ecefToEngine(cx, cy, cz);
  const step = 1;
  const cols = [[step, 0, 0], [0, step, 0], [0, 0, step]].map(([dx, dy, dz]) => {
    const a = ecefToEngine(cx + dx, cy + dy, cz + dz), b = ecefToEngine(cx - dx, cy - dy, cz - dz);
    return [(a[0] - b[0]) / (2 * step), (a[1] - b[1]) / (2 * step), (a[2] - b[2]) / (2 * step)];
  });
  return new THREE.Matrix4().set(
    cols[0][0], cols[1][0], cols[2][0], o[0],
    cols[0][1], cols[1][1], cols[2][1], o[1],
    cols[0][2], cols[1][2], cols[2][2], o[2],
    0, 0, 0, 1
  );
}

function hash(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// Geneva palette: light plaster and molasse sandstone facades, clay-tile and zinc roofs, grey flat roofs
const color = new THREE.Color();
function facadeColor(seed, kind, style = STYLE.inconnu) {
  const r = hash(seed + 1), s = hash(seed * 7 + 3);
  switch (style) {
    case STYLE.sacre: case STYLE.clocher: // dressed limestone and molasse: pale grey-beige, the odd greener molasse
      if (r < 0.7) return color.setHSL(0.1 + s * 0.03, 0.07 + s * 0.05, 0.62 + r * 0.1);
      return color.setHSL(0.14 + s * 0.03, 0.1, 0.55 + s * 0.08);
    case STYLE.ancien: // limestone and lime plaster of the old town: grey-beige, ochre, a few pastels
      if (r < 0.5) return color.setHSL(0.1 + s * 0.03, 0.1 + r * 0.12, 0.66 + s * 0.12);
      if (r < 0.8) return color.setHSL(0.09 + s * 0.04, 0.3 + s * 0.15, 0.68 + r * 0.1);
      return color.setHSL(0.02 + s * 0.12, 0.25, 0.72 + s * 0.08);
    case STYLE.xixe: // Geneva's molasse (grey-green sandstone), cream plaster and pale limestone
      if (r < 0.45) return color.setHSL(0.13 + s * 0.04, 0.1 + s * 0.08, 0.56 + r * 0.14);
      if (r < 0.8) return color.setHSL(0.1 + s * 0.03, 0.22 + s * 0.12, 0.72 + s * 0.1);
      return color.setHSL(0.11, 0.06 + s * 0.06, 0.74 + r * 0.08);
    case STYLE.moderne: // fair-faced concrete, off-white render, the odd pastel
      if (r < 0.7) return color.setHSL(0.1 + s * 0.05, 0.03 + s * 0.06, 0.64 + r * 0.16);
      return color.setHSL(s, 0.2, 0.7 + r * 0.08);
    case STYLE.contemporain: // white and light grey render, timber cladding, dark metal
      if (r < 0.65) return color.setHSL(0.1, 0.02 + s * 0.04, 0.78 + s * 0.1);
      if (r < 0.82) return color.setHSL(0.07 + s * 0.02, 0.35, 0.42 + s * 0.1);
      return color.setHSL(0.6, 0.04, 0.3 + s * 0.1);
    case STYLE.bureaux: // spandrel panels between the glazing: grey-blue, bronze, aluminium
      if (r < 0.5) return color.setHSL(0.58, 0.1, 0.36 + s * 0.12);
      if (r < 0.75) return color.setHSL(0.08, 0.2, 0.34 + s * 0.1);
      return color.setHSL(0.6, 0.03, 0.6 + s * 0.1);
  }
  if (r < 0.45) return color.setHSL(0.10 + s * 0.04, 0.18 + r * 0.2, 0.74 + s * 0.12); // cream / ochre plaster
  if (r < 0.75) return color.setHSL(0.08 + s * 0.06, 0.04 + s * 0.06, 0.70 + r * 0.12); // light grey / white
  if (r < 0.9) return color.setHSL(0.07 + s * 0.03, 0.22, 0.56 + s * 0.12); // sandstone
  return color.setHSL(0.02 + s * 0.04, 0.26, 0.48 + s * 0.12); // muted red / rose
}
function roofColor(seed, pitched) {
  const r = hash(seed * 13 + 5), s = hash(seed * 3 + 11);
  if (!pitched) return color.setHSL(0.1, 0.03, 0.42 + r * 0.14); // gravel / membrane flat roofs
  if (r < 0.78) return color.setHSL(0.025 + s * 0.025, 0.45 + r * 0.15, 0.32 + s * 0.08); // clay tiles
  if (r < 0.9) return color.setHSL(0.47 + s * 0.04, 0.22, 0.42 + s * 0.08); // weathered copper
  return color.setHSL(0.6, 0.06, 0.28 + s * 0.06); // slate / eternit
}

// The tile's shift fits the median building. A church can come out standing clear of the ground all round: the
// cathedral on its hill, ~6 m up. It is a dozen buildings (nave, aisles, towers, spire, portico), so the floating
// church buildings that touch come down together, by the smallest of their gaps: the lowest of them settles on the
// ground, a little into it. A group stays put when one of them stands on a church building that does not float (its
// base's centre over that one's footprint, higher up: the Russian church's domes on its body), and so does a bell
// tower floating on its own (its church is over the tile's edge: it stands on it there). The base being flat, where
// the ground falls away under a settled building (the cathedral's south side, down to the Terrasse Agrippa
// d'Aubigné) its walls are carried down into the ground (shift.footing: the bottom vertices to lower). Only churches: elsewhere a floating volume is often meant to (canopies, footbridges,
// buildings on stilts or over the Rhône). Returns the shift of each building (batch id -> metres).
function settleChurches(positions, batchOf, total, dy, ground, kindOf) {
  const sacred = (b) => /^Sakral/.test(kindOf(b)), tower = (b) => /Turm/.test(kindOf(b));
  const none = Object.assign(() => dy, { footing: () => false });
  if (!ground) return none;
  const box = new Map(); // batch id -> [minX, maxX, minZ, maxZ, minY, base centre x, z, bottom vertex count]
  for (let i = 0; i < total; i++) {
    const b = batchOf[i];
    if (!sacred(b)) continue;
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const r = box.get(b) || box.set(b, [x, x, z, z, y]).get(b);
    if (x < r[0]) r[0] = x; if (x > r[1]) r[1] = x; if (z < r[2]) r[2] = z; if (z > r[3]) r[3] = z; if (y < r[4]) r[4] = y;
  }
  if (!box.size) return none;
  // the gap under each one's base: its bottom vertices against the ground under them, the closest one
  const gap = new Map();
  for (let i = 0; i < total; i++) {
    const b = batchOf[i], r = box.get(b), y = positions[i * 3 + 1];
    if (!r || y > r[4] + 0.3) continue;
    const g = ground(positions[i * 3], positions[i * 3 + 2]);
    if (Number.isFinite(g)) gap.set(b, Math.min(gap.get(b) ?? Infinity, y + dy - g));
    r[5] = (r[5] || 0) + positions[i * 3]; r[6] = (r[6] || 0) + positions[i * 3 + 2]; r[7] = (r[7] || 0) + 1;
  }
  const floats = (b) => gap.get(b) > 0.3;
  const resting = (b) => {
    const A = box.get(b), cx = A[5] / A[7], cz = A[6] / A[7];
    for (const [c, C] of box) if (c !== b && !floats(c) && A[4] > C[4] + 1 && cx > C[0] && cx < C[1] && cz > C[2] && cz < C[3]) return true;
    return false;
  };
  // groups of floating church buildings whose footprints touch (half a metre apart at most)
  const ids = [...gap.keys()].filter(floats);
  const parent = new Map(ids.map((b) => [b, b]));
  const find = (b) => { while (parent.get(b) !== b) b = parent.get(b); return b; };
  for (let a = 0; a < ids.length; a++) for (let c = a + 1; c < ids.length; c++) {
    const A = box.get(ids[a]), C = box.get(ids[c]);
    if (Math.min(A[1], C[1]) - Math.max(A[0], C[0]) > -0.5 && Math.min(A[3], C[3]) - Math.max(A[2], C[2]) > -0.5) parent.set(find(ids[a]), find(ids[c]));
  }
  const drop = new Map();
  for (const b of ids) { const r = find(b); drop.set(r, Math.min(drop.get(r) ?? Infinity, resting(b) ? 0 : gap.get(b))); }
  const body = new Set(ids.filter((b) => !tower(b)).map(find));
  const shift = new Map(ids.filter((b) => drop.get(find(b)) > 0 && body.has(find(b))).map((b) => [b, dy - drop.get(find(b)) - 0.15]));
  // footings: the settled buildings whose base now stands within 5 m of the ground (not those up on the roofs)
  const near = new Set([...shift.keys()].filter((b) => gap.get(b) - drop.get(find(b)) < 5));
  return Object.assign((b) => shift.get(b) ?? dy, { footing: (b, y) => near.has(b) && y < box.get(b)[4] + 0.3 });
}

// Bakes a decoded tile into one engine-space geometry: position, vertex colour, and the height above the building's
// surveyed ground point (aGround: storey lines and shop windows follow the street, whatever the terrain does).
export function bakeTile(gltf, tile, stats) {
  const { featureTable, batchTable } = tile;
  const rtc = featureTable.RTC_CENTER || [0, 0, 0];
  gltf.scene.updateMatrixWorld(true);
  const meshes = [];
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (!meshes.length) return null;
  // Tile centre in ECEF: RTC_CENTER plus the first mesh's node offset
  const firstNode = new THREE.Vector3().setFromMatrixPosition(meshes[0].matrixWorld).applyMatrix4(Y_UP_TO_Z_UP);
  const center = [rtc[0] + firstNode.x, rtc[1] + firstNode.y, rtc[2] + firstNode.z];
  const toEngine = tileMatrix(center)
    .multiply(new THREE.Matrix4().makeTranslation(rtc[0] - center[0], rtc[1] - center[1], rtc[2] - center[2]))
    .multiply(Y_UP_TO_Z_UP);

  let total = 0;
  for (const m of meshes) total += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count;
  let positions = new Float32Array(total * 3);
  const batchOf = new Uint32Array(total);
  const normalsY = new Float32Array(total);
  const v = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  let k = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const full = new THREE.Matrix4().multiplyMatrices(toEngine, m.matrixWorld);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(full);
    const pos = g.attributes.position, nor = g.attributes.normal, bid = g.attributes._batchid;
    const index = g.index;
    const n = index ? index.count : pos.count;
    for (let t = 0; t < n; t++) {
      const i = index ? index.getX(t) : t;
      v.fromBufferAttribute(pos, i).applyMatrix4(full);
      positions[k * 3] = v.x; positions[k * 3 + 1] = v.y; positions[k * 3 + 2] = v.z;
      normalsY[k] = nor ? nrm.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize().y : 0;
      batchOf[k] = bid ? Math.round(bid.getX(i)) : 0;
      k++;
    }
  }

  // Vertical calibration: surveyed roof tops against the baked (ellipsoidal) ones
  const roofTop = batchTable.DACH_MAX || [];
  const maxY = new Map();
  for (let i = 0; i < total; i++) maxY.set(batchOf[i], Math.max(maxY.get(batchOf[i]) ?? -Infinity, positions[i * 3 + 1]));
  // the top of the plumb walls (the eaves, the foot of a spire): a church's windows and a tower's belfry hang from it
  const wallTop = new Map();
  for (let i = 0; i < total; i++) {
    if (Math.abs(normalsY[i]) < 0.05) wallTop.set(batchOf[i], Math.max(wallTop.get(batchOf[i]) ?? -Infinity, positions[i * 3 + 1]));
  }
  const diffs = [];
  for (const [b, y] of maxY) if (Number.isFinite(roofTop[b])) diffs.push(roofTop[b] - FRAME.H0 - y);
  // Some releases (Geneva's) carry no surveyed roof tops: the buildings' feet then calibrate the tile on the terrain
  // model instead (the lowest vertex of each building against the ground under it)
  const foot = new Map(); // batch id -> vertex index of its lowest point
  for (let i = 0; i < total; i++) {
    const f = foot.get(batchOf[i]);
    if (f === undefined || positions[i * 3 + 1] < positions[f * 3 + 1]) foot.set(batchOf[i], i);
  }
  if (!diffs.length && stats.ground) {
    for (const i of foot.values()) {
      const g = stats.ground(positions[i * 3], positions[i * 3 + 2]);
      if (Number.isFinite(g)) diffs.push(g - positions[i * 3 + 1]);
    }
  }
  const local = median(diffs);
  if (local != null) stats.offsets.push(local);
  const dy = local ?? median(stats.offsets) ?? 0;

  const ground = batchTable.GELAENDEPUNKT || [];
  const kinds = batchTable.OBJEKTART || [];
  const shift = settleChurches(positions, batchOf, total, dy, stats.ground, (b) => kinds[b] || '');
  const egids = batchTable.EGID || [];
  let colors = new Uint8Array(total * 4);
  let above = new Float32Array(total);
  // aFacade: style, storey height (m), the building's height above its foot (m); per building from the RegBL
  let facade = new Float32Array(total * 3);
  // aArchetype: window scale (the measured share of windows against the usual), shop fronts (0..1), the wall's texture
  const arch = new Float32Array(total * 3);
  // "style,storey dm,archetype,RRGGBB" per building (tools/build-geneva-facades.mjs): the wall colour measured in the
  // photomesh (or its archetype's), the archetype's share of windows and shop fronts
  const styleOf = (tile.facades || '').split(';').map((e) => {
    const [st, f, a, hex, w, p, t] = e.split(',');
    return [Number(st), Number(f), a === undefined ? -1 : Number(a), hex, w === undefined ? null : [+w, +p, +t]];
  });
  const archetypes = tile.archetypes || [];
  const wallColour = new THREE.Color();
  let minY = Infinity;
  for (let i = 0; i < total; i++) {
    const b = batchOf[i];
    const y = positions[i * 3 + 1] + shift(b);
    positions[i * 3 + 1] = y;
    minY = Math.min(minY, y);
    const base = Number.isFinite(ground[b]) ? ground[b] - FRAME.H0 : positions[foot.get(b) * 3 + 1] + (foot.get(b) <= i ? 0 : shift(b));
    above[i] = y - base;
    const seed = (egids[b] || 0) * 31 + b + (tile.seed || 0);
    const roof = normalsY[i] > 0.35;
    let [style = STYLE.inconnu, storey = 31, a = -1, hex, own] = styleOf[b] || [];
    // churches: their own stone and windows; the colour measured on their own photographed walls only
    const kind = kinds[b] || '';
    const sacred = /^Sakral/.test(kind);
    if (sacred) { style = /Turm/.test(kind) ? STYLE.clocher : STYLE.sacre; if (!own) hex = null; }
    const c = roof ? roofColor(seed, normalsY[i] < 0.97) : hex ? wallColour.set(`#${hex}`) : facadeColor(seed, kind, style);
    const at = own ? { win: own[0], shop: own[1], rough: own[2] } : archetypes[a];
    arch[i * 3] = at ? Math.min(1.5, Math.max(0.6, 0.65 + at.win * 2.2)) : 1;
    arch[i * 3 + 1] = at ? at.shop : 0.5;
    arch[i * 3 + 2] = sacred ? Math.max(at?.rough ?? 0, 0.26) : at?.rough ?? 0.15;
    facade[i * 3] = style; facade[i * 3 + 1] = storey / 10;
    // the building's height above its foot; a church's: up to its eaves (the gables and spires above stay plain)
    const top = sacred && Number.isFinite(wallTop.get(b)) ? wallTop.get(b) : maxY.get(b);
    facade[i * 3 + 2] = top - positions[foot.get(b) * 3 + 1] + (foot.get(b) <= i ? shift(b) : 0);
    colors[i * 4] = c.r * 255; colors[i * 4 + 1] = c.g * 255; colors[i * 4 + 2] = c.b * 255; colors[i * 4 + 3] = roof ? 255 : 0;
  }
  // a settled church's walls carried down to the ground where it falls away under its flat base (settleChurches)
  for (let i = 0; i < total; i++) {
    if (!shift.footing(batchOf[i], positions[i * 3 + 1] - shift(batchOf[i]))) continue;
    const g = stats.ground(positions[i * 3], positions[i * 3 + 2]) - 0.3;
    if (!(g < positions[i * 3 + 1])) continue;
    above[i] -= positions[i * 3 + 1] - g;
    positions[i * 3 + 1] = g;
    minY = Math.min(minY, g);
  }
  // Buildings standing in a photomesh area (js/photomesh.js) fold away while the photomesh shows (aHide: the
  // material's positionNode), and come back when the Photomesh button turns it off
  const centre = new Map();
  for (let i = 0; i < total; i++) {
    const c = centre.get(batchOf[i]) || centre.set(batchOf[i], [Infinity, -Infinity, Infinity, -Infinity]).get(batchOf[i]);
    c[0] = Math.min(c[0], positions[i * 3]); c[1] = Math.max(c[1], positions[i * 3]);
    c[2] = Math.min(c[2], positions[i * 3 + 2]); c[3] = Math.max(c[3], positions[i * 3 + 2]);
  }
  const inMesh = new Set([...centre].filter(([, c]) => insidePhotomesh((c[0] + c[1]) / 2, (c[2] + c[3]) / 2)).map(([b]) => b));
  // aHide: x 1 in a photomesh area, yz the building's centre (it comes back as a whole inside the street view's circle)
  const hide = new Float32Array(total * 3);
  for (let i = 0; i < total; i++) {
    const c = centre.get(batchOf[i]);
    hide[i * 3] = inMesh.has(batchOf[i]) ? 1 : 0;
    hide[i * 3 + 1] = (c[0] + c[1]) / 2; hide[i * 3 + 2] = (c[2] + c[3]) / 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4, true));
  geometry.setAttribute('aGround', new THREE.BufferAttribute(above, 1));
  geometry.setAttribute('aFacade', new THREE.BufferAttribute(facade, 3));
  geometry.setAttribute('aHide', new THREE.BufferAttribute(hide, 3));
  geometry.setAttribute('aArchetype', new THREE.BufferAttribute(arch, 3));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  geometry.userData = { buildings: maxY.size, inPhotomesh: inMesh.size, calibration: dy, minY };
  return geometry;
}

// Facades drawn per style (FACADE_STYLES) on the storey grid of each building:
//  ancien        stone and plaster, narrow windows in stone surrounds, shutters, a cornice
//  xixe          molasse, tall windows in surrounds, shutters, the étage noble's wrought-iron balcony, string courses
//  moderne       wider windows, balcony slabs and parapets every storey
//  contemporain  large glazing, slim frames
//  bureaux       curtain walls: glass between mullions and spandrels
//  sacre         a church: dressed stone without storeys, tall pointed stained-glass windows hung from the eaves
//  clocher       its bell tower: arrow slits up the shaft, louvred belfry openings under the eaves
// Roofs take the SWISSIMAGE orthophoto (js/orthophoto.js) over their procedural colour. Windows light up after dusk.
function createMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, flatShading: true });
  // folded to a point (no surface, no shadow) where the photomesh shows the real building: in its areas, unless the
  // building stands within the street view's circle around a camera near the ground (js/photomesh.js)
  const hideAttr = attribute('aHide', 'vec3');
  m.positionNode = positionLocal.mul(float(1).sub(hideAttr.x.mul(photomeshOn).mul(outsideStreetView(hideAttr.yz))));
  const above = attribute('aGround', 'float');
  const facade = attribute('aFacade', 'vec3');
  const style = facade.x, storey = max(facade.y, 2.4), height = facade.z;
  const roof = vertexColor().a;
  const is = (k) => step(abs(style.sub(k)), 0.5);
  // One value per style: ancien, xixe, moderne, contemporain, bureaux, inconnu (the churches: sacre, clocher, after)
  const pick = (...v) => v.reduce((acc, value, k) => acc.add(is(k).mul(value)), float(0));
  const sacred = is(6).add(is(7)), secular = float(1).sub(sacred);
  const rnd = (a, b) => fract(sin(float(a).mul(12.9898).add(float(b).mul(78.233))).mul(43758.5453));

  const wall = step(normalWorld.y.abs(), 0.35).mul(float(1).sub(roof));
  const along = positionWorld.x.mul(normalWorld.z.abs()).add(positionWorld.z.mul(normalWorld.x.abs()));
  const bay = pick(2.9, 3.3, 3.0, 3.6, 1.6, 2.9, 2.9, 2.9);
  const u = fract(along.div(bay)), bayIndex = floor(along.div(bay));
  const level = floor(above.div(storey)), v = fract(above.div(storey));
  const building = fract(height.mul(7.13)); // a per-building constant
  const windowId = rnd(bayIndex.add(building.mul(97)), level);

  // Window opening in the bay (u) and the storey (v)
  // the archetype's windows: wider and taller where the photos show more glass (aArchetype.x, 0.6..1.5)
  const archetype = attribute('aArchetype', 'vec3');
  const winScale = archetype.x;
  const halfW = pick(0.2, 0.22, 0.31, 0.28, 0.46, 0.22).mul(winScale.sqrt()).min(0.47);
  const winMid = pick(0.535, 0.53, 0.55, 0.51, 0.505, 0.55);
  const winHalfH = pick(0.265, 0.33, 0.25, 0.39, 0.455, 0.25).mul(winScale.sqrt()).min(0.46);
  const sill = winMid.sub(winHalfH), head = winMid.add(winHalfH);
  const box = (hw, lo, hi) => step(u.sub(0.5).abs(), hw).mul(step(lo, v)).mul(step(v, hi));
  const opening = box(halfW, sill, head);
  // Storeys that carry windows: from the first floor up to below the cornice / roof edge
  const upper = step(max(storey, 3.4), above).mul(step(above, height.sub(0.9))).mul(secular);
  const glassMask = opening.mul(upper).mul(wall);

  // Stone surrounds (ancien, xixe) and closed shutters; open shutter leaves beside the windows
  const stone = is(0).add(is(1)).add(sacred);
  const surround = box(halfW.add(0.045), sill.sub(0.05), head.add(0.05)).sub(opening).max(0).mul(stone).mul(upper).mul(wall);
  const shutters = step(rnd(building, 3.1), pick(0.95, 0.85, 0.3, 0, 0, 0.5)); // buildings with shutters
  const leaves = box(halfW.mul(2.05), sill, head).sub(box(halfW.add(0.05), sill, head)).max(0);
  const closed = step(0.82, windowId).mul(shutters);
  const shutterMask = leaves.mul(float(1).sub(closed)).add(opening.mul(closed)).mul(shutters).mul(upper).mul(wall);
  const louvres = smoothstep(0.35, 0.5, fract(above.mul(9.0))).mul(0.25).add(0.75);
  const shutterTone = rnd(building, 5.7);
  const shutterColor = mix(mix(vec3(0.16, 0.22, 0.17), vec3(0.42, 0.44, 0.4), step(0.4, shutterTone)), vec3(0.3, 0.19, 0.11), step(0.8, shutterTone)).mul(louvres);

  // xixe: the étage noble (second level) and the top full storey carry a continuous wrought-iron balcony
  const topLevel = floor(height.sub(0.9).div(storey)).sub(1);
  const balconyLevel = step(abs(level.sub(1)), 0.5).add(step(abs(level.sub(topLevel)), 0.5).mul(step(4, topLevel))).min(1);
  const railing = is(1).mul(balconyLevel).mul(step(v, 0.3)).mul(upper).mul(wall).mul(step(0.35, rnd(building, 8.2)));
  const bars = step(0.6, fract(along.mul(7.0))).max(step(0.27, v));
  // moderne: balcony slabs and parapets every storey on part of the facade
  const slabs = is(2).mul(step(v, 0.07).add(step(v, 0.3).mul(step(0.5, rnd(floor(along.div(bay.mul(2))), building)))).min(1)).mul(upper).mul(wall);
  // Cornice and string courses (ancien, xixe), a darker plinth at the foot
  const fromTop = height.sub(above);
  const cornice = stone.mul(step(0.25, fromTop)).mul(step(fromTop, 0.85)).mul(wall);
  const corniceShadow = stone.mul(step(0.85, fromTop)).mul(step(fromTop, 1.0)).mul(wall);
  const course = is(1).mul(step(v, 0.04)).mul(upper).mul(wall);
  const plinth = stone.mul(step(above, 0.7)).mul(wall);
  // Shop fronts on the ground floor (js/storefronts.js: painted front, glazed door, sign, a room behind the glass), on
  // as many buildings as the archetype's show them in the photos (aArchetype.y)
  const shops = wall.mul(step(rnd(building, 11.3), archetype.y)).mul(secular);
  const store = createStorefront({ above, groundTop: max(storey, 3.4), enabled: shops, seed: building });
  const shop = store.mask;

  // The churches. Nave and choir: an equilateral pointed window in every 5.6 m bay, from a third of the way up to just
  // under the eaves, its stained glass in leaded panes; a lighter stone surround
  const nave = is(6).mul(wall);
  const xs = fract(along.div(5.6)).sub(0.5).mul(5.6).abs(); // metres from the bay's axis
  const hw = float(0.75);
  const lSill = max(float(2.6), height.mul(0.3));
  const lSpring = min(height.sub(1.4).sub(hw.mul(1.732)), lSill.add(min(height.mul(0.45), float(8))));
  const lancetIn = (w) => step(xs, w).mul(step(lSill.sub(w.sub(hw)), above))
    .mul(step(xs.add(w).pow(2).add(above.sub(lSpring).max(0).pow(2)), w.mul(w).mul(4)));
  const hasLancets = step(lSill.add(1.8), lSpring).mul(nave);
  const lancet = lancetIn(hw).mul(hasLancets);
  const lancetSurround = lancetIn(hw.add(0.14)).sub(lancet).max(0).mul(hasLancets);
  const lead = step(0.9, fract(above.div(0.55))).max(step(xs, 0.05)).max(step(0.88, fract(xs.div(0.375))));
  const paneId = rnd(floor(above.div(0.55)).add(building.mul(31)), floor(along.div(0.375)));
  const stained = mix(mix(vec3(0.05, 0.08, 0.2), vec3(0.22, 0.04, 0.05), step(0.55, paneId)), vec3(0.24, 0.17, 0.04), step(0.85, paneId))
    .mul(float(1).sub(lead.mul(0.75)));
  // Bell tower: arrow slits up the shaft every 7 m, the belfry's louvred openings (round-headed) under the eaves
  const tower = is(7).mul(wall);
  const xt = fract(along.div(2.6)).sub(0.5).mul(2.6).abs();
  const bSill = height.sub(5.2), bSpring = height.sub(1.9);
  const belfry = step(xt, 0.5).mul(step(bSill, above)).mul(step(xt.pow(2).add(above.sub(bSpring).max(0).pow(2)), 0.25))
    .mul(step(9, height)).mul(tower);
  const slats = smoothstep(0.3, 0.45, fract(above.mul(4.5)));
  const slit = step(xt, 0.12).mul(step(0.55, fract(above.div(7)))).mul(step(fract(above.div(7)), 0.75))
    .mul(step(4, above)).mul(step(above, bSill.sub(2))).mul(tower);
  // the wall's texture as photographed (aArchetype.z: 0.1 smooth render .. 0.25+ stone, brick): a finer, stronger grain
  // and courses of blocks on the rough ones
  const roughness = archetype.z.sub(0.08).max(0).mul(3).min(1);
  const blocks = step(0.06, fract(above.div(0.42))).mul(step(0.04, fract(along.div(0.9).add(floor(above.div(0.42)).mul(0.5))))).oneMinus().mul(roughness).mul(wall).mul(0.12);
  const grain = mx_noise_float(positionWorld.mul(mix(float(0.6), float(2.4), roughness))).mul(mix(float(0.08), float(0.22), roughness)).add(0.96).sub(blocks);
  const procedural = vertexColor().rgb.mul(grain);
  // Roofs: the orthophoto where there is one
  const ortho = orthoAt(positionWorld);
  let col = mix(procedural, ortho.color.mul(1.05), roof.mul(ortho.weight).mul(0.92));
  col = mix(col, col.mul(1.18).min(1), surround.add(cornice).add(course).min(1).mul(0.8));
  col = mix(col, col.mul(0.62), corniceShadow.add(plinth.mul(0.5)).min(1));
  col = mix(col, col.mul(1.12).min(1), slabs);
  col = mix(col, shutterColor, shutterMask.min(1));
  const glassTint = mix(vec3(0.05, 0.06, 0.07), vec3(0.17, 0.19, 0.21), windowId).add(is(4).mul(vec3(0.02, 0.05, 0.08)));
  const glass = glassMask.mul(float(1).sub(closed.mul(shutters)));
  col = mix(col, glassTint, glass.mul(0.9));
  col = mix(col, vec3(0.04, 0.04, 0.045), railing.mul(float(1).sub(bars)).mul(0.9));
  col = mix(col, store.color, shop);
  col = mix(col, col.mul(1.15).min(1), lancetSurround.mul(0.85));
  col = mix(col, stained, lancet);
  col = mix(col, mix(vec3(0.03, 0.03, 0.035), vec3(0.2, 0.17, 0.13), slats), belfry);
  col = mix(col, vec3(0.03, 0.03, 0.035), slit);
  m.colorNode = col;
  m.roughnessNode = mix(mix(float(0.92), float(0.12), glass.add(lancet.mul(0.7)).min(1)), store.roughness, shop);
  m.metalnessNode = mix(float(0), float(0.35), glass.mul(0.8).add(railing.mul(0.5)).min(1)).mul(float(1).sub(shop));

  // After dusk some windows glow warm; the shops' rooms and signs are lit by their own lamps (more so at night)
  const night = smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow);
  const lit = glass.mul(step(0.55, windowId)).mul(float(1).sub(shop));
  const warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.9, 0.92, 1.0), step(0.85, windowId));
  // the churches: no lit rooms, but floodlit from the foot of their walls, their stained glass faintly aglow
  const flood = exp(above.div(max(height, 6)).mul(-1.6)).mul(sacred).mul(wall).mul(float(1).sub(lancet));
  m.emissiveNode = warm.mul(lit.min(1)).mul(night).mul(1.4)
    .add(col.mul(vec3(1.0, 0.82, 0.6)).mul(flood).mul(night).mul(0.55))
    .add(stained.mul(lancet).mul(night).mul(1.2))
    .add(store.emissive.mul(shop));
  return m;
}

let gltfLoader = null;
function loaderFor() {
  if (gltfLoader) return gltfLoader;
  const draco = new DRACOLoader().setDecoderPath(new URL('libs/draco/gltf/', import.meta.resolve('three/addons/')).href);
  gltfLoader = new GLTFLoader().setDRACOLoader(draco);
  return gltfLoader;
}

async function fetchBuffer(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return await res.arrayBuffer();
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

/**
 * One swissBUILDINGS3D tile from `url` as a mesh in the city's material (for js/canton.js): `stats` as in bakeTile
 * ({ offsets, ground }). Resolves to null for a tile without buildings.
 */
let sharedMaterial = null;
export async function loadSwissTile(url, { seed = 0, stats }) {
  sharedMaterial ??= createMaterial();
  const tile = parseB3dm(await fetchBuffer(url));
  const gltf = await loaderFor().parseAsync(tile.glb, '');
  const geometry = bakeTile(gltf, { ...tile, seed }, stats);
  if (!geometry) return null;
  const mesh = new THREE.Mesh(geometry, sharedMaterial);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/**
 * Streams the city's swissBUILDINGS3D tiles into `scene`, nearest to `center` first.
 * Returns { group, ready, done }: `ready` resolves once every tile within `nearRadius` is in (or rejects when the
 * service can't be reached at all), `done` once all tiles are.
 */
export function streamSwissBuildings(scene, { center = { x: 0, z: 0 }, nearRadius = 450, concurrency = 8, onProgress, groundHeight = null } = {}) {
  const group = new THREE.Group();
  group.name = 'swissbuildings3d';
  group.userData.terrain = 'absolute'; // baked in world heights
  scene.add(group);
  const material = createMaterial();
  const stats = { offsets: [], buildings: 0, failed: 0, ground: groundHeight };
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  const done = (async () => {
    const index = await (await fetch(INDEX_URL)).json();
    const facades = await fetch(FACADES_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const base = new URL(index.base, INDEX_URL);
    const tiles = index.tiles.map((t, i) => ({ ...t, seed: i * 977, d: Math.hypot(t.x - center.x, t.z - center.z) })).sort((a, b) => a.d - b.d);
    const near = tiles.filter((t) => t.d <= nearRadius).length || Math.min(tiles.length, 12);
    let next = 0, loaded = 0, settled = 0;
    const settle = () => {
      settled++;
      onProgress?.(loaded, tiles.length);
      if (settled === near) (loaded ? resolveReady(group) : rejectReady(new Error('no swissBUILDINGS3D tile could be loaded')));
    };
    const worker = async () => {
      while (next < tiles.length) {
        const t = tiles[next++];
        try {
          const tile = parseB3dm(await fetchBuffer(new URL(t.u, base)));
          const gltf = await loaderFor().parseAsync(tile.glb, '');
          const geometry = bakeTile(gltf, { ...tile, seed: t.seed, facades: facades?.tiles?.[t.u], archetypes: facades?.archetypes }, stats);
          if (geometry) {
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = t.u;
            mesh.castShadow = mesh.receiveShadow = true;
            group.add(mesh);
            stats.buildings += geometry.userData.buildings;
          }
          loaded++;
        } catch (error) {
          stats.failed++;
          if (stats.failed <= 3) console.warn('[swissbuildings3d]', t.u, error);
        }
        settle();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    group.userData = { terrain: 'absolute', city: 'Genève', source: `swisstopo swissBUILDINGS3D 3.0 (${index.release})`, tiles: loaded, failed: stats.failed, buildings: stats.buildings, calibration: median(stats.offsets) };
    console.info(`[swissbuildings3d] ${loaded}/${tiles.length} tiles, ${stats.buildings} buildings, height calibration ${median(stats.offsets)?.toFixed(2)} m`);
    return group;
  })();
  done.catch((error) => rejectReady(error));
  return { group, ready, done };
}
