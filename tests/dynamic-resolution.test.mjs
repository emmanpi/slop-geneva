import assert from 'node:assert/strict';
import test from 'node:test';
import { createDynamicResolution, MIN_SCALE } from '../js/dynamic-resolution.js';

// A renderer whose frame time follows a cost model of its pixel ratio; `seconds` of frames at that frame time
function run(cost, seconds, { max = 1 } = {}) {
  const renderer = { ratio: max, changes: 0, setPixelRatio(r) { this.ratio = r; this.changes++; } };
  const dyn = createDynamicResolution(renderer, { max });
  let now = 0;
  const trace = [];
  while (now < seconds * 1000) {
    const ms = cost(renderer.ratio);
    now += ms;
    dyn.update(ms, now);
    trace.push(renderer.ratio);
  }
  return { renderer, dyn, trace };
}

test('GPU-bound: the scale drops until the frame fits in ~60 fps, and stays there', () => {
  // 22 ms at full resolution, the pixels' share scaling with the pixel count
  const { renderer, trace } = run((r) => 6 + 16 * r * r, 60);
  assert.ok(renderer.ratio < 1 && renderer.ratio >= MIN_SCALE, `settled at ${renderer.ratio}`);
  assert.ok(6 + 16 * renderer.ratio ** 2 <= 18.2 + 1e-9, 'the frame fits');
  // no endless oscillation: a handful of changes over the last 30 s (backed-off probes at most)
  const last = trace.slice(-1500);
  let flips = 0;
  for (let i = 1; i < last.length; i++) if (last[i] !== last[i - 1]) flips++;
  assert.ok(flips <= 4, `${flips} changes in the last frames`);
});

test('CPU-bound: lowering the resolution does not help, so the image stays sharp', () => {
  const { renderer } = run(() => 22, 30);
  assert.equal(renderer.ratio, 1);
});

test('light load: the resolution never moves', () => {
  const { renderer } = run(() => 12, 30);
  assert.equal(renderer.ratio, 1);
  assert.equal(renderer.changes, 0);
});

test('heavy GPU load: never below the minimum scale', () => {
  const { renderer } = run((r) => 10 + 40 * r * r, 30);
  assert.equal(renderer.ratio, MIN_SCALE);
});

test('a single hitch does not move the resolution', () => {
  let n = 0;
  const { renderer } = run(() => (++n === 500 ? 300 : 14), 20);
  assert.equal(renderer.changes, 0);
});

test('back to full resolution within seconds once the load is light again', () => {
  const renderer = { ratio: 1, setPixelRatio(r) { this.ratio = r; } };
  const dyn = createDynamicResolution(renderer);
  let now = 0;
  const frames = (cost, seconds) => { const end = now + seconds * 1000; while (now < end) { const ms = cost(renderer.ratio); now += ms; dyn.update(ms, now); } };
  frames((r) => 10 + 40 * r * r, 20); // the helicopter over the city
  assert.equal(renderer.ratio, MIN_SCALE);
  frames(() => 12, 10); // landed: plenty of room
  assert.equal(renderer.ratio, 1);
});

test('vsync-capped light load after a heavy one: climbs back within ~15 s', () => {
  const renderer = { ratio: 1, setPixelRatio(r) { this.ratio = r; } };
  const dyn = createDynamicResolution(renderer);
  let now = 0;
  const frames = (cost, seconds) => { const end = now + seconds * 1000; while (now < end) { const ms = cost(renderer.ratio); now += ms; dyn.update(ms, now); } };
  frames((r) => 10 + 40 * r * r, 20);
  frames(() => 1000 / 60, 15);
  assert.equal(renderer.ratio, 1);
});

test('vsync: a step down that cannot reach the next refresh is undone (no blur for nothing)', () => {
  // 60 Hz: anything over 16.7 ms is shown for 33.3 ms; the GPU needs 20 ms at full resolution, 18 at 0.85
  const { renderer } = run((r) => (10 + 10 * r * r > 1000 / 60 ? 1000 / 30 : 1000 / 60), 30);
  assert.equal(renderer.ratio, 1);
});

test('sharper than 1 on a Retina display when there is room, and back when it costs frames', () => {
  const renderer = { ratio: 1, setPixelRatio(r) { this.ratio = r; } };
  const dyn = createDynamicResolution(renderer, { max: 1.5, start: 1 });
  let now = 0;
  const frames = (cost, seconds) => { const end = now + seconds * 1000; while (now < end) { const ms = cost(renderer.ratio); now += ms; dyn.update(ms, now); } };
  frames((r) => 4 + 4 * r * r, 20); // street level: plenty of room
  assert.equal(renderer.ratio, 1.5);
  frames((r) => 8 + 8 * r * r, 30); // a heavier view: 26 ms at 1.5, 16 at 1
  assert.ok(8 + 8 * renderer.ratio ** 2 <= 18.2 && renderer.ratio >= 1, `the frame fits again (${renderer.ratio})`);
});

test('from a sharp view into a heavy one: back to 1 at once, even when the vsync hides the gain', () => {
  const renderer = { ratio: 1, setPixelRatio(r) { this.ratio = r; } };
  const dyn = createDynamicResolution(renderer, { max: 1.5, start: 1 });
  let now = 0;
  const frames = (cost, seconds) => { const end = now + seconds * 1000; while (now < end) { const ms = cost(renderer.ratio); now += ms; dyn.update(ms, now); } };
  frames(() => 8, 20);
  assert.equal(renderer.ratio, 1.5);
  // 120 Hz: frames rounded to 8.3 ms; 26 ms at 1.5, 20 at 1: both rounded to 25 ms
  frames((r) => Math.ceil((14 + 6 * r * r) / (1000 / 120)) * (1000 / 120), 10);
  assert.equal(renderer.ratio, 1);
});
