import test from "node:test";
import assert from "node:assert/strict";
import { __testing } from "./ppvstreams.mjs";

const event = { uri_name: "dutch-darts-session-30519" };
const path = `/embed/${event.uri_name}`;

test("PPV accepts exact API-selected rotated host without changing its event path", () => {
  const iframe = `https://taifood-blog.asia${path}`;
  assert.equal(__testing.safeEmbedUrl({ ...event, iframe }), iframe);
});

test("PPV preserves legacy signed context and missing-iframe fallback", () => {
  const iframe = `https://embedindia.st${path}?gid=opaque-test-value`;
  assert.equal(__testing.safeEmbedUrl({ ...event, iframe }), iframe);
  assert.equal(__testing.safeEmbedUrl(event), `https://embedindia.st${path}`);
});

test("PPV preserves canonical nested event routes accepted by Android", () => {
  const uri_name = "mlb/2026-09-10/hou-phi";
  const iframe = `https://taifood-blog.asia/embed/${uri_name}`;
  assert.equal(__testing.safeEmbedUrl({ uri_name, iframe }), iframe);
  for (const route of ["event%2Fother", "event/../other", "event//other", ".event", "event/"]) {
    assert.equal(__testing.safeEmbedUrl({ uri_name: route, iframe: `https://taifood-blog.asia/embed/${route}` }), "");
  }
});

for (const iframe of [
  `http://taifood-blog.asia${path}`,
  `https://taifood-blog.asia.evil.test${path}`,
  `https://sub.taifood-blog.asia${path}`,
  `https://taifood-blog.asia:444${path}`,
  `https://user:pass@taifood-blog.asia${path}`,
  `https://taifood-blog.asia${path}#frame`,
  `https://taifood-blog.asia${path}?event=other`,
  `https://taifood-blog.asia${path}?gid=opaque`,
  `https://taifood-blog.asia${path}?`,
  `https://taifood-blog.asia${path}#`,
  `https://taifood-blog.asia:443${path}`,
  `https://taifood-blog.asia/a/..${path}`,
  "https://taifood-blog.asia/embed/another-event",
  `https://taifood-blog.asia/watch/${event.uri_name}`,
]) {
  test(`PPV rejects unbound or unsafe catalog page: ${iframe}`, () => {
    assert.equal(__testing.safeEmbedUrl({ ...event, iframe }), "");
  });
}

