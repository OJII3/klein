import assert from "node:assert/strict";
import test from "node:test";

import { truncateWatchOutput } from "./watch-output";

test("keeps runner-sized output intact", () => {
  const output = "a".repeat(64 * 1024);
  assert.equal(truncateWatchOutput(output), output);
});

test("truncates output larger than the display limit", () => {
  const output = "a".repeat(64 * 1024 + 1);
  const truncated = truncateWatchOutput(output);
  assert.match(truncated, /1文字省略/u);
  assert.ok(truncated.startsWith("a".repeat(64 * 1024)));
});
