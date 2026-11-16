import assert from "node:assert/strict";
import test from "node:test";
import type { ChatInputCommandInteraction } from "discord.js";
import type { AsrClient } from "@modules/asr/domain/asr-client";

import { createDiscordAccessPolicy } from "../domain/discord-access-policy";
import type { VoiceChatConversation } from "../ports/voice-chat-conversation";
import { DiscordVoiceChatController } from "./discord-voice-chat-controller";
import { DiscordVoiceCaptureSession } from "./discord-voice-capture-session";

function createInteraction(
  subcommand: "join" | "leave",
  options: {
    channelId?: string;
    isThread?: boolean;
    parentId?: string;
    userId?: string;
    userIsBot?: boolean;
    sentMessages?: unknown[];
  } = {},
) {
  const replies: string[] = [];
  const sentMessages = options.sentMessages ?? [];
  const interaction = {
    channel: {
      id: options.channelId ?? "channel-123",
      isThread: () => options.isThread ?? false,
      parentId: options.parentId ?? null,
      send: async (message: unknown) => {
        sentMessages.push(message);
      },
    },
    channelId: options.channelId ?? "channel-123",
    deferReply: async () => undefined,
    editReply: async (content: string) => replies.push(content),
    guild: {
      members: {
        fetch: async () => ({
          displayName: "さつき",
          user: { username: "satsuki" },
          voice: { channel: { id: "voice-channel-123" } },
        }),
      },
      voiceAdapterCreator: {},
    },
    guildId: "guild-123",
    inGuild: () => true,
    options: { getSubcommand: () => subcommand },
    reply: async ({ content }: { content: string }) => replies.push(content),
    user: { id: options.userId ?? "user-123", bot: options.userIsBot ?? false },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies, sentMessages };
}

function createController(
  conversationFactory: {
    create(context: {
      readonly channelId: string;
      readonly guildId: string;
      readonly parentChannelId?: string;
      readonly threadId?: string;
      readonly user: {
        readonly bot: boolean;
        readonly displayName: string;
        readonly id: string;
        readonly username: string;
      };
      readonly voiceChannelId: string;
      readonly playReaction?: (reaction: string, signal: AbortSignal) => Promise<boolean>;
    }): Promise<VoiceChatConversation>;
  },
  policy = createDiscordAccessPolicy({ default: "allow", directMessages: "deny" }),
  characterName = "クライン",
) {
  return new DiscordVoiceChatController(policy, undefined, {
    asr: {} as AsrClient,
    characterName,
    conversationFactory,
    language: "ja",
    tts: { synthesize: async () => new Uint8Array() },
  });
}

test("sends final voice transcripts to the dedicated conversation", async () => {
  const originalStart = DiscordVoiceCaptureSession.prototype.start;
  let onTranscript: ((text: string, requestId?: string) => Promise<void>) | undefined;
  DiscordVoiceCaptureSession.prototype.start = async function () {
    onTranscript = (
      this as unknown as {
        options: { onTranscript: (text: string, requestId?: string) => Promise<void> };
      }
    ).options.onTranscript;
  };
  const contexts: unknown[] = [];
  const transcripts: string[] = [];
  const requestIds: Array<string | undefined> = [];
  const controller = createController({
    create: async (context) => {
      contexts.push(context);
      return {
        handleTranscript: async (text, requestId) => {
          transcripts.push(text);
          requestIds.push(requestId);
        },
        stop: async () => undefined,
      };
    },
  });
  const { interaction } = createInteraction("join", {
    channelId: "thread-123",
    isThread: true,
    parentId: "channel-123",
  });

  try {
    await controller.handleCommand(interaction);
    assert.ok(onTranscript);
    await onTranscript("こんにちは", "asr-request-123");

    const { speak, playReaction, onSpeechStart, ...contextWithoutSpeak } = contexts[0] as Record<
      string,
      unknown
    >;
    assert.equal(typeof speak, "function");
    assert.equal(typeof playReaction, "function");
    assert.equal(typeof onSpeechStart, "function");
    assert.deepEqual(contextWithoutSpeak, {
      channelId: "thread-123",
      guildId: "guild-123",
      parentChannelId: "channel-123",
      threadId: "thread-123",
      user: {
        bot: false,
        displayName: "さつき",
        id: "user-123",
        username: "satsuki",
      },
      voiceChannelId: "voice-channel-123",
    });
    assert.deepEqual(transcripts, ["こんにちは"]);
    assert.deepEqual(requestIds, ["asr-request-123"]);
  } finally {
    DiscordVoiceCaptureSession.prototype.start = originalStart;
    await controller.stop();
  }
});

