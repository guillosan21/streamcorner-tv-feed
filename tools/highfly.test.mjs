import test from "node:test";
import assert from "node:assert/strict";
import { addonApiConfiguration, addonSources, fetchHighflyGames, attachAddonSources, playbackEvidence, samePlayback, preferAddonOverPpv } from "./highfly.mjs";

const installationId = "synthetic-installation.identifier+private";
const installationPath = Buffer.from(JSON.stringify({ freeUserId: installationId })).toString("base64url");
const installationUrl = `https://sports.highfly.to/${installationPath}/manifest.json`;

test("private installation uses only the configured API path and excludes credential-bearing output", async () => {
  const calls = [];
  const result = await fetchHighflyGames(new Date(), async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "error");
    assert.ok(url.startsWith(installationUrl.replace("/manifest.json", "/")));
    return { ok: true, json: async () => url.includes("/stream/") ? { streams: [
      { name: "Leaf", url: "https://cdn.test/live.m3u8?ft=media-token" },
      { name: "private query", url: `https://cdn.test/live.m3u8?id=${encodeURIComponent(installationId)}` },
      { name: "100% HD", url: `https://cdn.test/encoded.m3u8?id=${installationId.replace("+", "%2b")}` },
      { name: "100% HD nested", url: `https://cdn.test/nested.m3u8?id=${installationId.replace("+", "%252b")}` },
      { name: "private path", url: `https://cdn.test/${installationPath}/live.m3u8` },
      { name: "private header", url: "https://cdn.test/header.m3u8", behaviorHints: { proxyHeaders: { request: { Referer: installationUrl } } } },
      { name: "Premium", title: "Upgrade", url: "https://cdn.test/premium.m3u8" },
      { name: "Premium", url: "https://cdn.test/premium-only.m3u8" },
      { name: "Setup", url: "https://cdn.test/setup.m3u8" },
    ] } : { metas: url.includes("skip=") ? [] : [
      { id: "streamed:test", type: "sport", name: "Home vs Away", releaseInfo: "LIVE" },
    ] } };
  }, { manifestUrl: installationUrl });
  assert.equal(calls.length, 3);
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].sources.length, 1);
  assert.equal(result.games[0].sources[0].url, "https://cdn.test/live.m3u8?ft=media-token");
  assert.ok(!JSON.stringify(result).includes(installationId));
  assert.ok(!JSON.stringify(result).includes(installationPath));
});

test("invalid installation configuration fails closed without requests or credential diagnostics", async () => {
  assert.equal(addonApiConfiguration().base, "https://sportsfree-us2.highfly.dev");
  for (const manifestUrl of [installationUrl.replace("https:", "http:"),
    installationUrl.replace("sports.highfly.to", "sports.highfly.to.evil.test"),
    installationUrl.replace("sports.highfly.to", "user@sports.highfly.to"),
    installationUrl + "?secret=private", installationUrl + "#fragment",
    "https://sports.highfly.to/bm90LWpzb24/manifest.json",
    "https://sports.highfly.to/eyJmcmVlVXNlcklkIjoiIn0/manifest.json"]) {
    const result = await fetchHighflyGames(new Date(), async () => { assert.fail("must not fetch"); }, { manifestUrl });
    assert.deepEqual(result.errors, ["Sports Streams installation configuration is invalid"]);
  }
  const result = await fetchHighflyGames(new Date(), async () => { throw new Error(installationUrl); }, { manifestUrl: installationUrl });
  assert.deepEqual(result.errors, ["Sports Streams catalog request failed"]);
});

test("reinstall placeholder produces an actionable safe provider diagnostic", async () => {
  const result = await fetchHighflyGames(new Date(), async (url) => ({ ok: true, json: async () =>
    url.includes("/stream/") ? { streams: [{ name: "Please reinstall the addon", url: "https://example.test/configure" }] } :
    { metas: url.includes("skip=") ? [] : [{ id: "streamed:a", name: "A vs B", type: "sport", releaseInfo: "LIVE" }] }
  }), { manifestUrl: "" });
  assert.deepEqual(result.games, []);
  assert.deepEqual(result.errors, ["Sports Streams requires verified installation configuration"]);
});

