import { GENEVA_DATA } from './geneva-geodata.js';
import { TERRAIN_INFO, SHORE } from './terrain.js';
import { PHENO } from './phenology.js';
import { loadTransit } from './transit-data.js';
import { NUM_PEDS } from './pedestrian-system.js';
import { lang, tr } from './i18n.js';

// The Data panel (toolbar): every layer this project adds to the engine, which knows nothing of Geneva out of the
// box, with its open data source and its numbers, some of them live (what runs right now).

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
    signalHeads: (D.signalHeads || []).length / 3,
    signalPoles: (D.signalPoles || []).length / 4,
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

    const L = (en, fr) => tr(en, fr);
    const nf = lang() === 'fr' ? 'fr-CH' : 'en-GB';
    const n = (v) => Math.round(v).toLocaleString(nf);
    const k = (m) => `${(m / 1000).toLocaleString(nf, { maximumFractionDigits: 1 })} km`;
    const big = [
      [n(swissBuildings), L('buildings in 3D', 'immeubles en 3D')],
      [n(S.trees), L('surveyed trees', 'arbres recensés')],
      [n(count('tram') + count('bus') + count('boat')), L('TPG & Mouettes trips a day', 'courses TPG & Mouettes par jour')],
      [n(f.measured), L('facades measured in photos', 'façades mesurées en photo')]
    ];
    const sections = [
      [L('Relief and imagery', 'Le relief et les images'), [
        [L('Terrain', 'Terrain'), 'swisstopo swissALTI3D', L(`${n(S.terrainPoints)} points (4 m), the lake and Rhône beds dug out`, `${n(S.terrainPoints)} points (4 m), les lits du lac et du Rhône creusés`)],
        [L('Horizon', 'Horizon'), 'swisstopo swissALTIRegio', L('the Salève, the Jura, the Voirons, Mont Blanc', 'le Salève, le Jura, les Voirons, le Mont-Blanc')],
        [L('Ground & roofs', 'Sol & toits'), 'swisstopo SWISSIMAGE', L('4,000 × 4,800 px at 1 m, the trees removed from the photo; the canton at 5 m', '4 000 × 4 800 px à 1 m, les arbres effacés de la photo ; le canton à 5 m')],
        [L('Bridges', 'Ponts'), 'swisstopo swissSURFACE3D', L(`${n(S.bridges)} bridge sections at their real height, iron balustrades`, `${n(S.bridges)} tronçons de pont à leur vraie hauteur, balustrades en fer`)]
      ]],
      [L('Buildings', 'Les bâtiments'), [
        [L('Buildings', 'Immeubles'), 'swisstopo swissBUILDINGS3D 3.0', L(`${n(swissBuildings)} in the city; ${n(canton.tiles || 0)} tiles for the canton, loaded around the camera from the air (${n(canton.loaded || 0)} now)`, `${n(swissBuildings)} dans la ville ; ${n(canton.tiles || 0)} tuiles pour le canton, chargées autour de la caméra en altitude (${n(canton.loaded || 0)} maintenant)`)],
        [L('Periods & storeys', 'Époques & étages'), L('FSO, Federal Register of Buildings (RegBL)', 'OFS, Registre des bâtiments (RegBL)'), L('each building’s facade style and storey height', 'style de façade, hauteur d’étage de chaque immeuble')],
        [L('Real facades', 'Façades réelles'), L('SITG, 3D photomesh 2019', 'SITG, Photomaillage 3D 2019'), L(`${n(f.measured)} buildings measured (colour, windows, shop fronts, texture) → ${f.archetypes} archetypes`, `${n(f.measured)} immeubles mesurés (couleur, fenêtres, vitrines, texture) → ${f.archetypes} archétypes`)],
        [L('City in 3D photos', 'Ville en photo 3D'), L('SITG, 3D photomesh 2019', 'SITG, Photomaillage 3D 2019'), L(`${n(pm.tiles || 0)} tiles (old town, Plainpalais), ${n(pm.full || 0)} at full resolution`, `${n(pm.tiles || 0)} tuiles (vieille ville, Plainpalais), ${n(pm.full || 0)} en pleine résolution`)],
        [L('Footprints', 'Emprises'), 'OpenStreetMap', L(`${n(S.osmBuildings)} buildings, ${n(S.parks)} parks and green spaces`, `${n(S.osmBuildings)} bâtiments, ${n(S.parks)} parcs et espaces verts`)]
      ]],
      [L('Nature', 'La nature'), [
        [L('Trees', 'Arbres'), L('SITG, cantonal tree inventory', 'SITG, Inventaire cantonal des arbres'), L(`${n(S.trees)} trees at their height and crown, ${n(S.evergreen)} of them evergreen`, `${n(S.trees)} arbres à leur hauteur et couronne, dont ${n(S.evergreen)} persistants`)],
        [L('Seasons', 'Saisons'), L('each tree’s genus', 'genre botanique de chaque arbre'), L(`${PHENO.length} calendars: leaf-out, autumn colours, leaf fall`, `${PHENO.length} calendriers : débourrement, couleurs d’automne, chute des feuilles`)],
        [L('Weather', 'Météo'), 'MeteoSwiss, Genève-Cointrin', w ? L(`live: ${Math.round(w.temp)}°, wind ${Math.round(w.wind * 3.6)} km/h${w.rain > 0.02 ? ', precipitation' : ''}`, `en direct : ${Math.round(w.temp)}°, vent ${Math.round(w.wind * 3.6)} km/h${w.rain > 0.02 ? ', précipitations' : ''}`) : L('live every 10 minutes', 'en direct toutes les 10 minutes')],
        [L('Shores', 'Rives'), 'OpenStreetMap + swissALTI3D', L(`${k(S.quayWall)} of quay walls, ${k(S.railing)} of railings`, `${k(S.quayWall)} de murs de quai, ${k(S.railing)} de garde-corps`)]
      ]],
      [L('The living city', 'La ville qui bouge'), [
        [L('TPG trams', 'Trams TPG'), 'opentransportdata.swiss (GTFS)', L(`${lines('tram')} lines, ${n(count('tram'))} trips a day, ${trams} running now`, `${lines('tram')} lignes, ${n(count('tram'))} courses par jour, ${trams} en circulation maintenant`)],
        [L('TPG buses', 'Bus TPG'), 'opentransportdata.swiss (GTFS)', L(`${lines('bus')} lines, ${n(count('bus'))} trips a day, ${busOnLines} buses on their lines now`, `${lines('bus')} lignes, ${n(count('bus'))} courses par jour, ${busOnLines} bus sur leur ligne maintenant`)],
        [L('Mouettes', 'Mouettes'), 'opentransportdata.swiss (GTFS)', L(`${lines('boat')} lines, ${n(count('boat'))} crossings a day`, `${lines('boat')} lignes, ${n(count('boat'))} traversées par jour`)],
        [L('Airliners', 'Avions'), L('OpenStreetMap (Cointrin’s runway)', 'OpenStreetMap (piste de Cointrin)'), L(`~${n(movements)} movements a day, the runway follows the wind`, `~${n(movements)} mouvements par jour, la piste suit le vent`)],
        [L('Cycle network', 'Réseau cyclable'), 'OpenStreetMap', L(`${(cy.km || 0).toLocaleString(nf)} km of tracks and lanes, ${cy.riders || 0} cyclists`, `${(cy.km || 0).toLocaleString(nf)} km de pistes et bandes, ${cy.riders || 0} cyclistes`)],
        [L('Streets', 'Rues'), 'OpenStreetMap', L(`${k(S.roadsKm)} of streets, ${k(S.pathsKm)} of paths`, `${k(S.roadsKm)} de rues, ${k(S.pathsKm)} de chemins`)],
        [L('Traffic signals', 'Feux'), L('SITG, OCT signal survey', 'SITG, OCT signalisation lumineuse'), S.signalHeads ? L(`${n(S.signalHeads)} heads on ${n(S.signalPoles)} poles, where they stand`, `${n(S.signalHeads)} feux sur ${n(S.signalPoles)} mâts, à leur place`) : L(`${n(S.signals)} junctions (OpenStreetMap)`, `${n(S.signals)} carrefours (OpenStreetMap)`)],
        [L('Road markings', 'Marquages'), L('SITG, OCT road marking survey', 'SITG, OCT marquages routiers'), L('every line, crossing, arrow and lettering as painted', 'chaque ligne, passage, flèche et inscription, comme peints')],
        [L('Rails', 'Rails'), 'OpenStreetMap', L(`${k(S.tramKm)} of tram track, ${k(S.railKm)} of SBB track, ${n(S.tramStops)} stops`, `${k(S.tramKm)} de voies de tram, ${k(S.railKm)} de voies CFF, ${n(S.tramStops)} arrêts`)],
        [L('Simulated traffic', 'Trafic simulé'), L('the engine, on this data', 'le moteur, sur ces données'), L(`${n(ctx.trafficSystem?.cars?.length || 0)} cars, ${n(ctx.trafficSystem?.bikes?.length || 0)} bicycles, ${n(NUM_PEDS)} pedestrians`, `${n(ctx.trafficSystem?.cars?.length || 0)} voitures, ${n(ctx.trafficSystem?.bikes?.length || 0)} vélos, ${n(NUM_PEDS)} piétons`)]
      ]],
      [L('Set pieces', 'Le décor'), [
        [L('Jet d’eau', 'Jet d’eau'), 'OpenStreetMap', L('2,600 drops; off out of hours, in a gale or a frost', '2 600 gouttes, coupé hors horaires, par grand vent ou par gel')],
        [L('Fireworks', 'Feux d’artifice'), L('the calendar', 'calendrier'), L('1st of August (Season menu)', '1er Août (menu Saison)')],
        [L('Fountains', 'Fontaines'), 'OpenStreetMap', `${n(S.fountains)}`]
      ]]
    ];
    body.innerHTML = `
      <p class="data-lead">${L('The engine knows nothing of Geneva out of the box: not one building, not one tree, not one tram. Everything below comes from open data, put together here.', 'Le moteur de départ ne sait rien de Genève : pas un immeuble, pas un arbre, pas un tram. Tout ce qui suit vient de données ouvertes, assemblées ici.')}</p>
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
