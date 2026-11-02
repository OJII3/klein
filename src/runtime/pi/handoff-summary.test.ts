import assert from "node:assert/strict";
import test from "node:test";

import { extractHandoffSource, formatHandoffSummary } from "./handoff-summary";

test("extracts user messages and carries forward the previous compaction summary", () => {
  const result = extractHandoffSource([
    {
      kind: "pi.user",
      model: [{ role: "user", content: [{ type: "text", text: "ユーザーの依頼" }] }],
    },
    {
      kind: "pi.assistant",
      model: [{ role: "assistant", content: [{ type: "text", text: "assistantの説明" }] }],
    },
    {
      kind: "pi.compaction",
      model: [{ role: "user", content: "過去の要約" }],
    },
    {
      kind: "klein.event",
      model: [{ role: "user", content: "続きの依頼" }],
    },
  ]);

  assert.deepEqual(result, {
    source: "ユーザーの依頼\n\n続きの依頼",
    previousSummary: "過去の要約",
  });
});

test("formats at most ten bullets within 800 characters", () => {
  const summary = formatHandoffSummary(
    ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"]
      .map((item) => `- ${item.repeat(100)}`)
      .join("\n"),
  );
  const handoffBullets = summary.split("## 引き継ぎ\n")[1]!;

  assert.ok(handoffBullets.split("\n").length <= 10);
  assert.ok(handoffBullets.length <= 800);
  assert.match(handoffBullets, /^- /);
  assert.doesNotMatch(handoffBullets, /eleven/);
});
