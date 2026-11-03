import * as THREE from 'three/webgpu';
import { Fn, float, fract, hash, instanceIndex, length, mix, smoothstep, time, uniform, vec2, vec3 } from 'three/tsl';
import { cityUniforms, transparentEffectMRT } from './tsl-materials.js';
import { simClock } from './sim-clock.js';

// Geneva's weather: live from MeteoSwiss's automatic station at Genève-Cointrin (open data, 10-minute values, CORS
// open), or a chosen sky. It sets the clouds, the haze and the fog over the light of the hour (lighting.js
// setWeather), wet roads, rain or snow around the camera, the wind in the trees and on the Jet d'eau's plume, and
// stops the Jet d'eau in a gale, a frost or out of its hours (10:00-22:30 here).

const STATION_URL = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/gve/ogd-smn_gve_t_now.csv';

// wind: m/s, dir: where it blows from (degrees, 0 north, 90 east), rain: mm per 10 min, sun: sunshine minutes per 10
export const WEATHER_PRESETS = {
  reel: { label: 'Météo réelle', sub: 'MeteoSwiss · Genève-Cointrin' },
  beau: { label: 'Beau temps', sub: 'soleil, petit vent du sud-ouest', temp: 14, wind: 2, gust: 4, dir: 225, rain: 0, sun: 10, fog: 0 },
  bise: { label: 'Bise', sub: 'ciel clair, vent froid du nord-est', temp: 4, wind: 9, gust: 17, dir: 45, rain: 0, sun: 10, fog: 0 },
  pluie: { label: 'Pluie', sub: 'ciel couvert, averses', temp: 9, wind: 4, gust: 9, dir: 225, rain: 1.2, sun: 0, fog: 0 },
  brouillard: { label: 'Stratus', sub: 'le brouillard de novembre', temp: 3, wind: 0.5, gust: 1, dir: 45, rain: 0, sun: 0, fog: 1 },
  neige: { label: 'Neige', sub: 'flocons, gel', temp: -1, wind: 2, gust: 5, dir: 0, rain: 0.6, sun: 0, fog: 0.2 }
};

async function fetchStation() {
  const text = await (await fetch(STATION_URL)).text();
  const lines = text.trim().split('\n');
  const head = lines[0].split(';');
  const num = (row, k) => { const v = parseFloat(row[head.indexOf(k)]); return Number.isFinite(v) ? v : null; };
  // the latest complete row
  for (let i = lines.length - 1; i > 0; i--) {
    const row = lines[i].split(';');
    const temp = num(row, 'tre200s0'), wind = num(row, 'fkl010z0');
    if (temp == null || wind == null) continue;
    return {
      time: row[head.indexOf('reference_timestamp')], temp, wind, gust: num(row, 'fkl010z1') ?? wind * 1.6,
      dir: num(row, 'dkl010z0') ?? 45, rain: num(row, 'rre150z0') ?? 0, sun: num(row, 'sre000z0') ?? 0,
      radiation: num(row, 'gre000z0') ?? 0, humidity: num(row, 'ure200s0') ?? 70, snow: num(row, 'htoauts0') ?? 0
    };
  }
  throw new Error('no complete row');
}

// --- Rain & snow: streaks / flakes in a box that follows the camera, wrapping around it ------------------------------------
const DROPS = 9000, BOX = vec3(70, 36, 70);
function createPrecipitation() {
  const uCamera = uniform(new THREE.Vector3());
  const uAmount = uniform(0); // 0..1
  const uSnow = uniform(0); // 0 rain .. 1 snow
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  m.mrtNode = transparentEffectMRT; // SSR keeps seeing what lies behind the drops
  const id = float(instanceIndex);
  const r1 = hash(id), r2 = hash(id.add(17.3)), r3 = hash(id.add(41.7)), r4 = hash(id.add(73.1));
  const fallSpeed = mix(float(9), float(1.1), uSnow).mul(r4.mul(0.4).add(0.8));
  m.positionNode = Fn(() => {
    // each drop at its place in a box tiling the world, the box seen from the camera
    const drift = vec2(cityUniforms.uWindX, cityUniforms.uWindZ).mul(cityUniforms.uWindStrength.abs()).mul(mix(float(1.5), float(2.5), uSnow));
    const fall = time.mul(fallSpeed);
    const p = vec3(r1, r2, r3).mul(BOX).add(vec3(drift.x.mul(time), fall.negate(), drift.y.mul(time)));
    const box = fract(p.sub(uCamera).div(BOX)).sub(0.5).mul(BOX);
    // none within 2.5 m of the camera (a drop at the lens is a white bar across the view)
    const r = length(box.xz).max(0.001);
    const local = vec3(box.x.mul(r.max(2.5).div(r)), box.y, box.z.mul(r.max(2.5).div(r)));
    // snow flutters
    const wobble = vec3(time.mul(1.3).add(r1.mul(40)).sin(), 0, time.mul(1.1).add(r2.mul(40)).cos()).mul(uSnow.mul(0.4));
    return uCamera.add(local).add(wobble);
  })();
  m.scaleNode = mix(vec2(0.012, 0.55), vec2(0.06, 0.06), uSnow);
  m.colorNode = mix(vec3(0.62, 0.68, 0.75), vec3(0.95, 0.96, 1.0), uSnow);
  // the drops beyond the amount stay out; the near ones fade in so the box's faces never show
  m.opacityNode = mix(float(0.32), float(0.85), uSnow).mul(r4.lessThan(uAmount).select(1, 0));
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
  mesh.count = DROPS;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.visible = false;
  mesh.name = 'Precipitation';
  return { mesh, uCamera, uAmount, uSnow };
}

