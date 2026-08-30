import test from "node:test";
import assert from "node:assert/strict";
import { addonSources, fetchHighflyGames, attachAddonSources, playbackEvidence, samePlayback, preferAddonOverPpv } from "./highfly.mjs";

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
  assert.equal(attachAddonSources([candidate], [{ ...official, status: "upcoming" }], () => true).unmatched, 1);
  assert.equal(attachAddonSources([candidate], [official, { ...official, id: "second-game" }], () => true).ambiguous, 1);
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
