import assert from "node:assert/strict";
import test from "node:test";
import type { ButtonInteraction, Client } from "discord.js";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordMessage } from "../domain/discord-message";
import { DiscordChoiceRequester } from "./discord-choice-requester";

interface ContainerJson {
  readonly accent_color?: number;
  readonly components: ReadonlyArray<{
    readonly content?: string;
    readonly components?: ReadonlyArray<{ readonly custom_id?: string; readonly label?: string }>;
  }>;
}

function toJson(payload: { components: Array<{ toJSON: () => unknown }> }): ContainerJson[] {
  return payload.components.map((component) => component.toJSON() as ContainerJson);
}

function createHarness(accessAllowed = true) {
  const sent: Array<{ components: Array<{ toJSON: () => unknown }>; flags: number }> = [];
  const channel = {
    send: async (payload: { components: Array<{ toJSON: () => unknown }>; flags: number }) => {
      sent.push(payload);
      return { id: "choice-message-1" };
    },
  };
  const client = {
    channels: { fetch: async (id: string) => (id === "channel-123" ? channel : null) },
    user: { id: "bot-123", username: "klein", displayName: "Klein" },
  } as unknown as Client;
  const accessPolicy = {
    canReceive: () => accessAllowed,
  } as unknown as DiscordAccessPolicy;
  const answers: DiscordMessage[] = [];
  const requester = new DiscordChoiceRequester(client, accessPolicy, async (message) => {
    answers.push(message);
  });

  return { answers, client, requester, sent };
}

function createInteraction(
  harness: ReturnType<typeof createHarness>,
  customId: string,
  userId = "user-123",
) {
  const replies: Array<{ content: string; flags?: number }> = [];
  const updates: Array<{ components: Array<{ toJSON: () => unknown }>; flags: number }> = [];
  const interaction = {
    customId,
    user: { id: userId, username: "user", displayName: "ユーザー", bot: false },
    guildId: "guild-123",
    channelId: "channel-123",
    channel: { name: "general", isThread: () => false },
    client: harness.client,
    reply: async (payload: { content: string; flags?: number }) => {
      replies.push(payload);
    },
    update: async (payload: { components: Array<{ toJSON: () => unknown }>; flags: number }) => {
      updates.push(payload);
    },
  } as unknown as ButtonInteraction;

  return { interaction, replies, updates };
}

async function sendQuestion(harness: ReturnType<typeof createHarness>): Promise<string> {
  await harness.requester.send("channel-123", {
    question: "どちらにしますか？",
    options: ["A", "B"],
    requesterUserId: "user-123",
  });
  const customId = toJson(harness.sent[0]!)[0]?.components[1]?.components?.[1]?.custom_id;
  assert.ok(customId);
  return customId;
}

test("posts a question with buttons and returns the message id", async () => {
  const harness = createHarness();

  const messageId = await harness.requester.send("channel-123", {
    question: "どちらにしますか？",
    options: ["A", "B"],
    requesterUserId: "user-123",
  });

  assert.equal(messageId, "choice-message-1");
  const [container] = toJson(harness.sent[0]!);
  assert.equal(container?.components[0]?.content, "どちらにしますか？");
  assert.deepEqual(
    container?.components[1]?.components?.map((button) => button.label),
    ["A", "B"],
  );
});

test("turns the pressed button into a user message", async () => {
  const harness = createHarness();
  const customId = await sendQuestion(harness);
  const { interaction, updates } = createInteraction(harness, customId);

  assert.equal(await harness.requester.handleButton(interaction), true);

  assert.equal(harness.answers.length, 1);
  const answer = harness.answers[0]!;
  assert.equal(answer.author.id, "user-123");
  assert.equal(answer.content, "B");
  assert.equal(answer.channelId, "channel-123");
  assert.equal(answer.guildId, "guild-123");
  assert.equal(answer.channelName, "general");
  assert.equal(answer.replyTo?.id, "choice-message-1");
  assert.equal(answer.replyTo?.content, "どちらにしますか？");
  assert.equal(answer.replyTo?.author?.id, "bot-123");
  assert.match(toJson(updates[0]!)[0]?.components[0]?.content ?? "", /→ B/u);
});

test("only lets the requesting user answer", async () => {
  const harness = createHarness();
  const customId = await sendQuestion(harness);
  const { interaction, replies } = createInteraction(harness, customId, "other-user");

  assert.equal(await harness.requester.handleButton(interaction), true);
  assert.equal(harness.answers.length, 0);
  assert.match(replies[0]?.content ?? "", /質問したユーザー/u);
});

test("does not deliver an answer when the channel access is denied", async () => {
  const harness = createHarness(false);
  const customId = await sendQuestion(harness);
  const { interaction, replies } = createInteraction(harness, customId);

  assert.equal(await harness.requester.handleButton(interaction), true);
  assert.equal(harness.answers.length, 0);
  assert.match(replies[0]?.content ?? "", /回答できません/u);
});

test("rejects a choice that is no longer pending", async () => {
  const harness = createHarness();
  const { interaction, replies } = createInteraction(harness, "choice:missing:0");

  assert.equal(await harness.requester.handleButton(interaction), true);
  assert.equal(harness.answers.length, 0);
  assert.match(replies[0]?.content ?? "", /回答済み|期限切れ/u);
});

test("accepts only the first answer", async () => {
  const harness = createHarness();
  const customId = await sendQuestion(harness);
  const first = createInteraction(harness, customId);
  const second = createInteraction(harness, customId);

  await harness.requester.handleButton(first.interaction);
  await harness.requester.handleButton(second.interaction);

  assert.equal(harness.answers.length, 1);
  assert.match(second.replies[0]?.content ?? "", /回答済み|期限切れ/u);
});

test("ignores buttons that belong to another feature", async () => {
  const harness = createHarness();
  const { interaction } = createInteraction(harness, "channel-access:allow:1");

  assert.equal(await harness.requester.handleButton(interaction), false);
});
