import test from "node:test";
import assert from "node:assert/strict";
import { decoderFor, isolatedDecoderFor, discoverStreamCornerRuntime, loadStreamCornerRuntime, streamCornerGameFromDetail, resolveStreamCornerIngestSource } from "./streamcorner.mjs";
import { isNativeStreamCornerSource, streamCornerIngestPath, feedSourceKey, playbackIdentity, deduplicatePlaybackSources } from "./playback-identity.mjs";
import { inspectStreamCapabilities, sourceProvenanceErrors } from "./scrape-streams.mjs";

const wrapper = "https://rockyembed.st/source/fetch.php?hd=123";
const ingestPath = "/embed/ingest/abc/channel-1";
const ingestTarget = `https://embed.st${ingestPath}#player=clappr&autoplay=true`;
const wrapperHtml = target => `<div id="player"></div><script>
(() => {
    const playerFrame = document.createElement("iframe");
    playerFrame.allow = "autoplay;encrypted-media;picture-in-picture;fullscreen";
    playerFrame.allowFullscreen = true;
    playerFrame.src = atob("${Buffer.from(target).toString('base64')}");
    document.getElementById("player").appendChild(playerFrame);
})();
</script>`;

test("003 verified wrapper emits a stable native binding with provider-reported evidence", async () => {
  let calls = 0;
  const native = await resolveStreamCornerIngestSource("003", { embed_url: wrapper, source_name: "One", hd: true }, 0,
    async (url, init) => {
      calls++;
      assert.equal(url, wrapper);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(wrapperHtml(ingestTarget));
    });
  assert.equal(calls, 1);
  assert.equal(native.url, "");
  assert.equal(native.embedUrl, ingestTarget);
  assert.equal(native.providerSourceRef, `streamcorner:v1~${Buffer.from(ingestPath).toString("base64url")}`);
  assert.equal(native.providerGeneration, "v1");
  assert.equal(native.availabilityEvidence, "provider-reported");
  assert.equal(native.hd, true);
  assert.equal(native.provider, "StreamCorner");
  assert.equal(native.embedProvider, "StreamCorner");
  assert.equal(native.name, "StreamCorner • One");
  assert.equal(native.maxHeight, undefined);
  assert.ok(isNativeStreamCornerSource(native));
  const noFragment = await resolveStreamCornerIngestSource("003", { embed_url: wrapper }, 0,
    async () => new Response(wrapperHtml(`https://embed.st${ingestPath}`)));
  assert.equal(noFragment.embedUrl, native.embedUrl);
  assert.equal(noFragment.providerSourceRef, native.providerSourceRef);
  const game = streamCornerGameFromDetail({ provider: "003", id: "one", row: {} }, {
    event_name: "Channel 24/7", streams: [{ stream_url: "https://cdn.example/live.m3u8" }],
  }, new Date("2026-10-18T18:00:00Z"), () => 28800, [native, native]);
  assert.equal(game.sources.length, 2);
  assert.equal(game.sources[0].url, "https://cdn.example/live.m3u8");
  assert.deepEqual(game.sources[1], native);
});

test("publisher identity and capability gates preserve only exact native bindings without fetching media", async () => {
  const native = await resolveStreamCornerIngestSource("003", { embed_url: wrapper }, 0,
    async () => new Response(wrapperHtml(ingestTarget)));
  const expected = `resolver:${native.providerSourceRef}:generation:v1`;
  assert.equal(streamCornerIngestPath(native.providerSourceRef), ingestPath);
  assert.equal(feedSourceKey(native), expected);
  assert.equal(playbackIdentity(native), expected);
  assert.deepEqual(deduplicatePlaybackSources([native, { ...native }]), [native]);
  assert.deepEqual(sourceProvenanceErrors([{ id: "native", sources: [native] }]), []);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail("native capability gate must not fetch web pages or manifests"); };
  try {
    assert.deepEqual(await inspectStreamCapabilities(native, "streamcorner"), native);
    for (const patch of [{ provider: "PPV" }, { embedProvider: "PPV" }, { providerGeneration: "v2" },
      { providerSourceRef: native.providerSourceRef + "=" }, { providerSourceRef: native.providerSourceRef + "\n" },
      { embedUrl: native.embedUrl + "\n" }, { availabilityEvidence: "verified" },
      { headers: { Referer: "https://streamcorner.st/", Authorization: "volatile" } },
      { url: "https://cdn.example/volatile.m3u8" }, { embedUrl: wrapper }]) {
      const malformed = { ...native, ...patch };
      assert.equal(isNativeStreamCornerSource(malformed), false);
      assert.equal(feedSourceKey(malformed), "");
      assert.equal(playbackIdentity(malformed), "");
      assert.equal(await inspectStreamCapabilities(malformed), null);
      assert.ok(sourceProvenanceErrors([{ id: "bad", sources: [malformed] }]).length > 0);
    }
  } finally { globalThis.fetch = originalFetch; }
  for (const path of ["/embed/ingest/../abc", "/embed/ingest/a?token=secret", "/embed/ingest/a/b/c/d/e", "/embed/ingest/a\n"]) {
    assert.equal(streamCornerIngestPath(`streamcorner:v1~${Buffer.from(path).toString("base64url")}`), null);
  }
});

