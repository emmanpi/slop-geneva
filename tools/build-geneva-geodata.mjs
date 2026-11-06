// tools/build-geneva-geodata.mjs — writes js/geneva-geodata.js for the engine's irregular-city data path (GEO.geneva)
// Sources (see package.json "data" scripts):
//   tools/data/cache/osm_geneva.json        OpenStreetMap, query tools/data/q_geneva.overpassql
//   tools/data/cache/osm_geneva_areas.json  OpenStreetMap quartiers & communes, query tools/data/q_geneva_areas.overpassql
//   tools/data/cache/geneva_trees.json      SITG cantonal tree inventory (tools/fetch-geneva-trees.mjs)
// Frame: js/geneva-frame.js (LV95 offset: x = east, z = south, metres). Buildings are drawn from swisstopo's
// swissBUILDINGS3D at runtime (js/swissbuildings3d.js); the OSM footprints below drive colliders, sidewalks & the
// fallback extrusions. Terrain heights live in data/geneva-terrain.bin (tools/build-geneva-terrain.mjs).
// usage: node tools/build-geneva-geodata.mjs [out.js]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME, WORLD_BOUNDS, lonLatToWorld, lv95ToWorld } from '../js/geneva-frame.js';
import { parseTerrain, gridHeight } from '../js/terrain-grid.js';
import { phenoClass } from '../js/phenology.js';
import { ROADWAY } from '../js/roadway.js';
import { toWorld, flat, geomPts, inFrame, ringArea, bbox, bboxInFrame, rdp, cleanRing, polygons, clipToFrame } from './osm-geometry.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(DIR, '..', 'js', 'geneva-geodata.js');
const CACHE = path.join(DIR, 'data', 'cache');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'));
const osm = readJson('osm_geneva.json');
const log = (...a) => console.log('[geneva-geodata]', ...a);
const terrainFile = fs.readFileSync(path.join(DIR, '..', 'data', 'geneva-terrain.bin'));
const TERRAIN = parseTerrain(terrainFile.buffer.slice(terrainFile.byteOffset, terrainFile.byteOffset + terrainFile.byteLength));
const r2 = (v) => Math.round(v * 100) / 100;

const r1 = (v) => Math.round(v * 10) / 10;
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

// --- Buildings (footprints; the volumes come from swissBUILDINGS3D) ------------------------------------------------------
const buildings = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node' || !t.building) continue;
  if (t.building === 'roof' || t.building === 'no' || t.building === 'construction') continue;
  if (t.location === 'underground' || (num(t.layer) ?? 0) < 0) continue;
  for (const [i, p] of polygons(e).entries()) {
    const ring = cleanRing(p.ring);
    if (ring.length < 3 || Math.abs(ringArea(ring)) < 6 || !bboxInFrame(bbox(ring))) continue;
    const levels = num(t['building:levels']);
    let h = num(t.height), src = 'height';
    if (h == null && levels != null) { h = levels * 3.2 + (t['roof:shape'] && t['roof:shape'] !== 'flat' ? 3 : 1); src = 'building:levels'; }
    // Without a height (and before the survey below): small footprints are sheds, kiosks and garages, the rest Geneva's
    // 5-7 storey blocks
    if (h == null) { const a = Math.abs(ringArea(ring)); h = a < 40 ? 3 : a < 120 ? 6 : 14; src = 'default'; }
    buildings.push({
      id: `${e.type[0]}${e.id}${i ? '_' + i : ''}`, ring: flat(ring), holes: p.holes.map((hh) => flat(cleanRing(hh))), h: r1(h),
      roofHeight: r1(num(t['roof:height']) ?? 0), roofShape: t['roof:shape'] || 'flat', levels: levels ?? 0,
      name: t.name || '', kind: t.building, heightSource: src
    });
  }
}

