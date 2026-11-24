import assert from "node:assert/strict";
import test from "node:test";

import { isRecord } from "@shared/type-guards";

import type { DiscordAccess } from "../domain/discord-access-policy";
import type { PendingDiscordAccessRequest } from "../ports/discord-access-request-store";
import type { DiscordAccessRuleTarget } from "../ports/discord-access-rule-store";
import {
  DiscordChannelAccessRequester,
  type DiscordChannelAccessButtonInteraction,
  type DiscordChannelAccessClient,
} from "./discord-channel-access-request";

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

function createHarness() {
  const sent: Array<{ components: ReadonlyArray<{ toJSON: () => unknown }> }> = [];
  const edits: Array<{ components: ReadonlyArray<{ toJSON: () => unknown }> }> = [];
  const channel = {
    send: async (payload: { components: ReadonlyArray<{ toJSON: () => unknown }> }) => {
      sent.push(payload);
      return { id: `pending-message-${sent.length}` };
    },
    messages: {
      fetch: async (messageId: string) => ({
        id: messageId,
        edit: async (payload: { components: ReadonlyArray<{ toJSON: () => unknown }> }) => {
          edits.push(payload);
        },
      }),
    },
  };
  const ownerMessages: Array<{ components: ReadonlyArray<{ toJSON: () => unknown }> }> = [];
  const owner = {
    send: async (payload: { components: ReadonlyArray<{ toJSON: () => unknown }> }) => {
      ownerMessages.push(payload);
      return { id: "owner-message" };
    },
  };
  const client: DiscordChannelAccessClient = {
    channels: { fetch: async () => channel },
    users: { fetch: async () => owner },
    guilds: { cache: new Map([["guild-123", { name: "テストサーバー" }]]) },
  };
  const updates: Array<{ target: DiscordAccessRuleTarget; access: DiscordAccess }> = [];
  const store = {
    async load() {},
    getGuildRule: () => undefined,
    async setAccess(target: DiscordAccessRuleTarget, access: DiscordAccess) {
      updates.push({ target, access });
    },
  };
  const persistedRequests = new Map<string, PendingDiscordAccessRequest>();
  const requestStore = {
    async load() {},
    list: () => [...persistedRequests.values()],
    async save(request: PendingDiscordAccessRequest) {
      persistedRequests.set(request.requestId, request);
    },
    async remove(requestId: string) {
      persistedRequests.delete(requestId);
    },
  };

  return {
    channel,
    client,
    edits,
    ownerMessages,
    persistedRequests,
    requestStore,
    sent,
    store,
    updates,
  };
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
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
  );

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
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
  );

  await requester.request(request);
  await requester.request(request);

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.ownerMessages.length, 1);
  assert.equal(harness.persistedRequests.size, 1);
});

test("keeps a pending request usable after a restart", async () => {
  const harness = createHarness();
  const beforeRestart = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
  );
  await beforeRestart.request(request);
  assert.equal(harness.persistedRequests.size, 1);

  const afterRestart = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
  );
  await afterRestart.request(request);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.ownerMessages.length, 1);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const customId = toJson(ownerMessage)[0]?.components[1]?.components?.[0]?.custom_id;
  assert.ok(customId);
  const interaction: DiscordChannelAccessButtonInteraction = {
    customId,
    user: { id: "owner-123" },
    reply: async () => undefined,
    update: async () => undefined,
  };

  assert.equal(await afterRestart.handleButton(interaction), true);
  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "allow",
    },
  ]);
  assert.equal(harness.persistedRequests.size, 0);
});

test("allows the channel and updates both messages when the owner accepts", async () => {
  const harness = createHarness();
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
  );
  await requester.request(request);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const customId = toJson(ownerMessage)[0]?.components[1]?.components?.[0]?.custom_id;
  assert.ok(customId);

  const updated: Array<{ components: ReadonlyArray<{ toJSON: () => unknown }> }> = [];
  const interaction: DiscordChannelAccessButtonInteraction = {
    customId,
    user: { id: "owner-123" },
    reply: async () => undefined,
    update: async (payload) => {
      updated.push(payload);
    },
  };

  assert.equal(await requester.handleButton(interaction), true);
  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "allow",
    },
  ]);
  const [firstUpdate] = updated;
  assert.ok(firstUpdate);
  const [firstEdit] = harness.edits;
  assert.ok(firstEdit);
  assert.match(toJson(firstUpdate)[0]?.components[0]?.content ?? "", /許可しました/u);
  assert.match(toJson(firstUpdate)[0]?.components[0]?.content ?? "", /テストサーバー/u);
  assert.match(toJson(firstUpdate)[0]?.components[0]?.content ?? "", /#thread-name/u);
  assert.match(toJson(firstEdit)[0]?.components[0]?.content ?? "", /許可されました/u);
  assert.equal(harness.persistedRequests.size, 0);
});

test("rejects the channel when the owner denies", async () => {
  const harness = createHarness();
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
  );
  await requester.request(request);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const customId = toJson(ownerMessage)[0]?.components[1]?.components?.[1]?.custom_id;
  assert.ok(customId);

  const interaction: DiscordChannelAccessButtonInteraction = {
    customId,
    user: { id: "owner-123" },
    reply: async () => undefined,
    update: async () => undefined,
  };

  await requester.handleButton(interaction);

  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "deny",
    },
  ]);
  const [firstEdit] = harness.edits;
  assert.ok(firstEdit);
  assert.match(toJson(firstEdit)[0]?.components[0]?.content ?? "", /拒否されました/u);
});

test("ignores button presses from anyone other than the owner", async () => {
  const harness = createHarness();
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
  );
  await requester.request(request);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const customId = toJson(ownerMessage)[0]?.components[1]?.components?.[0]?.custom_id;
  assert.ok(customId);

  const replies: string[] = [];
  const interaction: DiscordChannelAccessButtonInteraction = {
    customId,
    user: { id: "other-user" },
    reply: async (payload) => {
      replies.push(JSON.stringify(payload));
    },
    update: async () => undefined,
  };

  assert.equal(await requester.handleButton(interaction), true);
  assert.equal(harness.updates.length, 0);
  assert.match(replies[0] ?? "", /オーナー/u);
});
