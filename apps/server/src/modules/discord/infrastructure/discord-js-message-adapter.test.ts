import assert from "node:assert/strict";
import test from "node:test";

import { DiscordJsMessageAdapter, type DiscordAdapterMessage } from "./discord-js-message-adapter";

function createMessageStub(overrides: Partial<DiscordAdapterMessage> = {}): DiscordAdapterMessage {
  const channelId = overrides.channelId ?? "public";
  return {
    author: {
      bot: false,
      id: "user-123",
      username: "satsuki",
      displayName: "さつき",
    },
    attachments: new Map(),
    channel: { id: channelId, isThread: () => false },
    channelId,
    content: "参照先の内容",
    createdAt: new Date("2026-10-14T09:30:42.123Z"),
    guildId: "guild-123",
    id: "reference-123",
    mentions: { users: new Map(), roles: new Map() },
    fetchReference: async () => createMessageStub({ channelId }),
    ...overrides,
  };
}

test("keeps same-channel reply content", async () => {
  const adapter = new DiscordJsMessageAdapter();
  const message = createMessageStub({
    channelId: "public",
    reference: { messageId: "reference-123", channelId: "public" },
    fetchReference: async () => createMessageStub({ channelId: "public" }),
  });

  const reference = await adapter.fetchReplyReference(message);
  assert.equal(reference?.id, "reference-123");
  assert.equal(reference?.content, "参照先の内容");
  assert.equal(reference?.author?.id, "user-123");
});

test("does not fetch cross-channel reference content", async () => {
  const adapter = new DiscordJsMessageAdapter();
  let fetched = false;
  const message = createMessageStub({
    channelId: "public",
    reference: { messageId: "reference-123", channelId: "private" },
    fetchReference: async () => {
      fetched = true;
      return createMessageStub({ channelId: "private" });
    },
  });

  assert.deepEqual(await adapter.fetchReplyReference(message), { id: "reference-123" });
  assert.equal(fetched, false);
});

test("omits fetched reply content if it belongs to another channel", async () => {
  const adapter = new DiscordJsMessageAdapter();
  const message = createMessageStub({
    channelId: "public",
    reference: { messageId: "reference-123" },
    fetchReference: async () => createMessageStub({ channelId: "private" }),
  });

  assert.deepEqual(await adapter.fetchReplyReference(message), { id: "reference-123" });
});

test("preserves the original Discord message timestamp including milliseconds", () => {
  const adapter = new DiscordJsMessageAdapter();
  const message = createMessageStub({
    channel: { id: "public", isThread: () => false, name: "general" },
    createdAt: new Date("2026-10-14T18:30:42.123+09:00"),
  });

  const event = adapter.toDiscordMessage(message);
  assert.equal(event.channelName, "general");
  assert.equal(event.occurredAt, "2026-10-14T09:30:42.123Z");
});
