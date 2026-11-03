import * as THREE from 'three/webgpu';
import { attribute, float, mix, mx_noise_float, normalGeometry, positionGeometry, positionWorld, smoothstep, step, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GENEVA_DATA } from './geneva-geodata.js';
import { drapeOverlay, surfaceHeight, ROAD_TOP } from './terrain.js';
import { vehicleContact, resolveVehicleContact, sweptVehicleContact } from './vehicle-physics.js';
import { loadTransit, LINE_COLOURS } from './transit-data.js';
import { simClock } from './sim-clock.js';

// Geneva's tracks and trams (OSM railway=tram / rail in js/geneva-geodata.js):
//  - the rails of the TPG's metre-gauge tram network in the streets, and the CFF's standard-gauge lines on their
//    ballast (Cornavin, the line to Lausanne, the Léman Express), laid on the terrain or the bridge decks;
//  - white and orange articulated trams (five ~7 m sections, each following the track, so a tram bends through the
//    curves) on the TPG's timetable (js/transit-data.js, the city's clock js/sim-clock.js): each trip of lines 12, 14,
//    15, 17 and 18 drives in from the edge of the network, serves its stops in the frame, waits there for its departure
//    time and drives out; the line's colour on the front and rear displays. On the right-hand track of double lines
//    (the direction of a track is inferred from the parallel one), keeping their distance and braking for whatever
//    stands on the track ahead;
//  - every section is a solid body: the player bounces off them, and the traffic (traffic.js) brakes behind them.

const TRAM_SECTIONS = 5, SECTION = 7.3, GAP = 0.25, PITCH = SECTION + GAP; // ~37 m, like a Flexity
const TRAM_COUNT = 60; // running at once at most
const MAX_SPEED = 13, ACCEL = 1.1, BRAKE = 1.4, HEADWAY = 18;
const HALF_WIDTH = 1.2, TRAM_MASS = 4e4 / TRAM_SECTIONS, CLEARANCE = 1.7, STOP_SHORT = 4;

// --- Track network ---------------------------------------------------------------------------------------------------------
function polyline(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], z: flat[i + 1] });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum[cum.length - 1] };
}

// Position and unit direction at distance s along a way
function pointAt(way, s, out) {
  const { pts, cum } = way;
  s = Math.max(0, Math.min(way.len, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1] || 1e-6, t = (s - cum[i - 1]) / seg;
  out.x = a.x + (b.x - a.x) * t; out.z = a.z + (b.z - a.z) * t;
  out.dx = (b.x - a.x) / seg; out.dz = (b.z - a.z) / seg;
  return out;
}

function buildNetwork() {
  const ways = GENEVA_DATA.railways.filter((r) => r.kind === 'tram' && !r.tunnel && r.pts.length >= 4).map((r) => ({ ...polyline(r.pts), id: r.id, bridge: r.bridge, stops: [], dirs: 0 }));
  // Ends meeting at the same OSM node share their (rounded) coordinates
  const key = (p) => `${Math.round(p.x * 2)},${Math.round(p.z * 2)}`;
  const nodes = new Map();
  for (const w of ways) {
    for (const [end, p] of [[0, w.pts[0]], [1, w.pts[w.pts.length - 1]]]) {
      const k = key(p);
      if (!nodes.has(k)) nodes.set(k, []);
      nodes.get(k).push({ way: w, end });
    }
    w.ends = [key(w.pts[0]), key(w.pts[w.pts.length - 1])];
  }
  // Right-hand running: a track whose parallel twin lies on its left is run in its drawing direction (dirs = 1),
  // with the twin on its right against it (-1); single track both ways (0)
  const CELL = 16, grid = new Map();
  ways.forEach((w) => w.pts.forEach((p, i) => {
    if (!i) return;
    const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ w, i });
  }));
  const probe = {};
  for (const w of ways) {
    let left = 0, right = 0;
    for (let f = 0.2; f < 0.9; f += 0.2) {
      const m = pointAt(w, w.len * f, probe), lx = m.dz, lz = -m.dx;
      for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
        for (const { w: o, i } of grid.get(`${Math.floor(m.x / CELL) + gx},${Math.floor(m.z / CELL) + gz}`) || []) {
          if (o === w) continue;
          const a = o.pts[i - 1], b = o.pts[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1e-9;
          if (Math.abs((ex * m.dx + ez * m.dz) / Math.sqrt(L2)) < 0.9) continue; // not parallel
          const t = Math.max(0, Math.min(1, ((m.x - a.x) * ex + (m.z - a.z) * ez) / L2));
          const px = a.x + ex * t - m.x, pz = a.z + ez * t - m.z, d = Math.hypot(px, pz);
          if (d < 2 || d > 5) continue;
          if (px * lx + pz * lz > 0) left++; else right++;
        }
      }
    }
    w.dirs = left > right ? 1 : right > left ? -1 : 0;
  }
  // Tram stops within 4 m of a track, as distances along it
  for (const stop of GENEVA_DATA.tramStops) {
    for (const w of ways) {
      for (let i = 1; i < w.pts.length; i++) {
        const a = w.pts[i - 1], b = w.pts[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1e-9;
        const t = Math.max(0, Math.min(1, ((stop.x - a.x) * ex + (stop.z - a.z) * ez) / L2));
        if (Math.hypot(a.x + ex * t - stop.x, a.z + ez * t - stop.z) < 4) { w.stops.push(w.cum[i - 1] + Math.sqrt(L2) * t); break; }
      }
    }
  }
  for (const w of ways) w.stops.sort((p, q) => p - q);
  return { ways, nodes };
}

