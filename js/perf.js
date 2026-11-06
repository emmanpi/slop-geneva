import * as THREE from 'three/webgpu';

// js/perf.js
// Frame profiling and the switches to measure what each part of the city costs.
//
// URL parameters, read once at start-up (they also work without ?perf=1, as quality settings):
//   ?perf=1        the profiling overlay, GPU timestamps per pass and window.__perf (tools/perf-bench.mjs)
//   ?shadows=0     no sun shadows (both cascades)
//   ?ssr=0         no screen-space reflections (and the scene pass writes its colour only, no normal / metalRough MRT)
//   ?bloom=0       no bloom
//   ?msaa=0        no 4x MSAA on the scene pass
//   ?res=0.75      render resolution scale (pixel ratio; 1 = CSS pixels, as by default)
//   ?off=a,b       per-frame systems not updated (names: see SYSTEMS in the overlay or __perf.systems)
//   ?hide=a,b      scene layers hidden (top-level scene children, by name or a part of it; see __perf.inventory())
//
// In the frame loop, perf.run('name') closes the previous timed section, opens 'name' and says whether that system is
// on: `if (perf.run('traffic')) trafficSystem.update(...)`. perf.endFrame() closes the last one.

const params = new URLSearchParams(location.search);
const flag = (name, dflt = true) => {
  const v = params.get(name);
  return v === null ? dflt : !(v === '0' || v === 'false' || v === 'off');
};
const list = (name) => (params.get(name) || '').split(',').map((s) => s.trim()).filter(Boolean);

const enabled = flag('perf', false);
const quality = {
  shadows: flag('shadows'),
  ssr: flag('ssr'),
  bloom: flag('bloom'),
  msaa: flag('msaa'),
  res: Math.min(2, Math.max(0.25, Number(params.get('res')) || 1))
};

const off = new Set(list('off'));
const hidden = new Set(list('hide'));

const now = () => performance.now();
// Exponential moving averages, for the overlay
const EMA = 0.05;
const ema = (map, key, v) => map.set(key, map.has(key) ? map.get(key) + (v - map.get(key)) * EMA : v);

// --- CPU sections -------------------------------------------------------------------------------------------------
const cpuAvg = new Map();
let section = null;
let sectionStart = 0;
let frameStart = 0;
const frameSections = new Map(); // this frame's times, for the measurement window
const seenSystems = new Set();

function run(name) {
  const t = now();
  if (section !== null) frameSections.set(section, (frameSections.get(section) || 0) + t - sectionStart);
  else frameStart = t;
  section = name;
  sectionStart = t;
  seenSystems.add(name);
  return !off.has(name);
}

// --- GPU passes (WebGPU timestamp queries, labelled by a renderer inspector) -------------------------------------
let renderer = null;
let mainScene = null;
let mainCamera = null;
let mainTarget = null;
const shadowCams = new Map();
const uidLabel = new Map();
const gpuAvg = new Map();
const drawAvg = new Map();
const triAvg = new Map();
const frameDraws = new Map();
const frameTris = new Map();
let gpuTotalAvg = 0;
let resolving = false;

function passLabel(scene, camera, renderTarget) {
  if (scene && scene.overrideMaterial && scene.overrideMaterial.isShadowPassMaterial) {
    if (!shadowCams.has(camera)) shadowCams.set(camera, shadowCams.size);
    return 'shadow' + shadowCams.get(camera);
  }
  if (scene === mainScene && camera === mainCamera) return renderTarget === mainTarget ? 'scene' : 'scene (other)';
  if (scene === mainScene) return 'scene (other camera)';
  if (!renderTarget) return 'output';
  const name = renderTarget.texture?.name || renderTarget.name || '';
  return name ? 'fx ' + name.replace(/RenderTarget|Node/g, '').replace(/^\W+/, '') : 'fx';
}

class PerfInspector extends THREE.InspectorBase {
  constructor() {
    super();
    this.stack = [];
  }
  beginRender(uid, scene, camera, renderTarget) {
    const label = passLabel(scene, camera, renderTarget);
    uidLabel.set(uid, label);
    const info = this.getRenderer().info.render;
    this.stack.push({ label, d: info.drawCalls, t: info.triangles, childD: 0, childT: 0 });
  }
  finishRender() {
    const top = this.stack.pop();
    if (!top) return;
    const info = this.getRenderer().info.render;
    const d = info.drawCalls - top.d;
    const t = info.triangles - top.t;
    frameDraws.set(top.label, (frameDraws.get(top.label) || 0) + d - top.childD);
    frameTris.set(top.label, (frameTris.get(top.label) || 0) + t - top.childT);
    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      parent.childD += d;
      parent.childT += t;
    }
  }
}

