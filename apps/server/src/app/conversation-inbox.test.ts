import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { AgentEvent } from "@agents/core/agent-event";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import { serializeConversationKey, type ConversationKey } from "@shared/conversation-key";
import { isRecord, parseJson } from "@shared/type-guards";
import { ConversationInbox, type NewInboxItem } from "./conversation-inbox";
import { createTempDir } from "../testing/temp-dir";

const channelA: ConversationKey = { kind: "discord", channelId: "channel-a" };
const channelB: ConversationKey = { kind: "discord", channelId: "channel-b" };
const channelC: ConversationKey = { kind: "discord", channelId: "channel-c" };

function createDiscordMessage(id: string, content = "hello"): DiscordMessage {
  return {
    occurredAt: "2026-11-25T00:00:00.000Z",
    channelId: "channel-a",
    guildId: "guild-1",
    author: { bot: false, id: "user-1", username: "alice", displayName: "Alice" },
    content,
    id,
    images: [],
  };
}

function createDiscordItem(
  id: string,
  enqueuedAt: string,
  conversationKey: ConversationKey = channelA,
  content = "hello",
): NewInboxItem {
  return {
    kind: "discord.message",
    id,
    conversationKey,
    enqueuedAt,
    message: createDiscordMessage(id, content),
  };
}

function getConversationDirectory(stateDir: string, conversationKey: ConversationKey): string {
  return join(stateDir, "inbox", encodeURIComponent(serializeConversationKey(conversationKey)));
}

function getItemPath(stateDir: string, conversationKey: ConversationKey, id: string): string {
  return join(
    getConversationDirectory(stateDir, conversationKey),
    `${encodeURIComponent(id)}.json`,
  );
}

async function readStoredItem(path: string): Promise<Record<string, unknown>> {
  const value: unknown = parseJson(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error("stored item is not an object");
  return value;
}

test("enqueue writes a pending item and ignores a duplicate id", async () => {
  await using temp = await createTempDir("klein-conversation-inbox-");
  const store = new ConversationInbox(temp.path);

  assert.equal(
    await store.enqueue(
      createDiscordItem("message-1", "2026-11-25T00:00:00.000Z", channelA, "first"),
    ),
    true,
  );
  const path = getItemPath(temp.path, channelA, "message-1");
  const original = await readFile(path, "utf8");
  const stored = await readStoredItem(path);
  assert.equal(stored.status, "pending");
  assert.equal(stored.attempts, 0);

  assert.equal(
    await store.enqueue(
      createDiscordItem("message-1", "2026-11-25T00:05:00.000Z", channelA, "second"),
    ),
    false,
  );
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await readdir(getConversationDirectory(temp.path, channelA)), [
    "message-1.json",
  ]);

  const claimed = await store.claimNext(channelA);
  assert.equal(claimed?.kind, "discord.message");
  if (claimed?.kind !== "discord.message") throw new Error("expected a Discord message");
  assert.equal(claimed.message.content, "first");
});

test("claimNext takes the oldest pending item and breaks equal times by id", async () => {
  await using temp = await createTempDir("klein-conversation-inbox-");
  const store = new ConversationInbox(temp.path);

  await store.enqueue(createDiscordItem("later", "2026-11-25T00:00:02.000Z"));
  await store.enqueue(createDiscordItem("b", "2026-11-25T00:00:01.000Z"));
  await store.enqueue(createDiscordItem("a", "2026-11-25T00:00:01.000Z"));

  assert.equal((await store.claimNext(channelA))?.id, "a");
  assert.equal((await store.claimNext(channelA))?.id, "b");
  assert.equal((await store.claimNext(channelA))?.id, "later");
  assert.equal(await store.claimNext(channelA), undefined);
});

test("claimNext increments attempts and finish persists the terminal status", async () => {
  await using temp = await createTempDir("klein-conversation-inbox-");
  const store = new ConversationInbox(temp.path);

  await store.enqueue(createDiscordItem("message-1", "2026-11-25T00:00:00.000Z"));
  const claimed = await store.claimNext(channelA);
  assert.ok(claimed);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.attempts, 1);
  assert.equal(typeof claimed.claimedAt, "string");

  await store.finish(claimed, "failed", "send failed");

  const stored = await readStoredItem(getItemPath(temp.path, channelA, "message-1"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.attempts, 1);
  assert.equal(stored.error, "send failed");
  assert.equal(typeof stored.finishedAt, "string");
  assert.equal(await store.recoverClaims(), 0);
  assert.deepEqual(await store.listPendingConversations(), []);
});

test("recoverClaims returns claimed items to pending and keeps attempts", async () => {
  await using temp = await createTempDir("klein-conversation-inbox-");
  const store = new ConversationInbox(temp.path);

  await store.enqueue(createDiscordItem("first", "2026-11-25T00:00:00.000Z"));
  await store.enqueue(createDiscordItem("second", "2026-11-25T00:00:01.000Z"));
  assert.ok(await store.claimNext(channelA));
  assert.ok(await store.claimNext(channelA));

  assert.equal(await store.recoverClaims(), 2);

  for (const id of ["first", "second"]) {
    const stored = await readStoredItem(getItemPath(temp.path, channelA, id));
    assert.equal(stored.status, "pending");
    assert.equal(stored.attempts, 1);
    assert.equal(stored.claimedAt, undefined);
  }

  const reclaimed = await store.claimNext(channelA);
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, "first");
  assert.equal(reclaimed.attempts, 2);
  assert.equal(await store.recoverClaims(), 1);
});

