import assert from "node:assert/strict";
import test from "node:test";

import { MessageFlags } from "discord.js";

import { isRecord } from "@shared/type-guards";

import type { DiscordAccess } from "../domain/discord-access-policy";
import type { DiscordChannelLink, DiscordChannelLinkTarget } from "../domain/discord-channel-link";
import type { PendingDiscordChannelLinkRequest } from "../domain/discord-channel-link-request";
import type { DiscordAccessRuleTarget } from "../ports/discord-access-rule-store";
import type { DiscordChannelLinkStore } from "../ports/discord-channel-link-store";
import {
  DiscordChannelLinkRequester,
  type DiscordChannelLinkCommandInteraction,
} from "./discord-channel-link-requester";
import type { DiscordEphemeralContainerMessage } from "./discord-component-message";

interface ContainerJson {
  readonly components: ReadonlyArray<{
    readonly content?: string;
    readonly components?: ReadonlyArray<{ readonly custom_id?: string; readonly label?: string }>;
  }>;
}

function parseContainerJson(value: unknown): ContainerJson {
  assert.ok(isRecord(value));
  assert.ok(Array.isArray(value.components));
  return {
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
      listLinks: (guildId) => [...links.values()].filter((link) => link.guildId === guildId),
      saveLink: async (link) => {
        links.set(linkKey(link), link);
      },
      removeLink: async (target) => {
        links.delete(linkKey(target));
      },
    },
  };
}

function createHarness(options: { existingLink?: DiscordChannelLink } = {}) {
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
  const client = {
    channels: { fetch: async () => channel },
    users: { fetch: async () => owner },
    guilds: { cache: new Map([["guild-123", { name: "テストサーバー" }]]) },
  };
  const accessUpdates: Array<{ target: DiscordAccessRuleTarget; access: DiscordAccess }> = [];
  const accessRuleStore = {
    setAccess: async (target: DiscordAccessRuleTarget, access: DiscordAccess) => {
      accessUpdates.push({ target, access });
    },
  };
  const link = createLinkStore(options.existingLink ? [options.existingLink] : []);
  const requests = new Map<string, PendingDiscordChannelLinkRequest>();
  const requestStore = {
    list: () => [...requests.values()],
    save: async (request: PendingDiscordChannelLinkRequest) => {
      requests.set(request.requestId, request);
    },
    remove: async (requestId: string) => {
      requests.delete(requestId);
    },
  };
  const requester = new DiscordChannelLinkRequester({
    client,
    accessRuleStore,
    linkStore: link.store,
    requestStore,
    ownerUserId: "owner-123",
  });

  return {
    accessRuleStore,
    accessUpdates,
    client,
    edits,
    link,
    ownerMessages,
    requestStore,
    requests,
    requester,
    sent,
  };
}

