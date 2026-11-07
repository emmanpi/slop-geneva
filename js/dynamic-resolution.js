// js/dynamic-resolution.js
// Dynamic resolution: the renderer's pixel ratio follows the frame time, to hold 60 fps where the GPU is the limit
// (the helicopter over the city: ~10-16 M triangles in 4x MSAA) without blurring the street level, where it is not.
//
// - Down: when the median frame of the last half second is over HIGH_MS (under ~55 fps), the scale drops a step, never
//   below MIN_SCALE. A step that did not shorten the frame (by 3%) is undone and the scale holds for a minute instead
//   of blurring the image for nothing: the CPU is the limit there, or the display's vsync rounds the frame up to the
//   same 33 ms whatever the resolution.
// - Above 1 on a high-density display (Retina), up to `max`: sharper wherever there is room (street level, the
//   countryside), probed up from `start` like any step up, and dropped back to `start` at once when frames slow down.
// - Up: after a couple of seconds at 60 fps (median under LOW_MS), it probes a step up, a bigger one with plenty of
//   room (median under ROOMY_MS) or after a probe that held, so it is back to full resolution within seconds of
//   landing; if the frames slow down again it steps back and waits twice as long before the next probe.
// - Each change re-allocates the render targets: at most one a second.
//
// ?dynres=0 turns it off; an explicit ?res=... fixes the resolution (js/perf.js).

const MIN_SCALE = 0.85;
const HIGH_MS = 18.2;
const LOW_MS = 17.2;
const SETTLE_MS = 1000; // after a change, before judging it
const WINDOW_MS = 500;
const ROOMY_MS = 13; // plenty of room under the 60 fps frame: bigger, quicker steps up
const PROBE_MS = 2000; // at 60 fps this long before probing upwards (doubles after a failed probe, up to MAX_PROBE_MS)
const NEXT_PROBE_MS = 1000; // after a probe that held
const MAX_PROBE_MS = 60000;
const CPU_HOLD_MS = 60000; // after an ineffective step down
const EFFECTIVE = 0.97; // a step down must bring the frame under this share of what it was (and 0.4 ms shorter)
const STEP_DOWN = 0.1;
const STEP_UP = 0.05;

function createDynamicResolution(renderer, { max = 1, start = Math.min(1, max), enabled = true } = {}) {
  let scale = start;
  let lastChange = -Infinity;
  let lastAction = null; // 'down' | 'up'
  let beforeChangeMs = 0; // median frame before the last change
  let beforeChangeScale = start; // and the scale then
  let probeMs = PROBE_MS;
  let held = 0; // probes up in a row that held
  let goodSince = -Infinity;
  let lastStep = STEP_UP;
  let holdUntil = -Infinity;
  const samples = []; // [time, frame ms]

  const median = (now) => {
    const v = [];
    for (const [t, ms] of samples) if (now - t <= WINDOW_MS) v.push(ms);
    if (v.length < 8) return NaN;
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
  };

  function apply(next, now, action, current) {
    next = Math.round(Math.min(max, Math.max(MIN_SCALE, next)) * 100) / 100;
    if (next === scale) return;
    beforeChangeScale = scale;
    scale = next;
    renderer.setPixelRatio(scale);
    lastChange = now;
    lastAction = action;
    beforeChangeMs = current;
    samples.length = 0;
  }

  /** Per frame, with the wall-clock time between frames (ms) */
  function update(frameMs, now = performance.now()) {
    if (!enabled) return;
    if (frameMs > 100) return; // a hitch (teleport, a tab switch), not the steady load
    samples.push([now, frameMs]);
    while (samples.length && now - samples[0][0] > WINDOW_MS) samples.shift();
    if (now - lastChange < SETTLE_MS) return;
    const ms = median(now);
    if (Number.isNaN(ms)) return;

    // Judge the last change once settled
    if (lastAction === 'down') {
      lastAction = null;
      if (ms > Math.min(beforeChangeMs * EFFECTIVE, beforeChangeMs - 0.4)) {
        // no faster at a lower resolution: the CPU is the limit here, or the vsync
        apply(beforeChangeScale, now, null, ms);
        holdUntil = now + CPU_HOLD_MS;
        return;
      }
    } else if (lastAction === 'up') {
      lastAction = null;
      if (ms > HIGH_MS) {
        apply(beforeChangeScale, now, null, ms);
        probeMs = Math.min(MAX_PROBE_MS, Math.max(PROBE_MS, probeMs) * 2);
        held = 0;
        goodSince = now;
        return;
      }
      held++;
      probeMs = NEXT_PROBE_MS;
    }

    if (ms > HIGH_MS) {
      goodSince = -Infinity;
      held = 0;
      // above `start` the resolution is a bonus: slow frames take it back at once (no judging, no hold)
      if (scale > start) { apply(start, now, null, ms); probeMs = Math.min(MAX_PROBE_MS, Math.max(PROBE_MS, probeMs) * 2); return; }
      if (scale > MIN_SCALE && now >= holdUntil) apply(scale - (ms > 25 ? STEP_DOWN * 1.5 : STEP_DOWN), now, 'down', ms);
    } else if (ms < LOW_MS) {
      if (goodSince === -Infinity) goodSince = now;
      if (scale < max && now - goodSince >= (ms < ROOMY_MS ? Math.min(probeMs, NEXT_PROBE_MS) : probeMs)) {
        goodSince = -Infinity;
        lastStep = ms < ROOMY_MS || held > 0 ? STEP_DOWN : STEP_UP;
        apply(scale + lastStep, now, 'up', ms);
      }
    } else {
      goodSince = -Infinity;
    }
  }

  return {
    update,
    get scale() { return scale; },
    get enabled() { return enabled; },
    set enabled(on) {
      enabled = on;
      if (!on && scale !== start) {
        scale = start;
        renderer.setPixelRatio(start);
      }
    }
  };
}

export { createDynamicResolution, MIN_SCALE };
