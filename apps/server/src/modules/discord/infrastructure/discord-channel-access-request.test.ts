import assert from "node:assert/strict";
import test from "node:test";

import { isRecord } from "@shared/type-guards";

import type { DiscordAccess } from "../domain/discord-access-policy";
import type { DiscordChannelLink, DiscordChannelLinkTarget } from "../domain/discord-channel-link";
import type { PendingDiscordAccessRequest } from "../ports/discord-access-request-store";
import type { DiscordChannelLinkStore } from "../ports/discord-channel-link-store";
import type { DiscordAccessRuleTarget } from "../ports/discord-access-rule-store";
import {
  DiscordChannelAccessRequester,
  type DiscordChannelAccessButtonInteraction,
  type DiscordChannelAccessClient,
  type DiscordChannelLinkCommandInteraction,
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

function linkKey(target: DiscordChannelLinkTarget): string {
  return `${target.guildId}:${target.channelId}:${target.threadId ?? ""}`;
}

function createLinkStore(initial: readonly DiscordChannelLink[] = []): {
  store: DiscordChannelLinkStore;
  links: Map<string, DiscordChannelLink>;
} {
  const links = new Map(initial.map((link) => [linkKey(link), link]));
  return {
    links,
    store: {
      async load() {},
      getLink: (target) => links.get(linkKey(target)),
      saveLink: async (link) => {
        links.set(linkKey(link), link);
      },
      removeLink: async (target) => {
        links.delete(linkKey(target));
      },
    },
  };
}

function createLinkInteraction(options: { readonly userId?: string } = {}): {
  interaction: DiscordChannelLinkCommandInteraction;
  replies: Array<{ components: ReadonlyArray<{ toJSON: () => unknown }> }>;
} {
  const replies: Array<{ components: ReadonlyArray<{ toJSON: () => unknown }> }> = [];
  return {
    replies,
    interaction: {
      guildId: "guild-123",
      channelId: "thread-123",
      user: { id: options.userId ?? "user-123", bot: false },
      channel: {
        id: "thread-123",
        name: "thread-name",
        parentId: "parent-channel",
        isThread: () => true,
      },
      client: { channels: { fetch: async () => null } },
      inGuild: () => true,
      reply: async (payload) => {
        replies.push(payload);
      },
    },
  };
}

test("requests a channel link with an ephemeral confirmation and an owner prompt", async () => {
  const harness = createHarness();
  const link = createLinkStore();
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
    link.store,
  );
  const { interaction, replies } = createLinkInteraction();

  await requester.requestFromInteraction(interaction);

  const [reply] = replies;
  assert.ok(reply);
  assert.match(toJson(reply)[0]?.components[0]?.content ?? "", /オーナーに確認しています/u);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const [ownerContainer] = toJson(ownerMessage);
  assert.match(ownerContainer?.components[0]?.content ?? "", /チャンネルの登録リクエスト/u);
  assert.match(ownerContainer?.components[0]?.content ?? "", /<@user-123>/u);
  assert.match(ownerContainer?.components[0]?.content ?? "", /のチャンネルとして登録しますか/u);

  const [pending] = harness.sent;
  assert.ok(pending);
  assert.match(
    toJson(pending)[0]?.components[0]?.content ?? "",
    /自分のチャンネルとして登録するリクエスト/u,
  );
});

test("listing an already owned channel does not ask the owner again", async () => {
  const harness = createHarness();
  const link = createLinkStore([
    {
      guildId: "guild-123",
      channelId: "parent-channel",
      threadId: "thread-123",
      userId: "user-123",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
    link.store,
  );
  const { interaction, replies } = createLinkInteraction();

  await requester.requestFromInteraction(interaction);

  assert.match(
    toJson(replies[0])[0]?.components[0]?.content ?? "",
    /既にあなたのチャンネルとして登録されています/u,
  );
  assert.equal(harness.ownerMessages.length, 0);
});

test("refuses a link request when another user already owns the channel", async () => {
  const harness = createHarness();
  const link = createLinkStore([
    {
      guildId: "guild-123",
      channelId: "parent-channel",
      threadId: "thread-123",
      userId: "other-user",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
    link.store,
  );
  const { interaction, replies } = createLinkInteraction();

  await requester.requestFromInteraction(interaction);

  const [reply] = replies;
  assert.ok(reply);
  assert.match(
    toJson(reply)[0]?.components[0]?.content ?? "",
    /既に <@other-user> のチャンネルとして登録されています/u,
  );
  assert.match(toJson(reply)[0]?.components[0]?.content ?? "", /\/unlink/u);
  assert.equal(harness.ownerMessages.length, 0);
});

test("registers the channel and updates both messages when the owner approves a link", async () => {
  const harness = createHarness();
  const link = createLinkStore();
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
    link.store,
  );
  const { interaction } = createLinkInteraction();
  await requester.requestFromInteraction(interaction);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const customId = toJson(ownerMessage)[0]?.components[1]?.components?.[0]?.custom_id;
  assert.ok(customId);

  const updated: Array<{ components: ReadonlyArray<{ toJSON: () => unknown }> }> = [];
  assert.equal(
    await requester.handleButton({
      customId,
      user: { id: "owner-123" },
      reply: async () => undefined,
      update: async (payload) => {
        updated.push(payload);
      },
    }),
    true,
  );

  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "allow",
    },
  ]);
  assert.equal(link.links.get("guild-123:parent-channel:thread-123")?.userId, "user-123");
  assert.match(toJson(updated[0])[0]?.components[0]?.content ?? "", /登録しました/u);
  const [firstEdit] = harness.edits;
  assert.ok(firstEdit);
  assert.match(toJson(firstEdit)[0]?.components[0]?.content ?? "", /登録されました/u);
});

