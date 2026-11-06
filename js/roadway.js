// js/roadway.js
// The street space as the cadastre surveys it (SITG, CAD_DOMROUTIER_OBJETS_NIV0; data/geneva-roadway.bin from
// tools/build-geneva-roadway.mjs): the carriageways' outlines, the traffic islands, the kerbs along every edge between
// carriageway and what is raised beside it, and a 1 m mask of the carriageways. null when the file is missing (the
// streets are then drawn from OpenStreetMap's centre lines and widths alone).

const URL_DATA = new URL('../data/geneva-roadway.bin', import.meta.url);

async function loadBinary(url) {
  try {
    if (url.protocol === 'file:') {
      const { readFile } = await import('node:fs/promises');
      const b = await readFile(url);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    const res = await fetch(url);
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

function parse(buffer) {
  const head = new Int32Array(buffer, 0, 10);
  if (head[0] !== 0x59575247) return null;
  const [, , nRings, nPts, nKerbs, nKerbPts, MW, MH, X0, Z0] = head;
  const pad4 = (n) => (n + 3) & ~3;
  let o = 40;
  const starts = new Uint32Array(buffer, o, nRings + 1); o += (nRings + 1) * 4;
  const cls = new Uint8Array(buffer, o, nRings); o += pad4(nRings);
  const flags = new Uint8Array(buffer, o, nRings); o += pad4(nRings);
  const pts = new Float32Array(buffer, o, nPts * 2); o += nPts * 8;
  const kStarts = new Uint32Array(buffer, o, nKerbs + 1); o += (nKerbs + 1) * 4;
  const kPts = new Float32Array(buffer, o, nKerbPts * 2); o += nKerbPts * 8;
  const mask = new Uint8Array(buffer, o, Math.ceil((MW * MH) / 8));
  const ring = (a, b, src) => { const r = []; for (let k = a; k < b; k++) r.push({ x: src[k * 2], z: src[k * 2 + 1] }); return r; };
  // polygons: { island, ring, holes }
  const carriageways = [], islands = [];
  let current = null;
  for (let i = 0; i < nRings; i++) {
    const r = ring(starts[i], starts[i + 1], pts);
    if (flags[i] & 1 && current) { current.holes.push(r); continue; }
    current = { ring: r, holes: [] };
    (cls[i] === 1 ? islands : carriageways).push(current);
  }
  const kerbs = [];
  for (let i = 0; i < nKerbs; i++) kerbs.push(ring(kStarts[i], kStarts[i + 1], kPts));
  /** Is (x, z) on a surveyed carriageway (to the metre)? */
  const onCarriageway = (x, z) => {
    const i = Math.floor(x - X0), j = Math.floor(z - Z0);
    if (i < 0 || j < 0 || i >= MW || j >= MH) return false;
    const k = j * MW + i;
    return ((mask[k >> 3] >> (k & 7)) & 1) === 1;
  };
  /** Is (x, z) inside the area the survey covers (else nothing can be said)? */
  const covered = (x, z) => x >= X0 && z >= Z0 && x < X0 + MW && z < Z0 + MH;
  return { carriageways, islands, kerbs, onCarriageway, covered };
}

const buffer = await loadBinary(URL_DATA);
export const ROADWAY = buffer ? parse(buffer) : null;
// (the canton's tiles have the same format: js/canton-ground.js)
export { parse as parseRoadway };
