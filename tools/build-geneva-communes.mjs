// tools/build-geneva-communes.mjs — writes data/geneva-communes.json: the canton's 45 communes (swisstopo
// swissBOUNDARIES3D, BFS numbers 6601-6645), their outlines simplified to ~5 m and a label point, in world coordinates
// (js/geneva-frame.js), for the map (js/city-map.js: names, outlines, search) and the location label beyond the city.
// Output: { source, fetched, communes: [{ bfs, name, label: [x, z], rings: [[[x, z], ...], ...] }] }
// usage: node tools/build-geneva-communes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME } from '../js/geneva-frame.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, '..', 'data', 'geneva-communes.json');
const LAYER = 'https://api3.geo.admin.ch/rest/services/api/MapServer/ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill';
const log = (...a) => console.log('[geneva-communes]', ...a);

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'slop-geneva data tools' } }).catch((error) => ({ ok: false, status: error.message }));
    if (res.ok) return res.json();
    if (attempt === 4) throw new Error(`${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
}

// Ramer-Douglas-Peucker on a closed ring
function simplify(points, tolerance) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  // a closed ring (first point = last): split it at the point farthest from its start, then simplify both halves
  let split = 0, farthest = -1;
  points.forEach(([x, z], i) => { const d = Math.hypot(x - points[0][0], z - points[0][1]); if (d > farthest) { farthest = d; split = i; } });
  keep[0] = keep[split] = keep[points.length - 1] = 1;
  const stack = [[0, split], [split, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = points[a], [bx, bz] = points[b];
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
    let worst = -1, far = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i][0] - ax) * dz - (points[i][1] - az) * dx) / len;
      if (d > far) { far = d; worst = i; }
    }
    if (far > tolerance) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
const area = (r) => r.reduce((s, [x, z], i) => { const [x2, z2] = r[(i + 1) % r.length]; return s + x * z2 - x2 * z; }, 0) / 2;
const inRing = (r, x, z) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
};
const distToRing = (r, x, z) => {
  let d = Infinity;
  for (let i = 0; i < r.length; i++) {
    const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length], dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    d = Math.min(d, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return d;
};
// A label point well inside the largest ring: the grid point farthest from its edge
function labelPoint(ring) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  let best = [(x0 + x1) / 2, (z0 + z1) / 2], bestD = -1;
  const step = Math.max(x1 - x0, z1 - z0, 1) / 40;
  for (let x = x0; x <= x1; x += step) for (let z = z0; z <= z1; z += step) {
    if (!inRing(ring, x, z)) continue;
    const d = distToRing(ring, x, z);
    if (d > bestD) { bestD = d; best = [x, z]; }
  }
  return best.map((v) => Math.round(v));
}

const communes = [];
for (let bfs = 6601; bfs <= 6645; bfs++) {
  const data = await getJson(`${LAYER}/${bfs}?geometryFormat=geojson&sr=2056`);
  const f = data.feature;
  const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  const rings = polys.map((poly) => simplify(poly[0].map(([e, n]) => [Math.round((e - FRAME.E0) * 10) / 10, Math.round((FRAME.N0 - n) * 10) / 10]), 5));
  const largest = rings.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a));
  communes.push({ bfs, name: f.properties.gemname, label: labelPoint(largest), rings });
}
fs.writeFileSync(OUT, JSON.stringify({ source: 'swisstopo swissBOUNDARIES3D (communes du canton de Genève)', fetched: new Date().toISOString().slice(0, 10), communes }));
log(`${communes.length} communes -> data/geneva-communes.json (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