function createLinkInteraction(
  options: { readonly userId?: string; readonly channelId?: string } = {},
): {
  interaction: DiscordChannelLinkCommandInteraction;
  replies: DiscordEphemeralContainerMessage[];
} {
  const replies: DiscordEphemeralContainerMessage[] = [];
  return {
    replies,
    interaction: {
      guildId: "guild-123",
      channelId: options.channelId ?? "thread-123",
      user: { id: options.userId ?? "user-123", bot: false },
      channel: {
        id: options.channelId ?? "thread-123",
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
  const { interaction, replies } = createLinkInteraction();

  await harness.requester.requestFromInteraction(interaction);

  const [reply] = replies;
  assert.ok(reply);
  assert.equal(reply.flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
  assert.match(toJson(reply)[0]?.components[0]?.content ?? "", /オーナーに確認しています/u);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const [container] = toJson(ownerMessage);
  assert.match(container?.components[0]?.content ?? "", /チャンネルの登録リクエスト/u);
  assert.match(container?.components[0]?.content ?? "", /<@user-123>/u);
  assert.match(container?.components[0]?.content ?? "", /のチャンネルとして登録しますか/u);

  const [pending] = harness.sent;
  assert.ok(pending);
  assert.match(
    toJson(pending)[0]?.components[0]?.content ?? "",
    /自分のチャンネルとして登録するリクエスト/u,
  );
  assert.equal(harness.requests.size, 1);
});

test("does not ask the owner when another user already owns the channel", async () => {
  const harness = createHarness({
    existingLink: {
      guildId: "guild-123",
      channelId: "parent-channel",
      threadId: "thread-123",
      userId: "other-user",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const { interaction, replies } = createLinkInteraction();

  await harness.requester.requestFromInteraction(interaction);

  const [reply] = replies;
  assert.ok(reply);
  assert.match(
    toJson(reply)[0]?.components[0]?.content ?? "",
    /既に <@other-user> のチャンネルとして登録されています/u,
  );
  assert.match(toJson(reply)[0]?.components[0]?.content ?? "", /\/unlink/u);
  assert.equal(harness.ownerMessages.length, 0);
});

test("registers the channel and updates both messages when the owner approves", async () => {
  const harness = createHarness();
  const { interaction } = createLinkInteraction();
  await harness.requester.requestFromInteraction(interaction);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const customId = toJson(ownerMessage)[0]?.components[1]?.components?.[0]?.custom_id;
  assert.ok(customId);

  const updated: Array<{ components: ReadonlyArray<{ toJSON: () => unknown }> }> = [];
  assert.equal(
    await harness.requester.handleButton({
      customId,
      user: { id: "owner-123" },
      reply: async () => undefined,
      update: async (payload) => {
        updated.push(payload);
      },
    }),
    true,
  );

  assert.deepEqual(harness.accessUpdates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "allow",
    },
  ]);
  assert.equal(harness.link.links.get("guild-123:parent-channel:thread-123")?.userId, "user-123");
  assert.match(
    toJson(updated[0] ?? { components: [] })[0]?.components[0]?.content ?? "",
    /登録しました/u,
  );
  const [firstEdit] = harness.edits;
  assert.ok(firstEdit);
  assert.match(toJson(firstEdit)[0]?.components[0]?.content ?? "", /登録されました/u);
});

test("does not change access when the owner denies a link", async () => {
  const harness = createHarness();
  const { interaction } = createLinkInteraction();
  await harness.requester.requestFromInteraction(interaction);

  const [ownerMessage] = harness.ownerMessages;
  assert.ok(ownerMessage);
  const customId = toJson(ownerMessage)[0]?.components[1]?.components?.[1]?.custom_id;
  assert.ok(customId);

  await harness.requester.handleButton({
    customId,
    user: { id: "owner-123" },
    reply: async () => undefined,
    update: async () => undefined,
  });

  assert.deepEqual(harness.accessUpdates, []);
  assert.equal(harness.link.links.size, 0);
  const [firstEdit] = harness.edits;
  assert.ok(firstEdit);
  assert.match(toJson(firstEdit)[0]?.components[0]?.content ?? "", /登録されませんでした/u);
});

test("keeps a pending link request usable after a restart", async () => {
  const harness = createHarness();
  const beforeRestart = new DiscordChannelLinkRequester({
    client: harness.client,
    accessRuleStore: harness.accessRuleStore,
    linkStore: harness.link.store,
    requestStore: harness.requestStore,
    ownerUserId: "owner-123",
  });
  await beforeRestart.requestFromInteraction(createLinkInteraction().interaction);

  const afterRestart = new DiscordChannelLinkRequester({
    client: harness.client,
    accessRuleStore: harness.accessRuleStore,
    linkStore: harness.link.store,
    requestStore: harness.requestStore,
    ownerUserId: "owner-123",
  });
  assert.equal(harness.requests.size, 1);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.ownerMessages.length, 1);

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
  assert.equal(harness.link.links.get("guild-123:parent-channel:thread-123")?.userId, "user-123");
  assert.equal(harness.requests.size, 0);
});

test("unlinks a location only for the bot owner", async () => {
  const harness = createHarness({
    existingLink: {
      guildId: "guild-123",
      channelId: "parent-channel",
      threadId: "thread-123",
      userId: "user-123",
      linkedAt: "2026-01-01T00:00:00.000Z",
    },
  });

  const nonOwner = createLinkInteraction();
  await harness.requester.unlinkFromInteraction(nonOwner.interaction);
  const [nonOwnerReply] = nonOwner.replies;
  assert.ok(nonOwnerReply);
  assert.match(toJson(nonOwnerReply)[0]?.components[0]?.content ?? "", /オーナーだけ/u);
  assert.equal(harness.link.links.size, 1);
  assert.deepEqual(harness.accessUpdates, []);

  const owner = createLinkInteraction({ userId: "owner-123" });
  await harness.requester.unlinkFromInteraction(owner.interaction);
  const [ownerReply] = owner.replies;
  assert.ok(ownerReply);
  assert.match(toJson(ownerReply)[0]?.components[0]?.content ?? "", /リンクを解除しました/u);
  assert.equal(harness.link.links.size, 0);
  assert.deepEqual(harness.accessUpdates, [
    {
      target: { guildId: "guild-123", channelId: "parent-channel", threadId: "thread-123" },
      access: "deny",
    },
  ]);
});

test("reports when the location is not linked", async () => {
  const harness = createHarness();
  const { interaction, replies } = createLinkInteraction({ userId: "owner-123" });

  await harness.requester.unlinkFromInteraction(interaction);

  const [reply] = replies;
  assert.ok(reply);
  assert.match(toJson(reply)[0]?.components[0]?.content ?? "", /リンクされていません/u);
  assert.deepEqual(harness.accessUpdates, []);
});
