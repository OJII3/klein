import assert from "node:assert/strict";
import test from "node:test";

import { rewriteFxtwitterFetchInput, toFxTwitterApiUrl } from "./fxtwitter-fetch.js";

test("rewrites X and Twitter status URLs to the FxTwitter API", () => {
  assert.equal(
    toFxTwitterApiUrl("https://x.com/example/status/1234567890123456789"),
    "https://api.fxtwitter.com/2/status/1234567890123456789",
  );
  assert.equal(
    toFxTwitterApiUrl("https://mobile.twitter.com/example/status/123/photo/2"),
    "https://api.fxtwitter.com/2/status/123",
  );
});

test("does not rewrite unrelated URLs", () => {
  assert.equal(toFxTwitterApiUrl("https://x.com/example"), undefined);
  assert.equal(toFxTwitterApiUrl("https://example.com/status/123"), undefined);
  assert.equal(toFxTwitterApiUrl("https://not-x.com/example/status/123"), undefined);
});

test("rewrites single and multiple fetch_content URLs", () => {
  const input: Record<string, unknown> = {
    url: "https://twitter.com/example/status/1234567890",
    urls: ["https://x.com/example/status/9876543210", "https://example.com/docs"],
  };

  rewriteFxtwitterFetchInput(input);

  assert.deepEqual(input, {
    url: "https://api.fxtwitter.com/2/status/1234567890",
    urls: ["https://api.fxtwitter.com/2/status/9876543210", "https://example.com/docs"],
  });
});