// --- Real heights for the footprints OSM leaves without one ---------------------------------------------------------------
// Most of Geneva's OSM buildings carry no height. The stored swissBUILDINGS3D tiles give every surveyed building its
// height (batch table Height, at its Latitude/Longitude); failing that, the RegBL storeys (GASTW) give an estimate.
// They set the colliders and the fallback extrusions (a kiosk is not 14 m high).
{
  const SB = path.join(DIR, '..', 'data', 'swissbuildings3d');
  const points = [];
  if (fs.existsSync(path.join(SB, 'index.json'))) {
    const index = JSON.parse(fs.readFileSync(path.join(SB, 'index.json'), 'utf8'));
    for (const t of index.tiles) {
      const b = fs.readFileSync(path.join(SB, index.base, t.u));
      const ftJ = b.readUInt32LE(12), ftB = b.readUInt32LE(16), btJ = b.readUInt32LE(20);
      const bt = btJ ? JSON.parse(b.toString('utf8', 28 + ftJ + ftB, 28 + ftJ + ftB + btJ)) : {};
      (bt.Latitude || []).forEach((lat, k) => {
        if (!(bt.Height?.[k] > 0)) return;
        const [x, z] = toWorld(bt.Longitude[k], lat);
        points.push({ x, z, h: bt.Height[k], src: 'swissbuildings3d' });
      });
    }
  }
  const GWR = path.join(CACHE, 'gwr', 'gebaeude_batiment_edificio.csv');
  if (fs.existsSync(GWR)) {
    const lines = fs.readFileSync(GWR, 'utf8').split('\n'), head = lines[0].split('\t');
    const cE = head.indexOf('GKODE'), cN = head.indexOf('GKODN'), cF = head.indexOf('GASTW');
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split('\t');
      if (!f[cF]) continue;
      const { x, z } = lv95ToWorld(+f[cE], +f[cN]);
      if (inFrame(x, z)) points.push({ x, z, h: +f[cF] * 3.1 + 1, src: 'regbl' });
    }
  }
  const CELL = 40, grid = new Map();
  for (const p of points) { const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
  const inside = (ring, x, z) => { let c = false; for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) { if ((ring[i + 1] > z) !== (ring[j + 1] > z) && x < ((ring[j] - ring[i]) * (z - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) c = !c; } return c; };
  const tally = { swissbuildings3d: 0, regbl: 0 };
  for (const b of buildings) {
    if (b.heightSource === 'height') continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < b.ring.length; i += 2) { x0 = Math.min(x0, b.ring[i]); x1 = Math.max(x1, b.ring[i]); z0 = Math.min(z0, b.ring[i + 1]); z1 = Math.max(z1, b.ring[i + 1]); }
    let best = null;
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      for (const p of grid.get(`${i},${j}`) || []) {
        if (!inside(b.ring, p.x, p.z)) continue;
        // the survey first, then the tallest
        if (!best || (p.src === 'swissbuildings3d' && best.src !== 'swissbuildings3d') || (p.src === best.src && p.h > best.h)) best = p;
      }
    }
    if (best) { b.h = r1(Math.max(2.5, best.h)); b.heightSource = best.src; tally[best.src]++; }
  }
  log(`footprint heights: ${tally.swissbuildings3d} from swissBUILDINGS3D, ${tally.regbl} from the RegBL storeys`);
}

// --- Roads & railways ---------------------------------------------------------------------------------------------------
const WIDTH = { motorway: 14, trunk: 12, primary: 10, secondary: 8, tertiary: 7, residential: 6, unclassified: 6, living_street: 5, service: 3.5, pedestrian: 6, cycleway: 2.5, footway: 2, path: 1.5, steps: 2.5, track: 3 };
const LANES = { motorway: 4, trunk: 4, primary: 2, secondary: 2, tertiary: 2, residential: 2, unclassified: 2, living_street: 1, service: 1 };
const DRIVABLE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street']);
const RUES_BASSES_WIDTH = 18; // m, facade to facade (the footprints stand 8 to 12 m either side of the axis)
const zoneWays = [];
const RAIL = /^(rail|light_rail|tram|subway|funicular|narrow_gauge)$/;
function noteLevel(e, pts, kept, record, bridge, tunnel) {
  if (!e.nodes || e.nodes.length !== pts.length) return;
  const minor = MINOR.test(e.tags.highway || '');
  if (bridge) {
    const index = new Map(pts.map((p, i) => [p, i]));
    deckWays.push({ record, nodes: e.nodes, pts, kept: kept.map((p) => index.get(p)), minor, sidewalk: e.tags.footway === 'sidewalk' });
  } else if (!tunnel) for (const id of e.nodes) (minor ? minorGroundNodes : groundNodes).add(id);
}
const drivable = [];
const deckWays = []; // every rendered bridge way: { record, nodes, pts (full), kept (indices of the simplified points), minor }
// Nodes of rendered ways at ground level. Paths & steps often hang off a bridge's side (stairs down to the street or the
// platforms below), so they only anchor footbridges, never road or rail decks.
const groundNodes = new Set(), minorGroundNodes = new Set();
const MINOR = /^(footway|path|steps|cycleway|pedestrian|track|service|elevator)$/;
const roads = [];
const railways = [];
const signals = [];
const fountains = [];
const tramStops = [];
let trees = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node') {
    const [x, z] = toWorld(e.lon, e.lat);
    if (!inFrame(x, z)) continue;
    if (t.natural === 'tree') trees.push({ x: r1(x), z: r1(z), h: r1(num(t.height) ?? 10) });
    else if (t.highway === 'traffic_signals') signals.push({ x: r1(x), z: r1(z) });
    else if (t.amenity === 'fountain') fountains.push({ x: r1(x), z: r1(z), name: t.name || '' });
    else if (t.railway === 'tram_stop') tramStops.push({ x: r1(x), z: r1(z), name: t.name || '' });
    continue;
  }
  if (e.type !== 'way' || !e.geometry) continue;
  const pts = geomPts(e.geometry);
  if (!bboxInFrame(bbox(pts), 50)) continue;
  const bridge = !!t.bridge && t.bridge !== 'no' && t.bridge !== 'culvert';
  // Below ground counts as a tunnel: the engine has no underground, and the terrain tool fills the open cuts leading
  // there (the Bahnhofquai underpass, the ramps to the HB's underground stations)
  const tunnel = (!!t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') || t.covered === 'yes' || t.location === 'underground' ||
    (!bridge && (num(t.layer) ?? 0) < 0);
  const layer = num(t.layer) ?? (bridge ? 1 : tunnel ? -1 : 0);
  if (t.railway && RAIL.test(t.railway)) {
    if (t.service === 'yard' || t.service === 'siding' || t.service === 'spur') {
      if (t.railway !== 'rail') continue;
    }
    const kept = rdp(pts, 0.5);
    const record = { id: `w${e.id}`, pts: flat(kept), bridge, tunnel, layer, kind: t.railway, name: t.name || '' };
    railways.push(record);
    noteLevel(e, pts, kept, record, bridge, tunnel);
    continue;
  }
  if (!t.highway || /^(proposed|construction|platform|bus_stop|corridor|elevator|raceway|bridleway)$/.test(t.highway)) continue;
  // OSM maps crosswalks as footways across the carriageway: the engine paints its own (and would take them
  // for sidewalks in the middle of the street)
  if (t.footway === 'crossing' || t.cycleway === 'crossing' || t.path === 'crossing') continue;
  // The Rues-Basses (Marché, Croix-d'Or, Rive, Confédération) are a pedestrian zone the trams cross, mapped as a
  // residential street open to public transport (psv): walked from facade to facade, with no cars
  const zone = /\(Rues-Basses\)/.test(t.name || '');
  const kind = zone ? 'pedestrian' : t.highway.replace(/_link$/, '') in WIDTH ? t.highway : 'service';
  const base = kind.replace(/_link$/, '');
  const lanes = num(t.lanes) ?? LANES[base] ?? 1;
  const width = zone ? RUES_BASSES_WIDTH : num(t.width) ?? Math.max(WIDTH[base] ?? 3, lanes * 3);
  const oneway = t.oneway === 'yes' || t.oneway === '-1' || t.oneway === '1' || t.junction === 'roundabout';
  // Geneva's tram streets: the tracks share the carriageway (OSM railway=tram ways run along them)
  const kept = rdp(pts, 0.5);
  const record = { id: `w${e.id}`, pts: flat(kept), bridge, tunnel, layer, name: t.name || '', width: r1(width), lanes, oneway, reverse: t.oneway === '-1', kind, nodeIds: e.nodes || [] };
  // Cycle lanes along a street (OSM cycleway, cycleway:both|left|right): [left, right] of the way's drawing direction,
  // 'L' a lane (solid line), 'A' an advisory lane (dashed), 'B' a shared bus lane, 'T' a track beside it; lowercase:
  // ridden against the way's direction (a contraflow lane on a one-way street)
  {
    const code = (v) => (/^lane$/.test(v || '') ? 'L' : /^opposite_lane$/.test(v || '') ? 'l' : /^share_busway$/.test(v || '') ? 'B' : /^track$/.test(v || '') ? 'T' : /^opposite_track$/.test(v || '') ? 't' : '');
    const side = (k) => {
      const v = t[`cycleway:${k}`] ?? t['cycleway:both'] ?? (k === 'right' || !oneway ? t.cycleway : undefined);
      let c = code(v);
      if (c === 'L' && /advisory/.test(t[`cycleway:${k}:lane`] || t['cycleway:both:lane'] || t['cycleway:lane'] || '')) c = 'A';
      if (c && t[`cycleway:${k}:oneway`] === '-1') c = c.toLowerCase();
      return c;
    };
    let left = side('left'), right = side('right');
    if (oneway && t.cycleway === 'opposite_lane' && !left) left = 'l';
    if (kind !== 'cycleway' && (left || right)) record.cyc = `${left || '-'}${right || '-'}`;
  }
  if (zone) zoneWays.push(record);
  roads.push(record);
  noteLevel(e, pts, kept, record, bridge, tunnel);
  if (DRIVABLE.has(kind) && !tunnel && t.access !== 'no' && t.motor_vehicle !== 'no' && e.nodes && e.nodes.length === e.geometry.length) {
    drivable.push({ name: t.name || '', width: r1(width), lanes, dir: !oneway ? 0 : t.oneway === '-1' ? -1 : 1, nodes: e.nodes, pts, bridge });
  }
}