test("round-trips Discord messages and agent events", async () => {
  await using temp = await createTempDir("klein-conversation-inbox-");
  const store = new ConversationInbox(temp.path);

  const message: DiscordMessage = {
    occurredAt: "2026-11-25T01:02:03.456Z",
    channelId: "channel-a",
    channelName: "general",
    guildId: "guild-1",
    parentChannelId: "parent-1",
    threadId: "thread-1",
    author: { bot: false, id: "user-1", username: "alice", displayName: "Alice" },
    content: "look at this",
    id: "message-rich",
    images: [
      {
        id: "image-1",
        filename: "cat.png",
        mimeType: "image/png",
        data: "aGVsbG8=",
      },
    ],
    replyTo: {
      id: "message-parent",
      author: { bot: false, id: "user-2", username: "bob", displayName: "Bob" },
      content: "original",
    },
  };
  const discordInput: NewInboxItem = {
    kind: "discord.message",
    id: "message-rich",
    conversationKey: channelA,
    accessScope: "owner:user-1",
    enqueuedAt: "2026-11-25T01:02:03.456Z",
    message,
  };
  const event: AgentEvent = {
    id: "event-1",
    occurredAt: "2026-11-25T01:03:00.000Z",
    type: "notification",
    source: "scheduler",
    content: [
      { type: "text", text: "reminder" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  };
  const eventInput: NewInboxItem = {
    kind: "agent.event",
    id: "event-1",
    conversationKey: channelA,
    enqueuedAt: "2026-11-25T01:03:00.000Z",
    event,
  };

  await store.enqueue(discordInput);
  await store.enqueue(eventInput);

  const claimedMessage = await store.claimNext(channelA);
  assert.ok(claimedMessage);
  const { claimedAt: messageClaimedAt, ...messageRest } = claimedMessage;
  assert.equal(typeof messageClaimedAt, "string");
  assert.deepEqual(messageRest, { ...discordInput, status: "claimed", attempts: 1 });

  const claimedEvent = await store.claimNext(channelA);
  assert.ok(claimedEvent);
  const { claimedAt: eventClaimedAt, ...eventRest } = claimedEvent;
  assert.equal(typeof eventClaimedAt, "string");
  assert.deepEqual(eventRest, { ...eventInput, status: "claimed", attempts: 1 });
});

test("skips malformed items while loading valid siblings", async () => {
  await using temp = await createTempDir("klein-conversation-inbox-");
  const store = new ConversationInbox(temp.path);

  await store.enqueue(createDiscordItem("valid", "2026-11-25T00:00:00.000Z"));
  const directory = getConversationDirectory(temp.path, channelA);
  await writeFile(join(directory, "broken.json"), "{not json", "utf8");
  await writeFile(
    join(directory, "partial.json"),
    JSON.stringify({ kind: "discord.message", id: "partial" }),
    "utf8",
  );
  const otherDirectory = getConversationDirectory(temp.path, channelB);
  await mkdir(otherDirectory, { recursive: true });
  await writeFile(join(otherDirectory, "broken.json"), "{not json", "utf8");

  assert.deepEqual(await store.listPendingConversations(), [channelA]);
  assert.equal((await store.claimNext(channelA))?.id, "valid");
  assert.equal(await store.claimNext(channelA), undefined);
  assert.equal(await store.claimNext(channelB), undefined);
});

test("lists conversations that still have pending items", async () => {
  await using temp = await createTempDir("klein-conversation-inbox-");
  const store = new ConversationInbox(temp.path);

  await store.enqueue(createDiscordItem("a-1", "2026-11-25T00:00:00.000Z", channelA));
  await store.enqueue(createDiscordItem("b-1", "2026-11-25T00:00:01.000Z", channelB));
  await store.enqueue(createDiscordItem("c-1", "2026-11-25T00:00:02.000Z", channelC));

  const claimed = await store.claimNext(channelC);
  assert.ok(claimed);
  await store.finish(claimed, "done");

  assert.deepEqual(await store.listPendingConversations(), [channelA, channelB]);

  const first = await store.claimNext(channelA);
  assert.ok(first);
  await store.finish(first, "interrupted");
  assert.deepEqual(await store.listPendingConversations(), [channelB]);
});

test("treats a missing inbox directory as empty", async () => {
  await using temp = await createTempDir("klein-conversation-inbox-");
  const store = new ConversationInbox(join(temp.path, "missing"));

  assert.deepEqual(await store.listPendingConversations(), []);
  assert.equal(await store.claimNext(channelA), undefined);
  assert.equal(await store.recoverClaims(), 0);
});
