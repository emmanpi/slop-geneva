// tools/perf-bench.mjs
// Reproducible frame-cost measurements in Chrome (WebGPU), with the ?perf=1 profiler (js/perf.js).
//
//   npm run perf                       # baseline + every switch, every viewpoint
//   npm run perf -- --quick            # baseline only, every viewpoint
//   npm run perf -- --views=bellevue --only=systems
//   npm run perf -- --discover         # print the viewpoints (teleport keys) and the scene's layers, then stop
//
// For each viewpoint (a teleport, a mode, the chase camera, a fixed time & weather), it measures the baseline, then the city
// with one part removed at a time ("leave one out"): the cost of a part = baseline - without it.
//   - systems: a per-frame update() skipped (runtime switch)
//   - layers: a top-level scene layer hidden (runtime switch)
//   - render features: shadows, SSR, bloom, MSAA, resolution (a page reload with the URL switch)
// Results: <out>/perf-<date>.json and a Markdown summary next to it. Needs `npm run serve` running (port 8766), or
// --url. Runs a visible Chrome window: WebGPU on the Mac's real GPU, vsync and frame cap off so the numbers show the
// headroom past 60 fps.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const BASE = args.url || 'http://127.0.0.1:8766/';
const OUT = resolve(args.out || 'tools/data/perf');
const WARM = Number(args.warm || 3000);
const MEASURE = Number(args.measure || 5000);
const SETTLE = Number(args.settle || 1500);
const FIXED = { heure: args.heure || '16:45', meteo: args.meteo || 'beau', lang: 'fr' };
const WIDTH = Number(args.width || 1512);
const HEIGHT = Number(args.height || 945);

// Viewpoints: a teleport key (the city's landmarks, see --discover), the player's mode and the chase camera behind it.
// Street level by bike; from the helicopter (~90 m above the ground: the far shadow cascade reaches further and far
// more of the city is in view).
const VIEWS = {
  cornavin: { key: 'cornavin', mode: 'cyclist' }, // station, dense streets, traffic & trams
  montblanc: { key: 'montblanc', mode: 'cyclist' }, // the bridge: flags, the Rade, boats, SSR on the water
  jetdeau: { key: 'jetdeau', mode: 'cyclist' }, // the lake, moored boats
  cathedrale: { key: 'cathedrale', mode: 'cyclist' }, // old town, photomesh
  plainpalais: { key: 'plainpalais', mode: 'cyclist' }, // photomesh, the plain
  heliRade: { key: 'montblanc', mode: 'helicopter' }, // over the Rade, the city all around
  heliVieilleVille: { key: 'cathedrale', mode: 'helicopter' } // over the old town and its photomesh
};

const RENDER_SWITCHES = {
  shadows: 'shadows=0',
  ssr: 'ssr=0',
  bloom: 'bloom=0',
  msaa: 'msaa=0',
  res075: 'res=0.75',
  res050: 'res=0.5', // a big gain here = bound by pixels (fill rate, post-processing), not by geometry or the CPU
  bare: 'shadows=0&ssr=0&bloom=0&msaa=0' // the floor: the scene alone
};

const CHROME_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-webgpu-developer-features', // unquantised timestamp queries
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--autoplay-policy=no-user-gesture-required'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[perf]', ...a);

async function openCity(browser, extra = '') {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => log('page error:', e.message));
  const q = new URLSearchParams({ perf: '1', ...FIXED });
  const url = `${BASE}?${q}${extra ? '&' + extra : ''}`;
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.__slopgeneva?.ready && window.__perf, null, { timeout: 180000, polling: 500 });
  log(`loaded ${extra || 'baseline'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { context, page };
}

async function measure(page, ms = MEASURE) {
  await page.evaluate(() => window.__perf.startWindow());
  await sleep(ms);
  return page.evaluate(() => window.__perf.readWindow());
}

async function gotoView(page, view) {
  await page.evaluate(({ key, mode }) => {
    const s = window.__slopgeneva;
    s.mode(mode);
    s.camera('chase');
    s.teleport(key);
  }, view);
  await sleep(WARM);
}

function pickViews(keys) {
  const wanted = args.views ? String(args.views).split(',') : Object.keys(VIEWS);
  const out = {};
  for (const name of wanted) {
    const view = VIEWS[name] || { key: name, mode: 'cyclist' };
    if (keys.includes(view.key)) out[name] = view;
    else log(`no teleport "${view.key}" (see --discover)`);
  }
  return out;
}

const brief = (r) => r && {
  fps: r.fps, frameMs: r.frameMs.avg, p95: r.frameMs.p95,
  cpu: r.cpuMs.total, gpu: r.gpuMs ? r.gpuMs.total : null,
  draws: r.drawCallsTotal, tris: r.trianglesTotal
};

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: CHROME_FLAGS });
  const result = { date: new Date().toISOString(), fixed: FIXED, viewport: [WIDTH, HEIGHT], views: {}, inventory: null, render: {} };
  try {
    let { context, page } = await openCity(browser);
    const keys = await page.evaluate(() => Object.keys(window.__slopgeneva.TELEPORT_LOCATIONS));
    const layers = await page.evaluate(() => window.__perf.layers());
    const systems = await page.evaluate(() => window.__perf.systems.filter((s) => !['render', 'hud', 'controls', 'misc', 'culling'].includes(s)));
    result.inventory = await page.evaluate(() => window.__perf.inventory());
    result.memory = await page.evaluate(() => window.__perf.memory());
    if (args.discover) {
      console.log('teleports:', keys.join(', '));
      console.log('systems:', systems.join(', '));
      console.table(result.inventory);
      return;
    }
    const views = pickViews(keys);
    log('viewpoints:', JSON.stringify(views));
    const only = args.only ? String(args.only).split(',') : ['systems', 'layers', 'render'];
    // Layers worth testing: those with some weight (the sky, lights & tiny props are left alone)
    const testLayers = result.inventory.filter((r) => r.visible && r.draws > 0 && (r.triangles > 5000 || r.lights > 0 || r.draws > 50)).map((r) => r.name);

    for (const [view, key] of Object.entries(views)) {
      await gotoView(page, key);
      const base = await measure(page);
      const v = (result.views[view] = { teleport: key.key, mode: key.mode, baseline: base, systems: {}, layers: {} });
      log(`${view}: ${JSON.stringify(brief(base))}`);
      if (args.quick) continue;
      if (only.includes('systems')) {
        for (const s of systems) {
          await page.evaluate((n) => window.__perf.setSystem(n, false), s);
          await sleep(SETTLE);
          v.systems[s] = brief(await measure(page, MEASURE * 0.6));
          await page.evaluate((n) => window.__perf.setSystem(n, true), s);
          log(`  -${s}: ${JSON.stringify(v.systems[s])}`);
        }
      }
      if (only.includes('layers')) {
        for (const l of testLayers) {
          await page.evaluate((n) => window.__perf.setLayer(n, false), l);
          await sleep(SETTLE);
          v.layers[l] = brief(await measure(page, MEASURE * 0.6));
          await page.evaluate((n) => window.__perf.setLayer(n, true), l);
          log(`  -${l}: ${JSON.stringify(v.layers[l])}`);
        }
      }
    }
    await context.close();

    if (!args.quick && only.includes('render')) {
      for (const [name, sw] of Object.entries(RENDER_SWITCHES)) {
        ({ context, page } = await openCity(browser, sw));
        result.render[name] = {};
        for (const [view, key] of Object.entries(views)) {
          await gotoView(page, key);
          result.render[name][view] = brief(await measure(page));
          log(`  ${sw} @${view}: ${JSON.stringify(result.render[name][view])}`);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (args.discover) return;

  mkdirSync(OUT, { recursive: true });
  const stamp = result.date.replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = join(OUT, `perf-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  const mdPath = join(OUT, `perf-${stamp}.md`);
  writeFileSync(mdPath, summary(result));
  log('wrote', jsonPath);
  log('wrote', mdPath);
}