// Where the tram runs across a pedestrian zone: rails = [lo, hi], the signed offsets of its tracks from the way's axis
// (positive to the left of its drawing direction), so walkers keep out of the tram's path
{
  const tracks = [];
  for (const r of railways) if (r.kind === 'tram' && !r.tunnel) for (let i = 0; i + 3 < r.pts.length; i += 2) tracks.push(r.pts.slice(i, i + 4));
  for (const r of zoneWays) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const [ax, az, bx, bz] = r.pts.slice(i, i + 4), len = Math.hypot(bx - ax, bz - az);
      if (len < 1) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      for (const [px, pz, qx, qz] of tracks) {
        for (const [x, z] of [[px, pz], [qx, qz], [(px + qx) / 2, (pz + qz) / 2]]) {
          const s = (x - ax) * ux + (z - az) * uz;
          if (s < 0 || s > len) continue;
          const off = -(x - ax) * uz + (z - az) * ux;
          if (Math.abs(off) > r.width / 2) continue;
          lo = Math.min(lo, off); hi = Math.max(hi, off);
        }
      }
    }
    if (lo <= hi) r.rails = [r1(lo), r1(hi)];
  }
  log(`pedestrian zones: ${zoneWays.length} ways of the Rues-Basses, ${zoneWays.filter((r) => r.rails).length} with tram tracks`);
}