function resolveGpu() {
  if (resolving || !renderer || !renderer.backend.trackTimestamp) return;
  const pool = renderer.backend.timestampQueryPool && renderer.backend.timestampQueryPool.render;
  if (!pool) return;
  resolving = true;
  renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then(() => {
    const byFrame = new Map();
    for (const [uid, ms] of pool.timestamps) {
      const label = uidLabel.get(uid) || 'other';
      const f = uid.slice(uid.lastIndexOf(':f') + 2);
      let fr = byFrame.get(f);
      if (!fr) byFrame.set(f, (fr = new Map()));
      fr.set(label, (fr.get(label) || 0) + ms);
      uidLabel.delete(uid);
    }
    for (const fr of byFrame.values()) {
      let total = 0;
      for (const [label, ms] of fr) {
        ema(gpuAvg, label, ms);
        total += ms;
        if (win) win.gpu.set(label, (win.gpu.get(label) || 0) + ms);
      }
      gpuTotalAvg += (total - gpuTotalAvg) * EMA;
      if (win) {
        win.gpuFrames++;
        win.gpuTotals.push(total);
      }
    }
    // labels of passes whose queries never resolved (pool overflow, lost frames) must not pile up
    if (uidLabel.size > 4096) uidLabel.clear();
  }).catch(() => {}).finally(() => { resolving = false; });
}

// --- Frame end & measurement window -------------------------------------------------------------------------------
let lastFrameEnd = 0;
let win = null; // { frames, frameTimes[], cpu Map, gpu Map, gpuTotals[], draws Map, tris Map }
const frameTimes = [];

const HISTORY = 600;
const history = [];
let historyAt = 0;
// The frames of the history slower than `ms`: the time since the previous frame, the CPU spent in the frame loop
// (what is not CPU waited on the GPU or the browser) and the sections that took over 1 ms
function hitches(ms = 25) {
  return history.filter((h) => h && h.dt > ms).sort((a, b) => a.t - b.t).map((h) => ({
    dt: round(h.dt, 1),
    cpu: round(h.cpu, 1),
    sections: Object.fromEntries(Object.entries(h.sections).filter(([, v]) => v > 1).map(([k, v]) => [k, round(v, 1)]))
  }));
}