test("accept native streams with original provider labels; reject upsells, insecure URLs and duplicates", () => {
  const result = addonSources([
    { name: "Leaf · NFL", url: "https://leaf.highfly.dev/live.m3u8", behaviorHints: { notWebReady: true } },
    { name: "duplicate", url: "https://leaf.highfly.dev/live.m3u8" },
    { name: "CDN Premium", title: "🔒 Upgrade to watch", url: "https://www.google.com" },
    { url: "http://example.org/test.m3u8" }, { externalUrl: "https://example.org" },
    { url: "https://example.org/test.mp4" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].provider, "Sports Streams");
  assert.equal(result[0].name, "Sports Streams • Leaf · NFL");
});

test("catalog pagination excludes channels, finals and empty streams without inventing kickoff", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes("/stream/")) return { ok: true, json: async () => ({ streams: [{ name: "Leaf", url: "https://example.org/live.m3u8" }] }) };
    return { ok: true, json: async () => ({ metas: url.includes("skip=") ? [] : [
      { id: "streamed:a", name: "Home vs Away", type: "sport", releaseInfo: "LIVE", category: "football" },
      { id: "leaf:channel", name: "Channel", type: "sport", releaseInfo: "LIVE" },
      { id: "streamed:final", name: "Final", type: "sport", releaseInfo: "FINAL" },
    ] }) };
  };
  const result = await fetchHighflyGames(new Date("2026-08-30T00:00:00Z"), fetcher);
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].startsAt, "");
  assert.equal(result.games[0].endsAt, undefined);
  assert.equal(result.games[0].sport, "Soccer");
  assert.ok(calls.some((url) => url.endsWith("/skip=3.json")));
});

test("provider failures stay isolated", async () => {
  const result = await fetchHighflyGames(new Date(), async () => { throw new Error("timeout"); });
  assert.deepEqual(result.games, []);
  assert.equal(result.errors.length, 1);
});

test("require unique official ESPN match and retain its kickoff, scores and identity", () => {
  const official = { id: "espn-nfl-123", title: "Away at Home", startsAt: "2026-08-29T23:00:00Z",
    scoreboardEventId: "espn-nfl-123", status: "live", homeScore: "14", sources: [] };
  const candidate = { title: "Home vs Away", startsAt: "", sources: [{ provider: "Sports Streams" }] };
  assert.deepEqual(attachAddonSources([candidate], [official], () => true), { ambiguous: 0, unmatched: 0 });
  assert.equal(official.startsAt, "2026-08-29T23:00:00Z");
  assert.equal(official.homeScore, "14");
  assert.equal(official.id, "espn-nfl-123");
  assert.equal(official.sources.length, 1);
  assert.equal(attachAddonSources([candidate], [{ ...official, scoreboardEventId: "" }], () => true).unmatched, 1);
  assert.equal(attachAddonSources([candidate], [{ ...official, status: "upcoming" }], () => true,
    new Date("2026-08-29T20:00:00Z")).unmatched, 0);
  assert.equal(attachAddonSources([candidate], [official, { ...official, id: "second-game" }], () => true).ambiguous, 1);
});

test("early sources attach to unique upcoming ESPN fixture without changing game status", () => {
  const now = new Date("2026-10-20T16:30:00Z");
  const source = {provider:"Sports Streams",name:"Sports Streams • Leaf",url:"https://cdn.test/live.m3u8"};
  const event = {title:"Home vs Away",sources:[source]};
  const official = {id:"espn-123",scoreboardEventId:"espn-123",status:"upcoming",
    startsAt:"2026-10-20T16:45:00Z",sources:[],homeScore:"0"};
  assert.deepEqual(attachAddonSources([event],[official],()=>true,now),{ambiguous:0,unmatched:0});
  assert.equal(official.status,"upcoming");
  assert.equal(official.startsAt,"2026-10-20T16:45:00Z");
  assert.equal(official.homeScore,"0");
  assert.deepEqual(official.sources,[{...source,availableBeforeKickoff:true}]);
  assert.equal(source.availableBeforeKickoff,undefined);
  const hoursEarly = {...official,startsAt:"2026-10-20T23:00:00Z",sources:[]};
  assert.equal(attachAddonSources([event],[hoursEarly],()=>true,now).unmatched,0);
  assert.equal(hoursEarly.sources[0].availableBeforeKickoff,true);
});

