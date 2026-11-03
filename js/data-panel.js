import { GENEVA_DATA } from './geneva-geodata.js';
import { TERRAIN_INFO, SHORE } from './terrain.js';
import { PHENO } from './phenology.js';
import { loadTransit } from './transit-data.js';
import { NUM_PEDS } from './pedestrian-system.js';

// The Data panel (toolbar): every layer this project adds to the engine, which knows nothing of Geneva out of the
// box, with its open data source and its numbers, some of them live (what runs right now).

const fmt = (n) => Math.round(n).toLocaleString('fr-CH');
const km = (m) => `${(m / 1000).toLocaleString('fr-CH', { maximumFractionDigits: 1 })} km`;
const polyLength = (pts) => { let L = 0; for (let i = 2; i < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]); return L; };

let facadesInfo = null;
async function facades() {
  if (facadesInfo) return facadesInfo;
  const f = await fetch(new URL('../data/geneva-facades.json', import.meta.url)).then((r) => r.json()).catch(() => null);
  facadesInfo = f ? { archetypes: f.archetypes?.length || 0, measured: (f.archetypes || []).reduce((a, t) => a + t.n, 0) } : { archetypes: 0, measured: 0 };
  return facadesInfo;
}

// Counted once: the static layers
const STATIC = (() => {
  const D = GENEVA_DATA;
  const roads = D.roads.filter((r) => !/^(footway|path|steps|cycleway|pedestrian|track)$/.test(r.kind));
  const paths = D.roads.filter((r) => /^(footway|path|steps|pedestrian)$/.test(r.kind));
  const quayWall = SHORE.filter((s) => s.wall).reduce((a, s) => a + s.L, 0);
  const railing = SHORE.filter((s) => s.wall && !s.underDeck && s.drop > 1.4).reduce((a, s) => a + s.L, 0);
  return {
    trees: D.trees.length,
    evergreen: D.trees.filter((t) => PHENO[t.g]?.evergreen).length,
    roadsKm: roads.reduce((a, r) => a + polyLength(r.pts), 0),
    pathsKm: paths.reduce((a, r) => a + polyLength(r.pts), 0),
    bridges: D.roads.filter((r) => r.bridge && !/^(footway|path|steps)$/.test(r.kind)).length,
    signals: D.signals.length,
    fountains: D.fountains.length,
    osmBuildings: D.buildings.length,
    tramKm: D.railways.filter((r) => r.kind === 'tram' && !r.tunnel).reduce((a, r) => a + polyLength(r.pts), 0),
    railKm: D.railways.filter((r) => r.kind !== 'tram' && !r.tunnel).reduce((a, r) => a + polyLength(r.pts), 0),
    tramStops: D.tramStops.length,
    parks: D.parks.length,
    terrainPoints: TERRAIN_INFO.cols * TERRAIN_INFO.rows,
    quayWall, railing
  };
})();

/**
 * `ctx`: the running systems ({ swissStream, canton, photomesh, cycling, trams, trafficSystem, boats, planes, weather,
 * pedestrians }); returns { open() }
 */