function endFrame() {
  const t = now();
  if (section !== null) frameSections.set(section, (frameSections.get(section) || 0) + t - sectionStart);
  section = null;
  const cpuTotal = t - frameStart;
  const dt = lastFrameEnd ? t - lastFrameEnd : 16.7;
  lastFrameEnd = t;
  frameTimes.push(dt);
  if (frameTimes.length > 240) frameTimes.shift();

  for (const [k, v] of frameSections) ema(cpuAvg, k, v);
  ema(cpuAvg, 'total', cpuTotal);
  for (const [k, v] of frameDraws) ema(drawAvg, k, v);
  for (const [k, v] of frameTris) ema(triAvg, k, v);

  if (win) {
    win.frames++;
    win.frameTimes.push(dt);
    win.cpuTotals.push(cpuTotal);
    for (const [k, v] of frameSections) win.cpu.set(k, (win.cpu.get(k) || 0) + v);
    for (const [k, v] of frameDraws) win.draws.set(k, (win.draws.get(k) || 0) + v);
    for (const [k, v] of frameTris) win.tris.set(k, (win.tris.get(k) || 0) + v);
  }
  // the last HISTORY frames, to see what a hitch was made of (hitches())
  history[historyAt] = { t, dt, cpu: cpuTotal, sections: Object.fromEntries(frameSections) };
  historyAt = (historyAt + 1) % HISTORY;
  frameSections.clear();
  frameDraws.clear();
  frameTris.clear();
  resolveGpu();
  if (overlay && t >= nextOverlay) {
    nextOverlay = t + 500;
    drawOverlay();
  }
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const perFrame = (map, n) => Object.fromEntries([...map].map(([k, v]) => [k, round(v / Math.max(1, n))]).sort((a, b) => b[1] - a[1]));

function startWindow() {
  win = { frames: 0, frameTimes: [], cpuTotals: [], cpu: new Map(), gpu: new Map(), gpuFrames: 0, gpuTotals: [], draws: new Map(), tris: new Map() };
}
function readWindow() {
  if (!win) return null;
  const w = win;
  const ft = avg(w.frameTimes);
  return {
    frames: w.frames,
    fps: round(1000 / Math.max(0.001, ft), 1),
    frameMs: { avg: round(ft), p50: round(pct(w.frameTimes, 0.5)), p95: round(pct(w.frameTimes, 0.95)), p99: round(pct(w.frameTimes, 0.99)) },
    cpuMs: { total: round(avg(w.cpuTotals)), p95: round(pct(w.cpuTotals, 0.95)), sections: perFrame(w.cpu, w.frames) },
    gpuMs: w.gpuFrames ? { total: round(avg(w.gpuTotals)), p95: round(pct(w.gpuTotals, 0.95)), passes: perFrame(w.gpu, w.gpuFrames) } : null,
    drawCalls: perFrame(w.draws, w.frames),
    triangles: Object.fromEntries([...w.tris].map(([k, v]) => [k, Math.round(v / Math.max(1, w.frames))]).sort((a, b) => b[1] - a[1])),
    drawCallsTotal: Math.round([...w.draws.values()].reduce((a, b) => a + b, 0) / Math.max(1, w.frames)),
    trianglesTotal: Math.round([...w.tris.values()].reduce((a, b) => a + b, 0) / Math.max(1, w.frames))
  };
}

// --- Scene layers: inventory & hiding -----------------------------------------------------------------------------
function layerName(o, i) {
  return o.name || `${o.type}#${i}`;
}
function layers() {
  return mainScene ? mainScene.children.map((o, i) => ({ name: layerName(o, i), object: o })) : [];
}
function applyHidden() {
  const all = layers();
  const names = new Set(all.map((l) => l.name));
  // a pattern naming a layer exactly hides that layer (all its roots); otherwise every layer whose name contains it
  const matches = (name) => [...hidden].some((p) => (names.has(p) ? name === p : name.toLowerCase().includes(p.toLowerCase())));
  for (const { name, object } of all) {
    const hide = matches(name);
    if (hide) {
      if (object.userData.perfHidden === undefined) object.userData.perfHidden = object.visible;
      object.visible = false;
    } else if (object.userData.perfHidden !== undefined) {
      object.visible = object.userData.perfHidden;
      delete object.userData.perfHidden;
    }
  }
}

// What each top-level layer holds: meshes (visible), draws (a material group counts as one), instances, triangles
// (instances included), shadow-casting meshes. Everything in the tree, whatever the culling decides this frame.
function inventory() {
  const rows = new Map(); // layers of the same name (e.g. the ShadowProxy cells) count as one row
  for (const { name, object } of layers()) {
    let r = rows.get(name);
    if (!r) rows.set(name, (r = { name, visible: false, roots: 0, meshes: 0, visibleMeshes: 0, draws: 0, instances: 0, triangles: 0, casters: 0, casterTriangles: 0, lights: 0 }));
    r.roots++;
    r.visible ||= object.visible;
    object.traverse((o) => {
      if (o.isLight) r.lights++;
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      r.meshes++;
      let vis = true;
      for (let p = o; p && p !== mainScene; p = p.parent) if (!p.visible) { vis = false; break; }
      if (vis) r.visibleMeshes++;
      const geo = o.geometry;
      const n = o.isInstancedMesh ? o.count : (geo && geo.isInstancedBufferGeometry ? geo.instanceCount : 1);
      const groups = Array.isArray(o.material) && geo.groups.length ? geo.groups.length : 1;
      r.draws += groups;
      r.instances += o.isInstancedMesh ? n : 0;
      let tris = 0;
      if (o.isMesh && geo) {
        const count = geo.index ? geo.index.count : (geo.attributes.position ? geo.attributes.position.count : 0);
        tris = (Math.min(count, geo.drawRange.count) / 3) * (Number.isFinite(n) ? n : 1);
      }
      r.triangles += tris;
      if (o.castShadow) {
        r.casters++;
        r.casterTriangles += tris;
      }
    });
  }
  for (const r of rows.values()) {
    r.triangles = Math.round(r.triangles);
    r.casterTriangles = Math.round(r.casterTriangles);
  }
  return [...rows.values()].sort((a, b) => b.triangles - a.triangles);
}

// --- Overlay ------------------------------------------------------------------------------------------------------
let overlay = null;
let overlayText = null;
let overlayButtons = null;
let nextOverlay = 0;

function createOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'perf-overlay';
  overlay.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;max-height:80vh;overflow:auto;padding:8px 10px;' +
    'background:rgba(10,12,16,.82);color:#e8eef5;font:11px/1.35 ui-monospace,Menlo,monospace;border-radius:6px;' +
    'pointer-events:auto;min-width:260px;white-space:pre';
  overlayText = document.createElement('div');
  overlayButtons = document.createElement('div');
  overlayButtons.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;max-width:340px;white-space:normal';
  overlay.append(overlayText, overlayButtons);
  document.body.appendChild(overlay);
}

