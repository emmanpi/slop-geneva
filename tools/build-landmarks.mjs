// tools/build-landmarks.mjs — cuts Geneva's landmarks (the cathedral, the station, the churches, the theatres and
// palaces of js/geneva-geodata.js `landmarks`) out of the SITG's textured photomesh (Photomaillage 3D 2019, État de
// Genève, open data): the mesh's triangles within each landmark's OSM footprint (and 1.5 m around it, for the eaves),
// above the ground, each tile's part with its texture cropped to what the landmark uses (at most 2048 px: much sharper
// than the area tiles' 1024 px for the whole 100 m). js/landmark-meshes.js shows them in place of the procedural
// buildings, at street level too.
// Output: data/landmarks/<key>.glb and index.json { landmarks: [{ key, name, file, ring, triangles }] }.
// usage: node tools/build-landmarks.mjs [name filter]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { FRAME } from '../js/geneva-frame.js';
import { parseTerrain, gridHeight } from '../js/terrain-grid.js';
import { GENEVA_DATA } from '../js/geneva-geodata.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = 'https://vector.sitg.ge.ch/arcgis/rest/services/Hosted/PHOTOMESH_2019/FeatureServer/0/query';
const CACHE = path.join(DIR, 'data', 'cache', 'photomesh');
const OUT = path.join(DIR, '..', 'data', 'landmarks');
const MAX_TEX = 2048;
const MARGIN = 1.5;
const log = (...a) => console.log('[landmarks]', ...a);
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const terrainFile = fs.readFileSync(path.join(DIR, '..', 'data', 'geneva-terrain.bin'));
const TERRAIN = parseTerrain(terrainFile.buffer.slice(terrainFile.byteOffset, terrainFile.byteOffset + terrainFile.byteLength));

const pip = (r, x, z) => { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { if ((r[i + 1] > z) !== (r[j + 1] > z) && x < ((r[j] - r[i]) * (z - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c; } return c; };
const segDist = (r, x, z) => {
  let d = Infinity;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const ax = r[j], az = r[j + 1], bx = r[i], bz = r[i + 1], ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
    d = Math.min(d, Math.hypot(ax + ex * t - x, az + ez * t - z));
  }
  return d;
};
const inside = (r, x, z) => pip(r, x, z) || segDist(r, x, z) < MARGIN;

async function tileDir(url) {
  const name = path.basename(url, '.zip');
  const zip = path.join(CACHE, `${name}.zip`), dir = path.join(CACHE, name);
  if (!fs.existsSync(path.join(dir, `${name}.obj`))) {
    if (!fs.existsSync(zip)) {
      const buf = await retry(async () => { const res = await fetch(url); if (!res.ok) throw new Error(`${url}: ${res.status}`); return Buffer.from(await res.arrayBuffer()); });
      fs.writeFileSync(zip, buf);
    }
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }
  return { name, dir };
}

// The triangles of a tile inside the landmark's footprint, above the ground: positions (world), uvs (texture)
function cut(dir, name, ring) {
  const v = [], vt = [], tris = [];
  for (const line of fs.readFileSync(path.join(dir, `${name}.obj`), 'utf8').split('\n')) {
    if (line.startsWith('v ')) { const p = line.split(/\s+/); v.push([+p[1] - FRAME.E0, +p[3] - FRAME.H0, FRAME.N0 - +p[2]]); }
    else if (line.startsWith('vt ')) { const p = line.split(/\s+/); vt.push([+p[1], 1 - +p[2]]); }
    else if (line.startsWith('f ')) {
      const c = line.trim().split(/\s+/).slice(1).map((s) => s.split('/').map(Number));
      for (let i = 1; i + 1 < c.length; i++) {
        const t = [c[0], c[i], c[i + 1]];
        const P = t.map((k) => v[k[0] - 1]), T = t.map((k) => vt[k[1] - 1]);
        if (T.some((x) => !x)) continue;
        const cx = (P[0][0] + P[1][0] + P[2][0]) / 3, cy = (P[0][1] + P[1][1] + P[2][1]) / 3, cz = (P[0][2] + P[1][2] + P[2][2]) / 3;
        if (!inside(ring, cx, cz)) continue;
        if (cy - gridHeight(TERRAIN, cx, cz) < 0.4) continue; // the ground around: the engine's
        tris.push({ P, T });
      }
    }
  }
  return tris;
}

// Crop & downsample the texture to the uv box of the kept triangles; remap their uvs
function crop(img, tris) {
  let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
  for (const { T } of tris) for (const [u, w] of T) { u0 = Math.min(u0, u); v0 = Math.min(v0, w); u1 = Math.max(u1, u); v1 = Math.max(v1, w); }
  const px0 = Math.max(0, Math.floor(u0 * img.width) - 2), py0 = Math.max(0, Math.floor(v0 * img.height) - 2);
  const px1 = Math.min(img.width, Math.ceil(u1 * img.width) + 2), py1 = Math.min(img.height, Math.ceil(v1 * img.height) + 2);
  const cw = px1 - px0, ch = py1 - py0;
  const f = Math.max(1, Math.ceil(Math.max(cw, ch) / MAX_TEX));
  const w = Math.max(1, Math.floor(cw / f)), h = Math.max(1, Math.floor(ch / f));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const o = ((py0 + y * f + dy) * img.width + px0 + x * f + dx) * 4;
      r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2];
    }
    const o = (y * w + x) * 4, n = f * f;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
  const remap = ([u, w2]) => [((u * img.width - px0) / f) / w, ((w2 * img.height - py0) / f) / h];
  return { image: Buffer.from(jpeg.encode({ data: out, width: w, height: h }, 88).data), remap, w, h };
}

