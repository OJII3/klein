import assert from "node:assert/strict";
import test from "node:test";

import { createDiscordMessageAgentTurn } from "./discord-message-agent-turn";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";

const message: DiscordMessage = {
  author: {
    bot: false,
    id: "user-123",
    username: "user",
    displayName: "ユーザー",
  },
  channelId: "channel-123",
  content: "本文",
  id: "message-123",
  occurredAt: "2026-10-14T09:30:42.123Z",
  images: [{ id: "image-1", filename: "sample.png", mimeType: "image/png", data: "c2VjcmV0" }],
};

test("converts Discord messages to AgentTurn and applies bot guidance by option", () => {
  const context = { sharedMemory: "guild context" };
  const userTurn = createDiscordMessageAgentTurn(message, context, {
    botMessageGuidance: "Bot guidance",
  });
  const botTurn = createDiscordMessageAgentTurn(
    { ...message, author: { ...message.author, bot: true } },
    {},
    { botMessageGuidance: "Bot guidance" },
  );

  assert.equal(userTurn.event.id, message.id);
  assert.deepEqual(userTurn.context.blocks, [{ name: "shared-memory", content: "guild context" }]);
  assert.equal(userTurn.context.requesterId, "user-123");
  assert.equal(botTurn.context.requesterId, undefined);
  assert.equal(userTurn.event.content[0]?.type, "text");
  assert.equal(
    userTurn.event.content[0]?.type === "text" ? userTurn.event.content[0].text : "",
    "ユーザー (@user):\n本文\n[添付画像: sample.png]",
  );
  assert.deepEqual(userTurn.event.content[1], {
    type: "image",
    data: "c2VjcmV0",
    mimeType: "image/png",
  });
  assert.equal(
    botTurn.event.content[0]?.type === "text"
      ? botTurn.event.content[0].text.endsWith("Bot guidance")
      : false,
    true,
  );
});

test("orders proactive blocks after the existing context blocks", () => {
  const turn = createDiscordMessageAgentTurn(message, {
    sharedMemory: "guild context",
    channelRule: "rule",
    proactivePreferences: "preferences",
    waitingOn: "follow-up",
    pendingSignals: "signal",
  });

  assert.deepEqual(turn.context.blocks, [
    { name: "shared-memory", content: "guild context" },
    { name: "channel-rule", content: "rule" },
    { name: "proactive-preferences", content: "preferences" },
    { name: "waiting-on", content: "follow-up" },
    { name: "pending-signals", content: "signal" },
  ]);
});

test("omits empty context blocks", () => {
  const turn = createDiscordMessageAgentTurn(message, {
    sharedMemory: "",
    channelRule: "",
    proactivePreferences: "",
    waitingOn: "",
    pendingSignals: "",
  });

  assert.equal(turn.context.blocks, undefined);
});

test("validates owner messages during conversion when configured", () => {
  assert.throws(
    () =>
      createDiscordMessageAgentTurn(
        { ...message, author: { ...message.author, id: "other-user" } },
        {},
        { ownerValidation: { userId: "user-123", channelId: "channel-123" } },
      ),
    /Only the owner/,
  );
});