test("native wrapper admission requires exact 003 provenance before making any request", async () => {
  const fetcher = async () => { assert.fail("untrusted wrapper must not be fetched"); };
  for (const url of ["http://rockyembed.st/source/fetch.php?hd=123", "https://rockyembed.st:443/source/fetch.php?hd=123",
    "https://user@rockyembed.st/source/fetch.php?hd=123", "https://rockyembed.st.evil/source/fetch.php?hd=123",
    "https://rockyembed.st/source/fetch.php?hd=123&x=1", `${wrapper}#player`,
    "https://rockyembed.st/source/fetch.php?hd=%31", "https://rockyembed.st/source/../source/fetch.php?hd=123",
    "https://embed.st/embed/ingest/abc", `${wrapper}\n`]) {
    assert.equal(await resolveStreamCornerIngestSource("003", { embed_url: url }, 0, fetcher), null, url);
  }
  assert.equal(await resolveStreamCornerIngestSource("alpha", { embed_url: wrapper }, 0, fetcher), null);
  assert.equal(await resolveStreamCornerIngestSource("003", { embed_url: wrapper, stream_keys: "bad" }, 0, fetcher), null);
});

test("native wrapper rejects noncanonical targets, executable expressions and ambiguous scripts", async () => {
  const invalidTargets = ["https://evil.example/embed/ingest/abc", "https://embed.st.evil/embed/ingest/abc",
    "https://embed.st:443/embed/ingest/abc", "https://user@embed.st/embed/ingest/abc",
    "https://embed.st/embed/ingest/../abc", "https://embed.st/embed/ingest/%61bc",
    "https://embed.st/embed/ingest/abc?token=volatile", `${ingestTarget}&extra=true`,
    "https://embed.st/embed/ingest/a/b/c/d/e", "https://embed.st/embed/ingest/abc//",
    `https://embed.st/embed/ingest/${"a".repeat(129)}`, "https://embed.st/watch/abc", `${ingestTarget}\n`];
  const invalidHtml = invalidTargets.map(wrapperHtml).concat([
    wrapperHtml(ingestTarget).repeat(2), `${wrapperHtml(ingestTarget)}<script>atob(variable)</script>`,
    `<script>atob('${Buffer.from(ingestTarget).toString('base64')}' + variable)</script>`,
    `<script>throw Error('must never execute')</script>`,
  ]);
  for (const html of invalidHtml) {
    assert.equal(await resolveStreamCornerIngestSource("003", { embed_url: wrapper }, 0,
      async () => new Response(html)), null);
  }
});

