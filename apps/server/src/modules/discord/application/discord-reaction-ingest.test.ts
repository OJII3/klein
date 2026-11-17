import assert from "node:assert/strict";
import test from "node:test";

import { createDiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordReactionEvent } from "../domain/discord-reaction";
import { DiscordReactionIngest, type DiscordReactionSnapshot } from "./discord-reaction-ingest";

function createSnapshot(
  overrides: {
    authorId?: string;
    userId?: string;
    userIsBot?: boolean;
    thread?: boolean;
    content?: string;
  } = {},
): DiscordReactionSnapshot {
  return {
    message: {
      id: "message-123",
      channelId: "channel-123",
      guildId: "guild-123",
      content: overrides.content ?? "返信",
      authorId: overrides.authorId ?? "bot-123",
      channel: {
        id: "channel-123",
        name: "general",
        ...(overrides.thread ? { parentId: "parent-channel" } : {}),
        isThread: overrides.thread === true,
      },
    },
    emojiName: "👍",
    emojiIdentifier: "%F0%9F%91%8D",
    userId: overrides.userId ?? "user-123",
    userIsBot: overrides.userIsBot ?? false,
  };
}

function createIngest(options: { accessAllowed?: boolean; canAccept?: () => boolean } = {}) {
  const events: DiscordReactionEvent[] = [];
  const ingest = new DiscordReactionIngest({
    accessPolicy: createDiscordAccessPolicy({
      default: options.accessAllowed === false ? "deny" : "allow",
      directMessages: "allow",
    }),
    selfUserId: () => "bot-123",
    canAccept: options.canAccept ?? (() => true),
    onReaction: async (event) => {
      events.push(event);
    },
  });

  return { events, ingest };
}

test("turns a reaction on a bot message into an event", async () => {
  const harness = createIngest();

  const handled = await harness.ingest.handle(createSnapshot({ thread: true }));

  assert.equal(handled, true);
  assert.equal(harness.events.length, 1);
  const [event] = harness.events;
  assert.equal(event?.emoji, "👍");
  assert.equal(event?.messageId, "message-123");
  assert.equal(event?.channelId, "channel-123");
  assert.equal(event?.guildId, "guild-123");
  assert.equal(event?.parentChannelId, "parent-channel");
  assert.equal(event?.threadId, "channel-123");
  assert.equal(event?.channelName, "general");
  assert.equal(event?.messageAuthorId, "bot-123");
  assert.equal(event?.messageContent, "返信");
  assert.equal(event?.userId, "user-123");
});

test("ignores bot reactions, the bot's own reactions, and non-bot messages", async () => {
  const harness = createIngest();

  assert.equal(await harness.ingest.handle(createSnapshot({ userIsBot: true })), false);
  assert.equal(await harness.ingest.handle(createSnapshot({ userId: "bot-123" })), false);
  assert.equal(await harness.ingest.handle(createSnapshot({ authorId: "user-456" })), false);
  assert.equal(harness.events.length, 0);
});

test("ignores reactions in channels without access and while paused", async () => {
  const denied = createIngest({ accessAllowed: false });
  assert.equal(await denied.ingest.handle(createSnapshot()), false);
  assert.equal(denied.events.length, 0);

  let accepting = true;
  const paused = createIngest({ canAccept: () => accepting });
  accepting = false;
  assert.equal(await paused.ingest.handle(createSnapshot()), false);
  assert.equal(paused.events.length, 0);
});