// --- Track geometry ----------------------------------------------------------------------------------------------------------
function strips(list, offsets, width, y) {
  const geometries = [];
  for (const r of list) {
    const deck = !!r.bridge;
    const positions = [];
    for (let i = 2; i < r.pts.length; i += 2) {
      const ax = r.pts[i - 2], az = r.pts[i - 1], bx = r.pts[i], bz = r.pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const nx = -(bz - az) / L, nz = (bx - ax) / L;
      for (const o of offsets) {
        const p = (s, side) => [(s ? bx : ax) + nx * (o + side * width / 2), y, (s ? bz : az) + nz * (o + side * width / 2)];
        positions.push(...p(0, -1), ...p(1, -1), ...p(1, 1), ...p(0, -1), ...p(1, 1), ...p(0, 1));
      }
    }
    if (!positions.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(positions.length).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
    geometries.push(drapeOverlay(g, { deck, maxEdge: 4 }));
    g.dispose();
  }
  return geometries.length ? mergeGeometries(geometries, false) : null;
}

function buildTracks(group) {
  const steel = new THREE.MeshStandardNodeMaterial({ color: 0x9a9da2, roughness: 0.32, metalness: 0.85 });
  const ballast = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  ballast.colorNode = mix(vec3(0.09, 0.08, 0.07), vec3(0.16, 0.14, 0.12), mx_noise_float(positionWorld.xz.mul(3.1)).mul(0.5).add(0.5));
  const tram = GENEVA_DATA.railways.filter((r) => r.kind === 'tram' && !r.tunnel);
  const rail = GENEVA_DATA.railways.filter((r) => /^(rail|narrow_gauge)$/.test(r.kind) && !r.tunnel);
  const parts = [
    [strips(rail, [0], 3.2, 0.03), ballast],
    [strips(rail, [-0.7175, 0.7175], 0.075, 0.1), steel],
    [strips(tram, [-0.5, 0.5], 0.075, 0.075), steel] // metre gauge, flush with the road
  ];
  for (const [geometry, material] of parts) {
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

// --- Trams -------------------------------------------------------------------------------------------------------------------
// TPG livery: white body, orange skirt and stripe, dark glazing, grey roof (colours in linear space)
function createTramMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.1 });
  const y = positionGeometry.y, side = float(1).sub(step(0.7, normalGeometry.y.abs()));
  const glazing = smoothstep(1.28, 1.32, y).mul(smoothstep(2.62, 2.58, y)).mul(side);
  const skirt = smoothstep(0.98, 0.94, y);
  const stripe = smoothstep(2.78, 2.8, y).mul(smoothstep(2.95, 2.93, y)).mul(side);
  const roof = step(0.7, normalGeometry.y);
  const white = vec3(0.82, 0.83, 0.84), orange = vec3(0.92, 0.22, 0.01);
  const body = mix(mix(white, orange, skirt.add(stripe).min(1)), vec3(0.015, 0.02, 0.03), glazing);
  // Line display: a panel above the windscreen of the front and rear sections, lit in the line's colour
  const line = attribute('aLine', 'vec4');
  const endFace = step(0.7, normalGeometry.z.mul(line.w));
  const display = endFace.mul(smoothstep(2.62, 2.66, y)).mul(smoothstep(2.98, 2.94, y)).mul(smoothstep(0.75, 0.7, positionGeometry.x.abs()));
  m.colorNode = mix(mix(body, vec3(0.25, 0.26, 0.27), roof), line.xyz, display);
  m.emissiveNode = line.xyz.mul(display).mul(1.6);
  m.roughnessNode = mix(float(0.4), float(0.08), glazing);
  m.metalnessNode = mix(float(0.1), float(0.6), glazing);
  return m;
}

