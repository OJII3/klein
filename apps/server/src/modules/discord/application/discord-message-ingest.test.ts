import assert from "node:assert/strict";
import test from "node:test";

import { createDiscordAccessPolicy, type DiscordAccess } from "../domain/discord-access-policy";
import type { DiscordChannelAccessRequest } from "../domain/discord-access-request";
import type { DiscordMessage } from "../domain/discord-message";
import type {
  DiscordGatewayMessage,
  DiscordGatewayMessageReader,
} from "../ports/discord-gateway-message";
import { DiscordMessageIngest } from "./discord-message-ingest";

function createMessage(
  overrides: {
    authorId?: string;
    authorBot?: boolean;
    content?: string;
    thread?: boolean;
    mentionsBot?: boolean;
    hasImage?: boolean;
  } = {},
): DiscordGatewayMessage {
  const thread = overrides.thread === true;
  const channel = Object.assign(
    {
      id: "channel-123",
      name: "general",
      parentId: thread ? "parent-channel" : null,
      isThread: () => thread,
    },
    { send: async () => undefined },
  );

  return {
    id: "message-123",
    channelId: "channel-123",
    guildId: "guild-123",
    content: overrides.content ?? "こんにちは",
    createdAt: new Date("2026-11-18T09:30:42.123Z"),
    author: {
      bot: overrides.authorBot ?? false,
      id: overrides.authorId ?? "user-123",
      username: "satsuki",
      displayName: "さつき",
    },
    channel,
    attachments: {
      values: () =>
        overrides.hasImage
          ? [
              {
                id: "attachment-123",
                name: "sample.png",
                size: 68,
                url: "https://cdn.discordapp.com/attachments/sample.png",
                contentType: "image/png",
              },
            ]
          : [],
    },
    mentions: {
      users: {
        get: () => undefined,
        has: (id) => overrides.mentionsBot === true && id === "bot-123",
      },
      roles: { get: () => undefined },
    },
    fetchReference: async () => {
      throw new Error("fetchReference is not used in these tests");
    },
  };
}

function createReader(hasImage = false): DiscordGatewayMessageReader {
  return {
    hasSupportedImageAttachment: (message) =>
      [...message.attachments.values()].some((attachment) =>
        attachment.contentType?.startsWith("image/"),
      ),
    toDiscordMessage: (message): DiscordMessage => ({
      id: message.id,
      occurredAt: message.createdAt.toISOString(),
      channelId: message.channelId,
      ...(message.channel.name ? { channelName: message.channel.name } : {}),
      guildId: message.guildId ?? undefined,
      ...(message.channel.parentId ? { parentChannelId: message.channel.parentId } : {}),
      ...(message.channel.isThread() ? { threadId: message.channel.id } : {}),
      author: message.author,
      content: message.content.trim(),
      images: [],
    }),
    fetchImages: async () =>
      hasImage
        ? [
            {
              id: "attachment-123",
              filename: "sample.png",
              mimeType: "image/png",
              data: "base64",
            },
          ]
        : [],
    fetchReplyReference: async () => undefined,
  };
}

function createIngest(
  options: {
    access?: DiscordAccess;
    ownerUserId?: string;
    hasImage?: boolean;
    canAccept?: () => boolean;
    onMessage?: (message: DiscordMessage) => Promise<void>;
    requestAccess?: (request: DiscordChannelAccessRequest) => Promise<void>;
    selfUserId?: string;
  } = {},
) {
  const delivered: DiscordMessage[] = [];
  const requests: DiscordChannelAccessRequest[] = [];
  const ingest = new DiscordMessageIngest({
    accessPolicy: createDiscordAccessPolicy(
      {
        default: options.access ?? "allow",
        directMessages: "allow",
      },
      options.ownerUserId,
    ),
    reader: createReader(options.hasImage),
    selfUserId: () => options.selfUserId ?? "bot-123",
    canAccept: options.canAccept ?? (() => true),
    onMessage:
      options.onMessage ??
      (async (message) => {
        delivered.push(message);
      }),
    requestAccess:
      options.requestAccess ??
      (async (request) => {
        requests.push(request);
      }),
  });

  return { delivered, ingest, requests };
}

test("delivers a message that passes the channel access check", async () => {
  const harness = createIngest();

  const delivered = await harness.ingest.handle(createMessage());

  assert.equal(delivered, true);
  assert.equal(harness.delivered.length, 1);
  assert.equal(harness.delivered[0]?.content, "こんにちは");
  assert.equal(harness.delivered[0]?.author.id, "user-123");
});

test("ignores the bot's own messages and empty messages without images", async () => {
  const harness = createIngest();

  assert.equal(await harness.ingest.handle(createMessage({ authorId: "bot-123" })), false);
  assert.equal(await harness.ingest.handle(createMessage({ content: "  " })), false);
  assert.equal(harness.delivered.length, 0);
});

test("delivers image-only messages when the attachment is supported", async () => {
  const harness = createIngest({ hasImage: true });

  const delivered = await harness.ingest.handle(createMessage({ content: "", hasImage: true }));

  assert.equal(delivered, true);
  assert.equal(harness.delivered[0]?.images.length, 1);
});

test("asks the owner when the bot is mentioned in a denied thread", async () => {
  const harness = createIngest({ access: "deny" });

  const delivered = await harness.ingest.handle(createMessage({ mentionsBot: true, thread: true }));

  assert.equal(delivered, false);
  assert.deepEqual(harness.requests, [
    {
      guildId: "guild-123",
      channelId: "parent-channel",
      threadId: "channel-123",
      pendingChannelId: "channel-123",
      channelName: "general",
      requesterUserId: "user-123",
    },
  ]);
});

test("does not ask the owner when the bot is mentioned in an owner-only channel", async () => {
  const harness = createIngest({ access: "owner", ownerUserId: "owner-123" });

  const delivered = await harness.ingest.handle(createMessage({ mentionsBot: true }));

  assert.equal(delivered, false);
  assert.equal(harness.requests.length, 0);
});

test("delivers the owner's messages in an owner-only channel", async () => {
  const harness = createIngest({ access: "owner", ownerUserId: "owner-123" });

  const delivered = await harness.ingest.handle(createMessage({ authorId: "owner-123" }));

  assert.equal(delivered, true);
});

test("does not ask the owner without a mention and stops when acceptance is closed", async () => {
  const harness = createIngest({ access: "deny" });
  assert.equal(await harness.ingest.handle(createMessage()), false);
  assert.equal(harness.requests.length, 0);

  let accepting = true;
  const closed = createIngest({ canAccept: () => accepting });
  accepting = false;
  assert.equal(await closed.ingest.handle(createMessage()), false);
  assert.equal(closed.delivered.length, 0);
});
