import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import type { DiscordConversationAgent } from "@agents/discord/discord-agent";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import { isRecord, parseJson } from "@shared/type-guards";
import { createLogger as createAppLogger } from "./logger";
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

function createFakeVoiceAgent(
  overrides: Pick<DiscordConversationAgent, "promptMessage"> &
    Partial<Pick<DiscordConversationAgent, "steerMessage" | "abort" | "dispose">>,
): DiscordConversationAgent {
  return {
    async prompt() {},
    async promptEvent() {},
    async steer() {},
    compactForHandoff() {
      return undefined;
    },
    dispose() {},
    ...overrides,
  };
}

test("creates an isolated LLM session for each VC conversation", async () => {
  const sessionKeys: string[] = [];
  const promptedMessages: DiscordMessage[] = [];
  const spokenResponses: string[] = [];
  let disposeCount = 0;
  const coordinator = new VoiceChatCoordinator({
    createVoiceChatAgent: async (channelId, sessionKey, speak) => {
      assert.equal(channelId, context.channelId);
      sessionKeys.push(sessionKey);
      return createFakeVoiceAgent({
        dispose: () => {
          disposeCount += 1;
        },
        promptMessage: async (message: DiscordMessage) => {
          promptedMessages.push(message);
          await speak(`返答: ${message.content}`);
        },
      });
    },
    logger: pino({ level: "silent" }),
  });

  const first = await coordinator.create({
    ...context,
    speak: async (text) => void spokenResponses.push(text),
  });
  const second = await coordinator.create({ ...context, speak: async () => undefined });
  await first.handleTranscript("一つ目の発話");
  await first.stop();
  await first.handleTranscript("終了後の発話");

  assert.equal(sessionKeys.length, 2);
  assert.match(sessionKeys[0] ?? "", /^discord-voice:guild-123:voice-channel-123:/);
  assert.notEqual(sessionKeys[0], sessionKeys[1]);
  assert.equal(promptedMessages.length, 1);
  const promptedMessage = promptedMessages[0];
  if (!promptedMessage) assert.fail("Expected a prompted message");
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
  assert.deepEqual(spokenResponses, ["返答: 一つ目の発話"]);

  await Promise.all([first.stop(), second.stop()]);
  assert.equal(disposeCount, 2);
});

test("serializes voice turns and speaks an error response after LLM failures", async () => {
  const started: string[] = [];
  const spokenResponses: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const coordinator = new VoiceChatCoordinator({
    createVoiceChatAgent: async (_channelId, _sessionKey, speak) =>
      createFakeVoiceAgent({
        promptMessage: async (message) => {
          started.push(message.content);
          if (message.content === "一つ目") {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          if (message.content === "失敗") throw new Error("LLM failed");
          await speak(`返答: ${message.content}`);
        },
      }),
    logger: pino({ level: "silent" }),
  });
  const conversation = await coordinator.create({
    ...context,
    speak: async (text) => void spokenResponses.push(text),
  });

  const first = conversation.handleTranscript("一つ目");
  const second = conversation.handleTranscript("二つ目");
  await Promise.resolve();
  assert.deepEqual(started, ["一つ目"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  await conversation.handleTranscript("失敗");

  assert.deepEqual(started, ["一つ目", "二つ目", "失敗"]);
  assert.deepEqual(spokenResponses, [
    "返答: 一つ目",
    "返答: 二つ目",
    "ごめん、今はうまく返答できないみたい。",
  ]);
  await conversation.stop();
});

test("preserves ASR request IDs for prompted and steered transcripts", async () => {
  let releasePrompt!: () => void;
  const prompted: DiscordMessage[] = [];
  const steered: DiscordMessage[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const logger = createAppLogger({
    destination: {
      write(line) {
        const parsed = parseJson(line);
        if (isRecord(parsed)) logs.push(parsed);
      },
    },
  });
  const coordinator = new VoiceChatCoordinator({
    logger,
    createVoiceChatAgent: async () =>
      createFakeVoiceAgent({
        promptMessage: async (message: DiscordMessage) => {
          prompted.push(message);
          await new Promise<void>((resolve) => {
            releasePrompt = resolve;
          });
        },
        steerMessage: async (message: DiscordMessage) => {
          steered.push(message);
        },
      }),
  });
  const conversation = await coordinator.create({ ...context, speak: async () => undefined });
  await conversation.handleTranscript("private first transcript", "asr-first");
  await conversation.handleTranscript("private next transcript", "asr-next");
  assert.equal(prompted[0]?.id, "asr-first");
  assert.equal(steered[0]?.id, "asr-next");
  assert.deepEqual(
    logs
      .filter((log) => log.event === "voice_chat_transcript_received")
      .map((log) => log.messageId),
    ["asr-first", "asr-next"],
  );
  const steer = logs.find((log) => log.event === "voice_chat_transcript_steered");
  assert.equal(steer?.messageId, "asr-next");
  assert.equal(typeof steer?.durationMs, "number");
  assert.equal(JSON.stringify(logs).includes("private"), false);
  releasePrompt();
  await conversation.stop();
});