test("native wrapper requires the observed iframe assignment and unique player mount", async () => {
  const valid = wrapperHtml(ingestTarget);
  const encoded = Buffer.from(ingestTarget).toString("base64");
  for (const html of [
    `<div id="player"></div><script>const unused = atob("${encoded}");</script>`,
    `<div id="player"></div><script>// playerFrame.src = atob("${encoded}");</script>`,
    `<div id="player"></div><script>/* playerFrame.src = atob("${encoded}"); */</script>`,
    `<!-- ${valid} -->`, `<!-- ${valid}`, valid.replace('<div id="player"></div>', '<!-- <div id="player"></div> -->'),
    valid.replace('id="player"', 'data-id="player"'), valid.replace('id="player"', 'id="other" id="player"'),
    valid.replace('<div id="player"></div>', `<div data-note=' id="player"'></div>`),
    `<div id="player" data-note='${valid.slice(valid.indexOf("<script>"))}'></div>`,
    valid.replace('<div id="player"></div>', '<div data-note=" > " data-other="x" id="player"></div>')
      .replace('playerFrame.src = atob', 'const unused = atob'),
    valid.replace('playerFrame.src = atob', 'const unused = atob'),
    valid.replace('document.getElementById("player").appendChild(playerFrame);', 'playerFrame.src="https://evil.example/player";'),
    valid.replace('})();', 'playerFrame.src="https://evil.example/player"; })();'),
    valid + '<script>window.location.href="https://evil.example/player";</script>',
    valid + '<iframe src="https://evil.example/player"></iframe>',
    valid + '<div id="player"></div>', valid + '<span id=player></span>',
    valid.replace('<script>', '<script src="https://evil.example/bootstrap.js">'),
    valid.replace('<script>', '<script type="application/json">'),
    valid.replace('<script>', '<script type="importmap">'),
    valid.replace('<script>', '<script type="module">'),
    ...['template', 'noscript', 'textarea', 'title', 'xmp', 'plaintext', 'style', 'object', 'svg', 'math']
      .map(tag => `<${tag}>${valid}</${tag}>`),
  ]) assert.equal(await resolveStreamCornerIngestSource("003", { embed_url: wrapper }, 0,
    async () => new Response(html)), null);
  const observedWithAds = valid + '<script>aclib.runPop({zoneId:"8804222"});</script>' +
    '<script>var hs=document.createElement("script"); hs.src="//s10.histats.com/js15_as.js";</script>' +
    '<style>#player{width:100%}</style><noscript><img src="https://analytics.example/pixel"></noscript>';
  assert.ok(await resolveStreamCornerIngestSource("003", { embed_url: wrapper }, 0,
    async () => new Response(observedWithAds)));
  const quotedMarkup = valid.replace('<div id="player"></div>',
    `<div data-note='<script>fake</script> id="other" >' id="player"></div>`);
  assert.ok(await resolveStreamCornerIngestSource("003", { embed_url: wrapper }, 0,
    async () => new Response(quotedMarkup)));
});

test("native wrapper response errors, redirects and byte cap fail closed", async () => {
  for (const response of [new Response("bad", { status: 403 }),
    new Response(wrapperHtml(ingestTarget), { headers: { "content-length": "100001" } }),
    new Response(" ".repeat(100001) + wrapperHtml(ingestTarget)),
    { ok: true, redirected: true, headers: new Headers(), body: null },
    { ok: true, redirected: false, url: "https://evil.example/", headers: new Headers(), body: null }]) {
    assert.equal(await resolveStreamCornerIngestSource("003", { embed_url: wrapper }, 0, async () => response), null);
  }
  assert.equal(await resolveStreamCornerIngestSource("003", { embed_url: wrapper }, 0,
    async () => { throw new Error("timeout"); }), null);
});

test("uses the integrity-checked local decoder when the site challenges a publisher runner", async () => {
  const runtime = await loadStreamCornerRuntime(async () => new Response("challenge", { status: 403 }));
  assert.match(runtime.fallbackWarning, /HTTP 403/);
  assert.ok(runtime.decoderCode.length > 1000);
  assert.ok(runtime.workers.length > 0);
  assert.ok(runtime.decoderUrl.startsWith("https://streamcorner.st/assets/"));
});

test("discovers the rotating decoder and workers from the current domain only", async () => {
  const pages = new Map([
    ["https://streamcorner.st/", '<script type="module" src="/assets/entry.js"></script>'],
    ["https://streamcorner.st/assets/entry.js", 'import{j as x}from"./runtime.js";'],
    ["https://streamcorner.st/assets/runtime.js",
      'import{j as Mr}from"./decoder.js";const Zo=["data.good.workers.dev","evil.example"];const Na="corner";'],
    ["https://streamcorner.st/assets/decoder.js", 'function decode(){};export{decode as j};'],
  ]);
  const fetcher = async (url) => new Response(pages.get(url) || "", { status: pages.has(url) ? 200 : 404 });
  const runtime = await discoverStreamCornerRuntime(fetcher);
  assert.deepEqual(runtime.workers, ["data.good.workers.dev"]);
  assert.equal(runtime.decoderExport, "decode");
  assert.equal(runtime.decoderUrl, "https://streamcorner.st/assets/decoder.js");
});

