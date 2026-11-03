// tools/build-landmarks.mjs — cuts Geneva's landmarks (the cathedral, the station, the churches, the theatres and
// palaces of js/geneva-geodata.js `landmarks`) out of the SITG's textured photomesh (Photomaillage 3D 2019, État de
// Genève, open data): the mesh's triangles within each landmark's OSM footprint (and 1.5 m around it, for the eaves),
// above the ground, each tile's part with its texture cropped to what the landmark uses (at most 2048 px: much sharper
// than the area tiles' 1024 px for the whole 100 m). js/landmark-meshes.js shows them in place of the procedural
// buildings, at street level too.
// Then made clean in Blender (tools/blender-simplify.py: one watertight solid, its photogrammetric bumps smoothed,
// dissolved into large flat faces): each face takes the photo's mean colour there, the colours of a landmark grouped
// into its few materials (stone, tiles, copper, slate…). js/landmark-meshes.js draws them lit, with procedural stone.
// Output: data/landmarks/<key>.glb (the clean massing, vertex colours) and index.json
// { landmarks: [{ key, name, file, ring, triangles }] }; the photographed cut-out stays in tools/data/cache/landmarks/.
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
const RAW = path.join(DIR, 'data', 'cache', 'landmarks');
const BLENDER = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
fs.mkdirSync(RAW, { recursive: true });
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
  return { image: Buffer.from(jpeg.encode({ data: out, width: w, height: h }, 88).data), remap, w, h, rgba: out };
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
// The landmark as a heightfield solid: the highest photographed surface over each 0.4 m cell of its footprint (the
// triangles rasterised from above), gaps filled from the neighbours, the photogrammetry's bumps taken out (median
// filters), then a continuous top surface (steep between roof levels: the walls) closed by walls down to the ground
// along the footprint's edge
function heightfieldSolid(parts, ring) {
  const C = 0.6;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
  x0 -= MARGIN; z0 -= MARGIN; x1 += MARGIN; z1 += MARGIN;
  const nx = Math.ceil((x1 - x0) / C) + 1, nz = Math.ceil((z1 - z0) / C) + 1;
  const H = new Float32Array(nx * nz).fill(-Infinity);
  const inMask = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (inside(ring, x0 + i * C, z0 + j * C)) inMask[j * nx + i] = 1;
  for (const p of parts) {
    for (let t = 0; t < p.pos.length; t += 9) {
      const A = p.pos.slice(t, t + 3), B = p.pos.slice(t + 3, t + 6), D = p.pos.slice(t + 6, t + 9);
      const i0 = Math.max(0, Math.floor((Math.min(A[0], B[0], D[0]) - x0) / C)), i1 = Math.min(nx - 1, Math.ceil((Math.max(A[0], B[0], D[0]) - x0) / C));
      const j0 = Math.max(0, Math.floor((Math.min(A[2], B[2], D[2]) - z0) / C)), j1 = Math.min(nz - 1, Math.ceil((Math.max(A[2], B[2], D[2]) - z0) / C));
      const det = (B[2] - D[2]) * (A[0] - D[0]) + (D[0] - B[0]) * (A[2] - D[2]);
      const steepTop = Math.max(A[1], B[1], D[1]);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        if (!inMask[k]) continue;
        const x = x0 + i * C, z = z0 + j * C;
        let y;
        if (Math.abs(det) < 1e-6) y = steepTop; // a wall seen edge-on from above: its top
        else {
          const l1 = ((B[2] - D[2]) * (x - D[0]) + (D[0] - B[0]) * (z - D[2])) / det;
          const l2 = ((D[2] - A[2]) * (x - D[0]) + (A[0] - D[0]) * (z - D[2])) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
          y = l1 * A[1] + l2 * B[1] + l3 * D[1];
        }
        if (y > H[k]) H[k] = y;
      }
    }
  }
  // gaps: from the neighbours (grown inwards), else the ground
  for (let pass = 0; pass < 40; pass++) {
    let missing = 0;
    const next = H.slice();
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!inMask[k] || H[k] > -Infinity) continue;
      let s = 0, n = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const v = H[jj * nx + ii];
        if (v > -Infinity) { s += v; n++; }
      }
      if (n) next[k] = s / n; else missing++;
    }
    H.set(next);
    if (!missing) break;
  }
  const ground = (i, j) => gridHeight(TERRAIN, x0 + i * C, z0 + j * C);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i; if (inMask[k] && !(H[k] > -Infinity)) H[k] = ground(i, j) + 2; }
  // the bumps out: medians over 5 x 5 cells, three times (walls and ridges keep their edges)
  for (let pass = 0; pass < 3; pass++) {
    const next = H.slice(), win = [];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!inMask[k]) continue;
      win.length = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz || !inMask[jj * nx + ii]) continue;
        win.push(H[jj * nx + ii]);
      }
      win.sort((a, b) => a - b);
      next[k] = win[win.length >> 1];
    }
    H.set(next);
  }
  // the mesh: the top over every 2 x 2 block of cells inside, walls down to below the ground along the edge
  const pos = [];
  const v = (i, j, y) => [x0 + i * C, y, z0 + j * C];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  const at = (i, j) => (i >= 0 && j >= 0 && i < nx && j < nz && inMask[j * nx + i] ? H[j * nx + i] : null);
  for (let j = 0; j + 1 < nz; j++) for (let i = 0; i + 1 < nx; i++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    if (a === null || b === null || c === null || d === null) continue;
    // (x east, z south, y up: counter-clockwise from above is a, d, c / a, c, b)
    tri(v(i, j, a), v(i, j + 1, d), v(i + 1, j + 1, c));
    tri(v(i, j, a), v(i + 1, j + 1, c), v(i + 1, j, b));
  }
  // walls: along every edge between a cell inside and one outside, from its top to a metre under the ground
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const h = at(i, j);
    if (h === null) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (at(i + di, j + dj) !== null) continue;
      // the wall: across the cell's side facing out, half a cell out
      const cx = i + di * 0.5, cz = j + dj * 0.5;
      const ex = dj !== 0 ? 0.5 : 0, ez = di !== 0 ? 0.5 : 0;
      const g = Math.min(ground(i, j), ground(i + di, j + dj)) - 1;
      const p1 = [cx - ex, cz - ez], p2 = [cx + ex, cz + ez];
      const A = v(p1[0], p1[1], h), B = v(p2[0], p2[1], h), Cc = v(p2[0], p2[1], g), Dd = v(p1[0], p1[1], g);
      // facing out (di, dj)
      const outward = (B[0] - A[0]) * dj - (B[2] - A[2]) * di < 0;
      if (outward) { tri(A, Dd, Cc); tri(A, Cc, B); } else { tri(A, B, Cc); tri(A, Cc, Dd); }
    }
  }
  return pos;
}