function drawOverlay() {
  const ft = avg(frameTimes);
  const lines = [];
  lines.push(`FPS ${round(1000 / ft, 0)}  frame ${round(ft, 1)} ms  p95 ${round(pct(frameTimes, 0.95), 1)} ms`);
  const cpuT = cpuAvg.get('total') || 0;
  lines.push(`CPU ${round(cpuT, 1)} ms   GPU ${renderer && renderer.backend.trackTimestamp ? round(gpuTotalAvg, 1) + ' ms' : 'n/a'}`);
  lines.push(`res x${quality.res}  shadows ${quality.shadows ? 'on' : 'off'}  ssr ${quality.ssr ? 'on' : 'off'}  bloom ${quality.bloom ? 'on' : 'off'}  msaa ${quality.msaa ? 'on' : 'off'}`);
  lines.push('— CPU (ms)');
  for (const [k, v] of [...cpuAvg].filter(([k]) => k !== 'total').sort((a, b) => b[1] - a[1]).slice(0, 8)) lines.push(`  ${k.padEnd(16)} ${v.toFixed(2)}${off.has(k) ? '  (off)' : ''}`);
  if (gpuAvg.size) {
    lines.push('— GPU passes (ms · draws · ktris)');
    for (const [k, v] of [...gpuAvg].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      lines.push(`  ${k.padEnd(18)} ${v.toFixed(2).padStart(6)} ${String(Math.round(drawAvg.get(k) || 0)).padStart(6)} ${String(Math.round((triAvg.get(k) || 0) / 1000)).padStart(7)}`);
    }
  }
  overlayText.textContent = lines.join('\n');
  if (overlayButtons.childElementCount !== seenSystems.size) {
    overlayButtons.replaceChildren();
    for (const name of seenSystems) {
      if (name === 'render' || name === 'post') continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.dataset.system = name;
      b.style.cssText = 'font:10px ui-monospace,Menlo,monospace;padding:1px 4px;border-radius:3px;border:1px solid #556;cursor:pointer';
      b.addEventListener('click', () => (off.has(name) ? off.delete(name) : off.add(name)));
      overlayButtons.appendChild(b);
    }
  }
  for (const b of overlayButtons.children) {
    const isOff = off.has(b.dataset.system);
    b.style.background = isOff ? '#5a2026' : '#1d3a2a';
    b.style.color = isOff ? '#f3b7bd' : '#bfe8cf';
  }
}

// A shadow caster with `alphaTest > 0` among the others makes three.js re-hash the node graphs of every caster's shadow
// render object each frame (the shadow passes copy `alphaTest` onto one shared material, bumping its version on each
// switch between 0 and > 0): ~25 ms of CPU per frame with the photomesh. Use alphaTestNode (+ maskShadowNode) instead,
// see createTreeMaterial in tsl-materials.js.
function warnAlphaTestedCasters(scene) {
  const found = new Map();
  scene.traverse((o) => {
    if (!o.castShadow || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.alphaTest > 0) found.set(m.name || m.type, (found.get(m.name || m.type) || 0) + 1);
    }
  });
  if (found.size) console.warn('[perf] alpha-tested shadow casters (use alphaTestNode, see js/perf.js):', Object.fromEntries(found));
}

