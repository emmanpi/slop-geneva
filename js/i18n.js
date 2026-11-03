// English by default, French on demand (the EN / FR toolbar button, remembered; or ?lang=fr). The page's own text is
// English with its French in data-fr (data-fr-title, data-fr-aria for the tooltips and labels); the scripts' text
// goes through tr(en, fr). Switching is live: listeners of 'langchange' redraw what they wrote.

let current = 'en';
try { if (localStorage.getItem('slopgeneva.lang') === 'fr') current = 'fr'; } catch { /* private window */ }
if (typeof location !== 'undefined') {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'fr' || q === 'en') current = q;
}

export const lang = () => current;
export const tr = (en, fr) => (current === 'fr' && fr != null ? fr : en);

export function applyI18n(root = document) {
  document.documentElement.lang = current;
  document.title = current === 'fr' ? 'Slop Genève' : 'Slop Geneva';
  for (const el of root.querySelectorAll('[data-fr]')) {
    if (el.dataset.en === undefined) el.dataset.en = el.textContent;
    el.textContent = current === 'fr' ? el.dataset.fr : el.dataset.en;
  }
  for (const el of root.querySelectorAll('[data-fr-title]')) {
    if (el.dataset.enTitle === undefined) el.dataset.enTitle = el.title;
    el.title = current === 'fr' ? el.dataset.frTitle : el.dataset.enTitle;
  }
  for (const el of root.querySelectorAll('[data-fr-aria]')) {
    if (el.dataset.enAria === undefined) el.dataset.enAria = el.getAttribute('aria-label') || '';
    el.setAttribute('aria-label', current === 'fr' ? el.dataset.frAria : el.dataset.enAria);
  }
}

export function setLang(l) {
  current = l === 'fr' ? 'fr' : 'en';
  try { localStorage.setItem('slopgeneva.lang', current); } catch { /* private window */ }
  applyI18n();
  window.dispatchEvent(new CustomEvent('langchange', { detail: current }));
}

// (at once: the loading screen too speaks the chosen language)
if (typeof document !== 'undefined') applyI18n();
