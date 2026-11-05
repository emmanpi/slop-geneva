// tools/build-geneva-moorings.mjs — writes js/geneva-moorings.js, the boats moored in the Rade all year, for
// js/moored-boats.js:
//  - every mooring place on the water as the canton authorises it (SITG, LCE_PLACES_AMARRAGE, Office cantonal de
//    l'eau, fetched by tools/fetch-sitg-roadway.mjs): the place's outline gives the boat's position and heading, its
//    authorised length and beam the boat's size;
//  - the paddle steamer « Genève » (1896), moored for good at the quai Gustave-Ador, from its OSM outline
//    (building=ship);
//  - a CGN Belle Époque paddle steamer alongside each of the CGN's two Geneva piers, Genève-Mont-Blanc and
//    Genève-Jardin-Anglais (their stops in the public transport timetable, opentransportdata.swiss GTFS), along the
//    quay.
// usage: node tools/build-geneva-moorings.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lonLatToWorld, lv95ToWorld } from '../js/geneva-frame.js';
import { inFrame } from './osm-geometry.mjs';
import { GENEVA_DATA } from '../js/geneva-geodata.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'data', 'cache');
const OUT = path.join(DIR, '..', 'js', 'geneva-moorings.js');
const log = (...a) => console.log('[geneva-moorings]', ...a);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// The oriented box around a set of points: its centre, length along its main axis, width across, heading
function orientedBox(pts) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 0.05) continue;
    const ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l;
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const [x, z] of pts) { const s = x * ux + z * uz, t = -x * uz + z * ux; s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
    const area = (s1 - s0) * (t1 - t0);
    if (!best || area < best.area) best = { area, ux, uz, s0, s1, t0, t1 };
  }
  let { ux, uz, s0, s1, t0, t1 } = best;
  if (t1 - t0 > s1 - s0) { [ux, uz] = [-uz, ux]; [s0, s1, t0, t1] = [-t1, -t0, s0, s1]; } // (main axis along the longer side)
  const sm = (s0 + s1) / 2, tm = (t0 + t1) / 2;
  return { x: sm * ux - tm * uz, z: sm * uz + tm * ux, length: s1 - s0, beam: t1 - t0, ux, uz };
}
const hash = (n) => { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };

// --- The mooring places --------------------------------------------------------------------------------------------------
const places = JSON.parse(fs.readFileSync(path.join(CACHE, 'sitg_lce_places_amarrage.json'), 'utf8')).features;
const boats = []; // flat [x, z, heading, length, beam, kind] (kind 0 motor boat, 1 sailing boat, 2 covered motor boat)
let skipped = 0;
for (const p of places) {
  if (p.PLACE_NATURE !== "A l'eau" || !p.rings?.[0]) { skipped++; continue; }
  const ring = p.rings[0].slice(0, -1).map(([e, n]) => { const { x, z } = lv95ToWorld(e, n); return [x, z]; });
  if (ring.length < 3) continue;
  const box = orientedBox(ring);
  if (!inFrame(box.x, box.z)) continue;
  // the authorised size, within the place (cm in the survey); else the place's own
  const length = Math.min(box.length, p.PLACE_LONGUEUR ? p.PLACE_LONGUEUR / 100 : box.length * 0.85);
  const beam = Math.min(box.beam, p.PLACE_LARGEUR ? p.PLACE_LARGEUR / 100 : box.beam * 0.8);
  if (length < 2.5 || beam < 0.9) continue;
  const h = hash(Number(p.OBJECTID) || boats.length);
  // the bow one way or the other along the place; sailing boats from 6.5 m on (most of the Rade's), some motor
  // boats under their winter covers
  const flip = hash((Number(p.OBJECTID) || 0) + 0.5) < 0.5 ? Math.PI : 0;
  const kind = length >= 6.5 && h < 0.6 ? 1 : h > 0.82 ? 2 : 0;
  boats.push(r2(box.x), r2(box.z), r3(Math.atan2(-box.uz, box.ux) + flip), r2(length), r2(beam), kind);
}

