// tools/build-photomesh.mjs — converts the SITG's textured 3D photomesh (Photomaillage 3D 2019, État de Genève, open
// data: 100 m tiles of OBJ + JPEG in LV95 / LN02, listed by the PHOTOMESH_2019 feature service) over an area into
// glTF binaries in the world frame (js/geneva-frame.js): data/photomesh/<area>/<tile>.glb and index.json.
// Vertices: x = E - E0, y = h - H0, z = N0 - N; each tile keeps its own texture, downsampled (default 1024 px).
// Each tile also gets a coarse level (<tile>.lo.glb: ~12% of the triangles with the tile's borders kept, vertex
// colours from the photo): js/photomesh.js shows those from afar and streams the full tiles in around the camera.
// The lake and the rivers are cut out of the mesh (the engine draws its own water).
// usage: node tools/build-photomesh.mjs <area> <minE> <minN> <maxE> <maxN> [--texture 1024]
//   e.g. node tools/build-photomesh.mjs plainpalais 2499600 1116800 2500000 1117300
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
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
const WATER = GENEVA_DATA.water.map((w) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < w.ring.length; i += 2) { x0 = Math.min(x0, w.ring[i]); x1 = Math.max(x1, w.ring[i]); z0 = Math.min(z0, w.ring[i + 1]); z1 = Math.max(z1, w.ring[i + 1]); }
  return { ring: w.ring, holes: w.holes || [], x0, x1, z0, z1 };
});
const inWater = (x, z) => WATER.some((w) => x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1 && pip(w.ring, x, z) && !w.holes.some((h) => pip(h, x, z)));

// Foliage by its colour in the photo (summer 2019): green over red and blue, for the crowns missing from the inventory
// (courtyards, private gardens)
function greenAt(img, uv, a, b, c) {
  if (!img) return false;
  let r = 0, g = 0, bl = 0;
  for (const v of [a, b, c]) {
    const x = Math.round(uv[v * 2] * (img.width - 1)), y = Math.round(uv[v * 2 + 1] * (img.height - 1));
    const o = (y * img.width + x) * 4;
    r += img.data[o]; g += img.data[o + 1]; bl += img.data[o + 2];
  }
  return g > r * 1.06 && g > bl * 1.04 && g < 3 * 200;
}

// Decided per vertex (per position: the texture's seams split vertices): a vertex of a crown or clutter triangle goes
// down to the ground unless a building's triangle uses it too, so nothing is left sticking up between the flattened
// triangles and the ground around them.
function removeTrees({ pos, uv, idx }, img = null) {
  const outPos = Array.from(pos), outUv = Array.from(uv), ortho = new Array(pos.length / 3).fill(0), outIdx = [];
  let flattened = 0, water = 0, cluttered = 0;
  const keyOf = (v) => `${pos[v * 3].toFixed(3)},${pos[v * 3 + 2].toFixed(3)},${pos[v * 3 + 1].toFixed(2)}`;
  const keys = Array.from({ length: pos.length / 3 }, (_, v) => keyOf(v));
  const candidate = new Set(), protect = new Set();
  const kind = new Uint8Array(idx.length / 3); // 0 keep, 1 water, 2 flatten
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const x = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, y = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3, z = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
    // steepness from the face normal
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const steep = Math.abs(ny) < 0.35 * Math.hypot(nx, ny, nz);
    const above = y - gridHeight(TERRAIN, x, z);
    // the water surface (low and flat over the lake or a river)
    if (!steep && above < 1.0 && inWater(x, z)) { kind[t / 3] = 1; water++; continue; }
    // Crowns (inventoried or green), and any other clutter standing above the ground away from the buildings: trees
    // missing from the inventory, poles, lamps, signs and the photogrammetry's stray shards (the engine draws its own
    // street furniture). The bridges over the water stay, and so do the eaves (within 1.5 m of a footprint).
    const building = partOfBuilding(x, z, steep);
    const crown = !building && (inCrown(x, z) || (above > 2 && greenAt(img, uv, a, b, c)));
    const clutter = !crown && above > 1.2 && !inWater(x, z) && !inBuilding(x, z, 0) && !inBuilding(x, z, 1.5);
    if (above > 1.2 && (crown || clutter)) {
      kind[t / 3] = 2;
      if (clutter) cluttered++;
      for (const v of [a, b, c]) candidate.add(keys[v]);
    } else if (building || (above > 1.2 && inBuilding(x, z, 1.5))) for (const v of [a, b, c]) protect.add(keys[v]);
  }
  const flatKey = (v) => candidate.has(keys[v]) && !protect.has(keys[v]);
  // the flattened vertices, on the ground and flagged for the orthophoto
  for (let v = 0; v < pos.length / 3; v++) {
    if (!flatKey(v)) continue;
    outPos[v * 3 + 1] = gridHeight(TERRAIN, pos[v * 3], pos[v * 3 + 2]) + 0.03;
    ortho[v] = 1;
  }
  // wholly flattened triangles share welded vertices (no texture there: the flat ground then simplifies away)
  const welded = new Map();
  const weld = (v) => {
    const key = `${pos[v * 3].toFixed(3)},${pos[v * 3 + 2].toFixed(3)}`;
    if (welded.has(key)) return welded.get(key);
    const n = outPos.length / 3;
    outPos.push(outPos[v * 3], outPos[v * 3 + 1], outPos[v * 3 + 2]);
    outUv.push(uv[v * 2], uv[v * 2 + 1]);
    ortho.push(1);
    welded.set(key, n);
    return n;
  };
  for (let t = 0; t < idx.length; t += 3) {
    if (kind[t / 3] === 1) continue;
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    if (tri.every(flatKey)) { outIdx.push(...tri.map(weld)); flattened++; } else outIdx.push(...tri);
  }
  // Drop the vertices no triangle uses any more
  const remap = new Int32Array(outPos.length / 3).fill(-1);
  const P = [], U = [], O = [];
  const idx2 = outIdx.map((v) => {
    if (remap[v] < 0) { remap[v] = O.length; P.push(outPos[v * 3], outPos[v * 3 + 1], outPos[v * 3 + 2]); U.push(outUv[v * 2], outUv[v * 2 + 1]); O.push(ortho[v]); }
    return remap[v];
  });
  return { pos: new Float32Array(P), uv: new Float32Array(U), ortho: new Float32Array(O), idx: O.length > 65535 ? new Uint32Array(idx2) : new Uint16Array(idx2), flattened, water, cluttered };
}

