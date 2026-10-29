import test from 'node:test';
import assert from 'node:assert/strict';
import { streamCornerCatalogRequestAllowed, openStreamCornerSiteCatalog, routeStreamCornerCatalogRequest } from './streamcorner-site-catalog.mjs';
import { resolveStreamCornerIngestSource, streamCornerGameFromDetail, prioritizeStreamCornerCatalogJobs } from './streamcorner.mjs';
import { isNativeStreamCornerSource } from './playback-identity.mjs';

test('catalog browser allows only provider assets and public worker requests', () => {
  for (const url of ['https://streamcorner.st/', 'https://streamcorner.st/assets/current.js',
    'https://data.current.workers.dev/corner?p=alpha']) assert.equal(streamCornerCatalogRequestAllowed(url), true);
  for (const url of ['http://streamcorner.st/', 'https://streamcorner.st.evil.test/',
    'https://user:password@streamcorner.st/', 'file:///etc/passwd', 'https://127.0.0.1/',
    'https://ads.example/ad.js', 'https://data.current.workers.dev/private',
    'https://streamcorner.st:8443/']) assert.equal(streamCornerCatalogRequestAllowed(url), false);
});

test('catalog browser closes on unavailable site without leaking page errors', async () => {
  let closed = false;
  const chromium = { launchServer: async () => ({ wsEndpoint: () => 'owned-browser', close: async () => { closed = true; } }),
    connect: async () => ({
    newContext: async options => {
      assert.equal(options.serviceWorkers, 'block');
      return { route: async () => {}, routeWebSocket: async () => {}, on() {},
      newPage: async () => ({ setDefaultTimeout() {}, goto: async () => { throw Error('private upstream context'); } }) };
    },
    close: async () => {},
  }) };
  await assert.rejects(openStreamCornerSiteCatalog({ chromium }), /^Error: StreamCorner public site catalog unavailable$/);
  assert.equal(closed, true);
});

test('redirects and blocked resources never continue outside the catalog boundary', async () => {
  for (const status of [200, 302, 307]) {
    let outcome;
    await routeStreamCornerCatalogRequest({
      request: () => ({ url: () => 'https://streamcorner.st/assets/current.js', method: () => 'GET', resourceType: () => 'script' }),
      fetch: async options => {
        assert.equal(options.maxRedirects, 0);
        assert.equal(options.timeout, 10_000);
        return { status: () => status };
      },
      fulfill: async () => { outcome = 'fulfilled'; },
      abort: async () => { outcome = 'aborted'; },
    });
    assert.equal(outcome, status === 200 ? 'fulfilled' : 'aborted');
  }
  let aborted = false;
  await routeStreamCornerCatalogRequest({
    request: () => ({ url: () => 'https://ads.example/video', method: () => 'GET', resourceType: () => 'media' }),
    fetch: async () => assert.fail('Forbidden request must not be sent'),
    abort: async () => { aborted = true; },
  });
  assert.equal(aborted, true);
});

test('stalled graceful shutdown force-kills the owned browser within its cleanup budget', { timeout: 10_000 }, async () => {
  let killed = false;
  const chromium = {
    launchServer: async () => ({ wsEndpoint: () => 'owned-browser', close: async () => {}, kill: async () => { killed = true; } }),
    connect: async () => ({ newContext: async () => { throw Error('initialization failed'); }, close: () => new Promise(() => {}) }),
  };
  await assert.rejects(openStreamCornerSiteCatalog({ chromium }), /public site catalog unavailable/);
  assert.equal(killed, true);
});

test('verified public channel wrappers retain native identity and continuous sports semantics', async () => {
  const embed_url = 'https://amazon.com.pandecocogaming.sbs/?p=' + 'a'.repeat(370);
  const source = await resolveStreamCornerIngestSource('channels', { embed_url, source_name: 'PREMIER SPORTS 1 UK' });
  assert.ok(isNativeStreamCornerSource(source));
  assert.equal(source.providerGeneration, 'v3');
  assert.equal(source.url, '');
  assert.equal(source.clearKey, '');
  const now = new Date('2026-10-29T15:00:00Z');
  const job = { provider: 'channels', id: 'premier-sports-1-uk', row: {} };
  const game = streamCornerGameFromDetail(job, { event_name: 'PREMIER SPORTS 1 UK' }, now, () => 1, [source]);
  assert.equal(game.is24x7, true);
  assert.equal(game.status, 'live');
  assert.equal(game.sport, 'Sports');
  assert.equal(game.league, 'Sports TV');
  assert.equal(streamCornerGameFromDetail(job, { event_name: 'PREMIER SPORTS 1 UK', timestamp: 9_000_000_000 }, now, () => 1, [source]).status, 'live');
  assert.equal(streamCornerGameFromDetail(job, { event_name: 'AMC' }, now, () => 1, [source]), null);
  assert.equal(await resolveStreamCornerIngestSource('channels', { embed_url: embed_url + '&extra=1' }), null);
});

test('sports channels cannot starve behind the detail budget and expired events stay excluded', () => {
  const now = new Date('2026-10-29T15:00:00Z');
  const current = now.getTime() / 1000;
  const rows = Array.from({ length: 310 }, (_, i) => ({ provider: 'beta', id: String(i),
    row: { event_name: 'Future match', timestamp: current + 3000 + i } }));
  const channel = { provider: 'channels', id: 'premier', row: { event_name: 'PREMIER SPORTS 1 UK' } };
  rows.push(channel, { provider: 'channels', id: 'amc', row: { event_name: 'AMC' } },
    { provider: '001', id: 'expired', row: { event_name: 'Ended', timestamp: current - 10_000 } });
  const selected = prioritizeStreamCornerCatalogJobs(rows, now, () => 3600);
  assert.equal(selected.length, 300);
  assert.equal(selected[0], channel);
  assert.equal(selected.some(row => row.id === 'amc' || row.id === 'expired'), false);
});
