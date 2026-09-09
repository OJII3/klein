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

function createMessage(): Message {
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
    content: "メンションなしのメッセージ",
    guildId: "guild-123",
    id: "message-123",
    mentions: {
      roles: new Map(),
      users: new Map(),
    },
  } as unknown as Message;
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