// Coarse level: meshoptimizer's edge collapses down to ~12% of the triangles (across the texture's seams: Permissive; tile borders locked so the
// coarse tile meets its neighbours' full ones without cracks)
await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;
function simplify({ pos, uv, ortho, idx }, ratio = 0.12, error = 0.02, flags = ['LockBorder', 'Permissive']) {
  const target = ratio ? Math.max(300, Math.floor((idx.length / 3) * ratio)) * 3 : 3;
  const [lod] = MeshoptSimplifier.simplify(Uint32Array.from(idx), pos, 3, target, error, flags);
  const remap = new Int32Array(pos.length / 3).fill(-1);
  const P = [], U = [], O = [];
  const out = Array.from(lod, (v) => {
    if (remap[v] < 0) { remap[v] = O.length; P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); U.push(uv[v * 2], uv[v * 2 + 1]); O.push(ortho[v]); }
    return remap[v];
  });
  return { pos: new Float32Array(P), uv: new Float32Array(U), ortho: new Float32Array(O), idx: O.length > 65535 ? new Uint32Array(out) : new Uint16Array(out) };
}

// Vertex colours for the coarse level, from the photo around each vertex's own texture coordinates (collapsing across
// the texture's seams scrambles any texture mapping; each kept vertex is an original one, with its own uv)
function vertexColours({ uv }, img) {
  const out = new Float32Array((uv.length / 2) * 3);
  const r = Math.max(1, Math.round(img.width / 512));
  for (let i = 0; i < uv.length / 2; i++) {
    const cx = Math.round(uv[i * 2] * (img.width - 1)), cy = Math.round(uv[i * 2 + 1] * (img.height - 1));
    let R = 0, G = 0, B = 0, n = 0;
    for (let y = Math.max(0, cy - r); y <= Math.min(img.height - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(img.width - 1, cx + r); x++) {
      const o = (y * img.width + x) * 4;
      R += img.data[o]; G += img.data[o + 1]; B += img.data[o + 2]; n++;
    }
    // sRGB -> linear (glTF vertex colours are linear)
    const lin = (c) => { c /= 255 * n; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    out[i * 3] = lin(R); out[i * 3 + 1] = lin(G); out[i * 3 + 2] = lin(B);
  }
  return out;
}

// Box-filtered downsample of a JPEG to `size` px
const decodeJpeg = (buf) => jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
function shrinkJpeg(img, size = TEXTURE) {
  const f = Math.max(1, Math.round(img.width / size)), w = Math.round(img.width / f), h = Math.round(img.height / f);
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

// glTF binary: one mesh, one unlit material: textured (uv + image), or with vertex colours (color, no image).
// Geometry compressed with EXT_meshopt_compression (three.js GLTFLoader + MeshoptDecoder); the image as is
function writeGlb(file, { pos, uv, idx, ortho, color }, image) {
  const pad = (n) => (n + 3) & ~3;
  const u8 = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const attrs = [['POSITION', pos, 3], ...(image ? [['TEXCOORD_0', uv, 2]] : []), ...(color ? [['COLOR_0', color, 3]] : []), ['_ORTHO', ortho, 1]];
  const encoded = [
    ...attrs.map(([, a, n]) => ({ data: MeshoptEncoder.encodeVertexBuffer(u8(a), a.length / n, n * 4), raw: a.byteLength, stride: n * 4, count: a.length / n, mode: 'ATTRIBUTES' })),
    { data: MeshoptEncoder.encodeIndexBuffer(u8(idx), idx.length, idx.BYTES_PER_ELEMENT), raw: idx.byteLength, stride: idx.BYTES_PER_ELEMENT, count: idx.length, mode: 'TRIANGLES' },
    ...(image ? [null] : [])
  ];
  const views = [];
  const chunks = [];
  let offset = 0, fallback = 0;
  encoded.forEach((e) => {
    const data = e ? Buffer.from(e.data) : image;
    chunks.push([offset, data]);
    if (e) {
      views.push({ buffer: 1, byteOffset: fallback, byteLength: e.raw, ...(e.mode === 'ATTRIBUTES' ? { byteStride: e.stride } : {}),
        extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: offset, byteLength: data.length, byteStride: e.stride, count: e.count, mode: e.mode } } });
      fallback = pad(fallback + e.raw);
    } else views.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
    offset = pad(offset + data.length);
  });
  const bin = Buffer.alloc(offset);
  for (const [o, d] of chunks) d.copy(bin, o);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  const TYPES = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3' };
  const accessors = attrs.map(([, a, n], i) => ({ bufferView: i, componentType: 5126, count: a.length / n, type: TYPES[n], ...(i === 0 ? { min, max } : {}) }));
  accessors.push({ bufferView: attrs.length, componentType: idx instanceof Uint32Array ? 5125 : 5123, count: idx.length, type: 'SCALAR' });
  const json = {
    asset: { version: '2.0', generator: 'slop-geneva tools/build-photomesh.mjs', copyright: 'SITG, État de Genève: Photomaillage 3D 2019' },
    extensionsUsed: ['KHR_materials_unlit', 'EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: Object.fromEntries(attrs.map(([name], i) => [name, i])), indices: attrs.length, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { ...(image ? { baseColorTexture: { index: 0 } } : {}), metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } }],
    ...(image ? {
      textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
      images: [{ bufferView: attrs.length + 1, mimeType: 'image/jpeg' }]
    } : {}),
    accessors,
    bufferViews: views, buffers: [{ byteLength: bin.length }, { byteLength: fallback, extensions: { EXT_meshopt_compression: { fallback: true } } }]
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
let bytes = 0, loBytes = 0;
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
  const source = decodeJpeg(fs.readFileSync(path.join(dir, texture)));
  const cut = removeTrees(parseObj(fs.readFileSync(path.join(dir, `${name}.obj`), 'utf8')), source);
  // the full level: within ~20 cm of the survey (the flattened crowns and flat ground collapse), seams & borders kept
  const geometry = { ...cut, ...simplify(cut, 0, 0.0015, ['LockBorder']) };
  if (!geometry.idx.length) { log(`${name}: all water, skipped`); continue; }
  const file = path.join(OUT, `${name}.glb`);
  const { min, max } = writeGlb(file, geometry, shrinkJpeg(source));
  const coarse = simplify(geometry);
  coarse.color = vertexColours(coarse, source);
  writeGlb(path.join(OUT, `${name}.lo.glb`), coarse, null);
  bytes += fs.statSync(file).size;
  loBytes += fs.statSync(path.join(OUT, `${name}.lo.glb`)).size;
  tiles.push({ file: `${name}.glb`, lo: `${name}.lo.glb`, triangles: geometry.idx.length / 3, loTriangles: coarse.idx.length / 3, min: min.map((v) => Math.round(v * 10) / 10), max: max.map((v) => Math.round(v * 10) / 10) });
  log(`${name}: ${cut.idx.length / 3} -> ${geometry.idx.length / 3} triangles (coarse ${coarse.idx.length / 3}), ${geometry.flattened} of crowns & clutter flattened onto the ground (${geometry.cluttered} clutter), ${geometry.water} on the water cut`);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  source: 'SITG, État de Genève: Photomaillage 3D 2019 (open data)', area, lv95: [minE, minN, maxE, maxN],
  // the area in world coordinates [minX, minZ, maxX, maxZ]: the engine hides its own buildings, ground & trees there
  bounds: [minE - FRAME.E0, FRAME.N0 - maxN, maxE - FRAME.E0, FRAME.N0 - minN], texture: TEXTURE, tiles
}, null, 1));
log(`wrote ${tiles.length} tiles to ${OUT} (${(bytes / 1048576).toFixed(1)} MB, coarse ${(loBytes / 1048576).toFixed(1)} MB)`);