function writeSolidGlb(file, pos) {
  writeColouredGlb(file, { pos, col: new Array(pos.length).fill(1) });
}

// A glTF binary's first mesh (as Blender writes it: plain accessors): positions and triangle indices
function readGlb(file) {
  const b = fs.readFileSync(file);
  const jl = b.readUInt32LE(12), json = JSON.parse(b.toString('utf8', 20, 20 + jl)), bin = b.subarray(20 + jl + 8);
  const acc = (i) => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView], off = bin.byteOffset + (v.byteOffset || 0) + (a.byteOffset || 0);
    const T = a.componentType === 5126 ? Float32Array : a.componentType === 5125 ? Uint32Array : a.componentType === 5123 ? Uint16Array : Uint8Array;
    const n = a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]);
    return new T(bin.buffer.slice(off, off + n * T.BYTES_PER_ELEMENT));
  };
  const pos = [], idx = [];
  const node = json.nodes.find((n) => n.mesh !== undefined) || {};
  const t = node.translation || [0, 0, 0];
  for (const prim of json.meshes[0].primitives) {
    const P = acc(prim.attributes.POSITION), I = prim.indices !== undefined ? acc(prim.indices) : Uint32Array.from({ length: P.length / 3 }, (_, k) => k);
    const base = pos.length / 3;
    for (let k = 0; k < P.length; k += 3) pos.push(P[k] + t[0], P[k + 1] + t[1], P[k + 2] + t[2]);
    for (const k of I) idx.push(base + k);
  }
  return { pos, idx };
}

