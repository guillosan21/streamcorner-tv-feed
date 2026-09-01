import assert from "node:assert/strict";
import test from "node:test";

import { __testing } from "./ppvstreams.mjs";

test("accepts verified always-live sports channels", () => {
  for (const event of [
    { always_live: true, name: "Fox Footy", category: "Australian Football" },
    { always_live: 1, name: "Willow", category: "Cricket" },
    { always_live: true, name: "US Open: ESPN & ESPN2", category: "Tennis" },
    { always_live: true, name: "Rally TV", category: "24/7 Streams" },
  ]) {
    assert.equal(__testing.isSports24x7Event(event), true, event.name);
  }
});

test("rejects entertainment and non-always-live entries", () => {
  for (const event of [
    { always_live: true, name: "Family Guy", category: "24/7 Streams" },
    { always_live: true, name: "The Simpsons", category: "24/7 Streams" },
    { always_live: true, name: "SpongeBob", category: "24/7 Streams" },
    { always_live: false, name: "ESPN", category: "Sports" },
  ]) {
    assert.equal(__testing.isSports24x7Event(event), false, event.name);
  }
});
