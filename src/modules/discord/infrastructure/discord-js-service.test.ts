import assert from "node:assert/strict";
import test from "node:test";
import type { Interaction, Message } from "discord.js";
import type { StreamingAsr } from "@modules/asr/domain/streaming-asr";

import { createDiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordMessage } from "../domain/discord-message";
import { DiscordOperatingState } from "../domain/discord-operating-state";
import type { DiscordMessageHandler } from "../ports/discord-service";
import { DiscordJsService } from "./discord-js-service";
import { DiscordVoiceChatSession } from "./discord-voice-chat-session";

type TestableDiscordJsService = {
  readonly client: {
    user: {
      id: string;
      setActivity?: (name: string) => void;
      setStatus?: (status: "online" | "idle") => void;
    } | null;
  };
  acceptingMessages: boolean;
  onMessage?: DiscordMessageHandler;
  handleMessage(message: Message): Promise<void>;
  handleInteraction(interaction: Interaction): Promise<void>;
};

function createVoiceJoinInteraction(
  options: {
    readonly channelId?: string;
    readonly isThread?: boolean;
    readonly parentId?: string;
  } = {},
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
    commandName: "voice",
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
    isChatInputCommand: () => true,
    options: { getSubcommand: () => "join" },
    reply: async ({ content }: { content: string }) => replies.push(content),
    user: { id: "user-123" },
  } as unknown as Interaction;
  return { interaction, replies };
}

function createMessage(
  options: {
    author?: { bot?: boolean; id?: string };
    content?: string;
    attachments?: Map<string, unknown>;
  } = {},
): Message {
  return {
    author: {
      bot: options.author?.bot ?? false,
      displayName: "さつき",
      id: options.author?.id ?? "user-123",
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

test("ignores only messages sent by this bot", async () => {
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
    await testableService.handleMessage(
      createMessage({ author: { bot: true, id: "bot-123" }, content: "自分の送信メッセージ" }),
    );
    await testableService.handleMessage(
      createMessage({ author: { bot: true, id: "other-bot-456" }, content: "別 bot のメッセージ" }),
    );

    assert.equal(received.length, 1);
    assert.equal(received[0]?.author.id, "other-bot-456");
    assert.equal(received[0]?.content, "別 bot のメッセージ");
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

test("sets the bot activity", async () => {
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
  );
  const testableService = service as unknown as TestableDiscordJsService;
  const activities: string[] = [];
  testableService.client.user = {
    id: "bot-123",
    setActivity: (name) => activities.push(name),
  };

  try {
    service.setActivity("65.5%/month (reset in 17 days)");
    assert.deepEqual(activities, ["65.5%/month (reset in 17 days)"]);
  } finally {
    await service.stop();
  }
});

test("pauses message handling while the bot is idle", async () => {
  const operatingState = new DiscordOperatingState();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    operatingState,
  );
  const testableService = service as unknown as TestableDiscordJsService;
  testableService.client.user = { id: "bot-123", setStatus: () => undefined };
  testableService.acceptingMessages = true;

  const received: DiscordMessage[] = [];
  testableService.onMessage = async (message) => {
    received.push(message);
  };

  try {
    service.setOperatingMode("paused");
    await testableService.handleMessage(createMessage());

    assert.equal(operatingState.mode, "paused");
    assert.equal(received.length, 0);
  } finally {
    await service.stop();
  }
});

test("changes the Discord presence when the operating mode changes", async () => {
  const operatingState = new DiscordOperatingState();
  const statuses: string[] = [];
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    operatingState,
  );
  const testableService = service as unknown as TestableDiscordJsService;
  testableService.client.user = {
    id: "bot-123",
    setStatus: (status) => statuses.push(status),
  };

  try {
    service.setOperatingMode("paused");
    service.setOperatingMode("active");

    assert.deepEqual(statuses, ["idle", "online"]);
    assert.equal(operatingState.mode, "active");
  } finally {
    await service.stop();
  }
});

test("handles idle and online slash commands for members with Manage Server", async () => {
  const operatingState = new DiscordOperatingState();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    operatingState,
  );
  const testableService = service as unknown as TestableDiscordJsService;
  testableService.client.user = {
    id: "bot-123",
    setStatus: () => undefined,
  };
  const replies: Array<{ content: string; ephemeral: boolean }> = [];
  const interaction = {
    commandName: "idle",
    inGuild: () => true,
    isChatInputCommand: () => true,
    memberPermissions: {
      has: () => true,
    },
    reply: async (response: { content: string; ephemeral: boolean }) => {
      replies.push(response);
    },
  } as unknown as Interaction;

  try {
    await testableService.handleInteraction(interaction);

    assert.equal(operatingState.mode, "paused");
    assert.deepEqual(replies, [{ content: "Botを一時停止しました。", ephemeral: true }]);
  } finally {
    await service.stop();
  }
});

test("forwards voice transcripts to the channel's LLM message handler", async () => {
  const originalStart = DiscordVoiceChatSession.prototype.start;
  let onTranscript: ((text: string) => Promise<void>) | undefined;
  DiscordVoiceChatSession.prototype.start = async function () {
    onTranscript = (
      this as unknown as {
        options: { onTranscript: (text: string) => Promise<void> };
      }
    ).options.onTranscript;
  };

  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({
      default: "deny",
      directMessages: "deny",
      guilds: {
        "guild-123": {
          access: "deny",
          channels: {
            "channel-123": {
              threads: { "thread-123": { access: "allow" } },
            },
          },
        },
      },
    }),
    undefined,
    new DiscordOperatingState(),
    { asr: {} as StreamingAsr, language: "ja" },
  );
  const testableService = service as unknown as TestableDiscordJsService;
  const received: DiscordMessage[] = [];
  testableService.onMessage = async (message) => {
    received.push(message);
  };
  const { interaction } = createVoiceJoinInteraction({
    channelId: "thread-123",
    isThread: true,
    parentId: "channel-123",
  });

  try {
    await testableService.handleInteraction(interaction);
    assert.ok(onTranscript);
    await onTranscript("こんにちは");

    assert.equal(received.length, 1);
    assert.deepEqual(
      {
        author: received[0]?.author,
        channelId: received[0]?.channelId,
        content: received[0]?.content,
        guildId: received[0]?.guildId,
        parentChannelId: received[0]?.parentChannelId,
        threadId: received[0]?.threadId,
      },
      {
        author: {
          bot: false,
          displayName: "さつき",
          id: "user-123",
          username: "satsuki",
        },
        channelId: "thread-123",
        content: "こんにちは",
        guildId: "guild-123",
        parentChannelId: "channel-123",
        threadId: "thread-123",
      },
    );
  } finally {
    DiscordVoiceChatSession.prototype.start = originalStart;
    await service.stop();
  }
});

test("blocks voice conversations in channels denied by the access policy", async () => {
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "deny", directMessages: "deny" }),
    undefined,
    new DiscordOperatingState(),
    { asr: {} as StreamingAsr, language: "ja" },
  );
  const { interaction, replies } = createVoiceJoinInteraction();

  try {
    await (service as unknown as TestableDiscordJsService).handleInteraction(interaction);
    assert.deepEqual(replies, ["このチャンネルではVC会話を利用できません。"]);
  } finally {
    await service.stop();
  }
});
