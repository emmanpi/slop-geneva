// tools/lib/canton-area.mjs — the commune/canton outlines and the small LV95 geometry helpers shared by the canton
// facade tools (fetch-canton-footprints, build-geneva-canton-facades, sample-photomesh-facades --canton). Pure geometry
// plus one fetcher for a commune's swissBOUNDARIES3D outline. Rings are lists of [E, N] polygons (LV95, EPSG:2056).

// Point in a single ring (ray casting)
export function pointInPoly(poly, E, N) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i][1] > N) !== (poly[j][1] > N) && E < ((poly[j][0] - poly[i][0]) * (N - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) inside = !inside;
  }
  return inside;
}

// Point in any of the rings (a MultiPolygon's outer rings)
export function pointInRings(rings, E, N) {
  return rings.some((r) => pointInPoly(r, E, N));
}

// Distance from (E, N) to the nearest edge of any ring (squared-distance check against `d`)
export function pointNearRings(rings, E, N, d) {
  const d2 = d * d;
  return rings.some((r) => r.some(([x, y], i) => {
    const [x2, y2] = r[(i + 1) % r.length], dx = x2 - x, dy = y2 - y;
    const t = Math.max(0, Math.min(1, ((E - x) * dx + (N - y) * dy) / (dx * dx + dy * dy || 1)));
    return (E - x - t * dx) ** 2 + (N - y - t * dy) ** 2 < d2;
  }));
}

// Bounding box of the rings, grown by `margin`
export function ringsBbox(rings, margin = 0) {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const r of rings) for (const [e, n] of r) { minE = Math.min(minE, e); minN = Math.min(minN, n); maxE = Math.max(maxE, e); maxN = Math.max(maxN, n); }
  return [minE - margin, minN - margin, maxE + margin, maxN + margin];
}

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return ((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0));
}

// Does polygon `poly` intersect any of the rings (vertex containment or an edge crossing)?
export function polyIntersectsRings(rings, poly) {
  for (const p of poly) if (pointInRings(rings, p[0], p[1])) return true;
  for (const r of rings) for (const p of r) if (pointInPoly(poly, p[0], p[1])) return true;
  for (const r of rings) for (let i = 0; i < r.length; i++) for (let j = 0; j < poly.length; j++) {
    if (segmentsCross(r[i], r[(i + 1) % r.length], poly[j], poly[(j + 1) % poly.length])) return true;
  }
  return false;
}

// A commune's outline (swissBOUNDARIES3D gemeinde-flaeche, LV95). `bfs` is the BFS commune number (Thônex 6640).
export async function fetchCommune(bfs) {
  const url = `https://api3.geo.admin.ch/rest/services/api/MapServer/ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill/${bfs}?geometryFormat=geojson&sr=2056`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`commune ${bfs}: ${res.status}`);
  const body = await res.json();
  const f = body.feature ?? body;
  const geometry = f.geometry;
  const coords = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const rings = coords.map((poly) => poly[0].map(([e, n]) => [e, n]));
  return { bfs, name: f.properties?.label ?? f.properties?.gemname ?? String(bfs), rings };
}

// The middle year of a cadastre EPOQUE_CONSTRUCTION label ("Période de 1976 à 1980", "Avant 1919", …), else null.
export function epochYear(s) {
  if (!s) return null;
  const ys = (String(s).match(/\d{4}/g) || []).map(Number);
  if (ys.length >= 2) return Math.round((ys[0] + ys[1]) / 2);
  if (ys.length === 1) return /avant/i.test(s) ? ys[0] - 19 : ys[0];
  return null;
}
