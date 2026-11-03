// tools/build-geneva-transit.mjs — writes data/geneva-transit.json: one weekday of the TPG's trams and buses and of
// the boats on the Rade (Mouettes genevoises, CGN) at their stops in the frame, from the Swiss public transport timetable
// (GTFS, opentransportdata.swiss, open data: tools/data/cache/gtfs/gtfs.zip, see the README).
// The 3.7 GB stop_times.txt is streamed out of the zip (unzip -p) and only the trips of these operators are kept.
// Output: { date, lines: { "<id>": { ref, kind: tram|bus|boat, agency } }, stops: [[name, x, z]],
//           trips: [[lineId, headsign, direction, [stopIndex, arrival s, departure s, ...]]] }
// with the stop events in the frame (plus the one stop either side, so a vehicle drives in and out of the frame).
// usage: node tools/build-geneva-transit.mjs [YYYYMMDD]   (default: the next Tuesday)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FRAME, lv95ToWorld } from '../js/geneva-frame.js';
import { wgs84ToLv95 } from '../js/swiss-projection.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ZIP = path.join(DIR, 'data', 'cache', 'gtfs', 'gtfs.zip');
const OUT = path.join(DIR, '..', 'data', 'geneva-transit.json');
const log = (...a) => console.log('[geneva-transit]', ...a);
const AGENCIES = { 881: 'TPG', 199: 'Mouettes genevoises', 184: 'CGN' };
const MARGIN = 400; // m around the frame

