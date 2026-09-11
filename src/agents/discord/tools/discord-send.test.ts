import assert from "node:assert/strict";
import test from "node:test";

import { createDiscordSendTool } from "./discord-send.js";

test("returns the sent content in the tool result", async () => {
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
    { content: "送信する本文" },
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
      text: "The message was sent to Discord.\nSent content:\n送信する本文",
    },
  ]);
});