test("publishes only direct HLS/DASH from the new catalog and preserves ClearKey", () => {
  const now = new Date("2026-09-27T18:00:00Z");
  const job = { provider: "alpha", id: "event-1", row: { timestamp: 1790528400 } };
  const game = streamCornerGameFromDetail(job, {
    event_name: "England vs Sri Lanka", category: "CRICKET", league: "Cricket", timestamp: 1790528400,
    streams: [
      { source_name: "WILLOW", stream_url: "https://cdn.example/live.mpd?token=abc", stream_keys: `${"a".repeat(32)}:${"b".repeat(32)}` },
      { source_name: "Web wrapper", embed_url: "https://rockystream.st/source/fetch.php" },
      { source_name: "Wrong format", stream_url: "https://cdn.example/landing.html" },
      { source_name: "Bad key", stream_url: "https://cdn.example/bad.mpd", stream_keys: "bad" },
    ],
  }, now, () => 8 * 60 * 60);
  assert.equal(game.sources.length, 1);
  assert.equal(game.sources[0].provider, "StreamCorner");
  assert.equal(game.sources[0].headers.Referer, "https://streamcorner.st/");
  assert.equal(game.sources[0].clearKey, `${"a".repeat(32)}:${"b".repeat(32)}`);
  assert.equal(game.sources[0].url, "https://cdn.example/live.mpd?token=abc");
});

test("a catalog row with only web players is not advertised as playable direct media", () => {
  const now = new Date("2026-09-27T18:00:00Z");
  const game = streamCornerGameFromDetail({ provider: "003", id: "id", row: { timestamp: 1790500000 } }, {
    event_name: "Game", streams: [{ embed_url: "https://rockystream.st/source/fetch.php" }],
  }, now, () => 8 * 60 * 60);
  assert.equal(game, null);
});


test("decoder invocation bounds a nonterminating synchronous provider decoder", () => {
  const decoder = decoderFor({
    workers: ["data.good.workers.dev"],
    decoderCode: "function decode(){while(true){}};export{decode as j};",
    decoderExport: "decode",
  }, async () => { throw new Error("unexpected fetch"); });
  const start = performance.now();
  assert.throws(() => decoder("https://data.good.workers.dev/corner", "alpha", "ALPHA"), /Script execution timed out/);
  assert.ok(performance.now() - start < 5000);
});

test("decoder worker transport rejects wrong origin path and method", async () => {
  let fetchCount = 0;
  const decoder = decoderFor({
    workers: ["data.good.workers.dev"],
    decoderCode: "async function decode(url,method){return fetch(url,{method})};export{decode as j};",
    decoderExport: "decode",
  }, async () => { fetchCount++; return new Response("{}"); });
  for (const [url, method] of [
    ["https://evil.example/corner", "POST"], ["https://data.good.workers.dev/other", "POST"],
    ["http://data.good.workers.dev/corner", "POST"], ["https://data.good.workers.dev/corner", "GET"],
  ]) await assert.rejects(decoder(url, method), /verified StreamCorner worker route/);
  assert.equal(fetchCount, 0);
  await decoder("https://data.good.workers.dev/corner", "POST");
  assert.equal(fetchCount, 1);
});

test("decoder recognizes host fetch and WebCrypto ArrayBuffers across VM boundary", async () => {
  const decoder = decoderFor({
    workers: ["data.good.workers.dev"],
    decoderCode: "async function decode(url){const body=await(await fetch(url,{method:'POST'})).arrayBuffer();if(!(body instanceof ArrayBuffer))throw Error('realm');const hash=await crypto.subtle.digest('SHA-256',body);if(!(hash instanceof ArrayBuffer))throw Error('crypto realm');return [new Uint8Array(body).length,hash.byteLength]};export{decode as j};",
    decoderExport: "decode",
  }, async () => new Response(new Uint8Array([1,2,3])));
  assert.deepEqual(Array.from(await decoder("https://data.good.workers.dev/corner")), [3,32]);
});

test("parent deadline terminates an infinite loop after an async boundary", async () => {
  const decode = isolatedDecoderFor({workers:[],decoderExport:'decode',
    decoderCode:'async function decode(){await Promise.resolve();while(true){}};export{decode as j};'}, 200);
  const start=performance.now();
  await assert.rejects(decode(), /timed out/);
  assert.ok(performance.now()-start<3000);
});

test("isolated decoder returns async data without raw provider errors", async () => {
  const decode=isolatedDecoderFor({workers:[],decoderExport:'decode',
    decoderCode:'async function decode(){await Promise.resolve();return [{id:1}]};export{decode as j};'});
  assert.deepEqual(await decode(),[{id:1}]);
  const fail=isolatedDecoderFor({workers:[],decoderExport:'decode',
    decoderCode:'async function decode(){throw Error("token=secret")};export{decode as j};'});
  await assert.rejects(fail(), {message:'provider decoder failed'});
});
