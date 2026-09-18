import assert from "node:assert/strict";
import test from "node:test";

import { truncateVoiceCommentary } from "./openai-live-voice-session";

test("normalizes whitespace in voice commentary", () => {
  assert.equal(truncateVoiceCommentary("  結果は\n確認できました。  "), "結果は 確認できました。");
});

test("keeps voice commentary within the conservative character limit", () => {
  const commentary = truncateVoiceCommentary(`${"あ".repeat(250)}。${"い".repeat(300)}`);

  assert.ok(commentary.length <= 400);
  assert.equal(commentary.endsWith("。"), true);
});
