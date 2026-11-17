import assert from "node:assert/strict";
import test from "node:test";

import { createDiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordChoiceButton } from "../domain/discord-choice";
import { DiscordChoiceService, type DiscordChoiceQuestionView } from "./discord-choice-service";

function createService(accessAllowed = true) {
  const service = new DiscordChoiceService(
    createDiscordAccessPolicy({
      default: accessAllowed ? "allow" : "deny",
      directMessages: "allow",
    }),
  );
  const questions: DiscordChoiceQuestionView[] = [];
  const postQuestion = async (view: DiscordChoiceQuestionView) => {
    questions.push(view);
    return { messageId: "choice-message-1" };
  };

  return { postQuestion, questions, service };
}

function createButton(customId: string, userId = "user-123"): DiscordChoiceButton {
  return {
    id: "interaction-123",
    customId,
    guildId: "guild-123",
    channelId: "channel-123",
    channel: { id: "channel-123", name: "general", isThread: false },
    user: { id: userId, username: "user", displayName: "ユーザー", bot: false },
    botUser: { id: "bot-123", username: "klein", displayName: "Klein", bot: true },
  };
}

async function sendQuestion(harness: ReturnType<typeof createService>): Promise<string> {
  return harness.service.send(
    "channel-123",
    {
      question: "どちらにしますか？",
      options: ["A", "B"],
      requesterUserId: "user-123",
    },
    harness.postQuestion,
  );
}

test("posts the question and returns the first answer as a user message", async () => {
  const harness = createService();
  const messageId = await sendQuestion(harness);

  assert.equal(messageId, "choice-message-1");
  assert.deepEqual(harness.questions[0]?.options, ["A", "B"]);
  assert.equal(harness.questions[0]?.buttonIds.length, 2);

  const customId = harness.questions[0]?.buttonIds[1];
  assert.ok(customId);
  const result = harness.service.handleButton(createButton(customId));

  assert.equal(result.kind, "answered");
  if (result.kind !== "answered") return;
  assert.equal(result.view.label, "B");
  assert.equal(result.view.userId, "user-123");
  assert.equal(result.answer.content, "B");
  assert.equal(result.answer.channelId, "channel-123");
  assert.equal(result.answer.channelName, "general");
  assert.equal(result.answer.replyTo?.id, "choice-message-1");
  assert.equal(result.answer.replyTo?.content, "どちらにしますか？");
  assert.equal(result.answer.replyTo?.author?.id, "bot-123");
});

test("rejects an answer from someone other than the requester", async () => {
  const harness = createService();
  await sendQuestion(harness);
  const customId = harness.questions[0]?.buttonIds[0];
  assert.ok(customId);

  const result = harness.service.handleButton(createButton(customId, "other-user"));

  assert.deepEqual(result, { kind: "rejected", reason: "not-requester" });
});

test("rejects an answer when the channel access is denied", async () => {
  const harness = createService(false);
  await sendQuestion(harness);
  const customId = harness.questions[0]?.buttonIds[0];
  assert.ok(customId);

  const result = harness.service.handleButton(createButton(customId));

  assert.deepEqual(result, { kind: "rejected", reason: "channel-denied" });
});

test("accepts only the first answer and ignores other buttons", async () => {
  const harness = createService();
  await sendQuestion(harness);
  const customId = harness.questions[0]?.buttonIds[0];
  assert.ok(customId);

  assert.equal(harness.service.handleButton(createButton(customId)).kind, "answered");
  assert.deepEqual(harness.service.handleButton(createButton(customId)), {
    kind: "rejected",
    reason: "expired",
  });
  assert.deepEqual(harness.service.handleButton(createButton("channel-access:allow:1")), {
    kind: "ignored",
  });
});
