// js/communes.js — the canton's 45 communes (data/geneva-communes.json, tools/build-geneva-communes.mjs: swisstopo
// swissBOUNDARIES3D), for the map (outlines, names, search) and the location beyond the city ("Choulex").
// Loaded once by main.js (loadCommunes); communeAt() answers null until then.

const URL_COMMUNES = new URL('../data/geneva-communes.json', import.meta.url);
const URL_CANTON_PHOTO = new URL('../data/geneva-canton-ortho.jpg', import.meta.url);
const URL_CANTON_PHOTO_INFO = new URL('../data/geneva-canton-ortho.json', import.meta.url);

/** The canton's photo for the map (tools/build-geneva-canton.mjs): resolves { img, bounds: [minX, minZ, maxX, maxZ] } */
let photo = null;
export function loadCantonPhoto() {
  photo ??= fetch(URL_CANTON_PHOTO_INFO).then((r) => r.json()).then((info) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ img, bounds: info.bounds });
    img.onerror = reject;
    img.src = URL_CANTON_PHOTO.href;
  }));
  return photo;
}

/** The communes once loaded: [{ bfs, name, label: [x, z], rings: [[[x, z], ...], ...], box: [minX, minZ, maxX, maxZ] }] */
export const COMMUNES = [];
let loading = null;

export function loadCommunes() {
  loading ??= fetch(URL_COMMUNES)
    .then((r) => (r.ok ? r.json() : { communes: [] }))
    .then((data) => {
      for (const c of data.communes) {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const r of c.rings) for (const [x, z] of r) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
        COMMUNES.push({ ...c, box: [x0, z0, x1, z1] });
      }
      return COMMUNES;
    })
    .catch(() => COMMUNES);
  return loading;
}

const inRing = (r, x, z) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
};

/** The commune at (x, z) in world metres, or null (beyond the canton, or not loaded yet) */
export function communeAt(x, z) {
  for (const c of COMMUNES) {
    if (x < c.box[0] || x > c.box[2] || z < c.box[1] || z > c.box[3]) continue;
    if (c.rings.some((r) => inRing(r, x, z))) return c;
  }
  return null;
}
