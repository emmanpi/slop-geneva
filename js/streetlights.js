// js/streetlights.js
// Geneva's street lamps and the tram and trolleybus overhead lines (data/geneva-streetlights.bin, from
// tools/build-geneva-streetlights.mjs): lamps { x, z, yaw, kind } (0 post along a kerb, 1 post mapped by OSM, 2 hung
// from a span wire, 3 post-top lantern; yaw turns a post head's +x over the road), the TPG's masts [x, z], its lines
// { kind (0 contact wire, 1 span wire), pts: [x, z, x, z, ...] } and droppers [x, z]. null when the file is missing.

const URL_DATA = new URL('../data/geneva-streetlights.bin', import.meta.url);

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
  const head = new Int32Array(buffer, 0, 7);
  if (head[0] !== 0x544c5347) return null;
  const [, , nLamps, nMasts, nLines, nLinePts, nDroppers] = head;
  let o = 28;
  const l = new Float32Array(buffer, o, nLamps * 4); o += nLamps * 16;
  const lamps = [];
  for (let i = 0; i < nLamps; i++) lamps.push({ x: l[i * 4], z: l[i * 4 + 1], yaw: l[i * 4 + 2], kind: l[i * 4 + 3] });
  const masts = new Float32Array(buffer, o, nMasts * 2); o += nMasts * 8;
  const starts = new Uint32Array(buffer, o, nLines + 1); o += (nLines + 1) * 4;
  const kinds = new Uint8Array(buffer, o, nLines); o += (nLines + 3) & ~3;
  const pts = new Float32Array(buffer, o, nLinePts * 2); o += nLinePts * 8;
  const droppers = new Float32Array(buffer, o, nDroppers * 2);
  const lines = [];
  for (let i = 0; i < nLines; i++) lines.push({ kind: kinds[i], pts: pts.subarray(starts[i] * 2, starts[i + 1] * 2) });
  return { lamps, masts, lines, droppers };
}

const buffer = await loadBinary(URL_DATA);
export const STREETLIGHTS = buffer ? parse(buffer) : null;