test("blocks VC sessions when the text channel is denied", async () => {
  let createCalls = 0;
  const controller = createController(
    {
      create: async () => {
        createCalls += 1;
        return { handleTranscript: async () => undefined, stop: async () => undefined };
      },
    },
    createDiscordAccessPolicy({ default: "deny", directMessages: "deny" }),
  );
  const { interaction, replies } = createInteraction("join");

  try {
    await controller.handleCommand(interaction);

    assert.equal(createCalls, 0);
    assert.deepEqual(replies, ["このチャンネルではVC会話を利用できません。"]);
  } finally {
    await controller.stop();
  }
});

test("stops the capture and dedicated conversation on leave", async () => {
  const stopped: string[] = [];
  const originalStart = DiscordVoiceCaptureSession.prototype.start;
  DiscordVoiceCaptureSession.prototype.start = async () => undefined;
  const controller = createController({
    create: async () => ({
      handleTranscript: async () => undefined,
      stop: async () => {
        stopped.push("conversation");
      },
    }),
  });
  const { interaction: join } = createInteraction("join");
  const { interaction: leave, replies } = createInteraction("leave");

  try {
    await controller.handleCommand(join);
    await controller.handleCommand(leave);

    assert.deepEqual(stopped, ["conversation"]);
    assert.deepEqual(replies, ["VCから退出しました。"]);
  } finally {
    DiscordVoiceCaptureSession.prototype.start = originalStart;
    await controller.stop();
  }
});

test("owner VC access rejects other users and bots and accepts the owner", async () => {
  const originalStart = DiscordVoiceCaptureSession.prototype.start;
  DiscordVoiceCaptureSession.prototype.start = async () => undefined;
  let createCalls = 0;
  const controller = createController(
    {
      create: async () => {
        createCalls += 1;
        return { handleTranscript: async () => undefined, stop: async () => undefined };
      },
    },
    createDiscordAccessPolicy({ default: "owner", directMessages: "deny" }, "user-123"),
  );
  try {
    for (const identity of [{ userId: "other-user" }, { userIsBot: true }]) {
      const { interaction, replies } = createInteraction("join", identity);
      await controller.handleCommand(interaction);
      assert.deepEqual(replies, ["このチャンネルではVC会話を利用できません。"]);
    }
    assert.equal(createCalls, 0);
    await controller.handleCommand(createInteraction("join").interaction);
    assert.equal(createCalls, 1);
  } finally {
    DiscordVoiceCaptureSession.prototype.start = originalStart;
    await controller.stop();
  }
});

test("uses characterName in VC join and leave announcements", async () => {
  const originalStart = DiscordVoiceCaptureSession.prototype.start;
  DiscordVoiceCaptureSession.prototype.start = async () => undefined;
  const controller = createController(
    {
      create: async () => ({
        handleTranscript: async () => undefined,
        stop: async () => undefined,
      }),
    },
    undefined,
    "月見ヤチヨ",
  );
  const sentMessages: unknown[] = [];
  const { interaction: join } = createInteraction("join", { sentMessages });
  const { interaction: leave } = createInteraction("leave", { sentMessages });

  try {
    await controller.handleCommand(join);
    await controller.handleCommand(leave);

    assert.equal(sentMessages.length, 2);
    assert.match(JSON.stringify(sentMessages[0]), /月見ヤチヨが参加しました/);
    assert.match(JSON.stringify(sentMessages[1]), /月見ヤチヨが退出しました/);
  } finally {
    DiscordVoiceCaptureSession.prototype.start = originalStart;
    await controller.stop();
  }
});
