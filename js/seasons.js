import { uniform } from 'three/tsl';

// Seasons: the trees of the cantonal inventory (SITG) follow their genus through the year: leafing out in spring,
// turning in autumn (maples orange & red, limes and birches yellow, planes tan, chestnuts browning early, oaks and
// beeches bronze), shedding their leaves in late autumn and standing bare in winter; conifers & evergreens stay green.
// The day of the year is a shared uniform (default: today's date; ?jour=AAAA-MM-JJ or ?saison=printemps|ete|automne|hiver
// in the URL, or the Season menu).

import { PHENO } from './phenology.js';
export { PHENO, phenoClass, phenoState } from './phenology.js';

const DAY = 86400000;
export function dayOfYear(date) {
  return (date - new Date(date.getFullYear(), 0, 1)) / DAY;
}

export const SEASON_PRESETS = {
  aujourdhui: { label: "Aujourd'hui", day: null },
  printemps: { label: 'Printemps', sub: 'fin avril', day: 115 },
  ete: { label: 'Été', sub: 'mi-juillet', day: 195 },
  automne: { label: 'Automne', sub: 'fin octobre', day: 300 },
  hiver: { label: 'Hiver', sub: 'mi-janvier', day: 15 }
};

/** The day of the year the trees show (0..365) */
export const seasonDay = uniform(dayOfYear(new Date()));

export function setSeason(id) {
  const p = SEASON_PRESETS[id];
  seasonDay.value = p && p.day != null ? p.day : dayOfYear(new Date());
  return seasonDay.value;
}

export function initSeasonFromURL() {
  const q = new URLSearchParams(location.search);
  const jour = q.get('jour');
  if (jour && !Number.isNaN(Date.parse(jour))) seasonDay.value = dayOfYear(new Date(jour + 'T12:00:00'));
  else if (q.get('saison') && SEASON_PRESETS[q.get('saison')]) setSeason(q.get('saison'));
  return seasonDay.value;
}
