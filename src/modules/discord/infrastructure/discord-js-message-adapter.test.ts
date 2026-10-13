import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "discord.js";

import { DiscordJsMessageAdapter } from "./discord-js-message-adapter";

function createReferencedMessage(channelId: string): Message {
  return {
    author: {
      bot: false,
      id: "user-123",
      username: "satsuki",
      displayName: "さつき",
    },
    channelId,
    content: "参照先の内容",
    id: "reference-123",
    mentions: { users: new Map(), roles: new Map() },
  } as unknown as Message;
}

test("keeps same-channel reply content", async () => {
  const adapter = new DiscordJsMessageAdapter();
  const message = {
    channelId: "public",
    reference: { messageId: "reference-123", channelId: "public" },
    fetchReference: async () => createReferencedMessage("public"),
  } as unknown as Message;

  const reference = await adapter.fetchReplyReference(message);
  assert.equal(reference?.id, "reference-123");
  assert.equal(reference?.content, "参照先の内容");
  assert.equal(reference?.author?.id, "user-123");
});

test("does not fetch cross-channel reference content", async () => {
  const adapter = new DiscordJsMessageAdapter();
  let fetched = false;
  const message = {
    channelId: "public",
    reference: { messageId: "reference-123", channelId: "private" },
    fetchReference: async () => {
      fetched = true;
      return createReferencedMessage("private");
    },
  } as unknown as Message;

  assert.deepEqual(await adapter.fetchReplyReference(message), { id: "reference-123" });
  assert.equal(fetched, false);
});

test("omits fetched reply content if it belongs to another channel", async () => {
  const adapter = new DiscordJsMessageAdapter();
  const message = {
    channelId: "public",
    reference: { messageId: "reference-123" },
    fetchReference: async () => createReferencedMessage("private"),
  } as unknown as Message;

  assert.deepEqual(await adapter.fetchReplyReference(message), { id: "reference-123" });
});
