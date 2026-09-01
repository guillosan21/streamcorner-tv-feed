import assert from "node:assert/strict";
import test from "node:test";

import { __testing } from "./dlstreams.mjs";

test("keeps dedicated sports networks and excludes entertainment", () => {
  for (const name of ["ESPN USA", "Fox Sports 1 USA", "TUDN MX", "NFL Network USA", "Sky Sports F1 UK", "Willow Cricket"]) {
    assert.equal(__testing.isSportsChannel(name), true, name);
  }
  for (const name of ["ABC USA", "Family Guy", "Fox News USA", "Showtime USA", "Cartoon Network", "18+ Player"]) {
    assert.equal(__testing.isSportsChannel(name), false, name);
  }
});

test("parses unique sports channels from the provider catalog", () => {
  const html = `
    <a href="/watch.php?id=44"><span>ESPN USA</span><span>ID: 44</span></a>
    <a href="/watch.php?id=39">Fox Sports 1 USA <b>ID: 39</b></a>
    <a href="/watch.php?id=44">ESPN duplicate ID: 44</a>
    <a href="/watch.php?id=333">Showtime USA ID: 333</a>`;
  assert.deepEqual(__testing.parseChannels(html), [
    { id: "44", name: "ESPN USA", group: "United States Sports" },
    { id: "39", name: "Fox Sports 1 USA", group: "United States Sports" },
  ]);
});

test("puts the most useful local regions first and sorts channels naturally", () => {
  const channels = [
    { name: "Arena Sport 2", group: "Europe Sports" },
    { name: "TUDN MX", group: "Mexico Sports" },
    { name: "ESPN 10 USA", group: "United States Sports" },
    { name: "ESPN 2 USA", group: "United States Sports" },
  ].sort(__testing.compareChannels);
  assert.deepEqual(channels.map((channel) => channel.name), ["ESPN 2 USA", "ESPN 10 USA", "TUDN MX", "Arena Sport 2"]);
});

test("groups Mexico and international channels without changing their names", () => {
  assert.equal(__testing.channelGroup("ESPN 1 MX"), "Mexico Sports");
  assert.equal(__testing.channelGroup("NFL Network"), "United States Sports");
  assert.equal(__testing.channelGroup("beIN Sports MENA English 1"), "Middle East & Africa Sports");
});

test("extracts only the validated provider player route", () => {
  const html = '<iframe src="https://ads.example/player?id=44"></iframe>' +
    '<iframe src="https://hamis.romponalis.st/premiumtv/daddy3.php?id=44"></iframe>';
  assert.equal(
    __testing.parsePlayerTemplate(html, "44"),
    "https://hamis.romponalis.st/premiumtv/daddy3.php?id=__CHANNEL_ID__",
  );
  assert.equal(__testing.parsePlayerTemplate(html, "45"), "");
});

test("ships verified high-resolution channel artwork", () => {
  assert.match(__testing.channelLogoUrl("44"), /^https:\/\/.+/); // ESPN USA
  assert.match(__testing.channelLogoUrl("935"), /^https:\/\/.+/); // TUDN MX
  assert.equal(__testing.channelLogoUrl("not-a-channel"), "");
});
