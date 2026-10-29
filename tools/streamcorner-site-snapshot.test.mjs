import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamCornerSiteSnapshot, validateStreamCornerSiteSnapshot, loadStreamCornerSiteSnapshot } from './streamcorner-site-snapshot.mjs';

test('public module snapshot follows bounded same-origin dependencies and detects corruption', async () => {
  const assets = new Map([
    ['/assets/runtime.js', 'new Worker(new URL("./worker.js",import.meta.url))'],
    ['/assets/worker.js', 'import{j}from"./decoder.js";'],
    ['/assets/decoder.js', 'export const j=1;'],
  ]);
  const snapshot = await createStreamCornerSiteSnapshot('https://streamcorner.st/assets/runtime.js', async (url, options) => {
    assert.equal(url.origin, 'https://streamcorner.st');
    assert.equal(options.redirect, 'error');
    return new Response(assets.get(url.pathname), { status: assets.has(url.pathname) ? 200 : 404 });
  });
  assert.deepEqual(Object.keys(snapshot.assets).sort(), [...assets.keys()].sort());
  assert.equal(validateStreamCornerSiteSnapshot(snapshot), snapshot);
  snapshot.assets['/assets/worker.js'].code += 'tampered';
  assert.throws(() => validateStreamCornerSiteSnapshot(snapshot), /integrity/);
  await assert.rejects(createStreamCornerSiteSnapshot('https://evil.test/assets/runtime.js'), /Invalid/);
});

test('checked-in code cache is integrity verified and contains no saved catalog rows', async () => {
  const snapshot = await loadStreamCornerSiteSnapshot();
  assert.ok(Object.keys(snapshot.assets).length > 1);
  assert.deepEqual(Object.keys(snapshot).sort(), ['assets', 'capturedAt', 'runtimePath', 'schema']);
  for (const asset of Object.values(snapshot.assets)) assert.deepEqual(Object.keys(asset).sort(), ['code', 'sha256']);
});