function nextTuesday() {
  const d = new Date();
  d.setDate(d.getDate() + ((9 - d.getDay()) % 7 || 7));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
const DATE = process.argv[2] || nextTuesday();
const WEEKDAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${DATE.slice(0, 4)}-${DATE.slice(4, 6)}-${DATE.slice(6)}T12:00:00`).getDay()];

// CSV line with quoted fields (no embedded newlines in this feed)
function parseCSV(line) {
  const out = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let j = i + 1, s = '';
      for (;;) {
        const k = line.indexOf('"', j);
        if (k < 0) { s += line.slice(j); j = line.length; break; }
        s += line.slice(j, k);
        if (line[k + 1] === '"') { s += '"'; j = k + 2; } else { j = k + 1; break; }
      }
      out.push(s);
      i = j + 1;
    } else {
      const k = line.indexOf(',', i);
      out.push(k < 0 ? line.slice(i) : line.slice(i, k));
      i = k < 0 ? line.length + 1 : k + 1;
    }
  }
  return out;
}

async function eachRow(file, fn) {
  const proc = spawn('unzip', ['-p', ZIP, file]);
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let head = null;
  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, '');
    if (!line) continue;
    const f = parseCSV(line);
    if (!head) { head = Object.fromEntries(f.map((n, i) => [n, i])); continue; }
    if (fn(f, head) === false) { proc.kill(); break; }
  }
}

const secs = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };

// --- Lines -------------------------------------------------------------------------------------------------------------------
const lines = {};
await eachRow('routes.txt', (f, h) => {
  const agency = f[h.agency_id];
  if (!AGENCIES[agency]) return;
  const type = +f[h.route_type];
  const kind = type === 900 || type === 0 ? 'tram' : type === 1000 || type === 4 ? 'boat' : type >= 700 && type < 800 || type === 3 ? 'bus' : null;
  if (!kind) return;
  lines[f[h.route_id]] = { ref: f[h.route_short_name], kind, agency: AGENCIES[agency] };
});
log(`${Object.keys(lines).length} lines:`, [...new Set(Object.values(lines).map((l) => `${l.kind} ${l.ref}`))].sort().join(', '));

// --- Services running on DATE -------------------------------------------------------------------------------------------------
const active = new Set();
await eachRow('calendar.txt', (f, h) => {
  if (f[h[WEEKDAY]] === '1' && f[h.start_date] <= DATE && f[h.end_date] >= DATE) active.add(f[h.service_id]);
});
let added = 0, removed = 0;
await eachRow('calendar_dates.txt', (f, h) => {
  if (f[h.date] !== DATE) return;
  if (f[h.exception_type] === '1') { active.add(f[h.service_id]); added++; } else if (active.delete(f[h.service_id])) removed++;
});
log(`${DATE} (${WEEKDAY}): ${active.size} services (${added} added, ${removed} removed by exception)`);

// --- Trips -------------------------------------------------------------------------------------------------------------------
const trips = new Map();
await eachRow('trips.txt', (f, h) => {
  const line = lines[f[h.route_id]];
  if (!line || !active.has(f[h.service_id])) return;
  trips.set(f[h.trip_id], { route: f[h.route_id], headsign: f[h.trip_headsign], dir: +f[h.direction_id] || 0, events: [] });
});
log(`${trips.size} trips`);

// --- Stops in (and around) the frame ---------------------------------------------------------------------------------------
const [minE, minN, maxE, maxN] = FRAME.lv95;
const stopInfo = new Map();
await eachRow('stops.txt', (f, h) => {
  const lat = +f[h.stop_lat], lon = +f[h.stop_lon];
  if (!(lat > 46.1 && lat < 46.3 && lon > 6.0 && lon < 6.3)) return;
  const { E, N } = wgs84ToLv95(lon, lat);
  const inside = E > minE && E < maxE && N > minN && N < maxN;
  const near = E > minE - MARGIN && E < maxE + MARGIN && N > minN - MARGIN && N < maxN + MARGIN;
  const { x, z } = lv95ToWorld(E, N);
  stopInfo.set(f[h.stop_id], { name: f[h.stop_name], x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, inside, near });
});

// --- Stop times (streamed) ------------------------------------------------------------------------------------------------
let rows = 0;
const t0 = Date.now();
await eachRow('stop_times.txt', (f, h) => {
  if (++rows % 5e6 === 0) log(`  ${(rows / 1e6).toFixed(0)}M stop times, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const trip = trips.get(f[h.trip_id]);
  if (!trip) return;
  trip.events.push([+f[h.stop_sequence], f[h.stop_id], secs(f[h.arrival_time]), secs(f[h.departure_time])]);
});
log(`${rows} stop times read in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// --- Output: trips with stop events in the frame ----------------------------------------------------------------------------
const stops = [], stopIndex = new Map();
const outLines = {}, outTrips = [];
for (const trip of trips.values()) {
  trip.events.sort((a, b) => a[0] - b[0]);
  const ev = trip.events.map(([, id, arr, dep]) => ({ s: stopInfo.get(id), id, arr, dep })).filter((e) => e.s);
  const inIdx = ev.map((e, i) => (e.s.inside ? i : -1)).filter((i) => i >= 0);
  if (!inIdx.length) continue;
  const first = Math.max(0, inIdx[0] - 1), last = Math.min(ev.length - 1, inIdx[inIdx.length - 1] + 1);
  const flat = [];
  for (const e of ev.slice(first, last + 1)) {
    const key = `${e.s.name}|${e.s.x}|${e.s.z}`;
    if (!stopIndex.has(key)) { stopIndex.set(key, stops.length); stops.push([e.s.name, e.s.x, e.s.z]); }
    flat.push(stopIndex.get(key), e.arr, e.dep);
  }
  if (flat.length < 6) continue;
  const line = lines[trip.route];
  const id = `${line.kind}:${line.ref}`;
  outLines[id] = { ref: line.ref, kind: line.kind, agency: line.agency };
  outTrips.push([id, trip.headsign, trip.dir, flat]);
}
outTrips.sort((a, b) => a[3][1] - b[3][1]);
fs.writeFileSync(OUT, JSON.stringify({
  source: 'Horaire officiel suisse (GTFS), opentransportdata.swiss', date: DATE, weekday: WEEKDAY,
  lines: outLines, stops, trips: outTrips
}));
const tally = {};
for (const [id] of outTrips) tally[id] = (tally[id] || 0) + 1;
log(Object.entries(tally).sort().map(([k, v]) => `${k}:${v}`).join(' '));
log(`wrote ${OUT}: ${stops.length} stops, ${outTrips.length} trips (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