// Every clean face takes the mean colour of the photographed triangles nearest its centre (within 1.5 m); then the
// landmark's colours are grouped (k-means, 5) so the faces read as a few materials, flat as built
function colourFaces({ pos, idx }, samples) {
  const CELL = 2, grid = new Map();
  for (const s of samples) {
    const k = `${Math.floor(s.x / CELL)},${Math.floor(s.y / CELL)},${Math.floor(s.z / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  const faces = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const cx = (pos[a] + pos[b] + pos[c]) / 3, cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    let r = 0, g = 0, bl = 0, w = 0;
    for (let i = Math.floor(cx / CELL) - 1; i <= Math.floor(cx / CELL) + 1; i++) for (let j = Math.floor(cy / CELL) - 1; j <= Math.floor(cy / CELL) + 1; j++) for (let k = Math.floor(cz / CELL) - 1; k <= Math.floor(cz / CELL) + 1; k++) {
      for (const s of grid.get(`${i},${j},${k}`) || []) {
        const d = Math.hypot(s.x - cx, s.y - cy, s.z - cz);
        if (d > 2) continue;
        const wt = 1 / (0.3 + d);
        r += s.rgb[0] * wt; g += s.rgb[1] * wt; bl += s.rgb[2] * wt; w += wt;
      }
    }
    faces.push({ a, b, c, rgb: w ? [r / w, g / w, bl / w] : null });
  }
  // the colours grouped: k-means over the faces that found a colour
  const known = faces.filter((f) => f.rgb);
  const K = Math.min(5, known.length);
  let centres = Array.from({ length: K }, (_, i) => known[Math.floor(((i + 0.5) / K) * known.length)].rgb.slice());
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  known.sort((p, q) => lum(p.rgb) - lum(q.rgb));
  centres = Array.from({ length: K }, (_, i) => known[Math.floor(((i + 0.5) / K) * known.length)].rgb.slice());
  const nearest = (c) => { let best = 0, bd = Infinity; centres.forEach((m, i) => { const d = (m[0] - c[0]) ** 2 + (m[1] - c[1]) ** 2 + (m[2] - c[2]) ** 2; if (d < bd) { bd = d; best = i; } }); return best; };
  for (let it = 0; it < 12; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const f of known) { const i = nearest(f.rgb); sum[i][0] += f.rgb[0]; sum[i][1] += f.rgb[1]; sum[i][2] += f.rgb[2]; sum[i][3]++; }
    centres = centres.map((m, i) => (sum[i][3] ? [sum[i][0] / sum[i][3], sum[i][1] / sum[i][3], sum[i][2] / sum[i][3]] : m));
  }
  // the photos' walls stand half in shade under a blue sky: a warmer, lighter albedo
  const albedo = (c) => [Math.min(255, c[0] * 1.18), Math.min(255, c[1] * 1.12), Math.min(255, c[2] * 0.98)];
  const fallback = centres.reduce((best, m) => (lum(m) > lum(best) ? m : best), centres[0]);
  // the walls: one stone, the landmark's (the bright half of the wall faces' colours, averaged); the roofs: their cluster
  const steep = (f) => {
    const ux = pos[f.b] - pos[f.a], uy = pos[f.b + 1] - pos[f.a + 1], uz = pos[f.b + 2] - pos[f.a + 2];
    const vx = pos[f.c] - pos[f.a], vy = pos[f.c + 1] - pos[f.a + 1], vz = pos[f.c + 2] - pos[f.a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return Math.abs(ny) < 0.5 * Math.hypot(nx, ny, nz);
  };
  const wallCols = known.filter(steep).map((f) => f.rgb).sort((p, q) => lum(p) - lum(q));
  const bright = wallCols.slice(Math.floor(wallCols.length * 0.5));
  let stone = bright.length ? [0, 1, 2].map((k) => bright.reduce((a, c) => a + c[k], 0) / bright.length) : fallback;
  // (the photographed walls are mostly in shade: Geneva's limestone and molasse stand light, ~165 of 255)
  const sl = lum(stone) || 1;
  if (sl < 165) stone = stone.map((v) => Math.min(255, (v * 165) / sl));
  const out = { pos: [], col: [] };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  for (const f of faces) {
    const c = albedo(steep(f) ? stone : centres[nearest(f.rgb || fallback)]);
    for (const v of [f.a, f.b, f.c]) { out.pos.push(pos[v], pos[v + 1], pos[v + 2]); out.col.push(lin(c[0]), lin(c[1]), lin(c[2])); }
  }
  return out;
}

// glTF binary, flat triangles with vertex colours (no texture)
function writeColouredGlb(file, { pos, col }) {
  const pad = (n) => (n + 3) & ~3;
  const P = Buffer.from(new Float32Array(pos).buffer), C = Buffer.from(new Float32Array(col).buffer);
  const bin = Buffer.alloc(pad(P.length) + C.length);
  P.copy(bin, 0); C.copy(bin, pad(P.length));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < pos.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pos[k + a]); max[a] = Math.max(max[a], pos[k + a]); }
  const json = {
    asset: { version: '2.0', generator: 'slop-geneva tools/build-landmarks.mjs', copyright: 'SITG, État de Genève: Photomaillage 3D 2019 (simplified)' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: col.length / 3, type: 'VEC3' }
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.length }, { buffer: 0, byteOffset: pad(P.length), byteLength: C.length }],
    buffers: [{ byteLength: bin.length }]
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad(jsonBuf.length) - jsonBuf.length, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const chunk = (buf, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.write(type, 4); return Buffer.concat([h, buf]); };
  fs.writeFileSync(file, Buffer.concat([header, chunk(jsonBuf, 'JSON'), chunk(bin, 'BIN\0')]));
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
  const parts = [], samples = [];
  let triangles = 0;
  for (const url of urls) {
    const { name: tile, dir } = await tileDir(url);
    const tris = cut(dir, tile, ring);
    if (!tris.length) continue;
    const mtl = fs.readFileSync(path.join(dir, `${tile}.mtl`), 'utf8');
    const img = jpeg.decode(fs.readFileSync(path.join(dir, /map_Kd\s+(.+)/.exec(mtl)[1].trim().replace(/\\/g, '/'))), { useTArray: true, maxMemoryUsageInMB: 2048 });
    const { image, remap, w, h, rgba } = crop(img, tris);
    const pos = [], uv = [];
    // (E, N, h) -> (x, y, z) is a rotation: the winding stays
    for (const { P, T } of tris) {
      for (const p of P) pos.push(...p);
      const U = T.map(remap);
      for (const t of U) uv.push(...t);
      // the triangle's colour: the photo around its centre (3 x 3 texels), for the clean faces nearby
      const cu = (U[0][0] + U[1][0] + U[2][0]) / 3, cv = (U[0][1] + U[1][1] + U[2][1]) / 3;
      const px = Math.round(cu * (w - 1)), py = Math.round(cv * (h - 1));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.max(0, py - 1); y <= Math.min(h - 1, py + 1); y++) for (let x = Math.max(0, px - 1); x <= Math.min(w - 1, px + 1); x++) {
        const o = (y * w + x) * 4; r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; n++;
      }
      samples.push({ x: (P[0][0] + P[1][0] + P[2][0]) / 3, y: (P[0][1] + P[1][1] + P[2][1]) / 3, z: (P[0][2] + P[1][2] + P[2][2]) / 3, rgb: [r / n, g / n, b / n] });
    }
    parts.push({ pos, uv, image });
    triangles += tris.length;
  }
  if (!parts.length) { log(`${name}: nothing in the photomesh`); continue; }
  const key = slug(name);
  writeGlb(path.join(RAW, `${key}.photo.glb`), parts);
  // the landmark's solid: its photographed surfaces as a heightfield over its footprint, denoised
  const raw = path.join(RAW, `${key}.glb`);
  writeSolidGlb(raw, heightfieldSolid(parts, ring));
  // clean in Blender, then coloured
  const cleanFile = path.join(RAW, `${key}.clean.glb`);
  execFileSync(BLENDER, ['-b', '--factory-startup', '-P', path.join(DIR, 'blender-simplify.py'), '--', raw, cleanFile, '0.35', '4'], { stdio: 'pipe' });
  const clean = readGlb(cleanFile);
  const coloured = colourFaces(clean, samples);
  writeColouredGlb(path.join(OUT, `${key}.glb`), coloured);
  triangles = coloured.pos.length / 9;
  const entry = { key, name, file: `${key}.glb`, ring, triangles };
  const at = index.landmarks.findIndex((l) => l.key === key);
  if (at >= 0) index.landmarks[at] = entry; else index.landmarks.push(entry);
  log(`${name}: ${urls.length} tiles, ${triangles} triangles, ${(fs.statSync(path.join(OUT, `${key}.glb`)).size / 1048576).toFixed(1)} MB`);
}
fs.writeFileSync(indexFile, JSON.stringify({ source: 'SITG, État de Genève: Photomaillage 3D 2019 (open data)', landmarks: index.landmarks }));
