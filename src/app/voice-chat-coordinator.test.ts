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
    info: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as Logger;
}

test("creates an isolated LLM session for each VC conversation", async () => {
  const sessionKeys: string[] = [];
  const promptedMessages: unknown[] = [];
  const spokenResponses: string[] = [];
  let disposeCount = 0;
  const coordinator = new VoiceChatCoordinator({
    createVoiceChatAgent: async (channelId, sessionKey, speak) => {
      assert.equal(channelId, context.channelId);
      sessionKeys.push(sessionKey);
      return {
        dispose: () => {
          disposeCount += 1;
        },
        prompt: async (message: DiscordMessage) => {
          promptedMessages.push(message);
          await speak(`返答: ${message.content}`);
        },
      } as unknown as DiscordAgent;
    },
    logger: createLogger(),
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
          await speak(`返答: ${message.content}`);
        },
      }) as unknown as DiscordAgent,
    logger: createLogger(),
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

test("selects and plays a preset reaction while the LLM is preparing its answer", async () => {
  let releasePrompt: (() => void) | undefined;
  let reactionStarted: (() => void) | undefined;
  const reactionWasStarted = new Promise<void>((resolve) => {
    reactionStarted = resolve;
  });
  let selectedInput: unknown;
  let playedReaction: string | undefined;
  let reactionSignal: AbortSignal | undefined;
  const coordinator = new VoiceChatCoordinator({
    createVoiceChatAgent: async () =>
      ({
        dispose: () => undefined,
        prompt: async () =>
          new Promise<void>((resolve) => {
            releasePrompt = resolve;
          }),
      }) as unknown as DiscordAgent,
    logger: createLogger(),
    reactionSelector: {
      select: async (input) => {
        selectedInput = input;
        return "preset-ack";
      },
    },
  });
  const conversation = await coordinator.create({
    ...context,
    playReaction: async (reaction, signal) => {
      playedReaction = reaction;
      reactionSignal = signal;
      reactionStarted?.();
      return true;
    },
    speak: async () => undefined,
  });

  const processing = conversation.handleTranscript("こんにちは");
  await reactionWasStarted;
  assert.deepEqual(selectedInput, {
    text: "こんにちは",
    recentTranscripts: [],
    lastReaction: undefined,
  });
  assert.equal(playedReaction, "preset-ack");
  await new Promise((resolve) => setTimeout(resolve, 610));
  assert.equal(reactionSignal?.aborted, false);
  releasePrompt?.();
  await processing;
  await conversation.stop();
});

test("keeps reaction selection parallel and carries the last played preset into the next turn", async () => {
  const prompts: Array<() => void> = [];
  const played: string[] = [];
  const inputs: Array<{ text: string; lastReaction?: string }> = [];
  const playedWaiters: Array<() => void> = [];
  const coordinator = new VoiceChatCoordinator({
    createVoiceChatAgent: async () =>
      ({
        dispose: () => undefined,
        prompt: async () =>
          new Promise<void>((resolve) => {
            prompts.push(resolve);
          }),
      }) as unknown as DiscordAgent,
    logger: createLogger(),
    reactionSelector: {
      select: async (input) => {
        inputs.push(input);
        return `preset-${inputs.length}`;
      },
    },
  });
  const conversation = await coordinator.create({
    ...context,
    playReaction: async (reaction) => {
      played.push(reaction);
      playedWaiters.shift()?.();
      return true;
    },
    speak: async () => undefined,
  });

  const waitForPlay = (): Promise<void> =>
    new Promise((resolve) => {
      playedWaiters.push(resolve);
    });
  const firstPlayed = waitForPlay();
  const first = conversation.handleTranscript("最初の話");
  await firstPlayed;
  assert.deepEqual(played, ["preset-1"]);
  prompts.shift()?.();
  await first;

  const secondPlayed = waitForPlay();
  const second = conversation.handleTranscript("次の話");
  await secondPlayed;
  assert.equal(inputs[1]?.lastReaction, "preset-1");
  assert.deepEqual(played, ["preset-1", "preset-2"]);
  prompts.shift()?.();
  await second;
  await conversation.stop();
});

test("does not wait for a selector that ignores cancellation", async () => {
  let releasePrompt: (() => void) | undefined;
  let selectorStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    selectorStarted = resolve;
  });
  const coordinator = new VoiceChatCoordinator({
    createVoiceChatAgent: async () =>
      ({
        dispose: () => undefined,
        prompt: async () =>
          new Promise<void>((resolve) => {
            releasePrompt = resolve;
          }),
      }) as unknown as DiscordAgent,
    logger: createLogger(),
    reactionSelector: {
      select: async () => {
        selectorStarted?.();
        return new Promise<string | undefined>(() => undefined);
      },
    },
  });
  const conversation = await coordinator.create({
    ...context,
    playReaction: async () => false,
    speak: async () => undefined,
  });

  const processing = conversation.handleTranscript("質問");
  await started;
  releasePrompt?.();
  await processing;
  await conversation.stop();
});

test("speech start cancels a pending reaction decision", async () => {
  let notifySpeechStart: (() => void) | undefined;
  let releasePrompt: (() => void) | undefined;
  let selectorStarted: (() => void) | undefined;
  let selectorSignal: AbortSignal | undefined;
  let played = false;
  const started = new Promise<void>((resolve) => {
    selectorStarted = resolve;
  });
  const coordinator = new VoiceChatCoordinator({
    createVoiceChatAgent: async () =>
      ({
        dispose: () => undefined,
        prompt: async () =>
          new Promise<void>((resolve) => {
            releasePrompt = resolve;
          }),
      }) as unknown as DiscordAgent,
    logger: createLogger(),
    reactionSelector: {
      select: async (_input, signal) => {
        selectorSignal = signal;
        selectorStarted?.();
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve("preset-ack"), 10);
        });
      },
    },
  });
  const conversation = await coordinator.create({
    ...context,
    onSpeechStart: (listener) => {
      notifySpeechStart = listener;
      return () => undefined;
    },
    playReaction: async () => {
      played = true;
      return true;
    },
    speak: async () => undefined,
  });

  const processing = conversation.handleTranscript("質問");
  await started;
  notifySpeechStart?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(selectorSignal?.aborted, true);
  assert.equal(played, false);
  releasePrompt?.();
  await processing;
  await conversation.stop();
});
