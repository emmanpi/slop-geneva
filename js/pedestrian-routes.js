// Small, lazily connected sidewalk tracks. A walk stays on curb islands and sidewalk strips (blockAt is never null
// along it), so it never steps onto the roadway; crossing it is a separate, signal-controlled track owned by traffic.js.
// Sidewalk strips (city-config.js sidewalkAt) come back as a new object on every call: compare islands by footing,
// never by identity, or every sidewalk outside a mapped block (most of Geneva's) is rejected.
// Walkways: OSM footways, pedestrian streets, paths, steps and living streets (the quays, the old town, the parks) form
// their own network of tracks, joined where their vertices meet.
const WALK_KINDS = new Set(['pedestrian', 'footway', 'path', 'steps', 'living_street']);
const WAY_WEIGHT = { pedestrian: 4, living_street: 2 }; // how much busier than a footway, per metre (and per 6 m of width)
const WAY_CELL = 64;
const LINE_GAP = 1.5; // m between walking lines across a wide pedestrian street
const TRAM_CLEAR = 1.9; // m kept clear either side of a tram track (half the car's width and a step)

function createPedestrianRoutes({ walkable, onSidewalk }, blockAt, roads = []) {
  const sidewalks = new Map(), crossings = new Map(), junctions = new Map(), connections = new WeakMap();
  const point = (track, end) => ({ x: track.ax + track.ux * track.len * end, z: track.az + track.uz * track.len * end });
  const segment = (a, b, extra = {}) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    return { ax: a.x, az: a.z, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len,
      len, node: null, side: 0, line: 0, ...extra };
  };

  function clear(a, b, onFoot = false) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)));
    let x = a.x, z = a.z;
    for (let i = 0; i <= steps; i++) {
      const nx = a.x + (b.x - a.x) * i / steps, nz = a.z + (b.z - a.z) * i / steps;
      if (!walkable(Math.min(x, nx) - 0.4, Math.max(x, nx) + 0.4, Math.min(z, nz) - 0.4, Math.max(z, nz) + 0.4)) return false;
      if (onFoot && !blockAt(nx, nz)) return false;
      x = nx; z = nz;
    }
    return true;
  }

  function along(e) {
    if (sidewalks.has(e)) return sidewalks.get(e);
    const result = [];
    sidewalks.set(e, result);
    // Two walking lines on each side leave room for people to pass or stop together.
    for (const sign of [-1, 1]) {
      for (const inset of [1.7, 2.8]) {
        const off = sign * (e.half + inset);
        const a = { x: e.sx + e.rx * off, z: e.sz + e.rz * off };
        const b = { x: a.x + e.dx * e.len, z: a.z + e.dz * e.len };
        const block = blockAt(a.x, a.z);
        if (!block || !clear(a, b, true)) continue;
        if (!e.general && (!onSidewalk(a.x, a.z) || !onSidewalk(b.x, b.z))) continue;
        result.push(segment(a, b, { edge: e, from: e.from, to: e.to, block }));
      }
    }
    return result;
  }

  function across(n) {
    if (crossings.has(n)) return crossings.get(n);
    const result = [];
    crossings.set(n, result);
    if (!n.signal) return result;
    for (let side = 0; side < 4; side++) {
      const road = n.road[side];
      if (!road) continue;
      const avenue = side >= 2, sign = side % 2 === 0 ? 1 : -1;
      for (const line of avenue ? [sign * 0.75] : [-0.75, 0.75]) {
        const a = { x: avenue ? road.x0 - road.half - 2 : n.x + sign * (n.hx + 1.25) + line,
          z: avenue ? n.z + sign * (n.hz + 1.25) + line : road.z0 - road.half - 2 };
        const len = road.half * 2 + 4;
        const b = { x: a.x + (avenue ? len : 0), z: a.z + (avenue ? 0 : len) };
        if (!onSidewalk(a.x, a.z) || !onSidewalk(b.x, b.z) || !clear(a, b)) continue;
        result.push(segment(a, b, { node: n, side, line, from: n, to: n }));
      }
    }
    return result;
  }

  // Walkway junctions: vertices within 1.5 m are one (half of the ways carry no OSM node ids for their points)
  const wayNodes = new Map(), wayCells = new Map();
  function wayNode(p) {
    const kx = Math.round(p.x / 1.5), kz = Math.round(p.z / 1.5);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const n of wayNodes.get((kx + dx) * 100000 + kz + dz) || []) if (Math.hypot(n.x - p.x, n.z - p.z) < 1.5) return n;
      }
    }
    const n = { x: p.x, z: p.z, way: true, segs: [] }, key = kx * 100000 + kz;
    if (!wayNodes.has(key)) wayNodes.set(key, []);
    wayNodes.get(key).push(n);
    return n;
  }
  for (const r of roads) {
    if (!WALK_KINDS.has(r.kind) || r.tunnel || (r.layer ?? 0) < 0 || !r.pts) continue;
    for (let i = 1; i < r.pts.length; i++) {
      const a = wayNode(r.pts[i - 1]), b = wayNode(r.pts[i]);
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (a === b || len < 1) continue;
      const seg = { road: r, a, b, len, weight: len * (WAY_WEIGHT[r.kind] || 1) * Math.max(1, (r.w || 2) / 6), tracks: null };
      a.segs.push(seg);
      b.segs.push(seg);
      const cells = new Set();
      for (let t = 0; t <= len; t += WAY_CELL / 2) {
        const x = a.x + (b.x - a.x) * Math.min(1, t / len), z = a.z + (b.z - a.z) * Math.min(1, t / len);
        cells.add(Math.floor(x / WAY_CELL) * 100000 + Math.floor(z / WAY_CELL));
      }
      cells.add(Math.floor(b.x / WAY_CELL) * 100000 + Math.floor(b.z / WAY_CELL));
      for (const k of cells) {
        if (!wayCells.has(k)) wayCells.set(k, []);
        wayCells.get(k).push(seg);
      }
    }
  }

  /** Walkway segments reaching within `radius` of (x, z), with their running weights for a weighted pick */
  function waysNear(x, z, radius, out = { segs: [], cum: [], total: 0 }) {
    out.segs.length = out.cum.length = 0;
    out.total = 0;
    const seen = new Set();
    for (let ix = Math.floor((x - radius) / WAY_CELL); ix <= Math.floor((x + radius) / WAY_CELL); ix++) {
      for (let iz = Math.floor((z - radius) / WAY_CELL); iz <= Math.floor((z + radius) / WAY_CELL); iz++) {
        for (const seg of wayCells.get(ix * 100000 + iz) || []) {
          if (seen.has(seg)) continue;
          seen.add(seg);
          const dx = seg.b.x - seg.a.x, dz = seg.b.z - seg.a.z;
          const t = Math.max(0, Math.min(1, ((x - seg.a.x) * dx + (z - seg.a.z) * dz) / (seg.len * seg.len)));
          if (Math.hypot(seg.a.x + dx * t - x, seg.a.z + dz * t - z) > radius) continue;
          out.segs.push(seg);
          out.cum.push(out.total += seg.weight);
        }
      }
    }
    return out;
  }

  // Walking lines along a walkway segment: two on a footway, four across a pedestrian street, along the edges of a
  // living street (its middle is the shared carriageway); none where it crosses a roadway (a mapped crossing)
  // A wide pedestrian street (the Rues-Basses): lines every LINE_GAP m across it, none over the tram's tracks
  function wideLines(half, rails) {
    const out = [];
    for (let edge = half - 0.8; edge >= 0; edge -= LINE_GAP) {
      for (const off of edge > 0.01 ? [-edge, edge] : [0]) {
        if (rails && off > rails[0] - TRAM_CLEAR && off < rails[1] + TRAM_CLEAR) continue;
        out.push(Math.round(off * 100) / 100);
      }
    }
    return out.sort((a, b) => a - b);
  }

  function wayTracks(seg) {
    if (seg.tracks) return seg.tracks;
    const result = seg.tracks = [];
    const r = seg.road, half = (r.w || 2) / 2;
    const ux = (seg.b.x - seg.a.x) / seg.len, uz = (seg.b.z - seg.a.z) / seg.len;
    const offsets = r.kind === 'living_street' ? [-(half - 0.2), half - 0.2]
      : half >= 4 ? wideLines(half, r.rails) : half >= 2.5 ? [-1.8, -0.6, 0.6, 1.8] : half >= 1 ? [-0.5, 0.5] : [0];
    const tryLine = (off) => {
      const a = { x: seg.a.x - uz * off, z: seg.a.z + ux * off };
      const b = { x: seg.b.x - uz * off, z: seg.b.z + ux * off };
      if (!clear(a, b, true)) return;
      const block = blockAt((a.x + b.x) / 2, (a.z + b.z) / 2);
      result.push(segment(a, b, { way: seg, from: seg.a, to: seg.b, block, line: off }));
    };
    for (const off of offsets) tryLine(off);
    if (!result.length && !offsets.includes(0)) tryLine(0);
    return result;
  }

  function ports(n) {
    if (junctions.has(n)) return junctions.get(n);
    const result = [], seen = new Set();
    junctions.set(n, result);
    if (n.way) {
      for (const seg of n.segs) for (const track of wayTracks(seg)) result.push({ track, end: seg.a === n ? 0 : 1 });
      return result;
    }
    for (const e of [...n.in, ...n.out]) {
      if (seen.has(e)) continue;
      seen.add(e);
      for (const track of along(e)) result.push({ track, end: e.from === n ? 0 : 1 });
    }
    for (const track of across(n)) result.push({ track, end: 0 }, { track, end: 1 });
    return result;
  }

  // Stay in the sidewalk band even where angled building colliders are deliberately omitted from the road graph.
  // Sidewalk strips have no outline: being one (within a few metres of a street) already keeps to the band.
  function cornerClear(a, b, band = true) {
    if (!clear(a, b, true)) return false;
    if (!band) return true;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)));
    for (let i = 0; i <= steps; i++) {
      const x = a.x + (b.x - a.x) * i / steps, z = a.z + (b.z - a.z) * i / steps;
      const block = blockAt(x, z);
      if (!block?.poly) continue;
      let distance = Infinity;
      for (let j = 0, k = block.poly.length - 1; j < block.poly.length; k = j++) {
        const p = block.poly[j], q = block.poly[k], dx = q.x - p.x, dz = q.z - p.z;
        const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / (dx * dx + dz * dz || 1)));
        distance = Math.min(distance, Math.hypot(x - p.x - dx * t, z - p.z - dz * t));
      }
      if (distance > 4) return false;
    }
    return true;
  }

  function links(track, dir) {
    let ends = connections.get(track);
    if (!ends) connections.set(track, ends = []);
    const end = dir > 0 ? 1 : 0;
    if (ends[end]) return ends[end];
    const result = ends[end] = [];
    const n = end ? track.to : track.from;
    if (!n) return result;
    const a = point(track, end);
    if (!blockAt(a.x, a.z)) return result;
    // walkways cross parks and squares: no curb band to keep to there
    const band = !n.way;
    for (const port of ports(n)) {
      const next = port.track, nextDir = port.end ? -1 : 1;
      if (next === track || (n.way && next.way === track.way)) continue;
      const b = point(next, port.end), distance = Math.hypot(b.x - a.x, b.z - a.z);
      if (distance > 32 || !blockAt(b.x, b.z)) continue;
      const path = [];
      if (distance > 0.01) {
        if (cornerClear(a, b, band)) {
          path.push({ track: segment(a, b), dir: 1 });
        } else {
          // Meeting the two offset sidewalk lines rounds the curb instead of cutting diagonally through a lot.
          const ax = track.ux * dir, az = track.uz * dir, bx = next.ux * nextDir, bz = next.uz * nextDir;
          const cross = ax * bz - az * bx;
          if (Math.abs(cross) < 0.2) continue;
          const t = ((b.x - a.x) * bz - (b.z - a.z) * bx) / cross;
          const c = { x: a.x + ax * t, z: a.z + az * t };
          if (t < 0 || t > 20 || (b.x - c.x) * bx + (b.z - c.z) * bz < 0 || Math.hypot(b.x - c.x, b.z - c.z) > 20) continue;
          if (!cornerClear(a, c, band) || !cornerClear(c, b, band)) continue;
          if (t > 0.01) path.push({ track: segment(a, c), dir: 1 });
          if (Math.hypot(b.x - c.x, b.z - c.z) > 0.01) path.push({ track: segment(c, b), dir: 1 });
        }
      }
      path.push({ track: next, dir: nextDir });
      result.push(path);
    }
    return result;
  }

  function next(track, dir, goalX, goalZ) {
    let best = null, bestScore = -Infinity;
    const a = point(track, dir > 0 ? 1 : 0);
    const gx = goalX - a.x, gz = goalZ - a.z, distance = Math.hypot(gx, gz) || 1;
    for (const path of links(track, dir)) {
      const last = path[path.length - 1], target = last.track;
      const ux = target.ux * last.dir, uz = target.uz * last.dir;
      const back = ux * track.ux * dir + uz * track.uz * dir < -0.8;
      const score = (ux * gx + uz * gz) / distance + Math.random() * 0.7 - (back ? 2 : 0);
      if (score > bestScore) { best = path; bestScore = score; }
    }
    return best;
  }

  function canDodge(p, offset) {
    const target = { x: p.ax + p.ux * p.t + p.uz * offset, z: p.az + p.uz * p.t - p.ux * offset };
    return !!blockAt(p.x, p.z) && onSidewalk(target.x, target.z) && cornerClear(p, target);
  }

  return { along, across, next, canDodge, waysNear, wayTracks };
}

export { createPedestrianRoutes };
