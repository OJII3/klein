import assert from "node:assert/strict";
import test from "node:test";

import { MessageFlags } from "discord.js";

import {
  DISCORD_TEXT_DISPLAY_LIMIT,
  createEphemeralTextContainerMessage,
  createTextContainerMessage,
  truncateTextLines,
} from "./discord-component-message";

test("wraps text in a components v2 container with the tone color", () => {
  const message = createTextContainerMessage("許可しました", "success");

  assert.equal(message.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(message.components[0]?.toJSON(), {
    type: 17,
    accent_color: 0x57f287,
    components: [{ type: 10, content: "許可しました" }],
  });
});

test("keeps the default accent color when no tone is given", () => {
  const message = createTextContainerMessage("一覧です");

  assert.deepEqual(message.components[0]?.toJSON(), {
    type: 17,
    components: [{ type: 10, content: "一覧です" }],
  });
});

test("uses the neutral tone color when asked", () => {
  const message = createTextContainerMessage("一覧です", "neutral");

  assert.equal(message.components[0]?.toJSON().accent_color, 0x747f8d);
});

test("marks the message ephemeral when asked", () => {
  const message = createEphemeralTextContainerMessage("確認しています", "warning");

  assert.equal(message.flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
});

test("truncates long lists and reports the remaining line count", () => {
  assert.equal(truncateTextLines(["a", "b", "c"], 2), "a\n…ほか 2 件");
  assert.equal(truncateTextLines(["a", "b"], 10), "a\nb");
});

test("keeps every line that fits within the text display limit", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line-${index}`);
  const text = truncateTextLines(lines);

  assert.equal(text, lines.join("\n"));
  assert.ok(text.length <= DISCORD_TEXT_DISPLAY_LIMIT);
});