// --- The steamers --------------------------------------------------------------------------------------------------------
const steamers = []; // { name, x, z, heading, length, beam }
// « Genève », from its OSM outline
const osm = JSON.parse(fs.readFileSync(path.join(CACHE, 'osm_geneva.json'), 'utf8')).elements;
for (const e of osm) {
  if (e.type !== 'way' || e.tags?.building !== 'ship' || e.tags?.name !== 'Genève' || !e.geometry) continue;
  const box = orientedBox(e.geometry.map(({ lat, lon }) => { const { x, z } = lonLatToWorld(lon, lat); return [x, z]; }));
  // (the outline takes in the paddle boxes, some 6 m over the 6.75 m hull)
  steamers.push({ name: 'Genève', x: r2(box.x), z: r2(box.z), heading: r3(Math.atan2(-box.uz, box.ux)), length: r2(box.length), beam: r2(Math.max(6, box.beam - 5.5)) });
}
// The CGN's piers: alongside the quay, the steamer's side against it
const shoreEdges = [];
for (const w of GENEVA_DATA.water) if (w.ring?.length >= 6) {
  for (const r of [w.ring, ...(w.holes || [])]) for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    shoreEdges.push([r[i], r[i + 1], r[j], r[j + 1]]);
  }
}
const nearestShore = (x, z) => {
  let best = null;
  for (const [ax, az, bx, bz] of shoreEdges) {
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    if (l2 < 1) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
    if (!best || d < best.d) { const l = Math.sqrt(l2); best = { d, px, pz, ux: dx / l, uz: dz / l }; }
  }
  return best;
};
const inLake = (x, z) => GENEVA_DATA.water.some((w) => {
  if (!w.ring || w.ring.length < 6) return false;
  const pip = (r) => { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { if ((r[i + 1] > z) !== (r[j + 1] > z) && x < ((r[j] - r[i]) * (z - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c; } return c; };
  return pip(w.ring) && !(w.holes || []).some(pip);
});
const CGN = [
  { name: 'CGN · Genève-Mont-Blanc', lat: 46.20733326, lon: 6.14855489 }, // GTFS stop 8501237
  { name: 'CGN · Genève-Jardin-Anglais', lat: 46.20505164, lon: 6.15062102 } // GTFS stop 8501236
];
const STEAMER = { length: 68, beam: 8.6 }; // a CGN Belle Époque paddle steamer (Montreux, Savoie: 68 m; paddles out)
for (const pier of CGN) {
  const { x, z } = lonLatToWorld(pier.lon, pier.lat);
  const shore = nearestShore(x, z);
  if (!shore) continue;
  // out of the quay into the water by half the beam, the paddle box and a fender's gap
  let nx = -shore.uz, nz = shore.ux;
  if (!inLake(shore.px + nx * 6, shore.pz + nz * 6)) { nx = -nx; nz = -nz; }
  const off = STEAMER.beam / 2 + 3.2; // (the paddle boxes stand 2 m out of the hull)
  steamers.push({ name: pier.name, x: r2(shore.px + nx * off), z: r2(shore.pz + nz * off), heading: r3(Math.atan2(-shore.uz, shore.ux)), length: STEAMER.length, beam: STEAMER.beam });
}

const src = `// Generated by tools/build-geneva-moorings.mjs — do not edit.
// The Rade's moorings (SITG LCE_PLACES_AMARRAGE, Office cantonal de l'eau), the steamer « Genève » (OSM) and a CGN
// steamer at each CGN pier (GTFS stops). boats: flat [x, z, heading, length, beam, kind] (kind 0 motor boat,
// 1 sailing boat, 2 covered motor boat); heading turns +x onto the bow.
export const MOORINGS = ${JSON.stringify({ boats, steamers })};
`;
fs.writeFileSync(OUT, src);
const kinds = [0, 1, 2].map((k) => boats.filter((v, i) => i % 6 === 5 && v === k).length);
log(`${boats.length / 6} boats at their moorings (${kinds[0]} motor, ${kinds[1]} sailing, ${kinds[2]} covered), ` +
  `${skipped} places ashore or unsurveyed; steamers: ${steamers.map((s) => `${s.name} ${s.length.toFixed(0)} m`).join(', ')} -> ${path.relative(process.cwd(), OUT)} (${(src.length / 1e3).toFixed(0)} kB)`);