export function createDataPanel(ctx) {
  const dialog = document.getElementById('data-dialog');
  const body = document.getElementById('data-body');
  if (!dialog || !body) return { open() {} };

  async function render() {
    const transit = await loadTransit();
    const f = await facades();
    const count = (kind) => (transit ? transit.trips.filter((t) => transit.lines[t[0]]?.kind === kind).length : 0);
    const lines = (kind) => (transit ? Object.values(transit.lines).filter((l) => l.kind === kind).length : 0);
    const sb = ctx.swissStream?.group?.userData || {};
    const swissBuildings = sb.buildings || ctx.swissStream?.group?.children?.reduce((a, m) => a + (m.geometry?.userData?.buildings || 0), 0) || 0;
    const canton = ctx.canton?.group?.userData?.stats || ctx.canton?.stats || {};
    const pm = ctx.photomesh?.group?.userData?.stats || {};
    const cy = ctx.cycling?.stats || {};
    const trams = ctx.trams?.trams?.length ?? 0;
    const busOnLines = ctx.trafficSystem?.buses?.filter((b) => b.line).length ?? 0;
    const w = ctx.weather?.state?.current;
    const movements = Math.round(((23 - 6) * 3600) / 150 * 0.88);
    const S = STATIC;

    const big = [
      [fmt(swissBuildings), 'immeubles en 3D'],
      [fmt(S.trees), 'arbres recensés'],
      [fmt(count('tram') + count('bus') + count('boat')), 'courses TPG & Mouettes par jour'],
      [fmt(f.measured), 'façades mesurées en photo']
    ];
    const sections = [
      ['Le relief et les images', [
        ['Terrain', 'swisstopo swissALTI3D', `${fmt(S.terrainPoints)} points (4 m), les lits du lac et du Rhône creusés`],
        ['Horizon', 'swisstopo swissALTIRegio', 'le Salève, le Jura, les Voirons, le Mont-Blanc'],
        ['Sol & toits', 'swisstopo SWISSIMAGE', '4 000 × 4 800 px à 1 m, les arbres effacés de la photo ; le canton à 5 m'],
        ['Ponts', 'swisstopo swissSURFACE3D', `${fmt(S.bridges)} tronçons de pont à leur vraie hauteur, balustrades en fer`]
      ]],
      ['Les bâtiments', [
        ['Immeubles', 'swisstopo swissBUILDINGS3D 3.0', `${fmt(swissBuildings)} dans la ville ; ${fmt(canton.tiles || 0)} tuiles pour le canton, chargées autour de la caméra en altitude (${fmt(canton.loaded || 0)} maintenant)`],
        ['Époques & étages', 'OFS, Registre des bâtiments (RegBL)', 'style de façade, hauteur d’étage de chaque immeuble'],
        ['Façades réelles', 'SITG, Photomaillage 3D 2019', `${fmt(f.measured)} immeubles mesurés (couleur, fenêtres, vitrines, texture) → ${f.archetypes} archétypes`],
        ['Ville en photo 3D', 'SITG, Photomaillage 3D 2019', `${fmt(pm.tiles || 0)} tuiles (vieille ville, Plainpalais), ${fmt(pm.full || 0)} en pleine résolution`],
        ['Emprises', 'OpenStreetMap', `${fmt(S.osmBuildings)} bâtiments, ${fmt(S.parks)} parcs et espaces verts`]
      ]],
      ['La nature', [
        ['Arbres', 'SITG, Inventaire cantonal des arbres', `${fmt(S.trees)} arbres à leur hauteur et couronne, dont ${fmt(S.evergreen)} persistants`],
        ['Saisons', 'genre botanique de chaque arbre', `${PHENO.length} calendriers : débourrement, couleurs d’automne, chute des feuilles`],
        ['Météo', 'MeteoSwiss, Genève-Cointrin', w ? `en direct : ${Math.round(w.temp)}°, vent ${Math.round(w.wind * 3.6)} km/h${w.rain > 0.02 ? ', précipitations' : ''}` : 'en direct toutes les 10 minutes'],
        ['Rives', 'OpenStreetMap + swissALTI3D', `${km(S.quayWall)} de murs de quai, ${km(S.railing)} de garde-corps`]
      ]],
      ['La ville qui bouge', [
        ['Trams TPG', 'opentransportdata.swiss (GTFS)', `${lines('tram')} lignes, ${fmt(count('tram'))} courses par jour, ${trams} en circulation maintenant`],
        ['Bus TPG', 'opentransportdata.swiss (GTFS)', `${lines('bus')} lignes, ${fmt(count('bus'))} courses par jour, ${busOnLines} bus sur leur ligne maintenant`],
        ['Mouettes', 'opentransportdata.swiss (GTFS)', `${lines('boat')} lignes, ${fmt(count('boat'))} traversées par jour`],
        ['Avions', 'OpenStreetMap (piste de Cointrin)', `~${fmt(movements)} mouvements par jour, la piste suit le vent`],
        ['Réseau cyclable', 'OpenStreetMap', `${(cy.km || 0).toLocaleString('fr-CH')} km de pistes et bandes, ${cy.riders || 0} cyclistes`],
        ['Rues', 'OpenStreetMap', `${km(S.roadsKm)} de rues, ${km(S.pathsKm)} de chemins, ${fmt(S.signals)} feux suisses`],
        ['Rails', 'OpenStreetMap', `${km(S.tramKm)} de voies de tram, ${km(S.railKm)} de voies CFF, ${fmt(S.tramStops)} arrêts`],
        ['Trafic simulé', 'le moteur, sur ces données', `${fmt(ctx.trafficSystem?.cars?.length || 0)} voitures, ${fmt(ctx.trafficSystem?.bikes?.length || 0)} vélos, ${fmt(NUM_PEDS)} piétons`]
      ]],
      ['Le décor', [
        ['Jet d’eau', 'OpenStreetMap', '2 600 gouttes, coupé hors horaires, par grand vent ou par gel'],
        ['Feux d’artifice', 'calendrier', '1er Août, Fêtes de Genève, Nouvel An'],
        ['Fontaines', 'OpenStreetMap', `${fmt(S.fountains)}`]
      ]]
    ];
    body.innerHTML = `
      <p class="data-lead">Le moteur de départ ne sait rien de Genève : pas un immeuble, pas un arbre, pas un tram. Tout ce qui suit vient de données ouvertes, assemblées ici.</p>
      <div class="data-big">${big.map(([n, l]) => `<div><strong>${n}</strong><span>${l}</span></div>`).join('')}</div>
      ${sections.map(([title, rows]) => `
        <h3 class="data-h">${title}</h3>
        <table class="data-table"><tbody>
          ${rows.map(([layer, source, value]) => `<tr><th>${layer}</th><td>${value}<span class="data-src">${source}</span></td></tr>`).join('')}
        </tbody></table>`).join('')}`;
  }

  return {
    async open() {
      await render().catch((error) => { body.textContent = String(error); });
      if (!dialog.open) dialog.showModal();
    }
  };
}
