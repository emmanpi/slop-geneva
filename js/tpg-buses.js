import * as THREE from 'three/webgpu';
import { attribute, float, texture, uv, vec2 } from 'three/tsl';
import { loadTransit } from './transit-data.js';

// The TPG's buses on their lines (data/geneva-transit.json): a bus the traffic (js/traffic.js) puts on the road takes a
// trip running at the city's clock near the player, follows its line over the road graph from stop to stop (the
// shortest way between them), stops at each stop for the passengers and shows its line and destination on its signs.
// Once its line leaves the roads near the player, it drives on like any bus and is recycled with the traffic.

const SIGN_ROWS = 64; // the destination sign atlas: one 256 x 64 row per line & destination (row 0: plain "TPG")
const STOP_REACH = 30; // m from the road axis a stop may stand
const DWELL = [12, 22]; // s

/** The destination signs: an atlas of rows drawn on demand, and the material that picks a bus's row (aSign) */
export function createSignAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64 * SIGN_ROWS;
  const ctx = canvas.getContext('2d');
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const rows = new Map();
  function draw(row, ref, headsign, colour) {
    const y = row * 64;
    ctx.fillStyle = '#0c0f14';
    ctx.fillRect(0, y, 256, 64);
    ctx.fillStyle = colour;
    ctx.fillRect(6, y + 8, 62, 48);
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 ${ref.length > 2 ? 22 : 28}px Inter, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ref, 37, y + 33);
    ctx.fillStyle = '#ffb21c';
    ctx.font = '800 19px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    let text = headsign.replace(/^Genève,\s*/, '').toUpperCase();
    while (text.length > 3 && ctx.measureText(text).width > 172) text = text.slice(0, -1);
    ctx.fillText(text, 76, y + 33);
    map.needsUpdate = true;
  }
  draw(0, 'TPG', 'Genève', '#ee5a00');
  rows.set('', 0);
  function rowFor(ref, headsign) {
    const key = `${ref}|${headsign}`;
    if (rows.has(key)) return rows.get(key);
    const row = rows.size < SIGN_ROWS ? rows.size : 1 + (rows.size % (SIGN_ROWS - 1)); // (reuses rows when full)
    for (const [k, r] of rows) if (r === row) rows.delete(k);
    rows.set(key, row);
    // TPG bus lines: the main lines orange, the others in the network's grey-blue
    draw(row, ref, headsign, /^\d$|^1\d$/.test(ref) ? '#ee5a00' : '#3b5a78');
    return row;
  }
  const material = new THREE.MeshBasicNodeMaterial();
  const row = attribute('aSign', 'float');
  material.colorNode = texture(map, vec2(uv().x, uv().y.add(float(SIGN_ROWS - 1).sub(row)).div(SIGN_ROWS))).rgb;
  return { material, rowFor };
}

/**
 * Bus lines over the traffic's road graph (`edges`: directed straight edges with moves to the next ones). Returns
 * { ready, assign(v, nearEdgeSet, now) -> line state | null, nextEdge(line, edge), stopAhead(line, edge, s) }.
 */