// --- Street centreline graph: ways cut at every node shared by two ways (and at their ends) ----------------------------
// links: [node a, node b, name index, width, lanes, direction (1: a -> b, -1: b -> a, 0: both), inner shape points [x, z, ...],
//         1 when on a bridge]
const roadGraph = (() => {
  const uses = new Map();
  for (const w of drivable) for (const id of new Set(w.nodes)) uses.set(id, (uses.get(id) || 0) + 1);
  const ids = new Map();
  const nodes = [];
  const names = [];
  const nameIds = new Map();
  const nodeOf = (id, p) => { if (!ids.has(id)) { ids.set(id, nodes.length / 2); nodes.push(r1(p[0]), r1(p[1])); } return ids.get(id); };
  const nameOf = (n) => { if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); } return nameIds.get(n); };
  const links = [];
  for (const w of drivable) {
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const last = i === w.nodes.length - 1;
      if (!last && uses.get(w.nodes[i]) < 2 && w.nodes[i] !== w.nodes[0]) continue;
      if (w.nodes[i] === w.nodes[start]) { start = i; continue; }
      const seg = w.pts.slice(start, i + 1);
      const inner = rdp(seg, 0.4).slice(1, -1).flatMap(([x, z]) => [r1(x), r1(z)]);
      const link = [nodeOf(w.nodes[start], seg[0]), nodeOf(w.nodes[i], seg[seg.length - 1]), nameOf(w.name), w.width, w.lanes, w.dir, inner];
      if (w.bridge) link.push(1); // on a bridge deck (heights: the matching roads[].ys)
      links.push(link);
      start = i;
    }
  }
  return { nodes, links, names };
})();

// --- Water, parks & woods ------------------------------------------------------------------------------------------------
const water = [];
const parks = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node') continue;
  const isWater = t.natural === 'water' || /^(riverbank|dock)$/.test(t.waterway || '');
  const isWood = /^(wood|scrub)$/.test(t.natural || '') || t.landuse === 'forest';
  const isPark = isWood || /^(park|garden|playground|pitch)$/.test(t.leisure || '') ||
    /^(grass|recreation_ground|cemetery|village_green|meadow)$/.test(t.landuse || '') || t.natural === 'grassland';
  if (!isWater && !isPark) continue;
  if (t.location === 'underground' || t.tunnel === 'culvert') continue;
  for (const p of polygons(e)) {
    const ring = clipToFrame(cleanRing(p.ring, 0.6));
    if (ring.length < 3 || Math.abs(ringArea(ring)) < 20) continue;
    const holes = p.holes.map((h) => clipToFrame(cleanRing(h, 0.6))).filter((h) => h.length >= 3).map(flat);
    if (isWater) water.push({ id: `water${water.length}`, ring: flat(ring), holes, name: t.name || '', kind: t.water || t.waterway || 'water' });
    else parks.push({ id: `${e.type[0]}${e.id}`, ring: flat(ring), holes, name: t.name || '', kind: isWood ? 'wood' : t.leisure || t.landuse || t.natural });
  }
}