// One frame's draws, by pass (scene, shadow0, shadow1...), top-level layer and object: what fills each pass.
// Resolves after the next frame: { passes: { label: { draws, ktris, layers: { name: draws }, top: [...] } } }
function drawBreakdown() {
  return new Promise((resolve) => {
    const passes = new Map();
    const original = renderer.renderObject;
    const rootOf = (o) => {
      let p = o;
      while (p.parent && p.parent !== mainScene) p = p.parent;
      return p.parent === mainScene ? layerName(p, mainScene.children.indexOf(p)) : '(detached)';
    };
    const frame = renderer.info.frame + 1; // exactly one whole frame
    renderer.renderObject = function (object, scene, camera, geometry, material, group, ...rest) {
      if (renderer.info.frame !== frame) return original.call(this, object, scene, camera, geometry, material, group, ...rest);
      const label = passLabel(scene, camera, renderer.getRenderTarget());
      let p = passes.get(label);
      if (!p) passes.set(label, (p = { draws: 0, tris: 0, layers: new Map(), objects: new Map() }));
      const geo = geometry || object.geometry;
      const count = geo && (geo.index ? geo.index.count : geo.attributes.position ? geo.attributes.position.count : 0);
      const n = object.isInstancedMesh ? object.count : 1;
      const tris = object.isMesh && count ? (Math.min(count, geo.drawRange.count) / 3) * n : 0;
      p.draws++;
      p.tris += tris;
      const root = rootOf(object);
      p.layers.set(root, (p.layers.get(root) || 0) + 1);
      const src = object.material && !Array.isArray(object.material) ? object.material : material;
      const key = `${root} / ${object.parent && object.parent !== mainScene ? (object.parent.name || object.parent.type) + ' > ' : ''}${object.name || object.type}${object.isInstancedMesh ? ' (inst)' : ''} / mat ${(src && src.name) || (src && src.type) || ''} / geo ${(geo && geo.name) || (geo && geo.type) || ''}`;
      const o = p.objects.get(key) || { draws: 0, tris: 0 };
      o.draws++;
      o.tris += tris;
      p.objects.set(key, o);
      return original.call(this, object, scene, camera, geometry, material, group, ...rest);
    };
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      renderer.renderObject = original;
      const out = {};
      for (const [label, p] of passes) {
        out[label] = {
          draws: p.draws,
          ktris: Math.round(p.tris / 1000),
          layers: Object.fromEntries([...p.layers].sort((a, b) => b[1] - a[1])),
          top: [...p.objects].sort((a, b) => b[1].draws - a[1].draws).slice(0, 80).map(([k, v]) => `${v.draws} draws ${Math.round(v.tris / 1000)}k  ${k}`)
        };
      }
      resolve(out);
    })));
  });
}

// --- Set-up -------------------------------------------------------------------------------------------------------
/** Renderer options from the quality settings, and timestamp queries when profiling */
function rendererOptions() {
  return { antialias: quality.msaa, trackTimestamp: enabled };
}

/** Called once the city and its frame loop are set up */
function attach({ renderer: r, scene, camera, sceneTarget, extra = {} }) {
  renderer = r;
  mainScene = scene;
  mainCamera = camera;
  mainTarget = sceneTarget;
  if (hidden.size) applyHidden();
  warnAlphaTestedCasters(scene);
  if (!enabled) return;
  renderer.inspector = new PerfInspector();
  createOverlay();
  window.__perf = {
    quality: { ...quality },
    get systems() { return [...seenSystems]; },
    get off() { return [...off]; },
    get hidden() { return [...hidden]; },
    layers: () => layers().map((l) => l.name),
    inventory,
    drawBreakdown,
    setSystem(name, on) { if (on) off.delete(name); else off.add(name); },
    setLayer(pattern, visible) { if (visible) hidden.delete(pattern); else hidden.add(pattern); applyHidden(); },
    reset() { for (const k of [...off]) off.delete(k); hidden.clear(); applyHidden(); },
    startWindow,
    hitches,
    readWindow,
    memory: () => (renderer.info.memory ? { ...renderer.info.memory } : null),
    ...extra
  };
}

const perf = { enabled, quality, run, endFrame, rendererOptions, attach, isOff: (name) => off.has(name) };

export { perf };
