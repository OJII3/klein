import assert from "node:assert/strict";
import test from "node:test";
import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";
import type { AsrClient } from "@modules/asr/domain/asr-client";

import { createDiscordAccessPolicy } from "../domain/discord-access-policy";
import type {
  VoiceChatConversationContext,
  VoiceChatConversationFactory,
} from "../ports/voice-chat-conversation";
import {
  DiscordVoiceChatController,
  type VoiceCaptureSession,
  type VoiceChatCommandInteraction,
} from "./discord-voice-chat-controller";

const adapterCreator: DiscordGatewayAdapterCreator = () => ({
  sendPayload: () => true,
  destroy: () => undefined,
});

const asrStub: AsrClient = {
  connect: async () => ({
    onError: () => () => undefined,
    start: () => ({ write: () => undefined, commit: async () => ({ text: "" }) }),
    close: () => undefined,
  }),
};

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
  const channel = {
    id: options.channelId ?? "channel-123",
    isThread: () => options.isThread ?? false,
    parentId: options.parentId ?? null,
    send: async (message: unknown) => {
      sentMessages.push(message);
    },
  };
  const interaction: VoiceChatCommandInteraction = {
    channel,
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
      voiceAdapterCreator: adapterCreator,
    },
    guildId: "guild-123",
    inGuild: () => true,
    options: { getSubcommand: () => subcommand },
    reply: async ({ content }: { content: string }) => replies.push(content),
    user: { id: options.userId ?? "user-123", bot: options.userIsBot ?? false },
  };
  return { interaction, replies, sentMessages };
}

function createSessionStub(): VoiceCaptureSession {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    speakInBackground: async () => undefined,
    playReaction: async () => false,
    subscribeSpeechStart: () => () => undefined,
  };
}

function createController(
  conversationFactory: VoiceChatConversationFactory,
  policy = createDiscordAccessPolicy({ default: "allow", directMessages: "deny" }),
  characterName = "クライン",
  createSession: (options: {
    readonly onTranscript: (text: string, requestId?: string) => Promise<void>;
  }) => VoiceCaptureSession = () => createSessionStub(),
) {
  return new DiscordVoiceChatController(policy, undefined, {
    asr: asrStub,
    characterName,
    conversationFactory,
    createSession,
    language: "ja",
    tts: { synthesize: async () => new Uint8Array() },
  });
}

test("sends final voice transcripts to the dedicated conversation", async () => {
  let onTranscript: ((text: string, requestId?: string) => Promise<void>) | undefined;
  const contexts: VoiceChatConversationContext[] = [];
  const transcripts: string[] = [];
  const requestIds: Array<string | undefined> = [];
  const controller = createController(
    {
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
    },
    undefined,
    "クライン",
    (options) => {
      onTranscript = options.onTranscript;
      return createSessionStub();
    },
  );
  const { interaction } = createInteraction("join", {
    channelId: "thread-123",
    isThread: true,
    parentId: "channel-123",
  });

  try {
    await controller.handleCommand(interaction);
    assert.ok(onTranscript);
    await onTranscript("こんにちは", "asr-request-123");

    const [context] = contexts;
    assert.ok(context);
    const { speak, playReaction, onSpeechStart, ...contextWithoutSpeak } = context;
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
    await controller.stop();
  }
});

test("owner VC access rejects other users and bots and accepts the owner", async () => {
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
    await controller.stop();
  }
});

test("uses characterName in VC join and leave announcements", async () => {
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
    await controller.stop();
  }
});
