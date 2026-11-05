import assert from 'node:assert/strict';
import test from 'node:test';
import { createPedestrianRoutes } from '../js/pedestrian-routes.js';

// A footway along z = 0 turning north at x = 40, and one mapped across a roadway at x = 100 (blockAt null there)
const roads = [
  { kind: 'footway', w: 3, pts: [{ x: 0, z: 0 }, { x: 40, z: 0 }] },
  { kind: 'footway', w: 3, pts: [{ x: 40.6, z: 0.4 }, { x: 40, z: -40 }] },
  { kind: 'footway', w: 3, pts: [{ x: 95, z: 0 }, { x: 105, z: 0 }] },
  { kind: 'residential', w: 8, pts: [{ x: 0, z: 50 }, { x: 100, z: 50 }] }
];
const ground = { id: 'ground' };
const blockAt = (x) => (x > 98 && x < 102 ? null : ground);
const routes = createPedestrianRoutes({ walkable: () => true, onSidewalk: () => true }, blockAt, roads);

test('walkways near a point are found and weighted, and streets for cars are not walkways', () => {
  const near = routes.waysNear(20, 0, 30);
  assert.equal(near.segs.length, 2);
  assert.ok(near.segs.every((seg) => seg.road.kind === 'footway'));
  assert.equal(near.total, near.cum[near.cum.length - 1]);
});

test('a footway carries two walking lines and joins the next one at a shared vertex', () => {
  const segs = routes.waysNear(40, 0, 5).segs;
  const first = segs.find((seg) => seg.road === roads[0]), second = segs.find((seg) => seg.road === roads[1]);
  const lines = routes.wayTracks(first);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.way === first && Math.abs(line.len - first.len) < 1e-9));
  assert.equal(first.b, second.a, 'vertices 0.7 m apart are one junction');
  const east = lines.find((line) => line.ux > 0);
  const path = routes.next(east, 1, 40, -100);
  assert.ok(path, 'walking east, the north branch is reachable');
  assert.equal(path[path.length - 1].track.way, second);
});

test('a footway mapped over a roadway has no walking line', () => {
  const crossing = routes.waysNear(100, 0, 5).segs[0];
  assert.deepEqual(routes.wayTracks(crossing), []);
});

test('a wide pedestrian street is walked across its width, clear of the tram tracks', () => {
  const zone = [{ kind: 'pedestrian', w: 18, rails: [-1.8, 1.8], pts: [{ x: 0, z: 300 }, { x: 60, z: 300 }] }];
  const wide = createPedestrianRoutes({ walkable: () => true, onSidewalk: () => true }, () => ground, zone);
  const seg = wide.waysNear(30, 300, 5).segs[0];
  const offs = wide.wayTracks(seg).map((line) => line.line);
  assert.deepEqual(offs, [-8.2, -6.7, -5.2, 5.2, 6.7, 8.2]);
  assert.equal(seg.weight, 60 * 4 * 3, 'four times a footway per metre, three times for its width');
});