// Markdown: per viewpoint, the baseline's passes & sections, then each switch's saving (ms of frame / GPU / CPU)
function summary(r) {
  const L = [];
  L.push(`# Perf bench ${r.date}`, '', `Viewport ${r.viewport.join('x')}, heure ${r.fixed.heure}, météo ${r.fixed.meteo}. Gains = baseline − without.`, '');
  const gain = (b, x) => (x ? `${(b.frameMs.avg - x.frameMs).toFixed(2)} | ${b.gpuMs && x.gpu != null ? (b.gpuMs.total - x.gpu).toFixed(2) : '–'} | ${(b.cpuMs.total - x.cpu).toFixed(2)} | ${b.drawCallsTotal - x.draws}` : '– | – | – | –');
  for (const [view, v] of Object.entries(r.views)) {
    const b = v.baseline;
    L.push(`## ${view} (${v.teleport}, ${v.mode || 'cyclist'})`, '');
    L.push(`**${b.fps} fps**, frame ${b.frameMs.avg} ms (p95 ${b.frameMs.p95}), CPU ${b.cpuMs.total} ms (of which render ${b.cpuMs.sections.render ?? '–'}), ${b.drawCallsTotal} draws, ${(b.trianglesTotal / 1e6).toFixed(2)} M tris`, '');
    if (b.gpuMs) {
      L.push('GPU pass timestamps (indicative only: on Apple GPUs a pass\'s span includes its overlap with the others, so they do not add up to the frame)', '', '| GPU pass | ms | draws | k tris |', '|---|---:|---:|---:|');
      for (const [k, ms] of Object.entries(b.gpuMs.passes)) L.push(`| ${k} | ${ms} | ${Math.round(b.drawCalls[k] || 0)} | ${Math.round((b.triangles[k] || 0) / 1000)} |`);
      L.push('');
    }
    L.push('| CPU section | ms |', '|---|---:|');
    for (const [k, ms] of Object.entries(b.cpuMs.sections)) L.push(`| ${k} | ${ms} |`);
    L.push('');
    const rows = [];
    for (const [k, x] of Object.entries(v.systems)) rows.push(['system ' + k, x]);
    for (const [k, x] of Object.entries(v.layers)) rows.push(['layer ' + k, x]);
    for (const [k, per] of Object.entries(r.render)) if (per[view]) rows.push(['render ' + k, per[view]]);
    if (rows.length) {
      rows.sort((a, c) => (b.frameMs.avg - c[1].frameMs) - (b.frameMs.avg - a[1].frameMs));
      L.push('| without | frame ms saved | GPU-sum ms saved | CPU ms saved | draws saved |', '|---|---:|---:|---:|---:|');
      for (const [k, x] of rows) L.push(`| ${k} | ${gain(b, x)} |`);
      L.push('');
    }
  }
  if (r.inventory) {
    L.push('## Scene inventory (top-level layers)', '', '| layer | visible | meshes | draws | instances | k tris | casters | k caster tris | lights |', '|---|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const x of r.inventory) L.push(`| ${x.name} | ${x.visible ? 'yes' : 'no'} | ${x.meshes} | ${x.draws} | ${x.instances} | ${Math.round(x.triangles / 1000)} | ${x.casters} | ${Math.round(x.casterTriangles / 1000)} | ${x.lights} |`);
  }
  return L.join('\n') + '\n';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