test("does not change access when the owner denies a link", async () => {
  const harness = createHarness();
  const link = createLinkStore();
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
    link.store,
  );
  const { interaction } = createLinkInteraction();
  await requester.requestFromInteraction(interaction);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const customId = toJson(ownerMessage)[0]?.components[1]?.components?.[1]?.custom_id;
  assert.ok(customId);

  await requester.handleButton({
    customId,
    user: { id: "owner-123" },
    reply: async () => undefined,
    update: async () => undefined,
  });

  assert.deepEqual(harness.updates, []);
  assert.equal(link.links.size, 0);
  const [firstEdit] = harness.edits;
  assert.ok(firstEdit);
  assert.match(toJson(firstEdit)[0]?.components[0]?.content ?? "", /登録されませんでした/u);
});

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

test("keeps a pending link request usable after a restart", async () => {
  const harness = createHarness();
  const link = createLinkStore();
  const beforeRestart = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
    link.store,
  );
  await beforeRestart.request({ ...request, linkUserId: "user-123" });

  const afterRestart = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
    link.store,
  );
  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const customId = toJson(ownerMessage)[0]?.components[1]?.components?.[0]?.custom_id;
  assert.ok(customId);

  assert.equal(
    await afterRestart.handleButton({
      customId,
      user: { id: "owner-123" },
      reply: async () => undefined,
      update: async () => undefined,
    }),
    true,
  );

  assert.equal(link.links.get("guild-123:parent-channel:thread-123")?.userId, "user-123");
  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "allow",
    },
  ]);
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

  const replies: Array<{ content: string; flags?: number }> = [];
  const interaction: DiscordChannelAccessButtonInteraction = {
    customId,
    user: { id: "other-user" },
    reply: async (payload) => {
      replies.push(payload);
    },
    update: async () => undefined,
  };

  assert.equal(await requester.handleButton(interaction), true);
  assert.equal(harness.updates.length, 0);
  assert.match(replies[0]?.content ?? "", /オーナー/u);
});

test("unlinks a location only for the bot owner", async () => {
  const harness = createHarness();
  const link = createLinkStore([
    {
      guildId: "guild-123",
      channelId: "parent-channel",
      threadId: "thread-123",
      userId: "user-123",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
    link.store,
  );

  const nonOwner = createLinkInteraction();
  await requester.unlinkFromInteraction(nonOwner.interaction);
  const [nonOwnerReply] = nonOwner.replies;
  assert.ok(nonOwnerReply);
  assert.match(toJson(nonOwnerReply)[0]?.components[0]?.content ?? "", /オーナーだけ/u);
  assert.equal(link.links.size, 1);
  assert.deepEqual(harness.updates, []);

  const owner = createLinkInteraction({ userId: "owner-123" });
  await requester.unlinkFromInteraction(owner.interaction);
  const [ownerReply] = owner.replies;
  assert.ok(ownerReply);
  assert.match(toJson(ownerReply)[0]?.components[0]?.content ?? "", /リンクを解除しました/u);
  assert.equal(link.links.size, 0);
  assert.deepEqual(harness.updates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "deny",
    },
  ]);
});

test("reports when the location is not linked", async () => {
  const harness = createHarness();
  const link = createLinkStore();
  const requester = new DiscordChannelAccessRequester(
    harness.client,
    harness.store,
    harness.requestStore,
    "owner-123",
    link.store,
  );
  const { interaction, replies } = createLinkInteraction({ userId: "owner-123" });

  await requester.unlinkFromInteraction(interaction);

  const [reply] = replies;
  assert.ok(reply);
  assert.match(toJson(reply)[0]?.components[0]?.content ?? "", /リンクされていません/u);
  assert.deepEqual(harness.updates, []);
});
