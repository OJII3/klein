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
  options: { channelId?: string; isThread?: boolean; parentId?: string } = {},
) {
  const replies: string[] = [];
  const interaction = {
    channel: {
      id: options.channelId ?? "channel-123",
      isThread: () => options.isThread ?? false,
      parentId: options.parentId ?? null,
      send: async () => undefined,
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
    user: { id: "user-123" },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies };
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
    }): Promise<VoiceChatConversation>;
  },
  policy = createDiscordAccessPolicy({ default: "allow", directMessages: "deny" }),
) {
  return new DiscordVoiceChatController(policy, undefined, {
    asr: {} as AsrClient,
    conversationFactory,
    language: "ja",
  });
}

test("sends final voice transcripts to the dedicated conversation", async () => {
  const originalStart = DiscordVoiceCaptureSession.prototype.start;
  let onTranscript: ((text: string) => Promise<void>) | undefined;
  DiscordVoiceCaptureSession.prototype.start = async function () {
    onTranscript = (
      this as unknown as {
        options: { onTranscript: (text: string) => Promise<void> };
      }
    ).options.onTranscript;
  };
  const contexts: unknown[] = [];
  const transcripts: string[] = [];
  const controller = createController({
    create: async (context) => {
      contexts.push(context);
      return {
        handleTranscript: async (text) => {
          transcripts.push(text);
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
    await onTranscript("こんにちは");

    assert.deepEqual(contexts, [
      {
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
      },
    ]);
    assert.deepEqual(transcripts, ["こんにちは"]);
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