export function createWeather({ scene, lighting, jet }) {
  const precipitation = createPrecipitation();
  scene.add(precipitation.mesh);
  const state = { id: 'reel', current: null, live: null, error: null };
  let refresh = 0;

  function apply(w) {
    state.current = w;
    const overcast = w.fog ? 1 : Math.max(0, Math.min(1, w.rain > 0.05 ? 1 : 1 - (w.sun ?? 10) / 10 * (w.radiation == null || w.radiation > 60 ? 1 : 0.4)));
    const fog = w.fog ?? (w.humidity > 96 && w.wind < 1.5 && !(w.sun > 0) ? 0.8 : 0);
    const wet = w.rain > 0.05 ? Math.min(1, 0.55 + w.rain * 0.5) : overcast > 0.9 && w.humidity > 92 ? 0.45 : 0;
    lighting.setWeather({ overcast, fog, wet });
    // wind: blowing towards (x east, z south)
    const a = (w.dir * Math.PI) / 180;
    const tx = -Math.sin(a), tz = Math.cos(a);
    cityUniforms.uWindX.value = tx;
    cityUniforms.uWindZ.value = tz;
    const along = tx * 0.86 + tz * 0.51; // the trees' sway axis (tsl-materials.js TREE_WIND)
    cityUniforms.uWindStrength.value = Math.min(2.6, 0.25 + w.wind / 5 + Math.max(0, w.gust - w.wind) / 15) * (along < -0.2 ? -1 : 1);
    jet?.setWind(tx, tz, w.wind);
    const snowing = w.rain > 0.02 && w.temp <= 0.8;
    precipitation.uSnow.value = snowing ? 1 : 0;
    precipitation.uAmount.value = Math.min(1, w.rain > 0.02 ? 0.25 + w.rain * 0.6 : 0);
    precipitation.mesh.visible = precipitation.uAmount.value > 0;
  }

  async function loadLive() {
    try {
      state.live = await fetchStation();
      state.error = null;
    } catch (error) {
      state.error = String(error);
      console.warn('[weather] MeteoSwiss not reachable, staying with a fair sky:', error);
      state.live = null;
    }
    if (state.id === 'reel') apply(state.live || WEATHER_PRESETS.beau);
    return state.live;
  }

  function set(id) {
    state.id = WEATHER_PRESETS[id] ? id : 'reel';
    if (state.id === 'reel') return loadLive();
    apply(WEATHER_PRESETS[state.id]);
    return Promise.resolve(state.current);
  }

  function update(dt, camera, now = performance.now()) {
    if (precipitation.mesh.visible) precipitation.uCamera.value.copy(camera.position);
    // the live values refresh every 10 minutes
    if (state.id === 'reel' && now > refresh) { refresh = now + 600000; if (state.live) loadLive(); }
    // the Jet d'eau: 10:00-22:30, not in a gale (gusts over 50 km/h) nor a frost
    const w = state.current;
    if (jet && w) {
      const h = simClock.seconds / 3600;
      const on = h >= 10 && h < 22.5 && w.gust * 3.6 < 50 && w.temp > 0.5;
      if (on !== jet.running) jet.setRunning(on);
    }
  }

  /** A short line for the toolbar: "9° · bise 24 km/h" */
  function summary() {
    const w = state.current;
    if (!w) return 'Météo';
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    const from = dirs[Math.round(((w.dir % 360) + 360) % 360 / 45) % 8];
    const kmh = Math.round(w.wind * 3.6);
    const wind = from === 'NE' || from === 'N' && kmh > 12 ? `bise ${kmh} km/h` : kmh < 6 ? 'calme' : `${from} ${kmh} km/h`;
    const sky = w.fog > 0.5 ? 'stratus' : w.rain > 0.02 ? (w.temp <= 0.8 ? 'neige' : 'pluie') : '';
    return `${Math.round(w.temp)}° · ${sky ? `${sky} · ` : ''}${wind}`;
  }

  return { set, update, summary, state, precipitation };
}
