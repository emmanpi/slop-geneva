// One weekday of the TPG's and the boats' timetable at the stops of the frame (data/geneva-transit.json, written by
// tools/build-geneva-transit.mjs from the Swiss GTFS feed). Loaded once, shared by the trams and the boats.
let pending = null;

/** { date, lines: { id: { ref, kind, agency } }, stops: [[name, x, z]], trips: [[lineId, headsign, dir, [stop, arr, dep, ...]]] } */
export function loadTransit() {
  pending ??= fetch(new URL('../data/geneva-transit.json', import.meta.url))
    .then((r) => (r.ok ? r.json() : null))
    .catch((error) => { console.warn('[transit] timetable not loaded:', error); return null; });
  return pending;
}

// TPG line colours (sRGB)
export const LINE_COLOURS = {
  'tram:12': 0xf7a800, 'tram:14': 0x5c2d91, 'tram:15': 0x8b5a2b, 'tram:17': 0x00a3e0, 'tram:18': 0xc4007a,
  'boat:M1': 0x1d5aa8, 'boat:M2': 0x1d5aa8, 'boat:M3': 0x1d5aa8, 'boat:M4': 0x1d5aa8
};