// glTF binary: one primitive (and texture) per tile part, unlit
function writeGlb(file, parts) {
  const pad = (n) => (n + 3) & ~3;
  const chunks = [], views = [], accessors = [], primitives = [], materials = [], textures = [], images = [];
  let offset = 0;
  const push = (buf, extra = {}) => { views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...extra }); chunks.push([offset, buf]); offset = pad(offset + buf.length); return views.length - 1; };
  parts.forEach((p, i) => {
    const pos = new Float32Array(p.pos), uv = new Float32Array(p.uv);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pos.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pos[k + a]); max[a] = Math.max(max[a], pos[k + a]); }
    const vp = push(Buffer.from(pos.buffer)), vu = push(Buffer.from(uv.buffer)), vi = push(p.image);
    accessors.push({ bufferView: vp, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: vu, componentType: 5126, count: uv.length / 2, type: 'VEC2' });
    images.push({ bufferView: vi, mimeType: 'image/jpeg' });
    textures.push({ source: i, sampler: 0 });
    materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: i }, metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} }, doubleSided: true });
    primitives.push({ attributes: { POSITION: accessors.length - 2, TEXCOORD_0: accessors.length - 1 }, material: i });
  });
  const bin = Buffer.alloc(offset);
  for (const [o, b] of chunks) b.copy(bin, o);
  const json = {
    asset: { version: '2.0', generator: 'slop-geneva tools/build-landmarks.mjs', copyright: 'SITG, État de Genève: Photomaillage 3D 2019' },
    extensionsUsed: ['KHR_materials_unlit'], scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives }], materials, textures, images, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    accessors, bufferViews: views, buffers: [{ byteLength: bin.length }]
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad(jsonBuf.length) - jsonBuf.length, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const chunk = (buf, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.write(type, 4); return Buffer.concat([h, buf]); };
  fs.writeFileSync(file, Buffer.concat([header, chunk(jsonBuf, 'JSON'), chunk(bin, 'BIN\0')]));
}

async function retry(fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (error) { if (attempt >= 5) throw error; await new Promise((r) => setTimeout(r, 1500 * attempt)); }
  }
}
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const indexFile = path.join(OUT, 'index.json');
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { landmarks: [] };
for (const [name, lm] of Object.entries(GENEVA_DATA.landmarks)) {
  if (filter && !filter.test(name)) continue;
  const ring = lm.ring;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
  const env = [x0 - MARGIN + FRAME.E0, FRAME.N0 - (z1 + MARGIN), x1 + MARGIN + FRAME.E0, FRAME.N0 - (z0 - MARGIN)];
  const params = new URLSearchParams({ where: '1=1', geometry: env.join(','), geometryType: 'esriGeometryEnvelope', inSR: '2056', spatialRel: 'esriSpatialRelIntersects', outFields: 'url_telechargement', returnGeometry: 'false', f: 'json' });
  const { features } = await retry(async () => (await fetch(`${SERVICE}?${params}`)).json());
  const urls = [...new Set(features.map((f) => f.attributes.url_telechargement))].sort();
  const parts = [];
  let triangles = 0;
  for (const url of urls) {
    const { name: tile, dir } = await tileDir(url);
    const tris = cut(dir, tile, ring);
    if (!tris.length) continue;
    const mtl = fs.readFileSync(path.join(dir, `${tile}.mtl`), 'utf8');
    const img = jpeg.decode(fs.readFileSync(path.join(dir, /map_Kd\s+(.+)/.exec(mtl)[1].trim().replace(/\\/g, '/'))), { useTArray: true, maxMemoryUsageInMB: 2048 });
    const { image, remap } = crop(img, tris);
    const pos = [], uv = [];
    // (E, N, h) -> (x, y, z) is a rotation: the winding stays
    for (const { P, T } of tris) { for (const p of P) pos.push(...p); for (const t of T) uv.push(...remap(t)); }
    parts.push({ pos, uv, image });
    triangles += tris.length;
  }
  if (!parts.length) { log(`${name}: nothing in the photomesh`); continue; }
  const key = slug(name);
  writeGlb(path.join(OUT, `${key}.glb`), parts);
  const entry = { key, name, file: `${key}.glb`, ring, triangles };
  const at = index.landmarks.findIndex((l) => l.key === key);
  if (at >= 0) index.landmarks[at] = entry; else index.landmarks.push(entry);
  log(`${name}: ${urls.length} tiles, ${triangles} triangles, ${(fs.statSync(path.join(OUT, `${key}.glb`)).size / 1048576).toFixed(1)} MB`);
}
fs.writeFileSync(indexFile, JSON.stringify({ source: 'SITG, État de Genève: Photomaillage 3D 2019 (open data)', landmarks: index.landmarks }));