const terrainPatches = []; // bridgeheads where the terrain must rise to the surveyed road ({ x, z, h, r })
// --- Bridge decks ---------------------------------------------------------------------------------------------------------
// The terrain model is bare earth: under a bridge it holds the river or the tracks below. Nodes shared with a way at
// ground level are anchored to the terrain; the spans take the surface model sampled at their nodes
// (tools/fetch-bridge-decks.mjs, swissSURFACE3D); nodes without a (credible) sample are solved on the graph of bridge
// ways, interpolated harmonically (inverse-length weights), i.e. linearly along each chain.
{
  const DECKS = path.join(CACHE, 'bridge_decks.json');
  const surveyed = fs.existsSync(DECKS) ? JSON.parse(fs.readFileSync(DECKS, 'utf8')).decks : {};
  const pos = new Map(), adj = new Map(), majorDeck = new Set();
  // Under a tree the surface model reads the crown, not the deck (the Schanzengrabenpromenade, a boardwalk along the
  // canal, measured 11-19 m up): samples more than 3 m up within a municipal tree's crown are ignored.
  const TREE_CELL = 32, crowns = new Map();
  const treeFile = path.join(CACHE, 'geneva_trees.json');
  for (const t of fs.existsSync(treeFile) ? JSON.parse(fs.readFileSync(treeFile, 'utf8')).trees : []) {
    if (!t.crown) continue;
    const { x, z } = lv95ToWorld(t.E, t.N), k = `${Math.floor(x / TREE_CELL)}/${Math.floor(z / TREE_CELL)}`;
    if (!crowns.has(k)) crowns.set(k, []);
    crowns.get(k).push({ x, z, r: t.crown / 2 });
  }
  const underCrown = ([x, z]) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const t of crowns.get(`${Math.floor(x / TREE_CELL) + i}/${Math.floor(z / TREE_CELL) + j}`) || []) if (Math.hypot(t.x - x, t.z - z) < t.r) return true;
    }
    return false;
  };
  const link = (a, b, w) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push([b, w]); };
  for (const way of deckWays) {
    way.nodes.forEach((id, i) => { pos.set(id, way.pts[i]); if (!way.minor) majorDeck.add(id); });
    for (let i = 1; i < way.nodes.length; i++) {
      const w = 1 / Math.max(0.5, Math.hypot(way.pts[i][0] - way.pts[i - 1][0], way.pts[i][1] - way.pts[i - 1][1]));
      link(way.nodes[i - 1], way.nodes[i], w); link(way.nodes[i], way.nodes[i - 1], w);
    }
  }
  const ground = (id) => gridHeight(TERRAIN, pos.get(id)[0], pos.get(id)[1]);
  const pip = (ring, x, z) => { let inside = false; for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) { if ((ring[i + 1] > z) !== (ring[j + 1] > z) && x < ((ring[j] - ring[i]) * (z - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) inside = !inside; } return inside; };
  const inWater = ([x, z]) => water.some((w) => pip(w.ring, x, z) && !w.holes.some((h) => pip(h, x, z)));
  const h = new Map(), anchored = new Set();
  let measured = 0, canopy = 0;
  for (const [id] of adj) if (Number.isFinite(surveyed[id]) && surveyed[id] - FRAME.H0 - ground(id) > 3 && underCrown(pos.get(id))) { delete surveyed[id]; canopy++; }
  for (const [id, edges] of adj) {
    // Abutments: where a bridge meets a way at ground level (on land: tram tracks mapped across a bridge without the
    // bridge tag don't count), and the loose ends of bridge chains. They sit at ground level, except that
    // swissALTI3D removes bridges and interpolates the ground beneath them, which also pulls the bridgeheads down
    // towards the river: there the survey, when credible, sets the abutment, and the terrain is raised to meet it.
    const loose = new Set(edges.map(([b]) => b)).size < 2;
    const onLand = !inWater(pos.get(id));
    const junction = onLand && (groundNodes.has(id) || (!majorDeck.has(id) && minorGroundNodes.has(id)));
    if (junction || loose) {
      anchored.add(id);
      const g = ground(id), survey = surveyed[id] - FRAME.H0;
      if (survey - g > 0.4 && survey - g < 4) {
        h.set(id, survey);
        if (onLand) terrainPatches.push({ x: r1(pos.get(id)[0]), z: r1(pos.get(id)[1]), h: r2(survey), r: 15 });
      } else h.set(id, g);
    } else if (Number.isFinite(surveyed[id])) { anchored.add(id); h.set(id, Math.max(surveyed[id] - FRAME.H0, ground(id))); measured++; }
  }
  // Components without any anchor (e.g. a footbridge mapped on its own) start from their highest ground point
  const seen = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = [], stack = [start];
    seen.add(start);
    while (stack.length) { const id = stack.pop(); comp.push(id); for (const [b] of adj.get(id)) if (!seen.has(b)) { seen.add(b); stack.push(b); } }
    const top = Math.max(...comp.map(ground));
    for (const id of comp) if (!h.has(id)) h.set(id, comp.some((c) => anchored.has(c)) ? ground(id) : top);
  }
  const solve = () => {
    for (let iter = 0; iter < 4000; iter++) {
      let change = 0;
      for (const [id, edges] of adj) {
        if (anchored.has(id)) continue;
        let sw = 0, sh = 0;
        for (const [b, w] of edges) { sw += w; sh += w * h.get(b); }
        const v = sh / sw;
        change = Math.max(change, Math.abs(v - h.get(id)));
        h.set(id, v);
      }
      if (change < 0.001) break;
    }
  };
  // Samples that disagree with their neighbours (a bus, a branch, a gap in the surface model) by more than a bridge's
  // possible gradient are dropped and re-solved from the rest.
  let rejected = 0;
  for (let pass = 0; pass < 3; pass++) {
    solve();
    for (const [id, edges] of adj) {
      if (!anchored.has(id) || !Number.isFinite(surveyed[id])) continue;
      let sw = 0, sh = 0, len = 0;
      for (const [b, w] of edges) { sw += w; sh += w * h.get(b); len += 1 / w; }
      if (Math.abs(h.get(id) - sh / sw) > 1.5 + 0.12 * (len / edges.length)) { anchored.delete(id); rejected++; }
    }
  }
  solve();
  // Sidewalks mapped as bridge ways of their own (footway=sidewalk) carry on the deck of the carriageway they run along.
  // Where they meet the sidewalk on the ground on top of a retaining wall, which the 2 m survey smears into a slope,
  // they are anchored far below it (the Lindenhofstrasse's eastern sidewalk: 3.7 m at its end, against a deck at
  // 10.6 m, a wall across the Uraniastrasse under it): their nodes take the carriageway's deck, where the surface model
  // agrees (a sidewalk beside a deck on another level, under a viaduct, keeps its own).
  const carriageways = [];
  for (const way of deckWays) if (!way.minor) for (let i = 1; i < way.nodes.length; i++) carriageways.push([way.nodes[i - 1], way.nodes[i]]);
  const deckAt = (id) => Math.max(h.get(id), ground(id));
  const carriagewayDeck = ([x, z], ux, uz) => {
    let best = Infinity, y = NaN;
    for (const [a, b] of carriageways) {
      const [ax, az] = pos.get(a), [bx, bz] = pos.get(b), dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
      if (L < 1 || Math.abs(ux * dz - uz * dx) > 0.26 * L) continue;
      const t = ((x - ax) * dx + (z - az) * dz) / (L * L);
      if (t < -0.2 || t > 1.2) continue;
      const tc = Math.max(0, Math.min(1, t)), d = Math.hypot(ax + tc * dx - x, az + tc * dz - z);
      if (d < 12 && d < best) { best = d; y = deckAt(a) + tc * (deckAt(b) - deckAt(a)); }
    }
    return y;
  };
  let sidewalks = 0;
  for (const way of deckWays) {
    if (!way.sidewalk) continue;
    let lifted = false;
    way.nodes.forEach((id, i) => {
      const j = i ? i - 1 : 1, [x, z] = way.pts[i], dx = x - way.pts[j][0], dz = z - way.pts[j][1], L = Math.hypot(dx, dz) || 1;
      const y = carriagewayDeck(way.pts[i], dx / L, dz / L);
      if (!(y - deckAt(id) > 1) || !(Math.abs(surveyed[id] - FRAME.H0 - y) < 1)) return;
      // The ends of the sidewalk lie on the smeared wall top: the ground rises to meet them over a few metres
      if ((i === 0 || i === way.nodes.length - 1) && anchored.has(id)) terrainPatches.push({ x: r1(x), z: r1(z), h: r2(y), r: 6 });
      h.set(id, y);
      lifted = true;
    });
    if (lifted) sidewalks++;
  }
  const smooth = h;
  for (const way of deckWays) {
    // Decks never dip below the terrain they cross; heights in the world frame (above FRAME.H0)
    way.record.ys = way.kept.map((i) => r2(Math.max(smooth.get(way.nodes[i]), gridHeight(TERRAIN, way.pts[i][0], way.pts[i][1]))));
  }
  log(`bridge decks: ${deckWays.length} ways, ${adj.size} nodes (${measured - rejected} surveyed, ${rejected} rejected samples, ${canopy} under trees), ${terrainPatches.length} bridgeheads raised, ${sidewalks} sidewalks onto their carriageway's deck`);
}

