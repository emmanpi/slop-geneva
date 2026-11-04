import * as THREE from 'three/webgpu';
import { Fn, cos, exp, float, floor, fract, hash, instanceIndex, max, mix, sin, smoothstep, step, uniform, vec2, vec3 } from 'three/tsl';
import { transparentEffectMRT } from './tsl-materials.js';
import { simClock } from './sim-clock.js';
import { seasonDay } from './seasons.js';

// Fireworks over the Rade on the 1st of August (Fête nationale), from barges between the Jetée des Pâquis and the Jet
// d'eau, in every colour while the Jet d'eau is floodlit red (js/jet-deau.js); ?evenement=feux in the URL, or
// __slopgeneva.fireworks(true), sets them off at any time. A GPU particle system: SLOTS shells always in the air, each
// rising from its barge, bursting into SPARKS stars (peonies, willows, rings) that spread, sag and fade.

const SLOTS = 10, SPARKS = 420, PERIOD = 5.5; // a shell every PERIOD / SLOTS seconds
const RISE = 1.6; // s from the barge to the burst
const BARGES = [new THREE.Vector3(780, 1, -330), new THREE.Vector3(900, 1, -250), new THREE.Vector3(660, 1, -250)];
// The show (day of the year, start and end on the city's clock in hours)
const SHOWS = [{ name: '1er Août', day: 212, from: 22, to: 22.5 }];

export function buildFireworks(scene) {
  const uShow = uniform(0); // the show's own clock (s), advancing while it runs
  const uOn = uniform(0);
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  m.mrtNode = transparentEffectMRT;
  const id = float(instanceIndex);
  const slot = floor(id.div(SPARKS));
  const spark = id.sub(slot.mul(SPARKS));
  // this slot's current shell: its number n and its age
  const phase = uShow.div(PERIOD).sub(slot.div(SLOTS));
  const n = floor(phase);
  const age = fract(phase).mul(PERIOD);
  const seed = n.mul(SLOTS).add(slot);
  const r1 = hash(seed.add(0.1)), r2 = hash(seed.add(7.3)), r3 = hash(seed.add(13.9)), r4 = hash(seed.add(21.7));
  const barge = mix(mix(vec3(BARGES[0]), vec3(BARGES[1]), step(0.33, r1)), vec3(BARGES[2]), step(0.66, r1));
  const burstAt = barge.add(vec3(r2.sub(0.5).mul(60), r3.mul(90).add(150), r4.sub(0.5).mul(60)));
  const kind = hash(seed.add(31.1)); // < 0.45 peony, < 0.75 willow (long, gold, drooping), else ring
  // the star's direction: even over the sphere (or a ring)
  const u = hash(seed.mul(17).add(spark.mul(1.618))), w = hash(seed.mul(29).add(spark.mul(2.718)));
  const theta = u.mul(6.2832);
  const zc = mix(w.mul(2).sub(1), w.sub(0.5).mul(0.15), step(0.75, kind));
  const rr = max(float(0), float(1).sub(zc.mul(zc))).sqrt();
  const dir = vec3(rr.mul(cos(theta)), zc, rr.mul(sin(theta)));
  const willow = step(0.45, kind).mul(step(kind, 0.75));
  const speed = mix(float(50), float(34), willow).mul(r2.mul(0.4).add(0.8));
  const t = age.sub(RISE).max(0);
  const drag = mix(float(1.6), float(0.9), willow);
  const spread = float(1).sub(exp(t.mul(drag).negate())).div(drag);
  const sag = mix(float(4), float(7), willow).mul(t).mul(t);
  m.positionNode = Fn(() => {
    // rising shell: only the slot's first spark, climbing on its trail
    const climb = age.div(RISE).min(1);
    const shell = mix(barge, burstAt, float(1).sub(float(1).sub(climb).pow(2)));
    const star = burstAt.add(dir.mul(speed).mul(spread)).sub(vec3(0, sag, 0));
    return mix(shell, star, step(RISE, age));
  })();
  const life = mix(float(2.6), float(4.0), willow);
  const fade = smoothstep(life, life.mul(0.45), t);
  const twinkle = step(0.35, hash(seed.add(spark).add(floor(uShow.mul(14))))).mul(0.6).add(0.4);
  const colours = [vec3(1, 0.25, 0.2), vec3(0.3, 0.6, 1), vec3(0.4, 1, 0.45), vec3(1, 0.85, 0.35), vec3(0.85, 0.4, 1), vec3(1, 1, 1)];
  const ci = hash(seed.add(41.3)).mul(colours.length);
  let col = colours[0];
  for (let i = 1; i < colours.length; i++) col = mix(col, colours[i], step(i, ci));
  col = mix(col, vec3(1, 0.7, 0.3), willow); // willows burn gold
  const rising = float(1).sub(step(RISE, age)).mul(step(spark, 0.5));
  const bursting = step(RISE, age).mul(fade).mul(twinkle);
  m.colorNode = mix(col, vec3(1, 0.85, 0.6), rising).mul(6);
  m.opacityNode = rising.add(bursting).mul(uOn);
  m.scaleNode = vec2(mix(float(2.6), float(1.4), smoothstep(0, 2.5, t)).mul(mix(float(1), float(1.8), rising)));
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
  mesh.count = SLOTS * SPARKS;
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.visible = false;
  mesh.name = 'Fireworks';
  scene.add(mesh);

  // A light over the Rade that flickers with the bursts
  const flash = new THREE.PointLight(0xffd9a0, 0, 1800, 1.4);
  flash.position.set(780, 200, -300);
  scene.add(flash);

  let forced = new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('evenement') === 'feux';
  const state = { show: null };
  function showNow() {
    const day = Math.floor(seasonDay.value), h = simClock.seconds / 3600;
    return SHOWS.find((s) => Math.abs(day - s.day) < 1 && h >= s.from && h < s.to) || null;
  }
  function update(dt) {
    const show = forced ? { name: 'Feu d’artifice' } : showNow();
    state.show = show && show.name;
    const on = !!show;
    if (on && !mesh.visible) uShow.value = 0;
    mesh.visible = on;
    uOn.value = on ? 1 : 0;
    if (!on) { flash.intensity = 0; return; }
    uShow.value += dt;
    // brighter just after each burst
    const pulse = (uShow.value / (PERIOD / SLOTS)) % 1;
    flash.intensity = 9e4 * Math.exp(-pulse * 3) * (0.6 + 0.4 * Math.sin(uShow.value * 23));
  }
  return { mesh, update, state, set(on) { forced = !!on; } };
}
