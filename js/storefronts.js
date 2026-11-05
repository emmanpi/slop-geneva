import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, color, mix, max, min, abs, clamp, step, smoothstep, floor, fract, sign, fwidth,
  log2, pow, dot, normalize, texture, positionWorld, normalWorld, cameraPosition
} from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';

// Ground-floor shops for the swissBUILDINGS3D facades (js/swissbuildings3d.js), after Slop New York's storefronts
// (mrdoob/slop-newyork 8d88e41): a painted shopfront several window bays wide, its display glazing, a glazed door
// with handle and kick plate, a transom, a fascia sign, and behind the glass a room in parallax (interior mapping:
// back wall with shelves of goods, a counter nearer the glass, ceiling lamps), the sky glancing off it.
// Geneva's walls stand at any angle: positions are taken along the wall's own horizontal tangent, read left to right
// by someone facing it, and up from the building's surveyed ground point.

const SHOP_WIDTH = 7.5; // m, one shop unit
const LABELS = ['BOULANGERIE', 'PHARMACIE', 'TABAC · JOURNAUX', 'HORLOGERIE', 'CHOCOLATIER', 'FLEURISTE', 'LIBRAIRIE', 'CAFÉ'];

let signTexture = null;
function getSignTexture() {
  if (signTexture) return signTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.font = '600 32px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  LABELS.forEach((label, i) => ctx.fillText(label, 256, i * 64 + 32, 464));
  signTexture = new THREE.CanvasTexture(canvas);
  signTexture.generateMipmaps = true;
  signTexture.minFilter = THREE.LinearMipmapLinearFilter;
  return signTexture;
}

