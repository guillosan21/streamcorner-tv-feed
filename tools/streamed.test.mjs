import test from "node:test";
import assert from "node:assert/strict";
import { fetchStreamedGames, isValidStreamedEmbedUrl } from "./streamed.mjs";

const now = new Date("2026-09-27T18:00:00.000Z");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("Streamed JSON adapter merges all and live matches and maps validated embed sources", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    requests.push({ parsed, options });
    if (parsed.pathname === "/api/matches/all") return jsonResponse([
      {
        id: "match_1", title: "Home vs Away", category: "football", date: Date.parse("2026-09-27T20:00:00Z"),
        teams: { home: { name: "Home" }, away: { name: "Away" } },
        sources: [{ source: "hotel", id: "match_1" }],
      },
      {
        id: "match_live", title: "Live Home vs Live Away", category: "basketball", date: Date.parse("2026-09-27T17:00:00Z"),
        sources: [{ source: "alpha", id: "live_id" }],
      },
    ]);
    if (parsed.pathname === "/api/matches/live") return jsonResponse([
      { id: "match_live", title: "Live Home vs Live Away", category: "basketball", date: Date.parse("2026-09-27T17:00:00Z"), sources: [{ source: "alpha", id: "live_id" }] },
    ]);
    if (parsed.pathname === "/api/stream/hotel/match_1") return jsonResponse([
      { streamNo: 1, language: "English", hd: true, source: "hotel", embedUrl: "https://embed.st/embed/hotel/match_1/1" },
      { streamNo: 2, language: "Spanish", hd: false, source: "hotel", embedUrl: "https://embed.st/embed/hotel/match_1/2" },
      { streamNo: 3, language: "English", source: "hotel", embedUrl: "https://embed.st/embed/hotel/match_1/3" },
      { streamNo: 4, language: "English", hd: "true", source: "hotel", embedUrl: "https://embed.st/embed/hotel/match_1/4" },
      { streamNo: 4, language: "English", hd: true, source: "hotel", embedUrl: "https://embed.st/embed/alpha/match_1/4" },
      { streamNo: 5, language: "English", hd: true, source: "hotel", embedUrl: "https://embed.st/embed/hotel/other_match/5" },
      { streamNo: 6, language: "English", hd: true, source: "hotel", embedUrl: "https://embed.st/embed/hotel/match_1/7" },
      { streamNo: 1, language: "Conflict", hd: false, source: "hotel", embedUrl: "https://embed.st/embed/hotel/match_1/1" },
      { streamNo: 5, language: "English", hd: true, source: "hotel", embedUrl: "https://embed.st/embed/hotel/match_1/5" },
    ]);
    if (parsed.pathname === "/api/stream/alpha/live_id") return jsonResponse([
      { streamNo: 1, language: "English", hd: false, source: "alpha", embedUrl: "https://embed.st/embed/alpha/live_id/1" },
      { streamNo: 2, language: "English", hd: true, source: "alpha", embedUrl: "https://embed.st/embed/alpha/live_id/2" },
      { streamNo: 3, language: "English", source: "alpha", embedUrl: "https://embed.st/embed/alpha/live_id/3" },
    ]);
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await fetchStreamedGames(now, { fetchImpl });
  assert.equal(result.error, "");
  assert.equal(result.catalogCount, 2);
  assert.equal(result.liveCatalogCount, 1);
  assert.equal(result.playableGameCount, 2);
  assert.equal(result.playableSourceCount, 5);
  assert.equal(result.excludedHdSourceCount, 3);
  assert.equal(result.streamRequestCount, 2);
  assert.deepEqual(result.games.map((game) => game.status).sort(), ["live", "upcoming"]);
  assert.equal(result.games.find((game) => game.id === "streamed-match_1").sport, "Soccer");
  const upcomingSources = result.games.find((game) => game.id === "streamed-match_1").sources;
  const hdSource = upcomingSources.find((source) => source.hd === true);
  const unknownSource = upcomingSources.find((source) => source.hd === null);
  assert.equal(hdSource.provider, "Streamed");
  assert.equal(hdSource.embedUrl, "https://embed.st/embed/hotel/match_1/5");
  assert.match(hdSource.name, /\bHD\b/);
  assert.doesNotMatch(unknownSource.name, /\bHD\b/);
  assert.equal(upcomingSources.some((source) => /Spanish|Conflict/.test(source.name)), false);
  assert.ok(result.games.flatMap((game) => game.sources).every((source) => source.hd === true || source.hd === null));
  assert.ok(requests.every(({ parsed, options }) => parsed.origin === "https://streamed.pk" && options.redirect === "error" && options.signal));
});

test("Streamed API URLs are fixed to the HTTPS embed.st source route", () => {
  assert.equal(isValidStreamedEmbedUrl("https://embed.st/embed/hotel/match_123"), true);
  assert.equal(isValidStreamedEmbedUrl("https://embed.st/embed/hotel/match_123/24"), true);
  assert.equal(isValidStreamedEmbedUrl("https://embed.st/embed/hotel/match_123/25"), false);
  assert.equal(isValidStreamedEmbedUrl("https://embed.st/embed/hotel/match_123/1", "hotel", "match_123"), true);
  assert.equal(isValidStreamedEmbedUrl("https://embed.st/embed/alpha/match_123/1", "hotel", "match_123"), false);
  assert.equal(isValidStreamedEmbedUrl("https://embed.st/embed/hotel/other_match/1", "hotel", "match_123"), false);
  assert.equal(isValidStreamedEmbedUrl("http://embed.st/embed/hotel/match_123"), false);
  assert.equal(isValidStreamedEmbedUrl("https://sub.embed.st/embed/hotel/match_123"), false);
  assert.equal(isValidStreamedEmbedUrl("https://embed.st/embed/ingest/match_123"), false);
  assert.equal(isValidStreamedEmbedUrl("https://embed.st/embed/hotel/match_123?next=https://evil.example"), false);
  assert.equal(isValidStreamedEmbedUrl("https://embed.st/embed/hotel/match_123/1/extra"), false);
  assert.equal(isValidStreamedEmbedUrl("https://user:pass@embed.st/embed/hotel/match_123"), false);
});

test("Streamed endpoint failures are reported and malformed feed rows are ignored", async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/matches/all") return jsonResponse({ matches: [] });
    if (path === "/api/matches/live") return jsonResponse([
      { id: "../bad", title: "Bad", category: "football", date: now.getTime(), sources: [{ source: "evil", id: "x" }] },
    ]);
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await fetchStreamedGames(now, { fetchImpl });
  assert.equal(result.catalogCount, 0);
  assert.equal(result.playableSourceCount, 0);
  assert.equal(result.games.length, 0);
  assert.ok(result.errors.some((error) => error.includes("expected an array")));
});
