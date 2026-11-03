// tools/build-photomesh.mjs — converts the SITG's textured 3D photomesh (Photomaillage 3D 2019, État de Genève, open
// data: 100 m tiles of OBJ + JPEG in LV95 / LN02, listed by the PHOTOMESH_2019 feature service) over an area into
// glTF binaries in the world frame (js/geneva-frame.js): data/photomesh/<area>/<tile>.glb and index.json.
// Vertices: x = E - E0, y = h - H0, z = N0 - N; each tile keeps its own texture, downsampled (default 1024 px).
// usage: node tools/build-photomesh.mjs <area> <minE> <minN> <maxE> <maxN> [--texture 1024]
//   e.g. node tools/build-photomesh.mjs plainpalais 2499600 1116800 2500000 1117300
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { FRAME, lv95ToWorld } from '../js/geneva-frame.js';
import { parseTerrain, gridHeight } from '../js/terrain-grid.js';
import { GENEVA_DATA } from '../js/geneva-geodata.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = 'https://vector.sitg.ge.ch/arcgis/rest/services/Hosted/PHOTOMESH_2019/FeatureServer/0/query';
const args = process.argv.slice(2);
const textureArg = args.indexOf('--texture');
const TEXTURE = textureArg >= 0 ? +args.splice(textureArg, 2)[1] : 1024;
const [area, ...box] = args;
const [minE, minN, maxE, maxN] = box.map(Number);
if (!area || !(maxE > minE && maxN > minN)) {
  console.error('usage: node tools/build-photomesh.mjs <area> <minE> <minN> <maxE> <maxN> [--texture 1024]');
  process.exit(1);
}
const CACHE = path.join(DIR, 'data', 'cache', 'photomesh');
const OUT = path.join(DIR, '..', 'data', 'photomesh', area);
const log = (...a) => console.log('[photomesh]', ...a);
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// --- The tiles over the area (named after their north-west corner) ---------------------------------------------------------
const params = new URLSearchParams({
  where: '1=1', geometry: `${minE + 1},${minN + 1},${maxE - 1},${maxN - 1}`, geometryType: 'esriGeometryEnvelope', inSR: '2056',
  spatialRel: 'esriSpatialRelIntersects', outFields: 'url_telechargement', returnGeometry: 'false', f: 'json'
});
const { features } = await (await fetch(`${SERVICE}?${params}`)).json();
const urls = [...new Set(features.map((f) => f.attributes.url_telechargement))].filter((u) => {
  const [, e, n] = /(\d{7})_(\d{7})\.zip$/.exec(u).map(Number);
  return e >= minE && e < maxE && n > minN && n <= maxN; // tiles inside the area only
}).sort();
log(`${urls.length} tiles over ${area}`);

// --- OBJ -> indexed geometry in the world frame ------------------------------------------------------------------------------
function parseObj(text) {
  const v = [], vt = [], key = new Map(), pos = [], uv = [], idx = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) { const p = line.split(/\s+/); v.push([+p[1], +p[2], +p[3]]); }
    else if (line.startsWith('vt ')) { const p = line.split(/\s+/); vt.push([+p[1], +p[2]]); }
    else if (line.startsWith('f ')) {
      const corners = line.trim().split(/\s+/).slice(1).map((c) => {
        const [a, b] = c.split('/');
        const k = `${a}/${b}`;
        if (!key.has(k)) {
          const p = v[+a - 1], t = vt[+b - 1] || [0, 0];
          key.set(k, pos.length / 3);
          pos.push(p[0] - FRAME.E0, p[2] - FRAME.H0, FRAME.N0 - p[1]);
          uv.push(t[0], 1 - t[1]);
        }
        return key.get(k);
      });
      // (E, N, h) -> (x, y, z) = (E, h, -N) is a rotation: the winding stays
      for (let i = 1; i + 1 < corners.length; i++) idx.push(corners[0], corners[i], corners[i + 1]);
    }
  }
  return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) };
}

