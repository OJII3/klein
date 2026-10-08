import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "pino";

import type { DiscordAgent } from "@agents/discord/discord-agent";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import { VoiceChatCoordinator } from "./voice-chat-coordinator";

const context = {
  channelId: "text-channel-123",
  guildId: "guild-123",
  user: {
    bot: false,
    displayName: "さつき",
    id: "user-123",
    username: "satsuki",
  },
  voiceChannelId: "voice-channel-123",
};

function createLogger(): Logger {
  const logger = {
    child: () => logger,
    error: () => undefined,
  };
  return logger as unknown as Logger;
}

test("creates an isolated LLM session for each VC conversation", async () => {
  const sessionKeys: string[] = [];
  const promptedMessages: unknown[] = [];
  let disposeCount = 0;
  const coordinator = new VoiceChatCoordinator({
    createVoiceChatAgent: async (channelId, sessionKey) => {
      assert.equal(channelId, context.channelId);
      sessionKeys.push(sessionKey);
      return {
        dispose: () => {
          disposeCount += 1;
        },
        prompt: async (message: DiscordMessage) => {
          promptedMessages.push(message);
        },
      } as unknown as DiscordAgent;
    },
    logger: createLogger(),
    sendMessage: async () => undefined,
  });

  const first = await coordinator.create(context);
  const second = await coordinator.create(context);
  await first.handleTranscript("一つ目の発話");
  await first.stop();
  await first.handleTranscript("終了後の発話");

  assert.equal(sessionKeys.length, 2);
  assert.match(sessionKeys[0] ?? "", /^discord-voice:guild-123:voice-channel-123:/);
  assert.notEqual(sessionKeys[0], sessionKeys[1]);
  assert.equal(promptedMessages.length, 1);
  const promptedMessage = promptedMessages[0] as {
    author: unknown;
    channelId: string;
    content: string;
    guildId: string;
    id: string;
    images: unknown[];
    parentChannelId?: string;
    threadId?: string;
  };
  assert.match(promptedMessage.id, /.+/);
  assert.deepEqual(
    {
      author: promptedMessage.author,
      channelId: promptedMessage.channelId,
      content: promptedMessage.content,
      guildId: promptedMessage.guildId,
      images: promptedMessage.images,
      parentChannelId: promptedMessage.parentChannelId,
      threadId: promptedMessage.threadId,
    },
    {
      author: context.user,
      channelId: context.channelId,
      content: "一つ目の発話",
      guildId: context.guildId,
      images: [],
      parentChannelId: undefined,
      threadId: undefined,
    },
  );

  await Promise.all([first.stop(), second.stop()]);
  assert.equal(disposeCount, 2);
});

test("serializes voice turns and reports LLM failures in the text channel", async () => {
  const started: string[] = [];
  const errorMessages: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const coordinator = new VoiceChatCoordinator({
    createVoiceChatAgent: async () =>
      ({
        dispose: () => undefined,
        prompt: async (message: { content: string }) => {
          started.push(message.content);
          if (message.content === "一つ目") {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          if (message.content === "失敗") throw new Error("LLM failed");
        },
      }) as unknown as DiscordAgent,
    logger: createLogger(),
    sendMessage: async (_channelId, content) => {
      errorMessages.push(content);
    },
  });
  const conversation = await coordinator.create(context);

  const first = conversation.handleTranscript("一つ目");
  const second = conversation.handleTranscript("二つ目");
  await Promise.resolve();
  assert.deepEqual(started, ["一つ目"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  await conversation.handleTranscript("失敗");

  assert.deepEqual(started, ["一つ目", "二つ目", "失敗"]);
  assert.deepEqual(errorMessages, ["ごめん、今はうまく返答できないみたい。"]);
  await conversation.stop();
});