// --- Quarters (Quartiere, OSM admin_level 10) -----------------------------------------------------------------------------
const areas = [];
for (const e of readJson('osm_geneva_areas.json').elements) {
  const name = e.tags?.name;
  if (!name) continue;
  const polys = polygons(e).map((p) => ({ ring: flat(cleanRing(p.ring, 2)), holes: p.holes.map((h) => flat(cleanRing(h, 2))) }));
  if (polys.length) areas.push({ id: name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '_'), name, polygons: polys });
}

// --- Landmarks: footprints of named buildings (by OSM name, or by id when unnamed) ------------------------------------------------------------------------------
const LANDMARKS = {
  'Cathédrale Saint-Pierre': ['Cathédrale Saint-Pierre'],
  'Gare Cornavin': ['w301355984'], // the station building is unnamed (the named ways are its platform roofs)
  'Palais des Nations': ['Palais des Nations'],
  'Hôtel de Ville': ['Hôtel de Ville', 'Hôtel-de-Ville'],
  'Grand Théâtre': ['Grand Théâtre de Genève'],
  'Uni Bastions': ['Université de Genève - Uni Bastions (bâtiment principal)'],
  'Musée d’art et d’histoire': ['Musée d\'Art et d\'Histoire'],
  'Victoria Hall': ['Victoria Hall'],
  'Bâtiment des Forces Motrices': ['Bâtiment des Forces Motrices', 'BFM'],
  'Hôtel des Bergues': ['Four Seasons Hôtel des Bergues'],
  'Musée Ariana': ['Musée Ariana'],
  'Basilique Notre-Dame': ['Église Notre-Dame'],
  'Palais de Justice': ['Palais de Justice'],
  'Temple de la Madeleine': ['Temple de la Madeleine'],
  'Église russe': ['Église Russe'],
  'Temple de la Fusterie': ['Temple de la Fusterie'],
  'Uni Mail': ['Université de Genève - Uni Mail'],
  'Palais Wilson': ['Palais Wilson']
};
const landmarks = {};
for (const b of buildings) {
  const key = Object.keys(LANDMARKS).find((k) => LANDMARKS[k].includes(b.name) || LANDMARKS[k].includes(b.id));
  if (!key) continue;
  const pts = [];
  for (let i = 0; i < b.ring.length; i += 2) pts.push([b.ring[i], b.ring[i + 1]]);
  const bb = bbox(pts);
  const area = Math.abs(ringArea(pts));
  if (landmarks[key] && landmarks[key].area >= area) continue;
  landmarks[key] = { x: r1((bb.x0 + bb.x1) / 2), z: r1((bb.z0 + bb.z1) / 2), w: r1(bb.x1 - bb.x0), d: r1(bb.z1 - bb.z0), h: b.h, area: Math.round(area), ring: b.ring };
}

// --- Cantonal tree inventory (ICA, SITG) replaces the sparser OSM trees ----------------------------------------------------
// The inventory surveys each tree's total height and crown; when the height is missing it is estimated from the crown
// (broad urban limes, planes & chestnuts: roughly 1.3x the crown + trunk), else from the planting year.
const TREES = path.join(CACHE, 'geneva_trees.json');
const STREET = /^(Bords de voie|Trottoir\/Zone piétonnière|Place|Parking)$/;
if (fs.existsSync(TREES)) {
  const year = new Date().getFullYear();
  const { trees: city } = JSON.parse(fs.readFileSync(TREES, 'utf8'));
  trees = city.map((g) => {
    const { x, z } = lv95ToWorld(g.E, g.N);
    const h = g.height ? Math.min(40, Math.max(3, g.height)) : g.crown ? Math.min(30, 3 + g.crown * 1.3) : g.planted ? Math.min(24, 4 + (year - g.planted) * 0.4) : 10;
    return { x: r1(x), z: r1(z), h: r1(h), crown: g.crown ?? null, street: STREET.test(g.situation || ''), g: phenoClass(g.genus) };
  }).filter((t) => inFrame(t.x, t.z));
  log(`using ${trees.length} trees from the cantonal inventory`);
}