// --- Trees out of the mesh ------------------------------------------------------------------------------------------------
// Photogrammetry turns trees into lumpy blobs; the engine draws good ones (js/trees.js). Triangles of a crown (within an
// inventoried tree's crown, above the ground, away from any building footprint) are flattened onto the terrain and
// flagged (_ORTHO = 1): there the browser shows the orthophoto, from which the trees were also filled out
// (tools/build-geneva-ortho.mjs), and the engine's own tree stands on top.
const terrainFile = fs.readFileSync(path.join(DIR, '..', 'data', 'geneva-terrain.bin'));
const TERRAIN = parseTerrain(terrainFile.buffer.slice(terrainFile.byteOffset, terrainFile.byteOffset + terrainFile.byteLength));
const CELL = 20;
const gridOf = () => new Map();
const put = (grid, x, z, item) => { const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(item); };
const near = (grid, x, z) => { const out = []; const i0 = Math.floor(x / CELL), j0 = Math.floor(z / CELL); for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) out.push(...(grid.get(`${i},${j}`) || [])); return out; };
const trees = gridOf();
const TREES = path.join(DIR, 'data', 'cache', 'geneva_trees.json');
for (const t of fs.existsSync(TREES) ? JSON.parse(fs.readFileSync(TREES, 'utf8')).trees : []) {
  const { x, z } = lv95ToWorld(t.E, t.N);
  put(trees, x, z, { x, z, r: (Math.min(24, t.crown || 7) / 2) * 1.15 + 1 });
}
const footprints = gridOf();
for (const b of GENEVA_DATA.buildings) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < b.ring.length; i += 2) { x0 = Math.min(x0, b.ring[i]); x1 = Math.max(x1, b.ring[i]); z0 = Math.min(z0, b.ring[i + 1]); z1 = Math.max(z1, b.ring[i + 1]); }
  const item = { ring: b.ring, x0, x1, z0, z1 };
  for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) for (let z = Math.floor(z0 / CELL); z <= Math.floor(z1 / CELL); z++) put(footprints, x * CELL, z * CELL, item);
}
const pip = (r, x, z) => { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { if ((r[i + 1] > z) !== (r[j + 1] > z) && x < ((r[j] - r[i]) * (z - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c; } return c; };
// Part of a building: inside its footprint, or a wall-like (steep) triangle within a metre of it. Street trees touch the
// facades; their crowns go, the facades stay.
const inBuilding = (x, z, d) => near(footprints, x, z).some((b) => x > b.x0 - d && x < b.x1 + d && z > b.z0 - d && z < b.z1 + d &&
  (d ? [[d, 0], [-d, 0], [0, d], [0, -d]] : [[0, 0]]).some(([dx, dz]) => pip(b.ring, x + dx, z + dz)));
const partOfBuilding = (x, z, steep) => inBuilding(x, z, 0) || (steep && inBuilding(x, z, 1.0));
const inCrown = (x, z) => near(trees, x, z).some((t) => Math.hypot(t.x - x, t.z - z) < t.r);

function removeTrees({ pos, uv, idx }) {
  const outPos = Array.from(pos), outUv = Array.from(uv), ortho = new Array(pos.length / 3).fill(0), outIdx = [];
  let flattened = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const x = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, y = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3, z = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
    // steepness from the face normal
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const steep = Math.abs(ny) < 0.35 * Math.hypot(nx, ny, nz);
    if (y - gridHeight(TERRAIN, x, z) > 1.2 && inCrown(x, z) && !partOfBuilding(x, z, steep)) {
      // New vertices on the ground, flagged for the orthophoto
      const corners = [a, b, c].map((v) => {
        const n = outPos.length / 3;
        const vx = pos[v * 3], vz = pos[v * 3 + 2];
        outPos.push(vx, gridHeight(TERRAIN, vx, vz) + 0.03, vz);
        outUv.push(uv[v * 2], uv[v * 2 + 1]);
        ortho.push(1);
        return n;
      });
      outIdx.push(...corners);
      flattened++;
    } else outIdx.push(a, b, c);
  }
  // Drop the vertices no triangle uses any more
  const remap = new Int32Array(outPos.length / 3).fill(-1);
  const P = [], U = [], O = [];
  const idx2 = outIdx.map((v) => {
    if (remap[v] < 0) { remap[v] = O.length; P.push(outPos[v * 3], outPos[v * 3 + 1], outPos[v * 3 + 2]); U.push(outUv[v * 2], outUv[v * 2 + 1]); O.push(ortho[v]); }
    return remap[v];
  });
  return { pos: new Float32Array(P), uv: new Float32Array(U), ortho: new Float32Array(O), idx: O.length > 65535 ? new Uint32Array(idx2) : new Uint16Array(idx2), flattened };
}

// Box-filtered downsample of a JPEG to TEXTURE px
function shrinkJpeg(buf) {
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const f = Math.max(1, Math.round(img.width / TEXTURE)), w = Math.round(img.width / f), h = Math.round(img.height / f);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const o = ((y * f + dy) * img.width + x * f + dx) * 4;
      r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2];
    }
    const o = (y * w + x) * 4, n = f * f;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data: out, width: w, height: h }, 85).data);
}

