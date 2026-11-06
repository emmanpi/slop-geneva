import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The canton facades (tools/build-geneva-canton-facades.mjs, tools/sample-photomesh-facades.mjs --canton): data/
// geneva-canton-facades.json must hold, for every canton tile, one ;-separated entry per batch id, in batch id order,
// in the same format as data/geneva-facades.json. The 32 facade archetypes are the city's, reused unchanged. With an
// "area" (Phase A: a single commune), only that commune's tiles are present. Batch lengths are checked against the
// cached batch tables (tools/data/cache/canton_batches/, written by the --batches step) when they are present; without
// them the entries are still parsed and checked for range.
const HERE = new URL('../data/', import.meta.url);
const facades = JSON.parse(fs.readFileSync(new URL('geneva-canton-facades.json', HERE), 'utf8'));
const buildings = JSON.parse(fs.readFileSync(new URL('geneva-canton-buildings.json', HERE), 'utf8'));
const city = JSON.parse(fs.readFileSync(new URL('geneva-facades.json', HERE), 'utf8'));
const batchDir = new URL('../tools/data/cache/canton_batches/', import.meta.url);
const cached = fs.existsSync(batchDir) ? new Set(fs.readdirSync(batchDir)) : null;

test('the canton facades reuse the city styles and archetypes', () => {
  assert.deepEqual(facades.styles, ['ancien', 'xixe', 'moderne', 'contemporain', 'bureaux', 'inconnu']);
  assert.deepEqual(facades.archetypes, city.archetypes, 'the city\'s 32 archetypes, unchanged');
  assert.equal(facades.archetypes.length, 32);
  assert.match(facades.fetched, /^\d{4}-\d{2}-\d{2}$/);
  if (facades.area) {
    assert.equal(typeof facades.area.bfs, 'number');
    assert.equal(typeof facades.area.name, 'string');
  }
});

test('every canton tile (or area tile) has an entry, and every entry parses', () => {
  const entries = facades.tiles;
  const known = new Set(buildings.tiles.map(([u]) => u));
  // with an area, only that area's tiles are present; the batch cache (built with the same --area) lists them
  if (!facades.area) {
    assert.equal(Object.keys(entries).length, buildings.tiles.length, 'the whole canton');
    for (const [u] of buildings.tiles) assert.ok(typeof entries[u] === 'string', u);
  } else if (cached) {
    // every cached batch table (the area's tiles) has a matching facade entry
    for (const f of cached) assert.ok(entries[f.replace(/_/g, '/').replace(/\.json$/, '')] !== undefined, f);
  }
  let total = 0, measured = 0, knownStyle = 0;
  for (const [u, s] of Object.entries(entries)) {
    assert.ok(known.has(u), `unknown tile ${u}`);
    const parts = s.split(';');
    assert.ok(parts.length > 0, u);
    // batch length: against the cached batch table when present
    if (cached?.has(u.replace(/\//g, '_') + '.json')) {
      const { featureTable } = JSON.parse(fs.readFileSync(new URL('../tools/data/cache/canton_batches/' + u.replace(/\//g, '_') + '.json', import.meta.url), 'utf8'));
      assert.equal(parts.length, featureTable.BATCH_LENGTH, `${u}: entry count equals batch length`);
    }
    for (const e of parts) {
      const [style, storey, archetype, hex, w, p, t] = e.split(',');
      assert.ok(+style >= 0 && +style < facades.styles.length, `${u}: ${e}`);
      assert.ok(+storey >= 27 && +storey <= 45, `${u}: storey ${storey} dm`);
      assert.ok(+archetype >= -1 && +archetype < facades.archetypes.length, `${u}: ${e}`);
      assert.match(hex, /^[0-9a-f]{6}$/, `${u}: ${e}`);
      for (const x of [w, p, t]) assert.ok(+x >= 0 && +x <= 1, `${u}: ${e}`);
      total++;
      if (+style !== 5) knownStyle++;
      if (+archetype === -1) measured++; // a measured building keeps its own colour, no archetype
    }
  }
  assert.ok(total > 0, 'some buildings');
  // the shares, also logged in source
  const source = facades.source;
  assert.match(source, /measured/);
  assert.match(source, /known style/);
  const pct = (n) => `${(100 * n / total).toFixed(1)}%`;
  console.log(`[canton-facades] ${measured}/${total} buildings measured (${pct(measured)}), ${knownStyle}/${total} with a known style (${pct(knownStyle)})`);
});