// Fraction of a footprint of half width s around x that lies in [a, b] (box-filtered, no shimmer at distance)
const boxCoverage = Fn(([x, a, b, s]) => {
  const xv = float(x).toVar();
  const sv = max(float(s), 0.001).toVar();
  return clamp(min(xv.add(sv), b).sub(max(xv.sub(sv), a)).div(sv.mul(2.0)), 0.0, 1.0);
});
const hash = (p) => fract(dot(p, vec2(127.1, 311.7)).sin().mul(43758.5453));
const pulse = Fn(([x, a, b, w]) => {
  const p = float(x).toVar(), hw = max(float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => floor(t).mul(float(b).sub(a)).add(clamp(fract(t), a, b).sub(a));
  return integral(p.add(hw)).sub(integral(p.sub(hw))).div(hw.mul(2.0));
});

/**
 * Storefront nodes for a wall pixel. `above`: metres above the building's ground point; `groundTop`: height of its
 * ground floor; `enabled`: 1 where this building's wall carries shops (wall, secular, the archetype's share); `seed`:
 * a per-building constant. Returns the mask and its colour, emissive, roughness and glazing to mix over the wall.
 */
export function createStorefront({ above, groundTop, enabled, seed }) {
  // the wall's horizontal frame: outward normal n, tangent t pointing to the right of someone facing the wall
  const n = normalize(vec3(normalWorld.x, 0, normalWorld.z).add(vec3(0.00001, 0, 0)));
  const t = vec3(n.z, 0, n.x.negate());
  const horizontal = dot(positionWorld.xz, t.xz);
  const width = float(SHOP_WIDTH);
  const grid = horizontal.div(width);
  const x = fract(grid).mul(width), y = above;
  const fw = vec2(fwidth(grid).mul(width), fwidth(y)).toVar();
  const band = (p, a, b, w) => boxCoverage(p, a, b, w.mul(0.5));
  // ground floor only (none below the ground, on the skirts carried down slopes)
  const signTop = min(float(3.56), groundTop.sub(0.04));
  const mask = enabled.mul(step(0, y)).mul(step(y, signTop.add(0.08))).toVar();
  const id = vec2(floor(grid), seed.mul(113.0));
  const choice = hash(id.add(vec2(3.1, 17.2)));
  const lit = step(0.28, hash(id.add(vec2(37.1, 9.8))));
  const doorX = mix(float(0.24), width.sub(1.36), step(0.5, choice));
  const door = band(x, doorX, doorX.add(1.12), fw.x);
  const doorPane = band(x, doorX.add(0.06), doorX.add(1.06), fw.x).mul(band(y, 0.32, 2.42, fw.y));
  const display = band(x, 0.18, width.sub(0.18), fw.x).mul(band(y, 0.58, 2.88, fw.y));
  const transom = band(y, 2.46, 2.52, fw.y);
  const glass = max(display.mul(float(1).sub(max(door, transom))), doorPane)
    .add(display.mul(door).mul(band(y, 2.52, 2.88, fw.y))).clamp(0, 1);
  const handle = band(x, doorX.add(0.85), doorX.add(0.89), fw.x).mul(band(y, 1.05, 1.46, fw.y));
  const kickplate = door.mul(band(y, 0.23, 0.32, fw.y));
  const metal = max(handle, kickplate);
  const glazing = glass.mul(float(1).sub(handle)).toVar();
  // shopfront paint: Geneva greens, browns, slate and a deep oxblood
  const paint = mix(mix(mix(color(0x263831), color(0x463b30), step(0.3, choice)), color(0x242a32), step(0.62, choice)), color(0x4a2226), step(0.86, choice));
  const signHeight = signTop.sub(2.96).max(0.2);
  const signWidth = min(width.mul(0.82), 5.5);
  const signUV = vec2(x.sub(width.mul(0.5)).div(signWidth).add(0.5), y.sub(2.96).div(signHeight));
  const signLod = log2(max(fw.x.mul(512).div(signWidth), fw.y.mul(64).div(signHeight)));
  const signMask = band(signUV.x, 0, 1, fw.x.div(signWidth))
    .mul(band(signUV.y, 0, 1, fw.y.div(signHeight))).mul(float(1).sub(smoothstep(4, 6, signLod)));
  const signInk = Fn(() => {
    const ink = float(0).toVar();
    If(mask.mul(signMask).greaterThan(0.001), () => {
      const atlasUV = vec2(signUV.x.clamp(0, 1), float(1).sub(floor(choice.mul(8)).add(float(1).sub(signUV.y.clamp(0, 1))).div(8)));
      ink.assign(texture(getSignTexture(), atlasUV).level(signLod.clamp(0, 5)).a.mul(signMask));
    });
    return ink;
  })().toVar();
  const frame = mix(mix(paint, color(0x92958d), metal), color(0xe0d7bb), signInk);

  const interior = Fn(() => {
    const result = vec4(0).toVar();
    If(mask.greaterThan(0.001), () => {
      const light = mix(color(0xffd49a), color(0xe0edee), step(0.58, choice));
      const room = color(0x343330).toVar();
      const fixture = float(0).toVar();
      // fine displays fade before they turn subpixel; distant shops keep their average light level
      const detail = float(1).sub(smoothstep(0.06, 0.20, max(fw.x, fw.y)));
      If(detail.greaterThan(0.001).and(glazing.greaterThan(0.001)), () => {
        const ray = positionWorld.sub(cameraPosition);
        const inward = max(abs(dot(ray, n)), 0.1);
        const dx = dot(ray, t).div(inward);
        const dy = ray.y.div(inward);
        const ox = x.sub(width.mul(0.5)), oy = y.sub(1.55);
        const tx = width.mul(0.5).sub(ox.mul(sign(dx))).div(max(abs(dx), 0.001));
        const ty = float(1.55).sub(oy.mul(sign(dy))).div(max(abs(dy), 0.001));
        const depth = min(min(tx, ty), 3.6);
        const px = x.add(dx.mul(depth)), py = y.add(dy.mul(depth));
        const onSide = step(tx, min(ty, 3.6));
        const onHorizontal = step(ty, min(tx, 3.6));
        const ceiling = onHorizontal.mul(step(0, dy));
        const floorMask = onHorizontal.mul(float(1).sub(step(0, dy)));
        const back = float(1).sub(max(onSide, onHorizontal));
        const roomFw = fw.mul(float(1).add(float(3.6).div(inward)));
        const shelfY = py.div(0.55);
        const shelves = pulse(fract(shelfY), 0.05, 0.13, roomFw.y.div(0.55))
          .mul(band(py, 0.5, 2.3, roomFw.y)).mul(band(px, 0.3, width.sub(0.3), roomFw.x)).mul(back);
        const goodsX = px.div(0.28);
        const goodsSeed = hash(vec2(floor(goodsX), floor(shelfY)).add(choice.mul(31)));
        const goods = pulse(fract(goodsX), 0.12, 0.88, roomFw.x.div(0.28))
          .mul(pulse(fract(shelfY), 0.14, goodsSeed.mul(0.28).add(0.5), roomFw.y.div(0.55)))
          .mul(band(py, 0.5, 2.3, roomFw.y)).mul(back).mul(step(0.3, choice));
        const wall = mix(color(0x716557), color(0x596462), choice);
        const shell = mix(mix(wall, color(0x33302b), floorMask), color(0x9b9689), ceiling);
        const stock = mix(color(0x88654a), color(0x617b80), goodsSeed);
        const stocked = mix(mix(shell, stock, goods), color(0x30251b), shelves);
        // a counter nearer the glass than the rear shelves: they slide past at different rates as we walk by
        const displayX = x.add(dx.mul(1.3)), displayY = y.add(dy.mul(1.3));
        const counter = band(displayY, 0.65, 1.10, fw.y.mul(1.5))
          .mul(band(displayX, 0.2, width.sub(0.2), fw.x.mul(1.5))).mul(step(1.3, depth)).mul(float(1).sub(door));
        const furnished = mix(stocked, color(0x453a2d), counter.mul(0.82));
        const edgeShade = smoothstep(0, 0.5, min(px, width.sub(px))).mul(0.35).add(0.65);
        room.assign(mix(room, furnished.mul(edgeShade).mul(mix(0.58, 1, lit)), detail));
        const lamp = band(px, width.mul(0.18), width.mul(0.82), roomFw.x)
          .mul(band(depth, 0.65, 0.82, roomFw.y)).mul(ceiling);
        const backLight = band(py, 2.45, 2.52, roomFw.y).mul(back)
          .mul(band(px, 0.5, width.sub(0.5), roomFw.x));
        fixture.assign(max(lamp, backLight).mul(detail));
      });
      const view = normalize(cameraPosition.sub(positionWorld));
      const fresnel = pow(clamp(float(1).sub(abs(dot(view, n))), 0, 1), 2);
      const glassColor = mix(room.mul(light).mul(mix(0.35, 0.95, lit)), cityUniforms.uSkyHorizonColor, fresnel.mul(0.65).add(0.10));
      result.assign(vec4(mix(glassColor, light, fixture.mul(lit)), lit.mul(float(0.55).add(fixture.mul(2.2))).mul(float(1).sub(fresnel.mul(0.8)))));
    });
    return result;
  })().toVar();

  return {
    mask,
    glazing,
    color: mix(frame, interior.rgb, glazing),
    emissive: interior.rgb.mul(interior.a).mul(glazing).add(color(0xe0d7bb).mul(signInk).mul(lit).mul(0.12)).mul(cityUniforms.uInteriorGlow),
    roughness: mix(float(0.58), float(0.14).add(float(1).sub(smoothstep(0.3, 0.9, y)).mul(0.16)), glazing)
  };
}
