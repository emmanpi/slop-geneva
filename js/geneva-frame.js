import { wgs84ToLv95, lv95ToWgs84 } from './swiss-projection.js';

// The Geneva world frame, shared by the data tools and the browser.
// 1 unit = 1 m, x = LV95 east, z = LV95 south (grid north = -z), y = height above the lake (Léman ≈ 372 m a.s.l.).
// The origin (LV95 2500000 / 1118000) lies on the Rhône by the Pont de la Machine and Bel-Air, at the outlet of the
// lake; LV95 is a conformal metric grid, so the frame is a plain offset.
export const FRAME = {
  name: 'Genève · Centre',
  E0: 2500000,
  N0: 1118000,
  H0: 372,
  // LV95 extent of the mapped city [minE, minN, maxE, maxN]: from the Jonction to the Parc des Eaux-Vives, from
  // Plainpalais and the Bastions up to the Palais des Nations and the Ariana (4.0 × 4.8 km)
  lv95: [2498300, 1116500, 2502300, 1121300],
  // Grid spacing of the terrain model (tools/build-geneva-terrain.mjs)
  terrainCell: 4
};

export const lv95ToWorld = (east, north) => ({ x: east - FRAME.E0, z: FRAME.N0 - north });
export const worldToLv95 = (x, z) => ({ E: FRAME.E0 + x, N: FRAME.N0 - z });
export const lonLatToWorld = (lon, lat) => { const p = wgs84ToLv95(lon, lat); return lv95ToWorld(p.E, p.N); };
export const worldToLonLat = (x, z) => { const p = worldToLv95(x, z); return lv95ToWgs84(p.E, p.N); };

// World bounds [minX, minZ, maxX, maxZ]
export const WORLD_BOUNDS = [
  FRAME.lv95[0] - FRAME.E0, FRAME.N0 - FRAME.lv95[3], FRAME.lv95[2] - FRAME.E0, FRAME.N0 - FRAME.lv95[1]
];
