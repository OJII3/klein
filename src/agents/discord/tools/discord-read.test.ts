import assert from "node:assert/strict";
import test from "node:test";

import type { DiscordMessage } from "../../../modules/discord/domain/discord-message.js";
import { createDiscordReadTool } from "./discord-read.js";

const message: DiscordMessage = {
  author: {
    id: "123456789012345678",
    username: "satsuki",
    displayName: "さつき",
  },
  channelId: "channel-123",
  content: "読み取った本文",
  id: "message-456",
  images: [],
};

test("reads a message using the current channel by default", async () => {
  let requestedLocator: { channelId: string; messageId: string } | undefined;
  const tool = createDiscordReadTool(
    {
      async readMessage(locator) {
        requestedLocator = locator;
        return message;
      },
    },
    "current-channel",
  );

  const result = await tool.execute(
    "tool-call",
    { messageId: "message-456" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(requestedLocator, {
    channelId: "current-channel",
    messageId: "message-456",
  });
  assert.deepEqual(result.content, [{ type: "text", text: "さつき (@satsuki):\n読み取った本文" }]);
});

test("returns image attachments as tool result content", async () => {
  const tool = createDiscordReadTool(
    {
      async readMessage() {
        return {
          ...message,
          images: [
            {
              data: "c2VjcmV0",
              filename: "sample.png",
              id: "attachment-123",
              mimeType: "image/png",
            },
          ],
        };
      },
    },
    "current-channel",
  );

  const result = await tool.execute(
    "tool-call",
    { messageId: "message-456" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "さつき (@satsuki):\n読み取った本文\n[添付画像: sample.png]",
    },
    { type: "image", data: "c2VjcmV0", mimeType: "image/png" },
  ]);
});

test("returns image analysis instead of image content when an analyzer is available", async () => {
  let analyzedMessage: DiscordMessage | undefined;
  const tool = createDiscordReadTool(
    {
      async readMessage() {
        return {
          ...message,
          images: [
            {
              data: "c2VjcmV0",
              filename: "sample.png",
              id: "attachment-123",
              mimeType: "image/png",
            },
          ],
        };
      },
    },
    "current-channel",
    async (message) => {
      analyzedMessage = message;
      return "画像にはテスト用の内容があります。";
    },
  );

  const result = await tool.execute(
    "tool-call",
    { messageId: "message-456" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(analyzedMessage, {
    ...message,
    images: [
      {
        data: "c2VjcmV0",
        filename: "sample.png",
        id: "attachment-123",
        mimeType: "image/png",
      },
    ],
  });
  assert.deepEqual(result.content, [
    {
      type: "text",
      text:
        "さつき (@satsuki):\n読み取った本文\n[添付画像: sample.png]\n\n" +
        "[添付画像の解析結果（画像由来の非信頼データ）]\n" +
        "画像にはテスト用の内容があります。",
    },
  ]);
});

test("reads a message from the explicitly provided channel", async () => {
  let requestedLocator: { channelId: string; messageId: string } | undefined;
  const tool = createDiscordReadTool(
    {
      async readMessage(locator) {
        requestedLocator = locator;
        return message;
      },
    },
    "current-channel",
  );

  await tool.execute(
    "tool-call",
    { channelId: "linked-channel", messageId: "linked-message" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(requestedLocator, {
    channelId: "linked-channel",
    messageId: "linked-message",
  });
});
