// Tree phenology per genus (pure data: shared by js/seasons.js, js/trees.js and tools/build-geneva-geodata.mjs)

// Phenology classes. Days of the year (Genève, lowland):
//  out: [leaves appear, full leaf]   turn: [colour starts, full colour]   fall: [leaves start dropping, bare]
//  autumn: the turned colour (sRGB)  shape: engine crown shape (0 plane, 1 pinnate locust, 2 broad elm)
export const PHENO = [
  { name: 'feuillu', out: [100, 125], turn: [285, 310], fall: [305, 335], autumn: 0xb08a2c, shape: 2 },
  { name: 'persistant', evergreen: true, shape: 2 },
  { name: 'érable', out: [95, 118], turn: [278, 300], fall: [300, 325], autumn: 0xcc6a22, shape: 2 },
  { name: 'platane', out: [110, 135], turn: [295, 322], fall: [315, 350], autumn: 0xa37b3c, shape: 0 },
  { name: 'marronnier', out: [92, 112], turn: [235, 280], fall: [275, 305], autumn: 0x8a5a24, shape: 2 },
  { name: 'tilleul', out: [105, 125], turn: [275, 298], fall: [292, 318], autumn: 0xc9a227, shape: 2 },
  { name: 'chêne', out: [112, 135], turn: [295, 320], fall: [318, 360], autumn: 0x8c5b26, shape: 2 },
  { name: 'jaune', out: [100, 122], turn: [282, 302], fall: [300, 325], autumn: 0xdcb421, shape: 1 },
  { name: 'rouge', out: [95, 118], turn: [280, 302], fall: [300, 325], autumn: 0xa63c22, shape: 2 }
];

const GENUS = {
  Acer: 2, Platanus: 3, Aesculus: 4, Tilia: 5,
  Quercus: 6, Fagus: 6, Carpinus: 6, Ostrya: 6, Castanea: 6, Zelkova: 6,
  Betula: 7, Ginkgo: 7, Populus: 7, Fraxinus: 7, Gleditsia: 7, Robinia: 7, Sophora: 7, Styphnolobium: 7, Celtis: 7,
  Liriodendron: 7, Salix: 7, Juglans: 7, Catalpa: 7, Alnus: 7, Corylus: 7, Ailanthus: 7, Morus: 7, Paulownia: 7,
  Liquidambar: 8, Parrotia: 8, Prunus: 8, Cercis: 8, Sorbus: 8, Malus: 8, Pyrus: 8, Lagerstroemia: 8, Taxodium: 8,
  Metasequoia: 8, Nyssa: 8, Cornus: 8, Amelanchier: 8, Rhus: 8,
  Pinus: 1, Taxus: 1, Picea: 1, Cedrus: 1, Cupressus: 1, Thuja: 1, Chamaecyparis: 1, Sequoiadendron: 1, Sequoia: 1,
  Abies: 1, Ilex: 1, Buxus: 1, Cupressocyparis: 1, Calocedrus: 1, Juniperus: 1, Laurus: 1, Larix: 7, Ulmus: 7
};

/** Phenology class of a genus (SITG `genus`, Latin) */
export function phenoClass(genus) {
  if (!genus) return 0;
  return GENUS[genus] ?? 0;
}


/** Day-of-year to `{ leaves 0..1, turned 0..1 }` for a class (JS mirror of the shader, for tests & tools) */
export function phenoState(cls, day) {
  const p = PHENO[cls] || PHENO[0];
  if (p.evergreen) return { leaves: 1, turned: 0 };
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return { leaves: ss(p.out[0], p.out[1], day) * (1 - ss(p.fall[0], p.fall[1], day)), turned: ss(p.turn[0], p.turn[1], day) };
}
