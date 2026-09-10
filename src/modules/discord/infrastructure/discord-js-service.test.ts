import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "discord.js";

import { createDiscordAccessPolicy } from "../domain/discord-access-policy.js";
import type { DiscordMessage } from "../domain/discord-message.js";
import type { DiscordMessageHandler } from "../ports/discord-service.js";
import { DiscordJsService } from "./discord-js-service.js";

type TestableDiscordJsService = {
  readonly client: {
    user: { id: string } | null;
  };
  acceptingMessages: boolean;
  onMessage?: DiscordMessageHandler;
  handleMessage(message: Message): Promise<void>;
};

function createMessage(
  options: { content?: string; attachments?: Map<string, unknown> } = {},
): Message {
  return {
    author: {
      bot: false,
      displayName: "さつき",
      id: "user-123",
      username: "satsuki",
    },
    channel: {
      isThread: () => false,
      send: async () => undefined,
    },
    channelId: "channel-123",
    content: options.content ?? "メンションなしのメッセージ",
    guildId: "guild-123",
    id: "message-123",
    attachments: options.attachments ?? new Map(),
    mentions: {
      roles: new Map(),
      users: new Map(),
    },
  } as unknown as Message;
}

function createImageAttachment() {
  return {
    contentType: "image/png",
    id: "attachment-123",
    name: "sample.png",
    size: 68,
    url: "https://cdn.discordapp.com/attachments/sample.png",
  };
}

test("forwards guild messages without a bot mention", async () => {
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
  );
  const testableService = service as unknown as TestableDiscordJsService;
  testableService.client.user = { id: "bot-123" };
  testableService.acceptingMessages = true;

  const received: DiscordMessage[] = [];
  testableService.onMessage = async (message) => {
    received.push(message);
  };

  try {
    await testableService.handleMessage(createMessage());

    assert.equal(received.length, 1);
    assert.equal(received[0]?.content, "メンションなしのメッセージ");
  } finally {
    await service.stop();
  }
});

test("forwards image attachments, including image-only messages", async () => {
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
  );
  const testableService = service as unknown as TestableDiscordJsService;
  testableService.client.user = { id: "bot-123" };
  testableService.acceptingMessages = true;

  const received: DiscordMessage[] = [];
  testableService.onMessage = async (message) => {
    received.push(message);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      { headers: { "content-type": "image/png" } },
    );

  try {
    await testableService.handleMessage(
      createMessage({
        attachments: new Map([["attachment-123", createImageAttachment()]]),
        content: "",
      }),
    );

    assert.equal(received.length, 1);
    assert.equal(received[0]?.content, "");
    assert.deepEqual(
      received[0]?.images.map(({ filename, id, mimeType }) => ({ filename, id, mimeType })),
      [{ filename: "sample.png", id: "attachment-123", mimeType: "image/png" }],
    );
    assert.ok(received[0]?.images[0]?.data);
  } finally {
    globalThis.fetch = originalFetch;
    await service.stop();
  }
});