// --- Traffic signals as surveyed (SITG, Office cantonal des transports: tools/fetch-sitg-roadway.mjs) -------------------
// The survey draws each signal head as a plan symbol a few metres off the pole that carries it (1.4 m to 10 m, half
// within 3.6 m), turned by its bearing (degrees clockwise from grid north) in the direction of the traffic it controls.
// Each head goes on the nearest surveyed pole within POLE_REACH (or a pole of its own), facing back up that traffic.
// signalPoles: [x, z, arm x, arm z] per pole (the arm of a cantilever pole reaching over the carriageway, else 0, 0);
// signalHeads: [pole index, facing (radians, the yaw of a +z face), kind] with kind 0 vehicle, 1 pedestrian,
// 2 cyclist, 3 flashing amber.
const signalPoles = [], signalHeads = [];
{
  const read = (name) => { const f = path.join(CACHE, `sitg_${name}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).features : null; };
  const boxes = read('otc_sl_equipement_boitefeux'), masts = read('otc_sl_reseau_mat');
  if (boxes && masts) {
    const POLE_REACH = 6;
    const kindOf = (t) => (/^3x(100|200|300)/.test(t) ? 0 : /^piéton/.test(t) ? 1 : /^vélo/.test(t) ? 2 : /^clign(-droite|-gauche|-supplémentaire)?$/.test(t) ? 3 : -1);
    const poles = masts.map((m) => ({ ...lv95ToWorld(m.E, m.N), cantilever: /Porte a faux/.test(m.TYPE_DE_MAT || ''), heads: [] }));
    const cell = (x, z) => `${Math.floor(x / 8)}/${Math.floor(z / 8)}`;
    const grid = new Map();
    const index = (p) => { const k = cell(p.x, p.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); };
    poles.forEach(index);
    const nearestPole = (x, z, reach) => {
      let best = null, bd = reach;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const p of grid.get(`${Math.floor(x / 8) + i}/${Math.floor(z / 8) + j}`) || []) {
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < bd) { bd = d; best = p; }
        }
      }
      return best;
    };
    for (const b of boxes) {
      const kind = kindOf(b.TYPE_FEUX || '');
      if (kind < 0 || b.ANGLE == null) continue;
      const { x, z } = lv95ToWorld(b.E, b.N);
      if (!inFrame(x, z)) continue;
      let pole = nearestPole(x, z, POLE_REACH);
      if (!pole) { pole = nearestPole(x, z, 0.8) || { x, z, cantilever: false, heads: [] }; if (!pole.heads.length) { poles.push(pole); index(pole); } }
      // bearing a clockwise from north: the traffic flows along (sin a, cos a) east-north, i.e. (sin a, -cos a) in x-z;
      // the head faces the other way, -flow, which a yaw of -a turns +z onto
      const a = (b.ANGLE * Math.PI) / 180;
      pole.heads.push([r2(Math.atan2(-Math.sin(a), Math.cos(a))), kind]);
    }
    const streets = []; // [ax, az, bx, bz, half width] of each drivable way's segments
    for (const r of roads) if (DRIVABLE.has(r.kind) && !r.tunnel) for (let i = 0; i + 3 < r.pts.length; i += 2) streets.push([...r.pts.slice(i, i + 4), (r.width || 6) / 2]);
    // How far (x, z) lies inside the modelled carriageways, and the way out across the deepest one
    const KERB = 0.6; // m from the carriageway's edge, on the footway
    const intrusion = (x, z) => {
      let worst = null;
      for (const [ax, az, bx, bz, h] of streets) {
        if (Math.min(ax, bx) > x + h || Math.max(ax, bx) < x - h || Math.min(az, bz) > z + h || Math.max(az, bz) < z - h) continue;
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        if (l2 < 0.01) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
        const depth = h + KERB - d;
        if (depth > 0.01 && (!worst || depth > worst.depth)) {
          // out across the way, on the side the point already is (either side when on its axis)
          const l = Math.sqrt(l2), nx = -dz / l, nz = dx / l, side = (x - px) * nx + (z - pz) * nz;
          worst = { depth, px, pz, nx, nz, side, h };
        }
      }
      return worst;
    };
    // The survey's plan symbols stand off their poles, often over the road, and the OSM carriageways cover some of
    // the islands that carry poles: a pole on the modelled carriageway is moved out to its kerb (the nearer side
    // that is clear of every carriageway, within MAX_SHIFT m)
    const MAX_SHIFT = 9;
    let moved = 0, stuck = 0;
    // With the cadastre's carriageways (data/geneva-roadway.bin), a pole is on the road only where they say so (the
    // islands are not), and moves to the nearest point a kerb's width clear of them
    const surveyed = ROADWAY && ((x, z) => [[0, 0], [KERB, 0], [-KERB, 0], [0, KERB], [0, -KERB]].some(([dx, dz]) => ROADWAY.onCarriageway(x + dx, z + dz)));
    for (const p of poles) {
      p.ox = p.x; p.oz = p.z;
      if (surveyed) {
        if (!p.heads.length || !ROADWAY.onCarriageway(p.x, p.z)) continue;
        let best = null;
        for (let r = 0.5; r <= MAX_SHIFT && !best; r += 0.25) {
          for (let k = 0; k < 32; k++) {
            const a = (k / 32) * Math.PI * 2, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
            if (!surveyed(x, z)) { best = { x, z }; break; }
          }
        }
        if (best) { p.x = best.x; p.z = best.z; moved++; } else stuck++;
        continue;
      }
      if (!p.heads.length || !intrusion(p.x, p.z)) continue;
      let done = false;
      for (let step = 0; step < 4 && !done; step++) {
        const w = intrusion(p.x, p.z);
        if (!w) { done = true; break; }
        const options = (Math.abs(w.side) > 0.05 ? [Math.sign(w.side), -Math.sign(w.side)] : [1, -1])
          .map((s) => ({ x: w.px + w.nx * s * (w.h + KERB), z: w.pz + w.nz * s * (w.h + KERB) }))
          .filter((c) => Math.hypot(c.x - p.ox, c.z - p.oz) <= MAX_SHIFT)
          .sort((a, b) => (intrusion(a.x, a.z) ? 1 : 0) - (intrusion(b.x, b.z) ? 1 : 0) || Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
        if (!options.length) break;
        p.x = options[0].x; p.z = options[0].z;
      }
      if (done || !intrusion(p.x, p.z)) moved++;
      else { stuck++; p.x = p.ox; p.z = p.oz; }
    }
    // Cantilever arms reach from the pole across the traffic its vehicle heads face, toward the carriageway's axis
    const axisNear = (x, z) => {
      let best = null, bd = 25;
      for (const [ax, az, bx, bz] of streets) {
        if (Math.min(ax, bx) > x + bd || Math.max(ax, bx) < x - bd || Math.min(az, bz) > z + bd || Math.max(az, bz) < z - bd) continue;
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        if (l2 < 0.01) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
        if (d < bd) { bd = d; best = { x: px, z: pz, d }; }
      }
      return best;
    };
    for (const p of poles) {
      if (!p.heads.length) continue;
      let arm = [0, 0];
      const vehicle = p.heads.find(([, kind]) => kind === 0);
      const axis = p.cantilever && vehicle && axisNear(p.x, p.z);
      if (axis && axis.d > 2) {
        // across the face direction, on the side of the axis, as far as the axis less a lane's half
        const cx = Math.cos(vehicle[0]), cz = -Math.sin(vehicle[0]);
        const side = Math.sign((axis.x - p.x) * cx + (axis.z - p.z) * cz) || 1;
        const reach = Math.min(6, Math.max(2.5, Math.abs((axis.x - p.x) * cx + (axis.z - p.z) * cz) - 1.5));
        arm = [r2(cx * side * reach), r2(cz * side * reach)];
      }
      const i = signalPoles.length / 4;
      signalPoles.push(r2(p.x), r2(p.z), arm[0], arm[1]);
      for (const [yaw, kind] of p.heads) signalHeads.push(i, yaw, kind);
    }
    log(`signals (SITG): ${signalPoles.length / 4} poles, ${signalHeads.length / 3} heads (${['vehicle', 'pedestrian', 'cyclist', 'flashing'].map((label, k) => `${signalHeads.filter((v, j) => j % 3 === 2 && v === k).length} ${label}`).join(', ')}), ${poles.filter((p) => p.heads.length && p.cantilever).length} cantilevers; ${moved} moved off the carriageway to its kerb, ${stuck} left`);
  }
}

const data = {
  meta: {
    name: FRAME.name, city: 'Genève',
    bounds: WORLD_BOUNDS,
    lv95: FRAME.lv95,
    frame: `x = LV95 east - ${FRAME.E0}, z = ${FRAME.N0} - LV95 north, metres; y = height - ${FRAME.H0} m a.s.l.`,
    coordinateSystem: 'x east, z south, metres (Swiss LV95 grid)',
    origin: { E: FRAME.E0, N: FRAME.N0, H: FRAME.H0 },
    sources: [
      { name: 'OpenStreetMap contributors', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors' },
      { name: 'État de Genève, OCAN: Inventaire cantonal des arbres isolés (SITG)', license: 'Open data SITG', url: 'https://ckan.opendata.swiss/dataset/inventaire-cantonal-des-arbres-isoles' },
      { name: 'État de Genève, OCT: signalisation lumineuse, boîtes à feux & mâts (SITG)', license: 'Open data SITG', url: 'https://ckan.opendata.swiss/dataset/signalisation-lumineuse-boites-a-feux1' },
      { name: 'swisstopo swissALTI3D (terrain, data/geneva-terrain.bin)', license: 'OGD swisstopo', attribution: '© swisstopo' },
      { name: 'swisstopo swissBUILDINGS3D 3.0 (buildings, streamed)', license: 'OGD swisstopo', attribution: '© swisstopo' }
    ],
    areas,
    counts: { buildings: buildings.length, roads: roads.length, water: water.length, parks: parks.length, railways: railways.length, trees: trees.length, signals: signals.length, fountains: fountains.length, tramStops: tramStops.length }
  },
  buildings, roads, water, parks, railways, trees, signals, fountains, tramStops, landmarks, roadGraph, terrainPatches, signalPoles, signalHeads
};
fs.writeFileSync(OUT, `// js/geneva-geodata.js — GENERATED by tools/build-geneva-geodata.mjs, do not edit by hand.\n// Geneva city centre in the LV95 world frame of js/geneva-frame.js. © OpenStreetMap contributors (ODbL), SITG (État de Genève), swisstopo.\nexport const GENEVA_DATA = ${JSON.stringify(data)};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`, JSON.stringify(data.meta.counts));
log('landmarks:', Object.keys(landmarks).join(', '), '| missing:', Object.keys(LANDMARKS).filter((k) => !landmarks[k]).join(', '));
log('areas:', areas.map((a) => a.name).join(', '));
