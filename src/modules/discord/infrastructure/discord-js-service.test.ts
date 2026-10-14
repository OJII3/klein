import assert from "node:assert/strict";
import test from "node:test";
import type { Interaction, Message } from "discord.js";

import { createDiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordMessage } from "../domain/discord-message";
import { DiscordOperatingState } from "../domain/discord-operating-state";
import type { DiscordMessageHandler } from "../ports/discord-service";
import { DiscordJsService } from "./discord-js-service";

type TestableDiscordJsService = {
  readonly client: {
    channels: { fetch: (id: string) => Promise<unknown> };
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
    createdAt: new Date("2026-10-14T09:30:42.123Z"),
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

test("handles status slash subcommands for members with Manage Server", async () => {
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
  const replies: Array<{ description: string | undefined; ephemeral: boolean | undefined }> = [];
  let subcommand = "idle";
  const interaction = {
    commandName: "status",
    inGuild: () => true,
    channelId: "channel-123",
    channel: { isThread: () => false },
    user: { id: "user-123", bot: false },
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    options: { getSubcommand: () => subcommand },
    memberPermissions: {
      has: () => true,
    },
    reply: async (response: {
      embeds: Array<{ toJSON: () => { description?: string } }>;
      ephemeral?: boolean;
    }) => {
      replies.push({
        description: response.embeds[0]?.toJSON().description,
        ephemeral: response.ephemeral,
      });
    },
  } as unknown as Interaction;

  try {
    await testableService.handleInteraction(interaction);

    assert.equal(operatingState.mode, "paused");

    subcommand = "online";
    await testableService.handleInteraction(interaction);

    assert.equal(operatingState.mode, "active");
    assert.deepEqual(replies, [
      { description: "Botを一時停止しました。", ephemeral: false },
      { description: "Botを再開しました。", ephemeral: false },
    ]);
  } finally {
    await service.stop();
  }
});

test("owner channels only forward real owner messages", async () => {
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "owner", directMessages: "owner" }, "user-123"),
  );
  const testableService = service as unknown as TestableDiscordJsService;
  testableService.acceptingMessages = true;
  const received: DiscordMessage[] = [];
  testableService.onMessage = async (message) => {
    received.push(message);
  };
  try {
    await testableService.handleMessage(createMessage({ author: { id: "other-user" } }));
    await testableService.handleMessage(createMessage({ author: { id: "user-123", bot: true } }));
    await testableService.handleMessage(createMessage());
    assert.equal(received.length, 1);
    assert.equal(received[0]?.author.id, "user-123");
    assert.equal(received[0]?.author.bot, false);
  } finally {
    await service.stop();
  }
});

test("message reads enforce inherited access and trusted requester identity", async () => {
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy(
      {
        default: "deny",
        directMessages: "deny",
        guilds: {
          "guild-123": {
            channels: {
              private: { access: "owner", threads: { public: { access: "allow" } } },
            },
          },
        },
      },
      "user-123",
    ),
  );
  const testableService = service as unknown as TestableDiscordJsService;
  let reads = 0;
  testableService.client.channels.fetch = async (id) => ({
    id,
    guildId: "guild-123",
    isTextBased: () => true,
    isThread: () => id === "public" || id === "private-thread",
    parentId: "private",
    messages: {
      fetch: async () => {
        reads += 1;
        return createMessage();
      },
    },
  });
  const locator = { channelId: "private-thread", messageId: "message-123" };
  try {
    for (const requester of [
      undefined,
      { userId: "other-user" },
      { userId: "user-123", userIsBot: true },
    ]) {
      await assert.rejects(service.readMessage(locator, requester), /access denied/);
    }
    await assert.rejects(
      service.readMessage({ ...locator, channelId: "denied" }, { userId: "user-123" }),
      /access denied/,
    );
    assert.equal(reads, 0);
    assert.equal((await service.readMessage(locator, { userId: "user-123" })).id, "message-123");
    await service.readMessage({ ...locator, channelId: "public" });
    assert.equal(reads, 2);
  } finally {
    await service.stop();
  }
});
