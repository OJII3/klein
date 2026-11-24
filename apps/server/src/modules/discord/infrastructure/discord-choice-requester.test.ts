import assert from "node:assert/strict";
import test from "node:test";

import { isRecord } from "@shared/type-guards";

import { createDiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordMessage } from "../domain/discord-message";
import { containerMessageText } from "../../../testing/discord-container";
import {
  DiscordChoiceRequester,
  type DiscordChoiceButtonInteraction,
  type DiscordChoiceClient,
} from "./discord-choice-requester";

interface ContainerJson {
  readonly accent_color?: number;
  readonly components: ReadonlyArray<{
    readonly content?: string;
    readonly components?: ReadonlyArray<{ readonly custom_id?: string; readonly label?: string }>;
  }>;
}

function parseContainerJson(value: unknown): ContainerJson {
  assert.ok(isRecord(value));
  assert.ok(Array.isArray(value.components));
  return {
    ...(typeof value.accent_color === "number" ? { accent_color: value.accent_color } : {}),
    components: value.components.map((entry: unknown) => {
      assert.ok(isRecord(entry));
      const nested = Array.isArray(entry.components)
        ? entry.components.map((button: unknown) => {
            assert.ok(isRecord(button));
            return {
              ...(typeof button.custom_id === "string" ? { custom_id: button.custom_id } : {}),
              ...(typeof button.label === "string" ? { label: button.label } : {}),
            };
          })
        : undefined;
      return {
        ...(typeof entry.content === "string" ? { content: entry.content } : {}),
        ...(nested ? { components: nested } : {}),
      };
    }),
  };
}

function toJson(payload: {
  components: ReadonlyArray<{ toJSON: () => unknown }>;
}): ContainerJson[] {
  return payload.components.map((component) => parseContainerJson(component.toJSON()));
}

function createHarness(accessAllowed = true) {
  const sent: Array<{ components: ReadonlyArray<{ toJSON: () => unknown }>; flags: number }> = [];
  const channel = {
    send: async (payload: {
      components: ReadonlyArray<{ toJSON: () => unknown }>;
      flags: number;
    }) => {
      sent.push(payload);
      return { id: "choice-message-1" };
    },
  };
  const client: DiscordChoiceClient = {
    channels: { fetch: async (id: string) => (id === "channel-123" ? channel : null) },
  };
  const accessPolicy = createDiscordAccessPolicy({
    default: accessAllowed ? "allow" : "deny",
    directMessages: "allow",
  });
  const answers: DiscordMessage[] = [];
  const requester = new DiscordChoiceRequester(client, accessPolicy, async (message) => {
    answers.push(message);
  });

  return { answers, client, requester, sent };
}

function createInteraction(customId: string, userId = "user-123") {
  const replies: string[] = [];
  const updates: Array<{ components: ReadonlyArray<{ toJSON: () => unknown }>; flags: number }> =
    [];
  const interaction: DiscordChoiceButtonInteraction = {
    id: "interaction-123",
    customId,
    user: { id: userId, username: "user", displayName: "ユーザー", bot: false },
    guildId: "guild-123",
    channelId: "channel-123",
    channel: { id: "channel-123", name: "general", isThread: () => false },
    client: {
      user: { id: "bot-123", username: "klein", displayName: "Klein" },
    },
    reply: async (payload) => {
      replies.push(containerMessageText(payload));
    },
    update: async (payload) => {
      updates.push(payload);
    },
  };

  return { interaction, replies, updates };
}

async function sendQuestion(harness: ReturnType<typeof createHarness>): Promise<string> {
  await harness.requester.send("channel-123", {
    question: "どちらにしますか？",
    options: ["A", "B"],
    requesterUserId: "user-123",
  });
  const [firstSent] = harness.sent;
  assert.ok(firstSent);
  const customId = toJson(firstSent)[0]?.components[1]?.components?.[1]?.custom_id;
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
  const [firstSent] = harness.sent;
  assert.ok(firstSent);
  const [container] = toJson(firstSent);
  assert.equal(container?.components[0]?.content, "どちらにしますか？");
  assert.deepEqual(
    container?.components[1]?.components?.map((button) => button.label),
    ["A", "B"],
  );
});

test("turns the pressed button into a user message", async () => {
  const harness = createHarness();
  const customId = await sendQuestion(harness);
  const { interaction, updates } = createInteraction(customId);

  assert.equal(await harness.requester.handleButton(interaction), true);

  assert.equal(harness.answers.length, 1);
  const [answer] = harness.answers;
  assert.ok(answer);
  assert.equal(answer.author.id, "user-123");
  assert.equal(answer.content, "B");
  assert.equal(answer.channelId, "channel-123");
  assert.equal(answer.guildId, "guild-123");
  assert.equal(answer.channelName, "general");
  assert.equal(answer.replyTo?.id, "choice-message-1");
  assert.equal(answer.replyTo?.content, "どちらにしますか？");
  assert.equal(answer.replyTo?.author?.id, "bot-123");
  const [firstUpdate] = updates;
  assert.ok(firstUpdate);
  assert.match(toJson(firstUpdate)[0]?.components[0]?.content ?? "", /→ B/u);
});

test("only lets the requesting user answer", async () => {
  const harness = createHarness();
  const customId = await sendQuestion(harness);
  const { interaction, replies } = createInteraction(customId, "other-user");

  assert.equal(await harness.requester.handleButton(interaction), true);
  assert.equal(harness.answers.length, 0);
  assert.match(replies[0] ?? "", /質問したユーザー/u);
});

test("does not deliver an answer when the channel access is denied", async () => {
  const harness = createHarness(false);
  const customId = await sendQuestion(harness);
  const { interaction, replies } = createInteraction(customId);

  assert.equal(await harness.requester.handleButton(interaction), true);
  assert.equal(harness.answers.length, 0);
  assert.match(replies[0] ?? "", /回答できません/u);
});

test("rejects a choice that is no longer pending", async () => {
  const harness = createHarness();
  const { interaction, replies } = createInteraction("choice:missing:0");

  assert.equal(await harness.requester.handleButton(interaction), true);
  assert.equal(harness.answers.length, 0);
  assert.match(replies[0] ?? "", /回答済み|期限切れ/u);
});

test("accepts only the first answer", async () => {
  const harness = createHarness();
  const customId = await sendQuestion(harness);
  const first = createInteraction(customId);
  const second = createInteraction(customId);

  await harness.requester.handleButton(first.interaction);
  await harness.requester.handleButton(second.interaction);

  assert.equal(harness.answers.length, 1);
  assert.match(second.replies[0] ?? "", /回答済み|期限切れ/u);
});

test("ignores buttons that belong to another feature", async () => {
  const harness = createHarness();
  const { interaction } = createInteraction("channel-access:allow:1");

  assert.equal(await harness.requester.handleButton(interaction), false);
});
