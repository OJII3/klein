import assert from "node:assert/strict";
import test from "node:test";
import type { ButtonInteraction, Client } from "discord.js";

import type { DiscordAccess } from "../domain/discord-access-policy";
import type { DiscordAccessRuleTarget } from "../ports/discord-access-rule-store";
import { DiscordChannelAccessRequester } from "./discord-channel-access-request";

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

function createHarness() {
  const sent: Array<{ components: Array<{ toJSON: () => unknown }> }> = [];
  const edits: Array<{ components: Array<{ toJSON: () => unknown }> }> = [];
  const channel = {
    send: async (payload: { components: Array<{ toJSON: () => unknown }> }) => {
      sent.push(payload);
      return { id: `pending-message-${sent.length}` };
    },
    messages: {
      fetch: async (messageId: string) => ({
        id: messageId,
        edit: async (payload: { components: Array<{ toJSON: () => unknown }> }) => {
          edits.push(payload);
        },
      }),
    },
  };
  const ownerMessages: Array<{ components: Array<{ toJSON: () => unknown }> }> = [];
  const owner = {
    send: async (payload: { components: Array<{ toJSON: () => unknown }> }) => {
      ownerMessages.push(payload);
      return { id: "owner-message" };
    },
  };
  const client = {
    channels: { fetch: async (id: string) => (id === "pending-channel" ? channel : null) },
    users: { fetch: async () => owner },
    guilds: { cache: new Map([["guild-123", { name: "テストサーバー" }]]) },
  } as unknown as Client;
  const updates: Array<{ target: DiscordAccessRuleTarget; access: DiscordAccess }> = [];
  const store = {
    async load() {},
    getGuildRule: () => undefined,
    async setAccess(target: DiscordAccessRuleTarget, access: DiscordAccess) {
      updates.push({ target, access });
    },
  };

  return { channel, client, edits, ownerMessages, sent, store, updates };
}

const request = {
  guildId: "guild-123",
  channelId: "parent-channel",
  threadId: "thread-123",
  pendingChannelId: "pending-channel",
  channelName: "thread-name",
  requesterUserId: "user-123",
} as const;

test("posts a pending notice and asks the owner with allow and deny buttons", async () => {
  const harness = createHarness();
  const requester = new DiscordChannelAccessRequester(harness.client, harness.store, "owner-123");

  await requester.request(request);

  const [pending] = harness.sent;
  assert.ok(pending);
  assert.match(toJson(pending)[0]?.components[0]?.content ?? "", /承認待ち/u);
  assert.match(toJson(pending)[0]?.components[0]?.content ?? "", /<@user-123>/u);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const [container] = toJson(ownerMessage);
  assert.match(container?.components[0]?.content ?? "", /テストサーバー/u);
  assert.match(container?.components[0]?.content ?? "", /#thread-name/u);
  assert.deepEqual(
    container?.components[1]?.components?.map((button) => button.label),
    ["許可", "拒否"],
  );
});

test("does not ask twice for the same channel while a request is pending", async () => {
  const harness = createHarness();
  const requester = new DiscordChannelAccessRequester(harness.client, harness.store, "owner-123");

  await requester.request(request);
  await requester.request(request);

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.ownerMessages.length, 1);
});

test("allows the channel and updates both messages when the owner accepts", async () => {
  const harness = createHarness();
  const requester = new DiscordChannelAccessRequester(harness.client, harness.store, "owner-123");
  await requester.request(request);

  const customId = toJson(harness.ownerMessages[0]!)[0]?.components[1]?.components?.[0]?.custom_id;
  assert.ok(customId);

  const updated: Array<{ components: Array<{ toJSON: () => unknown }> }> = [];
  const interaction = {
    customId,
    user: { id: "owner-123" },
    reply: async () => undefined,
    update: async (payload: { components: Array<{ toJSON: () => unknown }> }) => {
      updated.push(payload);
    },
  } as unknown as ButtonInteraction;

  assert.equal(await requester.handleButton(interaction), true);
  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "allow",
    },
  ]);
  assert.match(toJson(updated[0]!)[0]?.components[0]?.content ?? "", /許可しました/u);
  assert.match(toJson(harness.edits[0]!)[0]?.components[0]?.content ?? "", /許可されました/u);
});

test("rejects the channel when the owner denies", async () => {
  const harness = createHarness();
  const requester = new DiscordChannelAccessRequester(harness.client, harness.store, "owner-123");
  await requester.request(request);

  const customId = toJson(harness.ownerMessages[0]!)[0]?.components[1]?.components?.[1]?.custom_id;
  assert.ok(customId);

  const interaction = {
    customId,
    user: { id: "owner-123" },
    reply: async () => undefined,
    update: async () => undefined,
  } as unknown as ButtonInteraction;

  await requester.handleButton(interaction);

  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "deny",
    },
  ]);
  assert.match(toJson(harness.edits[0]!)[0]?.components[0]?.content ?? "", /拒否されました/u);
});

test("ignores button presses from anyone other than the owner", async () => {
  const harness = createHarness();
  const requester = new DiscordChannelAccessRequester(harness.client, harness.store, "owner-123");
  await requester.request(request);

  const customId = toJson(harness.ownerMessages[0]!)[0]?.components[1]?.components?.[0]?.custom_id;
  assert.ok(customId);

  const replies: Array<{ content: string; flags?: number }> = [];
  const interaction = {
    customId,
    user: { id: "other-user" },
    reply: async (payload: { content: string; flags?: number }) => {
      replies.push(payload);
    },
    update: async () => undefined,
  } as unknown as ButtonInteraction;

  assert.equal(await requester.handleButton(interaction), true);
  assert.equal(harness.updates.length, 0);
  assert.match(replies[0]?.content ?? "", /オーナー/u);
});
