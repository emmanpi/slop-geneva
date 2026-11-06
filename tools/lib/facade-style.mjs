// tools/lib/facade-style.mjs — the facade styles, construction periods and storey heights shared by the city and the
// canton facade builders (tools/build-geneva-facades.mjs, tools/build-geneva-canton-facades.mjs). Pure constants and one
// small function, no I/O.

// The facade styles (js/swissbuildings3d.js draws them in this order)
export const STYLES = ['ancien', 'xixe', 'moderne', 'contemporain', 'bureaux', 'inconnu'];
export const S = Object.fromEntries(STYLES.map((s, i) => [s, i]));
// Middle year of each RegBL construction period (GBAUP)
export const PERIOD = { 8011: 1890, 8012: 1932, 8013: 1953, 8014: 1965, 8015: 1975, 8016: 1983, 8017: 1988, 8018: 1993, 8019: 1998, 8020: 2003, 8021: 2008, 8022: 2013, 8023: 2019 };
// Storey height in metres per style, the default when the building's height over its storeys is unknown or implausible
export const DEFAULT_STOREY = [3.1, 3.4, 2.9, 3.0, 3.6, 3.1];

// The style of a RegBL record (or a cadastre-only building shaped like one: { year, period, klass }). `vieilleVille` is
// a (E, N) => boolean test for the old town on its hill, where the pre-1919 buildings are the medieval city; outside it
// they are the 19th-century city. Null (the canton) treats them all as xixe.
export function styleOf(g, E = 0, N = 0, vieilleVille = null) {
  if (!g) return S.inconnu;
  const year = g.year ?? PERIOD[g.period] ?? null;
  if (g.klass === 1272) return S.ancien; // churches and temples: stone
  if (year == null) return S.inconnu;
  const office = g.klass === 1220 || g.klass === 1230 || g.klass === 1231;
  if (year < 1919 && g.period === 8011 && g.year == null) return (vieilleVille && vieilleVille(E, N)) ? S.ancien : S.xixe;
  if (year < 1840) return S.ancien;
  if (year < 1935) return S.xixe;
  if (office && year >= 1960) return S.bureaux;
  if (year < 1980) return S.moderne;
  return office ? S.bureaux : S.contemporain;
}