// glTF binary: one mesh, one textured unlit material
function writeGlb(file, { pos, uv, idx, ortho }, image) {
  const pad = (n) => (n + 3) & ~3;
  const parts = [Buffer.from(pos.buffer), Buffer.from(uv.buffer), Buffer.from(idx.buffer), image, Buffer.from(ortho.buffer)];
  const views = [];
  let offset = 0;
  for (const p of parts) { views.push({ buffer: 0, byteOffset: offset, byteLength: p.length }); offset = pad(offset + p.length); }
  const bin = Buffer.alloc(offset);
  parts.forEach((p, i) => p.copy(bin, views[i].byteOffset));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  const json = {
    asset: { version: '2.0', generator: 'slop-geneva tools/build-photomesh.mjs', copyright: 'SITG, État de Genève: Photomaillage 3D 2019' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1, _ORTHO: 3 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } }],
    textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: 3, mimeType: 'image/jpeg' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: uv.length / 2, type: 'VEC2' },
      { bufferView: 2, componentType: idx instanceof Uint32Array ? 5125 : 5123, count: idx.length, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: ortho.length, type: 'SCALAR' }
    ],
    bufferViews: views, buffers: [{ byteLength: bin.length }]
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad(jsonBuf.length) - jsonBuf.length, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const chunk = (buf, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.write(type, 4); return Buffer.concat([h, buf]); };
  fs.writeFileSync(file, Buffer.concat([header, chunk(jsonBuf, 'JSON'), chunk(bin, 'BIN\0')]));
  return { min, max };
}

const tiles = [];
let bytes = 0;
for (const url of urls) {
  const name = path.basename(url, '.zip');
  const zip = path.join(CACHE, `${name}.zip`), dir = path.join(CACHE, name);
  if (!fs.existsSync(zip)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  if (!fs.existsSync(path.join(dir, `${name}.obj`))) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }
  const mtl = fs.readFileSync(path.join(dir, `${name}.mtl`), 'utf8');
  const texture = /map_Kd\s+(.+)/.exec(mtl)[1].trim().replace(/\\/g, '/');
  const geometry = removeTrees(parseObj(fs.readFileSync(path.join(dir, `${name}.obj`), 'utf8')));
  const image = shrinkJpeg(fs.readFileSync(path.join(dir, texture)));
  const file = path.join(OUT, `${name}.glb`);
  const { min, max } = writeGlb(file, geometry, image);
  bytes += fs.statSync(file).size;
  tiles.push({ file: `${name}.glb`, triangles: geometry.idx.length / 3, min: min.map((v) => Math.round(v * 10) / 10), max: max.map((v) => Math.round(v * 10) / 10) });
  log(`${name}: ${geometry.idx.length / 3} triangles, ${geometry.flattened} of tree crowns flattened onto the ground`);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  source: 'SITG, État de Genève: Photomaillage 3D 2019 (open data)', area, lv95: [minE, minN, maxE, maxN],
  // the area in world coordinates [minX, minZ, maxX, maxZ]: the engine hides its own buildings, ground & trees there
  bounds: [minE - FRAME.E0, FRAME.N0 - maxN, maxE - FRAME.E0, FRAME.N0 - minN], texture: TEXTURE, tiles
}, null, 1));
log(`wrote ${tiles.length} tiles to ${OUT} (${(bytes / 1048576).toFixed(1)} MB)`);