test("untimed early sources reject stale, distant, completed, nonofficial and ambiguous fixtures", () => {
  const now = new Date("2026-10-20T16:30:00Z");
  const event = {sources:[{provider:"Sports Streams",url:"https://cdn.test/live.m3u8"}]};
  const official = {scoreboardEventId:"espn-123",status:"upcoming",startsAt:"2026-10-20T16:45:00Z",sources:[]};
  for(const patch of [{startsAt:"2026-10-19T16:45:00Z"},{startsAt:"2026-10-22T16:45:00Z"},
    {startsAt:"invalid"},{status:"completed"},{status:"cancelled"},{scoreboardEventId:""},{is24x7:true}]) {
    const game={...official,...patch,sources:[]};
    assert.equal(attachAddonSources([event],[game],()=>true,now).unmatched,1);
    assert.deepEqual(game.sources,[]);
  }
  const second={...official,scoreboardEventId:"espn-456",sources:[]};
  assert.equal(attachAddonSources([event],[official,second],()=>true,now).ambiguous,1);
  assert.equal(official.sources.length,0);
  assert.equal(second.sources.length,0);
});

test("official pregame feed lag does not drop sources while the fixture window remains valid", () => {
  const now=new Date("2026-10-20T17:15:00Z");
  const event={sources:[{provider:"Sports Streams",url:"https://cdn.test/live.m3u8"}]};
  const game={scoreboardEventId:"espn-123",status:"upcoming",startsAt:"2026-10-20T16:45:00Z",
    endsAt:"2026-10-20T20:45:00Z",sources:[]};
  assert.equal(attachAddonSources([event],[game],()=>true,now).unmatched,0);
  assert.equal(game.status,"upcoming");
  assert.equal(game.sources[0].availableBeforeKickoff,true);
  for(const patch of [{endsAt:"2026-10-20T17:00:00Z"},{endsAt:"invalid"},
    {startsAt:"2026-10-18T16:45:00Z",endsAt:"2026-10-25T20:45:00Z"}]) {
    const stale={...game,...patch,sources:[]};
    assert.equal(attachAddonSources([event],[stale],()=>true,now).unmatched,1);
    assert.equal(stale.sources.length,0);
  }
});

test("prefer add-on over PPV only with shared playback evidence", async () => {
  const addon = { provider: "Sports Streams", url: "https://cdn.test/game.m3u8" };
  const duplicate = { provider: "PPV", url: addon.url };
  const different = { provider: "PPV", url: "https://cdn.test/other.m3u8" };
  const game = { sources: [duplicate, different, addon] };
  const count = await preferAddonOverPpv([game], async (source) => ({ urls: new Set([source.url]), segments: new Set() }));
  assert.equal(count, 1);
  assert.deepEqual(game.sources, [different, addon]);
});

test("shared segment evidence requires two exact segments; signatures are not discarded", () => {
  const evidence = (urls, segments = []) => ({ urls: new Set(urls), segments: new Set(segments) });
  assert.equal(samePlayback(evidence(["https://a/live?channel=1"]), evidence(["https://a/live?channel=2"])), false);
  assert.equal(samePlayback(evidence([], ["s1"]), evidence([], ["s1"])), false);
  assert.equal(samePlayback(evidence([], ["s1", "s2"]), evidence([], ["s1", "s2"])), true);
});

test("resolve PPV embedded media through HLS variants and redirects", async () => {
  const fetcher = async (url) => ({ ok: true, url,
    text: async () => url.endsWith("/embed") ? '<script>file:"https://cdn.test/master.m3u8"</script>' :
      url.endsWith("master.m3u8") ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvideo.m3u8\n" :
      "#EXTM3U\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\nseg2.ts\n" });
  const result = await playbackEvidence({ provider: "PPV", embedUrl: "https://ppv.test/embed" }, fetcher);
  assert.ok(result.urls.has("https://cdn.test/video.m3u8"));
  assert.ok(result.segments.has("https://cdn.test/seg1.ts"));
  assert.equal(result.segments.size, 2);
});