export function createBusLines(edges) {
  let trips = [];
  let stopsXZ = [];
  const state = { ready: false, trips: 0 };
  loadTransit().then((data) => {
    if (!data) return;
    stopsXZ = data.stops;
    trips = data.trips.filter((t) => data.lines[t[0]]?.kind === 'bus').map((t) => {
      // (trips after midnight run on the next day's clock)
      const f = t[3][1] >= 86400 ? t[3].map((v, i) => (i % 3 ? v - 86400 : v)) : t[3];
      return { ref: data.lines[t[0]].ref, headsign: t[1], flat: f, start: f[1], end: f[f.length - 2] };
    });
    state.ready = true;
    state.trips = trips.length;
  });

  // Edges a stop stands by: within STOP_REACH of the edge's axis, between its ends
  const stopEdges = new Map();
  function edgesAt(stop) {
    if (stopEdges.has(stop)) return stopEdges.get(stop);
    const [, x, z] = stopsXZ[stop];
    const list = [];
    for (const e of edges) {
      const s = (x - e.sx) * e.dx + (z - e.sz) * e.dz;
      if (s < 0 || s > e.len) continue;
      const lat = Math.abs((x - e.sx) * e.dz - (z - e.sz) * e.dx);
      if (lat < STOP_REACH) list.push({ e, s: Math.min(Math.max(s, 9), e.len - 9), lat });
    }
    list.sort((a, b) => a.lat - b.lat);
    stopEdges.set(stop, list.slice(0, 6));
    return stopEdges.get(stop);
  }

  // Shortest drive (Dijkstra over edges) from any edge by stop A to any by stop B: [{ e, s }] of A and B and the edges
  // (`start`: the edge the bus is on at A, where the previous leg ended)
  const legCache = new Map();
  const edgeId = new Map(edges.map((e, i) => [e, i]));
  function leg(A, B, start = null) {
    const key = `${A}>${B}@${start ? edgeId.get(start) : ''}`;
    if (legCache.has(key)) return legCache.get(key);
    const targets = new Map(edgesAt(B).map((c) => [c.e, c]));
    const dist = new Map(), prev = new Map(), heap = [];
    const starts = start ? edgesAt(A).filter((a) => a.e === start) : edgesAt(A);
    for (const a of starts) {
      const t = targets.get(a.e);
      if (t && t.s > a.s + 5) { const r = { from: a, to: t, edges: [a.e] }; legCache.set(key, r); return r; }
      dist.set(a.e, a.e.len - a.s + a.lat * 2);
      heap.push(a.e);
      prev.set(a.e, null);
    }
    const startOf = new Map(starts.map((a) => [a.e, a]));
    let found = null;
    while (heap.length) {
      heap.sort((p, q) => dist.get(p) - dist.get(q));
      const e = heap.shift();
      const d = dist.get(e);
      if (d > 3000) break;
      if (targets.has(e) && !startOf.has(e)) { found = e; break; }
      for (const m of e.moves) {
        const f = m.to;
        const nd = d + (targets.has(f) ? targets.get(f).s : f.len);
        if (nd < (dist.get(f) ?? Infinity)) { dist.set(f, nd); prev.set(f, e); heap.push(f); }
      }
    }
    let r = null;
    if (found) {
      const path = [];
      for (let e = found; e; e = prev.get(e)) path.unshift(e);
      r = { from: startOf.get(path[0]), to: targets.get(found), edges: path };
    }
    legCache.set(key, r);
    return r;
  }

  // A trip's route from its stop `k` on: edges in order, with the stops on them. Stops off the roads (the one either
  // side of the frame, a terminus loop) are skipped, up to two in a row between served ones.
  function routeFrom(trip, k) {
    const f = trip.flat;
    let i = k;
    while (i < f.length && !edgesAt(f[i]).length) i += 3;
    const edgesOut = [], stops = [];
    let from = i;
    for (let j = i + 3; j < f.length; ) {
      let l = null, to = j;
      for (let skip = 0; skip < 3 && to < f.length && !l; skip++, to += 3) {
        l = leg(f[from], f[to], edgesOut.length ? edgesOut[edgesOut.length - 1] : null);
        if (l) break;
      }
      if (!l) break;
      if (!edgesOut.length) { edgesOut.push(...l.edges); stops.push({ e: l.from.e, s: l.from.s, dep: f[from + 2] }); }
      else edgesOut.push(...l.edges.slice(1));
      stops.push({ e: l.to.e, s: l.to.s, dep: f[to + 2] });
      from = to;
      j = to + 3;
    }
    return edgesOut.length ? { edges: edgesOut, stops } : null;
  }

  /** A line for bus v near the player: a trip under way at `now` with a stop on one of `near` (a Set of edges) */
  function assign(near, now) {
    if (!state.ready) return null;
    const running = trips.filter((t) => t.start - 60 <= now && t.end >= now);
    for (let attempt = 0; attempt < 20 && running.length; attempt++) {
      const trip = running[Math.floor(Math.random() * running.length)];
      // the stop it left last, by the clock
      let k = 0;
      for (let i = 0; i + 3 < trip.flat.length; i += 3) if (trip.flat[i + 2] <= now) k = i;
      const route = routeFrom(trip, k);
      if (!route) continue;
      const idx = route.edges.findIndex((e) => near.has(e));
      if (idx < 0) continue;
      return { ref: trip.ref, headsign: trip.headsign, route, idx, served: new Set(), dwellUntil: 0 };
    }
    return null;
  }

  /** Debugging: how the trips running at `now` route ({ running, routed, legsOk, stopsWithEdges }) */
  function diagnose(now) {
    const running = trips.filter((t) => t.start - 60 <= now && t.end >= now);
    let routed = 0, legs = 0, legsOk = 0, stops = 0, stopsOk = 0;
    for (const t of running) {
      if (routeFrom(t, 0)) routed++;
      for (let i = 0; i < t.flat.length; i += 3) { stops++; if (edgesAt(t.flat[i]).length) stopsOk++; }
      for (let i = 0; i + 3 < t.flat.length; i += 3) { legs++; if (leg(t.flat[i], t.flat[i + 3])) legsOk++; }
    }
    return { running: running.length, routed, legs, legsOk, stops, stopsOk };
  }

  return { state, assign, diagnose };
}