function tramSectionGeometry() {
  const g = new THREE.BoxGeometry(2.4, 3.15, SECTION, 1, 4, 1);
  g.translate(0, 0.3 + 3.15 / 2, 0); // low floor, 0.3 m above the rails
  return g;
}

export function buildTrams(scene) {
  const group = new THREE.Group();
  group.name = 'GenevaTrams';
  group.userData.terrain = 'absolute';
  buildTracks(group);
  const { ways, nodes } = buildNetwork();
  const geometry = tramSectionGeometry();
  // Per section: line colour (rgb, linear) and which end shows the line's display (w: 1 front, -1 rear, 0 none)
  const lineAttr = new THREE.InstancedBufferAttribute(new Float32Array(TRAM_COUNT * TRAM_SECTIONS * 4), 4);
  lineAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aLine', lineAttr);
  const sections = new THREE.InstancedMesh(geometry, createTramMaterial(), TRAM_COUNT * TRAM_SECTIONS);
  sections.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sections.castShadow = sections.receiveShadow = true;
  sections.frustumCulled = false;
  sections.count = 0;
  group.add(sections);
  scene.add(group);

  // --- Routes: the tracks between a trip's stops ----------------------------------------------------------------------------
  // Continuations of (way, end) heading out of its node, straightest first; `reverse` walks against the running
  // direction (to find where a tram came from)
  function continuations(way, end, reverse = false) {
    const here = pointAt(way, end ? way.len : 0, {});
    const hx = end ? here.dx : -here.dx, hz = end ? here.dz : -here.dz;
    const options = [];
    for (const c of nodes.get(way.ends[end]) || []) {
      if (c.way === way) continue;
      const dir = c.end === 0 ? 1 : -1;
      if (c.way.dirs && c.way.dirs !== (reverse ? -dir : dir)) continue;
      const p = pointAt(c.way, c.end ? c.way.len : 0, {});
      const cos = hx * p.dx * dir + hz * p.dz * dir;
      if (cos > 0.5) options.push({ way: c.way, dir, cos });
    }
    return options.sort((a, b) => b.cos - a.cos);
  }
  // Track positions a stop's platform may stand by
  const candidateCache = new Map();
  function candidates(stopIndex) {
    if (candidateCache.has(stopIndex)) return candidateCache.get(stopIndex);
    const [, x, z] = transit.stops[stopIndex];
    const list = [];
    for (const w of ways) {
      let best = null;
      for (let i = 1; i < w.pts.length; i++) {
        const a = w.pts[i - 1], b = w.pts[i], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / L2));
        const d = Math.hypot(a.x + ex * t - x, a.z + ez * t - z);
        if (d < 18 && (!best || d < best.d)) best = { way: w, s: w.cum[i - 1] + Math.sqrt(L2) * t, d };
      }
      if (best) list.push(best);
    }
    list.sort((a, b) => a.d - b.d);
    candidateCache.set(stopIndex, list.slice(0, 6));
    return candidateCache.get(stopIndex);
  }
  // Shortest run over the tracks from stop A to stop B (Dijkstra over (way, direction)): [{ way, dir, from, to }]
  function runBetween(A, B, startDir = null) {
    let best = null;
    const targets = candidates(B);
    for (const a of candidates(A)) {
      for (const dir of a.way.dirs ? [a.way.dirs] : [1, -1]) {
        if (startDir && (startDir.way !== a.way || startDir.dir !== dir)) continue;
        const heap = [{ cost: a.d * 3, way: a.way, dir, from: a.s, path: [] }];
        const seen = new Set();
        while (heap.length) {
          heap.sort((p, q) => p.cost - q.cost);
          const cur = heap.shift();
          if (best && cur.cost >= best.cost) break;
          // B on this way, ahead?
          for (const b of targets) {
            if (b.way !== cur.way || (cur.way.dirs && cur.way.dirs !== cur.dir)) continue;
            const run = (b.s - cur.from) * cur.dir;
            if (run < 0.5) continue;
            const cost = cur.cost + run + b.d * 3;
            if (!best || cost < best.cost) best = { cost, path: [...cur.path, { way: cur.way, dir: cur.dir, from: cur.from, to: b.s }] };
          }
          const key = `${cur.way.id}|${cur.dir}`;
          if (seen.has(key) && cur.path.length) continue;
          seen.add(key);
          const end = cur.dir > 0 ? 1 : 0;
          const run = cur.dir > 0 ? cur.way.len - cur.from : cur.from;
          if (cur.cost + run > 4000) continue;
          for (const o of continuations(cur.way, end)) {
            heap.push({ cost: cur.cost + run, way: o.way, dir: o.dir, from: o.dir > 0 ? 0 : o.way.len, path: [...cur.path, { way: cur.way, dir: cur.dir, from: cur.from, to: cur.dir > 0 ? cur.way.len : 0 }] });
          }
        }
      }
    }
    return best && best.path;
  }
  // Straightest run on from (way, dir, s) to a dead end (the frame's edge, a depot) or `max` metres
  function runOn(way, dir, s, max, reverse = false) {
    const legs = [];
    let total = 0;
    const visited = new Set();
    for (;;) {
      const to = dir > 0 ? way.len : 0;
      legs.push({ way, dir, from: s, to });
      total += Math.abs(to - s);
      visited.add(way);
      if (total > max) break;
      const next = continuations(way, dir > 0 ? 1 : 0, reverse).find((o) => !visited.has(o.way));
      if (!next) break;
      way = next.way; dir = next.dir; s = dir > 0 ? 0 : way.len;
    }
    return legs;
  }
  function legsToRoute(legs) {
    const flat = [];
    const add = (p) => { const l = flat[flat.length - 1]; if (!l || Math.hypot(l.x - p.x, l.z - p.z) > 0.05) flat.push(p); };
    const cumAt = [];
    for (const { way, dir, from, to } of legs) {
      cumAt.push(flat.length);
      add(pointAt(way, from, {}));
      const idx = way.cum.map((c, i) => i).filter((i) => (way.cum[i] - from) * dir > 0 && (to - way.cum[i]) * dir > 0);
      if (dir < 0) idx.reverse();
      for (const i of idx) add({ x: way.pts[i].x, z: way.pts[i].z });
      add(pointAt(way, to, {}));
    }
    const route = polyline(flat.flatMap((p) => [p.x, p.z]));
    return route;
  }
  const legLength = (legs) => legs.reduce((a, l) => a + Math.abs(l.to - l.from), 0);

  // A trip's route: the run in from the frame's edge, its stops in the frame, the run out; null when its stops are
  // not on the tracks (a trip around the frame's corner)
  const routeCache = new Map();
  function routeFor(trip) {
    const flat = trip[3];
    const stopsIdx = [], times = [];
    for (let i = 0; i < flat.length; i += 3) {
      if (!candidates(flat[i]).length) continue;
      stopsIdx.push(flat[i]); times.push([flat[i + 1], Math.max(flat[i + 2], flat[i + 1] + 20)]);
    }
    if (stopsIdx.length < 2) return null;
    const key = stopsIdx.join(',');
    let r = routeCache.get(key);
    if (r === undefined) {
      r = null;
      const legs = [];
      const stopAt = [];
      let ok = true;
      for (let i = 1; i < stopsIdx.length && ok; i++) {
        const prev = legs[legs.length - 1];
        const run = (prev && runBetween(stopsIdx[i - 1], stopsIdx[i], { way: prev.way, dir: prev.dir })) || runBetween(stopsIdx[i - 1], stopsIdx[i]);
        if (!run) { ok = i > 1; stopsIdx.length = i; break; }
        if (!legs.length) stopAt.push(0);
        // join the run to the previous one: a run starting where the last ended continues its leg
        legs.push(...run);
        stopAt.push(legLength(legs));
      }
      if (legs.length) {
        const first = legs[0], last = legs[legs.length - 1];
        // the run in: backwards from the first stop to the edge of the network
        const back = runOn(first.way, -first.dir, first.from, 1500, true);
        const inLegs = back.reverse().map((l) => ({ way: l.way, dir: -l.dir, from: l.to, to: l.from }));
        const lead = legLength(inLegs);
        const out = runOn(last.way, last.dir, last.to, 1500);
        const all = [...inLegs, ...legs, ...out];
        r = { route: legsToRoute(all), stops: stopAt.map((s) => s + lead), count: stopAt.length, lead };
        r.route.stops = r.stops;
      }
      routeCache.set(key, r);
    }
    if (!r) return null;
    return { ...r, times: times.slice(0, r.count) };
  }

  // --- Trams on the timetable -------------------------------------------------------------------------------------------
  const rand = (() => { let s = 20260520; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 1) >>> 0) / 4294967296; })();
  const trams = []; // running
  const free = Array.from({ length: TRAM_COUNT }, (_, i) => ({ slot: i }));
  let transit = null, schedule = [], cursor = 0, lastClock = null;
  const lineColour = new THREE.Color();
  loadTransit().then((data) => {
    if (!data) return;
    transit = data;
    // (trips after midnight run on the next day's clock)
    schedule = data.trips.filter((t) => data.lines[t[0]]?.kind === 'tram').map((t) => {
      if (t[3][1] >= 86400) t = [t[0], t[1], t[2], t[3].map((v, i) => (i % 3 ? v - 86400 : v))];
      return { trip: t, start: t[3][2] };
    });
    schedule.sort((a, b) => a.start - b.start);
    group.userData.stats.trips = schedule.length;
    lastClock = null;
  });

  function spawn(entry, now) {
    if (!free.length) return;
    const r = routeFor(entry.trip);
    if (!r) return;
    const t = free.pop();
    const lineId = entry.trip[0];
    lineColour.setHex(LINE_COLOURS[lineId] ?? 0xffffff).convertSRGBToLinear();
    // Already under way (the clock jumped, or the page opened mid-trip): start at the last stop it has left
    let next = 0, s = 0;
    while (next < r.count && r.times[next][1] < now) next++;
    if (next > 0) s = r.stops[Math.min(next, r.count) - 1];
    if (next >= r.count) { free.push(t); return; }
    Object.assign(t, { way: r.route, dir: 1, s, speed: next > 0 ? MAX_SPEED * 0.5 : 0, next, r, line: lineId, ref: transit.lines[lineId].ref,
      headsign: entry.trip[1], colour: [lineColour.r, lineColour.g, lineColour.b], leaveAt: null, trail: [], y: undefined, waiting: 0, done: false });
    const p = pointAt(r.route, s, {});
    for (let d = PITCH * TRAM_SECTIONS + 2; d >= 0; d -= 1) t.trail.push({ x: p.x - p.dx * d, z: p.z - p.dz * d });
    // a tram starting on the run in sets off ahead of its first departure, to be at the first stop on time
    trams.push(t);
  }

  // Trips due between the last clock reading and now (the run in takes ~lead / 9 m/s before the first departure)
  function dispatch(now) {
    if (!schedule.length) return;
    if (lastClock === null || now < lastClock || now - lastClock > 120) {
      // jump: everything running at this time
      for (const t of trams) free.push(t);
      trams.length = 0;
      for (const e of schedule) {
        const flat = e.trip[3];
        if (flat[1] - 120 <= now && flat[flat.length - 2] > now) spawn(e, now);
      }
      cursor = schedule.findIndex((e) => e.start - 160 > now);
      if (cursor < 0) cursor = schedule.length;
    } else {
      while (cursor < schedule.length && schedule[cursor].start - 160 <= now) spawn(schedule[cursor++], now);
    }
    lastClock = now;
  }

  const probe = {}, m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scale = new THREE.Vector3(1, 1, 1), euler = new THREE.Euler(0, 0, 0, 'YXZ');
  // Point at distance d behind the front along the trail (front last)
  function behind(trail, d, out) {
    for (let i = trail.length - 1; i > 0; i--) {
      const a = trail[i], b = trail[i - 1], L = Math.hypot(a.x - b.x, a.z - b.z);
      if (d <= L) { const f = d / (L || 1); out.x = a.x + (b.x - a.x) * f; out.z = a.z + (b.z - a.z) * f; return out; }
      d -= L;
    }
    out.x = trail[0].x; out.z = trail[0].z;
    return out;
  }

  // One oriented box per section, for collisions (refreshed every frame; parked far away when unused)
  const bodies = Array.from({ length: TRAM_COUNT * TRAM_SECTIONS }, () => ({
    x: 1e6, z: 1e6, prevX: 1e6, prevZ: 1e6, y: 0, sin: 0, cos: 1, halfW: HALF_WIDTH, halfL: SECTION / 2, mass: TRAM_MASS, vx: 0, vz: 0, angularVel: 0, tram: true
  }));

  // Distance to the nearest obstacle on the track ahead of the tram's front (straight-line look-ahead): the player,
  // the traffic (`obstacles`: lists of { x, z } and the player's position) and the other trams' sections
  function obstacleAhead(t, obstacles) {
    const f = pointAt(t.way, t.s, {}), fx = f.dx, fz = f.dz;
    let nearest = Infinity;
    const test = (p, reach = 0) => {
      const dx = p.x - f.x, dz = p.z - f.z;
      if (Math.abs(dx) > 50 || Math.abs(dz) > 50) return;
      const ahead = dx * fx + dz * fz - reach;
      if (ahead > 0 && ahead < 45 && Math.abs(dz * fx - dx * fz) < CLEARANCE && ahead < nearest) nearest = ahead;
    };
    for (const list of obstacles.vehicles || []) for (const v of list) if (v.edge) test(v);
    if (obstacles.player) test(obstacles.player);
    const traffic = nearest;
    nearest = Infinity;
    for (const o of trams) {
      if (o === t) continue;
      for (let n = 0; n < TRAM_SECTIONS; n++) test(bodies[o.slot * TRAM_SECTIONS + n], SECTION / 2 + HEADWAY - STOP_SHORT);
    }
    return { traffic, tram: nearest };
  }

  function update(dt, obstacles = {}) {
    const now = simClock.seconds;
    dispatch(now);
    for (const t of trams) {
      const { r } = t;
      // Next stop: brake for it, wait there for the departure time
      let limit = MAX_SPEED;
      if (t.next < r.count) {
        const toStop = r.stops[t.next] - t.s;
        limit = Math.min(limit, Math.sqrt(2 * BRAKE * Math.max(0, toStop - 0.3)));
        if (toStop < 0.8 && t.speed < 0.3) {
          // at the stop: the doors stay open 15-25 s, and until the departure time when early
          if (t.leaveAt == null) t.leaveAt = now + 15 + rand() * 10 + Math.max(0, r.times[t.next][1] - now) * (now > r.times[t.next][0] - 3600 ? 1 : 0);
          if (now >= t.leaveAt || now < t.leaveAt - 7200) { t.next++; t.leaveAt = null; } else { t.speed = 0; continue; }
        }
      }
      // Brake for whatever stands on the track; after 15 s at a standstill (a car facing it on a shared lane, which
      // waits for the tram in turn) carry on: the collision pushes the car aside
      const { traffic: blocked, tram: queued } = obstacleAhead(t, obstacles);
      // the tram ahead (at its stop, at a light) is always waited for
      if (queued < Infinity) limit = Math.min(limit, Math.sqrt(2 * BRAKE * 2 * Math.max(0, queued - STOP_SHORT)));
      if (blocked === Infinity) t.waiting = 0;
      else if (t.speed < 0.3 || t.waiting >= 15) t.waiting += dt;
      if (blocked < Infinity && t.waiting < 15) limit = Math.min(limit, Math.sqrt(2 * BRAKE * 2 * Math.max(0, blocked - STOP_SHORT)));
      t.speed = t.speed < limit ? Math.min(limit, t.speed + ACCEL * dt) : Math.max(limit, t.speed - BRAKE * 2 * dt);
      t.s += t.speed * dt;
      // Off the end of its route (the frame's edge, a depot): the trip is over here
      if (t.s >= t.way.len) { t.done = true; continue; }
      const front = pointAt(t.way, t.s, probe);
      const last = t.trail[t.trail.length - 1];
      if (Math.hypot(front.x - last.x, front.z - last.z) > 0.5) {
        t.trail.push({ x: front.x, z: front.z });
        if (t.trail.length > 120) t.trail.splice(0, t.trail.length - 120);
      }
    }
    for (let i = trams.length - 1; i >= 0; i--) {
      const t = trams[i];
      if (!t.done) continue;
      for (let n = 0; n < TRAM_SECTIONS; n++) Object.assign(bodies[t.slot * TRAM_SECTIONS + n], { x: 1e6, z: 1e6, prevX: 1e6, prevZ: 1e6 });
      trams.splice(i, 1);
      free.push(t);
    }
    // Sections: centred between their couplings along the trail, upright on the surface they cross
    let k = 0;
    const a = {}, b = {};
    for (const t of trams) {
      const front = pointAt(t.way, t.s, probe);
      const trail = [...t.trail, { x: front.x, z: front.z }];
      for (let n = 0; n < TRAM_SECTIONS; n++) {
        behind(trail, n * PITCH, a);
        behind(trail, n * PITCH + SECTION, b);
        const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
        const ya = surfaceHeight(a.x, a.z, t.y), yb = surfaceHeight(b.x, b.z, t.y);
        if (n === 0) t.y = ya;
        const yaw = Math.atan2(a.x - b.x, a.z - b.z);
        euler.set(Math.atan2(yb - ya, SECTION), yaw, 0);
        const body = bodies[t.slot * TRAM_SECTIONS + n];
        body.prevX = body.x === 1e6 ? cx : body.x; body.prevZ = body.z === 1e6 ? cz : body.z;
        body.x = cx; body.z = cz; body.y = (ya + yb) / 2;
        body.sin = Math.sin(yaw); body.cos = Math.cos(yaw);
        body.vx = body.sin * t.speed; body.vz = body.cos * t.speed;
        lineAttr.setXYZW(k, t.colour[0], t.colour[1], t.colour[2], n === 0 ? 1 : n === TRAM_SECTIONS - 1 ? -1 : 0);
        sections.setMatrixAt(k++, m.compose(pos.set(cx, (ya + yb) / 2 + ROAD_TOP + 0.015, cz), q.setFromEuler(euler), scale)); // on the rails' heads
      }
    }
    sections.count = k;
    sections.instanceMatrix.needsUpdate = true;
    lineAttr.needsUpdate = true;
  }
  update(0);

  // The player against the sections: a tram does not give way, so the player takes the whole correction
  const contact = {}, playerBody = { x: 0, z: 0, prevX: 0, prevZ: 0, sin: 0, cos: 1, halfW: 0, halfL: 0, mass: 0, vx: 0, vz: 0, angularVel: 0 };
  function collidePlayer(pe, mode, controllers) {
    if (!pe || mode === 'helicopter') return;
    const halfW = mode === 'cargobike' ? 0.38 : mode === 'cyclist' ? 0.35 : mode === 'person' ? 0.32 : 0.86;
    const halfL = mode === 'cargobike' ? 1.34 : mode === 'cyclist' ? 0.85 : mode === 'person' ? 0.32 : 2.18;
    const reach = SECTION / 2 + halfL + HALF_WIDTH;
    for (const b of bodies) {
      if (Math.abs(pe.position.x - b.x) > reach + 2 || Math.abs(pe.position.z - b.z) > reach + 2) continue;
      if (pe.position.y > b.y + 3.6 || pe.position.y < b.y - 2) continue;
      const a = playerBody, heading = pe.heading || 0;
      a.x = pe.position.x; a.z = pe.position.z;
      a.prevX = pe.prevX ?? a.x; a.prevZ = pe.prevZ ?? a.z;
      a.sin = Math.sin(heading); a.cos = Math.cos(heading);
      a.halfW = halfW; a.halfL = halfL;
      a.mass = mode === 'car' ? 1700 : mode === 'cargobike' ? 140 : mode === 'cyclist' ? 95 : 80;
      a.vx = a.sin * (pe.speed || 0) + (pe.vx || 0);
      a.vz = a.cos * (pe.speed || 0) + (pe.vz || 0);
      a.angularVel = mode === 'car' ? pe.angularVel || 0 : 0;
      if (!sweptVehicleContact(a, b, contact) && !vehicleContact(a, b, contact)) continue;
      const speed = resolveVehicleContact(a, b, contact);
      pe.position.x = contact.ax + contact.nx * contact.depth;
      pe.position.z = contact.az + contact.nz * contact.depth;
      if (speed <= 0) continue;
      pe.speed = a.vx * a.sin + a.vz * a.cos;
      if (mode === 'car') { pe.vx = a.vx - a.sin * pe.speed; pe.vz = a.vz - a.cos * pe.speed; pe.angularVel = a.angularVel; }
      if (mode !== 'person') controllers?.reportCollision(pe, b, 'vehicle', contact.x, b.y + 0.6, contact.z, contact.nx, 0, contact.nz, speed);
    }
  }

  group.userData.stats = { ...group.userData.stats, maxTrams: TRAM_COUNT, ways: ways.length, stops: ways.reduce((a, w) => a + w.stops.length, 0) };
  return { group, update, collidePlayer, bodies, trams };
}
