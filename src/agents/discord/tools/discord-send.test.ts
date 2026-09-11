import assert from "node:assert/strict";
import test from "node:test";

import { createDiscordSendTool } from "./discord-send.js";

test("returns the sent content and terminates after the final message", async () => {
  let sentMessage: { channelId: string; content: string } | undefined;
  const tool = createDiscordSendTool(
    {
      async sendMessage(channelId, content) {
        sentMessage = { channelId, content };
      },
    },
    "current-channel",
  );

  const result = await tool.execute(
    "tool-call",
    { content: "送信する本文", next_action: "finish" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(sentMessage, {
    channelId: "current-channel",
    content: "送信する本文",
  });
  assert.deepEqual(result.content, [
    {
      type: "text",
      text:
        "The message was sent to Discord.\n" +
        "Sent content:\n送信する本文\n" +
        "Next action: finish.",
    },
  ]);
  assert.equal(result.terminate, true);
});

test("continues the agent loop when more work is needed", async () => {
  const tool = createDiscordSendTool({ async sendMessage() {} }, "current-channel");

  const result = await tool.execute(
    "tool-call",
    { content: "調べてみる", next_action: "continue" },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(result.terminate, false);
});
