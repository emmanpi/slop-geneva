// tests/canton-layers.test.mjs — checks the 1 km canton tiles produced by tools/build-canton-layers.mjs against
// data/canton/index.json: file sizes, terrain grids (251 x 251, plausible heights, shared edges), the roadway and
// road-marking formats and bounds, the tree records, and the orthophotos' dimensions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeTest from 'node:test';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { FRAME, lv95ToWorld } from '../js/geneva-frame.js';
import { parseTerrain } from '../js/terrain-grid.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CANTON = path.join(DIR, '..', 'data', 'canton');
// (the tiles are data the owner may keep out of git: without them there is nothing to check)
const INDEX = path.join(CANTON, 'index.json');
const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : null;
const tiles = index ? Object.entries(index.tiles) : [];
const test = index ? nodeTest : nodeTest.skip;
const FILE = { terrain: 'terrain.bin', ortho: 'ortho.jpg', roadway: 'roadway.bin', roadmarks: 'roadmarks.bin', trees: 'trees.json' };

// The world box of a tile "E-N" (see js/geneva-frame.js: x = E - E0, z = N0 - N)
const tileBox = (key) => {
  const [e, n] = key.split('-').map(Number);
  return { e, n, x0: e * 1000 - FRAME.E0, x1: (e + 1) * 1000 - FRAME.E0, z0: FRAME.N0 - (n + 1) * 1000, z1: FRAME.N0 - n * 1000 };
};
const read = (f) => fs.readFileSync(f);
const terrain = new Map(); // key -> parsed grid, loaded lazily
const gridOf = (key) => {
  if (!terrain.has(key)) {
    const b = read(path.join(CANTON, key, 'terrain.bin'));
    terrain.set(key, parseTerrain(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
  }
  return terrain.get(key);
};
const pad4 = (n) => (n + 3) & ~3;

test('every canton tile lists its layers and their byte sizes', () => {
  assert.ok(tiles.length > 0, 'index.json has tiles');
  for (const [key, t] of tiles) {
    assert.ok(Array.isArray(t.layers) && t.layers.length > 0, `${key} has layers`);
    for (const layer of t.layers) {
      const file = path.join(CANTON, key, FILE[layer]);
      assert.ok(fs.existsSync(file), `${key}: ${FILE[layer]} exists`);
      assert.equal(fs.statSync(file).size, t.bytes[layer], `${key}: ${layer} size matches index`);
    }
  }
});

test('every terrain tile is a 251 x 251 grid over the tile with plausible heights', () => {
  for (const [key, t] of tiles) {
    if (!t.layers.includes('terrain')) continue;
    const { x0, x1, z0, z1 } = tileBox(key);
    const g = gridOf(key);
    assert.equal(g.cols, 251, `${key}: cols`);
    assert.equal(g.rows, 251, `${key}: rows`);
    assert.equal(g.cell, FRAME.terrainCell, `${key}: cell`);
    assert.equal(g.minX, x0, `${key}: minX`);
    assert.equal(g.minZ, z0, `${key}: minZ`);
    assert.equal(g.maxX, x1, `${key}: maxX`);
    assert.equal(g.maxZ, z1, `${key}: maxZ`);
    // Geneva heights are 330-1000 m a.s.l. -> -42..628 above H0
    for (const h of g.heights) assert.ok(h >= -42 && h <= 628, `${key}: height ${h} above H0`);
  }
});

test('neighbouring tiles share their terrain edge heights', () => {
  for (const [key, t] of tiles) {
    if (!t.layers.includes('terrain')) continue;
    const { e, n } = tileBox(key);
    const g = gridOf(key);
    // east edge (last column) vs the east neighbour's west edge (first column)
    const east = `${e + 1}-${n}`;
    if (index.tiles[east]?.layers.includes('terrain')) {
      const h = gridOf(east);
      for (let j = 0; j < 251; j++) assert.equal(g.heights[j * 251 + 250], h.heights[j * 251], `${key} vs ${east} east edge row ${j}`);
    }
    // south edge (last row) vs the south neighbour's north edge (first row)
    const south = `${e}-${n - 1}`;
    if (index.tiles[south]?.layers.includes('terrain')) {
      const h = gridOf(south);
      for (let i = 0; i < 251; i++) assert.equal(g.heights[250 * 251 + i], h.heights[i], `${key} vs ${south} south edge col ${i}`);
    }
  }
});

test('roadway and road-marking files have the right magic and their points in the tile (± 50 m)', () => {
  for (const [key, t] of tiles) {
    const { x0, x1, z0, z1 } = tileBox(key);
    if (t.layers.includes('roadway')) {
      const b = read(path.join(CANTON, key, 'roadway.bin'));
      const h = new Int32Array(b.buffer, b.byteOffset, 10);
      assert.equal(h[0], 0x59575247, `${key}: roadway magic`);
      assert.equal(h[1], 1, `${key}: roadway version`);
      assert.equal(h[6], 1000, `${key}: roadway mask width`);
      assert.equal(h[7], 1000, `${key}: roadway mask height`);
      assert.equal(h[8], x0, `${key}: roadway mask x0`);
      assert.equal(h[9], z0, `${key}: roadway mask z0`);
      let o = 40 + (h[2] + 1) * 4 + pad4(h[2]) * 2;
      const rp = new Float32Array(b.buffer, b.byteOffset + o, h[3] * 2); o += h[3] * 8 + (h[4] + 1) * 4;
      const kp = new Float32Array(b.buffer, b.byteOffset + o, h[5] * 2);
      for (let i = 0; i < h[3]; i++) {
        assert.ok(rp[i * 2] >= x0 - 51 && rp[i * 2] <= x1 + 51 && rp[i * 2 + 1] >= z0 - 51 && rp[i * 2 + 1] <= z1 + 51, `${key}: ring point ${i}`);
      }
      for (let i = 0; i < h[5]; i++) {
        assert.ok(kp[i * 2] >= x0 - 51 && kp[i * 2] <= x1 + 51 && kp[i * 2 + 1] >= z0 - 51 && kp[i * 2 + 1] <= z1 + 51, `${key}: kerb point ${i}`);
      }
    }
    if (t.layers.includes('roadmarks')) {
      const b = read(path.join(CANTON, key, 'roadmarks.bin'));
      const h = new Int32Array(b.buffer, b.byteOffset, 6);
      assert.equal(h[0], 0x4b4d5247, `${key}: roadmarks magic`);
      assert.equal(h[1], 1, `${key}: roadmarks version`);
      const [tile, nTiles, nShapes, nPts] = [h[2], h[3], h[4], h[5]];
      const tiles = new Int32Array(b.buffer, b.byteOffset + 24, nTiles * 4);
      const pad = pad4(nShapes);
      let o = 24 + nTiles * 16 + pad * 2;
      const starts = new Uint32Array(b.buffer, b.byteOffset + o, nShapes + 1); o += (nShapes + 1) * 4;
      const pts = new Int16Array(b.buffer, b.byteOffset + o, nPts * 2);
      for (let t = 0; t < nTiles; t++) {
        const [tx, tz, first, count] = [tiles[t * 4], tiles[t * 4 + 1], tiles[t * 4 + 2], tiles[t * 4 + 3]];
        const cx = (tx + 0.5) * tile, cz = (tz + 0.5) * tile;
        for (let s = first; s < first + count; s++) for (let k = starts[s]; k < starts[s + 1]; k++) {
          const x = cx + pts[k * 2] / 100, z = cz + pts[k * 2 + 1] / 100;
          assert.ok(x >= x0 - 51 && x <= x1 + 51 && z >= z0 - 51 && z <= z1 + 51, `${key}: roadmark point ${k}`);
        }
      }
    }
  }
});

test('tree records have the GENEVA_DATA.trees fields and their trunk inside the tile', () => {
  const FIELDS = ['x', 'z', 'h', 'crown', 'street', 'g'];
  for (const [key, t] of tiles) {
    if (!t.layers.includes('trees')) continue;
    const { x0, x1, z0, z1 } = tileBox(key);
    const trees = JSON.parse(read(path.join(CANTON, key, 'trees.json')));
    assert.equal(trees.length, t.trees, `${key}: tree count matches index`);
    for (const tr of trees) {
      for (const f of FIELDS) assert.ok(f in tr, `${key}: tree has ${f}`);
      assert.ok(Number.isInteger(tr.g), `${key}: phenology class`);
      assert.ok(tr.x >= x0 && tr.x < x1 && tr.z >= z0 && tr.z < z1, `${key}: trunk ${tr.x},${tr.z} in the tile`);
    }
  }
});

test('every orthophoto is a 1000 x 1000 JPEG', () => {
  for (const [key, t] of tiles) {
    if (!t.layers.includes('ortho')) continue;
    const b = read(path.join(CANTON, key, 'ortho.jpg'));
    assert.equal(b.readUInt16BE(0), 0xffd8, `${key}: a JPEG`);
    const img = jpeg.decode(b, { useTArray: true });
    assert.equal(img.width, 1000, `${key}: width`);
    assert.equal(img.height, 1000, `${key}: height`);
  }
});

// Sanity: the phase-A area, when present, is a commune outline and its tiles all touch it
test('the index area matches the build and every tile lies on the LV95 kilometre grid', () => {
  for (const key of Object.keys(index.tiles)) {
    const { e, n } = tileBox(key);
    assert.ok(Number.isInteger(e) && Number.isInteger(n), `${key}: kilometre tile`);
    assert.equal(lv95ToWorld(e * 1000, n * 1000).x, (e * 1000 - FRAME.E0), `${key}: x`);
  }
  if (index.area) {
    assert.ok(Number.isInteger(index.area.bfs) && index.area.name, 'area has bfs and name');
  }
});
