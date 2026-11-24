import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  Events,
  GatewayIntentBits,
  IntentsBitField,
  MessageFlags,
  Partials,
  type ClientOptions,
  type InteractionReplyOptions,
  type ModalBuilder,
} from "discord.js";

import type { SecretControl } from "../../secrets/application/secret-service";
import type { SecretRequest, SecretRequestDraft } from "../../secrets/domain/secret-request";
import { isRecord } from "@shared/type-guards";
import { createDiscordAccessPolicy } from "../domain/discord-access-policy";
import type { DiscordMessage } from "../domain/discord-message";
import type { DiscordReactionEvent } from "../domain/discord-reaction";
import { DiscordOperatingState } from "../domain/discord-operating-state";
import type { PendingDiscordAccessRequest } from "../ports/discord-access-request-store";
import type { PendingDiscordChannelLinkRequest } from "../domain/discord-channel-link-request";
import type {
  DiscordChatInputInteraction,
  DiscordModalSubmitInteraction,
} from "./discord-js-interaction-handler";
import type { DiscordAdapterAttachment } from "./discord-js-message-adapter";
import {
  DiscordJsService,
  type DiscordServiceChannel,
  type DiscordServiceClient,
  type DiscordServiceMessage,
  type DiscordServiceMessagePageOptions,
  type DiscordServiceSendableUser,
} from "./discord-js-service";
import type { DiscordServiceProfileGuild } from "./discord-js-user-profile";

interface FakeDiscordChannel extends DiscordServiceChannel {
  send?(payload: unknown): Promise<unknown>;
}

function createProfileUser(
  overrides: Partial<DiscordServiceSendableUser> = {},
): DiscordServiceSendableUser {
  return {
    id: "user-123",
    username: "satsuki",
    globalName: null,
    displayName: "さつき",
    bot: false,
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    avatarURL: () => null,
    bannerURL: () => null,
    flags: { toArray: () => [] },
    send: async () => undefined,
    ...overrides,
  };
}

function createSecretRequest(): SecretRequest {
  return {
    requestId: "request-1",
    userId: "user-123",
    channelId: "channel-123",
    accessScope: "user:user-123",
    workerId: "worker-1",
    service: "github",
    label: "GitHub",
    reason: "Issueを確認するため",
    fields: [{ key: "token", label: "トークン", env: "GH_TOKEN" }],
    createdAt: "2026-11-24T00:00:00.000Z",
    expiresAt: "2026-11-24T00:15:00.000Z",
  };
}

function createSecretRequestDraft(): SecretRequestDraft {
  const {
    requestId: _requestId,
    createdAt: _createdAt,
    expiresAt: _expiresAt,
    ...draft
  } = createSecretRequest();
  return draft;
}

function createSecretControl(overrides: Partial<SecretControl> = {}): SecretControl {
  return {
    async request() {
      throw new Error("Unexpected secret request");
    },
    async lookupPending() {
      return { kind: "missing" };
    },
    async attachMessage() {},
    async abandon() {},
    async complete() {
      return { kind: "missing" };
    },
    async cancel() {
      return { kind: "missing" };
    },
    async list() {
      return [];
    },
    async read() {
      return undefined;
    },
    async delete() {
      return false;
    },
    ...overrides,
  };
}

class FakeDiscordClient extends EventEmitter implements DiscordServiceClient {
  user: {
    id: string;
    setActivity: (name: string) => void;
    setStatus: (status: "online" | "idle") => void;
  } | null = null;

  channels: { fetch: (id: string) => Promise<FakeDiscordChannel | null> } = {
    fetch: async () => null,
  };

  users: {
    fetch: (
      id: string,
      options?: { readonly force?: boolean },
    ) => Promise<DiscordServiceSendableUser>;
  } = {
    fetch: async () => createProfileUser(),
  };

  guilds: {
    cache: Map<string, { readonly name?: string }>;
    fetch: (id: string) => Promise<DiscordServiceProfileGuild>;
  } = {
    cache: new Map(),
    fetch: async (id) => ({
      id,
      name: id,
      members: {
        async fetch() {
          throw new Error("Unexpected guild member fetch");
        },
      },
    }),
  };

  login = async (): Promise<string> => "token";
  destroy = async (): Promise<void> => undefined;
}

function createLinkRequestStore() {
  const requests = new Map<string, PendingDiscordChannelLinkRequest>();
  return {
    requests,
    async load() {},
    list: () => [...requests.values()],
    async save(request: PendingDiscordChannelLinkRequest) {
      requests.set(request.requestId, request);
    },
    async remove(requestId: string) {
      requests.delete(requestId);
    },
  };
}

function createBotUser(
  overrides: {
    setActivity?: (name: string) => void;
    setStatus?: (status: "online" | "idle") => void;
  } = {},
) {
  return {
    id: "bot-123",
    setActivity: overrides.setActivity ?? (() => undefined),
    setStatus: overrides.setStatus ?? (() => undefined),
  };
}

function createMessage(
  options: {
    author?: { bot?: boolean; id?: string };
    content?: string;
    attachments?: Map<string, DiscordAdapterAttachment>;
    mentionedUserIds?: string[];
  } = {},
): DiscordServiceMessage {
  const message: DiscordServiceMessage = {
    author: {
      bot: options.author?.bot ?? false,
      displayName: "さつき",
      id: options.author?.id ?? "user-123",
      username: "satsuki",
    },
    channel: Object.assign(
      {
        id: "channel-123",
        isThread: () => false,
      },
      {
        send: async () => undefined,
      },
    ),
    channelId: "channel-123",
    content: options.content ?? "メンションなしのメッセージ",
    guildId: "guild-123",
    createdAt: new Date("2026-10-14T09:30:42.123Z"),
    id: "message-123",
    attachments: options.attachments ?? new Map<string, DiscordAdapterAttachment>(),
    mentions: {
      roles: new Map(),
      users: new Map(
        (options.mentionedUserIds ?? []).map((id) => [
          id,
          { bot: false, displayName: id, id, username: id },
        ]),
      ),
    },
    fetchReference: async () => message,
  };
  return message;
}

function createImageAttachment(): DiscordAdapterAttachment {
  return {
    contentType: "image/png",
    id: "attachment-123",
    name: "sample.png",
    size: 68,
    url: "https://cdn.discordapp.com/attachments/sample.png",
  };
}

interface HistoryMessageFetch {
  (messageId: string): Promise<DiscordServiceMessage>;
  (options: DiscordServiceMessagePageOptions): Promise<ReadonlyMap<string, DiscordServiceMessage>>;
}

function createHistoryMessageFetch(
  loadPage: (
    options: DiscordServiceMessagePageOptions,
  ) => ReadonlyMap<string, DiscordServiceMessage>,
): HistoryMessageFetch {
  function fetch(messageId: string): Promise<DiscordServiceMessage>;
  function fetch(
    options: DiscordServiceMessagePageOptions,
  ): Promise<ReadonlyMap<string, DiscordServiceMessage>>;
  async function fetch(
    target: string | DiscordServiceMessagePageOptions,
  ): Promise<DiscordServiceMessage | ReadonlyMap<string, DiscordServiceMessage>> {
    return typeof target === "string" ? createMessage() : loadPage(target);
  }
  return fetch;
}

function extractFirstTextContent(response: InteractionReplyOptions): string | undefined {
  const firstComponent = response.components?.[0];
  if (
    !firstComponent ||
    typeof firstComponent !== "object" ||
    !("toJSON" in firstComponent) ||
    typeof firstComponent.toJSON !== "function"
  ) {
    return undefined;
  }
  const json: unknown = firstComponent.toJSON();
  if (!isRecord(json) || !Array.isArray(json.components)) return undefined;
  const inner: unknown = json.components[0];
  return isRecord(inner) && typeof inner.content === "string" ? inner.content : undefined;
}

function readReplyFlags(response: InteractionReplyOptions): number | undefined {
  return typeof response.flags === "number" ? response.flags : undefined;
}

function createChatInputInteraction(overrides: {
  id?: string;
  commandName: string;
  guildId?: string | null;
  channelId?: string;
  getSubcommand?: () => string;
  fetchChannel?: (
    id: string,
  ) => Promise<{ id: string; name?: string | null; isThread(): boolean } | null>;
  reply?: (response: InteractionReplyOptions) => Promise<unknown>;
  showModal?: (modal: ModalBuilder) => Promise<unknown>;
  deferReply?: (options: { ephemeral: boolean }) => Promise<unknown>;
  deleteReply?: () => Promise<void>;
}): DiscordChatInputInteraction {
  return {
    id: overrides.id ?? "interaction-123",
    commandName: overrides.commandName,
    inGuild: () => true,
    guildId: overrides.guildId ?? "guild-123",
    channelId: overrides.channelId ?? "channel-123",
    channel: { id: overrides.channelId ?? "channel-123", isThread: () => false },
    client: {
      channels: {
        cache: new Map(),
        fetch: overrides.fetchChannel ?? (async () => null),
      },
    },
    guild: null,
    user: { id: "user-123", bot: false },
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    options: { getSubcommand: overrides.getSubcommand ?? (() => "") },
    memberPermissions: { has: () => true },
    reply: overrides.reply ?? (async () => undefined),
    deferReply: overrides.deferReply ?? (async () => undefined),
    editReply: async () => undefined,
    deleteReply: overrides.deleteReply ?? (async () => undefined),
    showModal: overrides.showModal ?? (async () => undefined),
  };
}

function createModalSubmitInteraction(overrides: {
  id: string;
  customId: string;
  guildId?: string | null;
  channelId: string;
  getTextInputValue: (customId: string) => string;
  reply: (response: InteractionReplyOptions) => Promise<unknown>;
}): DiscordModalSubmitInteraction {
  return {
    id: overrides.id,
    customId: overrides.customId,
    guildId: overrides.guildId ?? "guild-123",
    inGuild: () => true,
    channelId: overrides.channelId,
    channel: { id: overrides.channelId, isThread: () => false },
    client: {
      channels: {
        cache: new Map(),
        fetch: async () => null,
      },
    },
    user: { id: "user-123", bot: false },
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    memberPermissions: { has: () => true },
    fields: {
      getTextInputValue: overrides.getTextInputValue,
    },
    reply: overrides.reply,
  };
}

function readRuleModal(modal: ModalBuilder): {
  customId: string;
  inputCustomId?: string;
  inputValue?: string;
} {
  const json: unknown = modal.toJSON();
  assert.ok(isRecord(json) && typeof json.custom_id === "string" && Array.isArray(json.components));
  const firstRow: unknown = json.components[0];
  assert.ok(isRecord(firstRow) && Array.isArray(firstRow.components));
  const firstInput: unknown = firstRow.components[0];
  assert.ok(isRecord(firstInput));
  return {
    customId: json.custom_id,
    inputCustomId: typeof firstInput.custom_id === "string" ? firstInput.custom_id : undefined,
    inputValue: typeof firstInput.value === "string" ? firstInput.value : undefined,
  };
}

test("forwards guild messages without a bot mention", async () => {
  const fakeClient = new FakeDiscordClient();
  fakeClient.user = createBotUser();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  const received: DiscordMessage[] = [];

  try {
    await service.start(async (message) => {
      received.push(message);
    });
    fakeClient.emit(Events.MessageCreate, createMessage());
    await service.flush();

    assert.equal(received.length, 1);
    assert.equal(received[0]?.content, "メンションなしのメッセージ");
  } finally {
    await service.stop();
  }
});

test("ignores only messages sent by this bot", async () => {
  const fakeClient = new FakeDiscordClient();
  fakeClient.user = createBotUser();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  const received: DiscordMessage[] = [];

  try {
    await service.start(async (message) => {
      received.push(message);
    });
    fakeClient.emit(
      Events.MessageCreate,
      createMessage({ author: { bot: true, id: "bot-123" }, content: "自分の送信メッセージ" }),
    );
    fakeClient.emit(
      Events.MessageCreate,
      createMessage({ author: { bot: true, id: "other-bot-456" }, content: "別 bot のメッセージ" }),
    );
    await service.flush();

    assert.equal(received.length, 1);
    assert.equal(received[0]?.author.id, "other-bot-456");
    assert.equal(received[0]?.content, "別 bot のメッセージ");
  } finally {
    await service.stop();
  }
});

test("forwards image attachments, including image-only messages", async () => {
  const fakeClient = new FakeDiscordClient();
  fakeClient.user = createBotUser();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  const received: DiscordMessage[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      { headers: { "content-type": "image/png" } },
    );

  try {
    await service.start(async (message) => {
      received.push(message);
    });
    fakeClient.emit(
      Events.MessageCreate,
      createMessage({
        attachments: new Map([["attachment-123", createImageAttachment()]]),
        content: "",
      }),
    );
    await service.flush();

    assert.equal(received.length, 1);
    assert.equal(received[0]?.content, "");
    assert.deepEqual(
      received[0]?.images.map(({ filename, id, mimeType }) => ({ filename, id, mimeType })),
      [{ filename: "sample.png", id: "attachment-123", mimeType: "image/png" }],
    );
    assert.ok(received[0]?.images[0]?.data);
  } finally {
    globalThis.fetch = originalFetch;
    await service.stop();
  }
});

test("sets the bot activity", async () => {
  const fakeClient = new FakeDiscordClient();
  const activities: string[] = [];
  fakeClient.user = createBotUser({
    setActivity: (name) => activities.push(name),
  });
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  try {
    service.setActivity("65.5%/month (reset in 17 days)");
    assert.deepEqual(activities, ["65.5%/month (reset in 17 days)"]);
  } finally {
    await service.stop();
  }
});

test("pauses message handling while the bot is idle", async () => {
  const fakeClient = new FakeDiscordClient();
  fakeClient.user = createBotUser();
  const operatingState = new DiscordOperatingState();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    operatingState,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  const received: DiscordMessage[] = [];

  try {
    await service.start(async (message) => {
      received.push(message);
    });
    service.setOperatingMode("paused");
    fakeClient.emit(Events.MessageCreate, createMessage());
    await service.flush();

    assert.equal(operatingState.mode, "paused");
    assert.equal(received.length, 0);
  } finally {
    await service.stop();
  }
});

test("changes the Discord presence when the operating mode changes", async () => {
  const fakeClient = new FakeDiscordClient();
  const statuses: string[] = [];
  fakeClient.user = createBotUser({
    setStatus: (status) => statuses.push(status),
  });
  const operatingState = new DiscordOperatingState();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    operatingState,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  try {
    service.setOperatingMode("paused");
    service.setOperatingMode("active");

    assert.deepEqual(statuses, ["idle", "online"]);
    assert.equal(operatingState.mode, "active");
  } finally {
    await service.stop();
  }
});

test("handles status slash subcommands for members with Manage Server", async () => {
  const fakeClient = new FakeDiscordClient();
  fakeClient.user = createBotUser();
  const operatingState = new DiscordOperatingState();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    operatingState,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );
  const replies: Array<{ content: string | undefined; flags: number | undefined }> = [];
  let subcommand = "idle";
  const interaction = createChatInputInteraction({
    commandName: "status",
    getSubcommand: () => subcommand,
    reply: async (response) => {
      replies.push({
        content: extractFirstTextContent(response),
        flags: readReplyFlags(response),
      });
    },
  });

  try {
    await service.start(async () => undefined);
    fakeClient.emit(Events.InteractionCreate, interaction);
    await service.flush();

    assert.equal(operatingState.mode, "paused");

    subcommand = "online";
    fakeClient.emit(Events.InteractionCreate, interaction);
    await service.flush();

    assert.equal(operatingState.mode, "active");
    assert.deepEqual(replies, [
      { content: "Botを一時停止しました。", flags: 32768 },
      { content: "Botを再開しました。", flags: 32768 },
    ]);
  } finally {
    await service.stop();
  }
});

test("lists explicitly allowed channels and threads with their access levels", async () => {
  const fakeClient = new FakeDiscordClient();
  const accessRuleStore = {
    async load() {},
    async setAccess() {},
    getGuildRule(guildId: string) {
      return guildId === "guild-123"
        ? {
            access: "deny" as const,
            channels: {
              "channel-allow": {
                access: "allow" as const,
                threads: {
                  "thread-allow": {},
                  "thread-deny": { access: "deny" as const },
                },
              },
              "channel-owner": { access: "allow" as const },
              "channel-deny": { access: "deny" as const },
            },
          }
        : undefined;
    },
  };
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy(
      { default: "deny", directMessages: "allow" },
      "owner-user",
      accessRuleStore,
      (target) =>
        target.guildId === "guild-123" && target.channelId === "channel-owner"
          ? "owner-user"
          : undefined,
    ),
    undefined,
    undefined,
    undefined,
    undefined,
    accessRuleStore,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );
  const names: Record<string, string> = {
    "channel-allow": "allow-name",
    "thread-allow": "thread-name",
    "channel-owner": "owner-name",
  };
  let content: string | undefined;
  let flags: number | undefined;
  const interaction = createChatInputInteraction({
    commandName: "channels",
    channelId: "channel-allow",
    fetchChannel: async (id) => ({ id, name: names[id], isThread: () => false }),
    reply: async (response) => {
      content = extractFirstTextContent(response);
      flags = readReplyFlags(response);
    },
  });

  try {
    await service.start(async () => undefined);
    fakeClient.emit(Events.InteractionCreate, interaction);
    await service.flush();

    assert.equal(
      content,
      [
        "### 許可されたチャンネルとスレッド",
        "ギルド全体: 拒否",
        "・#allow-name（許可）",
        "　└ #thread-name（許可）",
        "・#owner-name（オーナーのみ）",
      ].join("\n"),
    );
    assert.equal(flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
  } finally {
    await service.stop();
  }
});

test("registers a channel through /link even when the channel is denied", async () => {
  const fakeClient = new FakeDiscordClient();
  const ownerMessages: InteractionReplyOptions[] = [];
  fakeClient.users.fetch = async () => ({
    ...createProfileUser(),
    send: async (payload) => {
      ownerMessages.push(payload);
      return undefined;
    },
  });
  const channelMessages: unknown[] = [];
  fakeClient.channels.fetch = async (id) => ({
    id,
    isTextBased: () => true,
    isThread: () => false,
    send: async (payload: unknown) => {
      channelMessages.push(payload);
      return { id: "pending-message-1" };
    },
  });

  const accessUpdates: Array<{ target: unknown; access: string }> = [];
  const links = new Map<string, { userId: string }>();
  const accessRuleStore = {
    async load() {},
    async setAccess(target: unknown, access: string) {
      accessUpdates.push({ target, access });
    },
    getGuildRule: () => undefined,
  };
  const requests = new Map<string, PendingDiscordAccessRequest>();
  const accessRequestStore = {
    async load() {},
    list: () => [...requests.values()],
    async save(request: PendingDiscordAccessRequest) {
      requests.set(request.requestId, request);
    },
    async remove(requestId: string) {
      requests.delete(requestId);
    },
  };
  const channelLinkStore = {
    async load() {},
    getLink: (target: { channelId: string; threadId?: string }) =>
      links.get(`${target.channelId}:${target.threadId ?? ""}`)
        ? {
            guildId: "guild-123",
            channelId: target.channelId,
            ...(target.threadId ? { threadId: target.threadId } : {}),
            userId: links.get(`${target.channelId}:${target.threadId ?? ""}`)?.userId ?? "",
            linkedAt: "2026-01-01T00:00:00.000Z",
          }
        : undefined,
    async saveLink(link: { channelId: string; threadId?: string; userId: string }) {
      links.set(`${link.channelId}:${link.threadId ?? ""}`, { userId: link.userId });
    },
    async removeLink(target: { channelId: string; threadId?: string }) {
      links.delete(`${target.channelId}:${target.threadId ?? ""}`);
    },
    listLinks: () => {
      const result: Array<{
        guildId: string;
        channelId: string;
        threadId?: string;
        userId: string;
        linkedAt: string;
      }> = [];
      for (const [key, value] of links) {
        const [channelId = "", threadId = ""] = key.split(":");
        result.push({
          guildId: "guild-123",
          channelId,
          ...(threadId ? { threadId } : {}),
          userId: value.userId,
          linkedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      return result;
    },
  };
  const linkRequestStore = createLinkRequestStore();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "deny", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    accessRuleStore,
    "owner-123",
    accessRequestStore,
    {
      createClient: () => fakeClient,
      channelLinkStore,
      channelLinkRequestStore: linkRequestStore,
    },
  );

  let deferred: { ephemeral: boolean } | undefined;
  let deleted = false;
  const interaction = createChatInputInteraction({
    commandName: "link",
    channelId: "channel-denied",
    deferReply: async (options) => {
      deferred = options;
    },
    deleteReply: async () => {
      deleted = true;
    },
  });

  try {
    await service.start(async () => undefined);
    fakeClient.emit(Events.InteractionCreate, interaction);
    await service.flush();

    assert.deepEqual(deferred, { ephemeral: true });
    assert.equal(deleted, true);
    assert.equal(ownerMessages.length, 1);
    assert.match(extractFirstTextContent(ownerMessages[0]) ?? "", /チャンネルの登録リクエスト/u);
    assert.equal(channelMessages.length, 1);
    assert.equal(accessUpdates.length, 0);
    assert.equal(linkRequestStore.requests.size, 1);
  } finally {
    await service.stop();
  }
});

test("removes a channel link through /unlink for the bot owner", async () => {
  const fakeClient = new FakeDiscordClient();
  const accessUpdates: Array<{ target: unknown; access: string }> = [];
  const accessRuleStore = {
    async load() {},
    async setAccess(target: unknown, access: string) {
      accessUpdates.push({ target, access });
    },
    getGuildRule: () => undefined,
  };
  const requests = new Map<string, PendingDiscordAccessRequest>();
  const accessRequestStore = {
    async load() {},
    list: () => [...requests.values()],
    async save(request: PendingDiscordAccessRequest) {
      requests.set(request.requestId, request);
    },
    async remove(requestId: string) {
      requests.delete(requestId);
    },
  };
  let link: { userId: string; linkedAt: string } | undefined = {
    userId: "member-123",
    linkedAt: "2026-01-01T00:00:00.000Z",
  };
  const channelLinkStore = {
    async load() {},
    getLink: (target: { channelId: string; threadId?: string }) =>
      link
        ? {
            guildId: "guild-123",
            channelId: target.channelId,
            ...(target.threadId ? { threadId: target.threadId } : {}),
            ...link,
          }
        : undefined,
    async saveLink() {},
    async removeLink() {
      link = undefined;
    },
    listLinks: () =>
      link
        ? [
            {
              guildId: "guild-123",
              channelId: "channel-denied",
              userId: link.userId,
              linkedAt: link.linkedAt,
            },
          ]
        : [],
  };
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "deny", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    accessRuleStore,
    "user-123",
    accessRequestStore,
    {
      createClient: () => fakeClient,
      channelLinkStore,
      channelLinkRequestStore: createLinkRequestStore(),
    },
  );

  let replyContent: string | undefined;
  const interaction = createChatInputInteraction({
    commandName: "unlink",
    channelId: "channel-denied",
    reply: async (response) => {
      replyContent = extractFirstTextContent(response);
    },
  });

  try {
    await service.start(async () => undefined);
    fakeClient.emit(Events.InteractionCreate, interaction);
    await service.flush();

    assert.match(replyContent ?? "", /リンクを解除しました/u);
    assert.equal(link, undefined);
    assert.deepEqual(accessUpdates, [
      { target: { guildId: "guild-123", channelId: "channel-denied" }, access: "deny" },
    ]);
  } finally {
    await service.stop();
  }
});

test("owner channels only forward real owner messages", async () => {
  const fakeClient = new FakeDiscordClient();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "owner", directMessages: "owner" }, "user-123"),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );
  const received: DiscordMessage[] = [];
  try {
    await service.start(async (message) => {
      received.push(message);
    });
    fakeClient.emit(Events.MessageCreate, createMessage({ author: { id: "other-user" } }));
    fakeClient.emit(Events.MessageCreate, createMessage({ author: { id: "user-123", bot: true } }));
    fakeClient.emit(Events.MessageCreate, createMessage());
    await service.flush();

    assert.equal(received.length, 1);
    assert.equal(received[0]?.author.id, "user-123");
    assert.equal(received[0]?.author.bot, false);
  } finally {
    await service.stop();
  }
});

test("message reads enforce inherited access and trusted requester identity", async () => {
  const fakeClient = new FakeDiscordClient();
  let reads = 0;
  fakeClient.channels.fetch = async (id) => ({
    id,
    guildId: "guild-123",
    isTextBased: () => true,
    isThread: () => id === "public" || id === "private-thread",
    parentId: "private",
    messages: {
      fetch: async () => {
        reads += 1;
        return createMessage();
      },
    },
  });
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy(
      {
        default: "deny",
        directMessages: "deny",
      },
      "user-123",
      {
        getGuildRule: (guildId) =>
          guildId === "guild-123"
            ? {
                channels: {
                  private: { access: "allow", threads: { public: { access: "allow" } } },
                },
              }
            : undefined,
      },
      (target) => (target.threadId === "private-thread" ? "user-123" : undefined),
    ),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );
  const locator = { channelId: "private-thread", messageId: "message-123" };
  try {
    for (const requester of [
      undefined,
      { userId: "other-user" },
      { userId: "user-123", userIsBot: true },
    ]) {
      await assert.rejects(service.readMessage(locator, requester), /access denied/);
    }
    await assert.rejects(
      service.readMessage({ ...locator, channelId: "denied" }, { userId: "user-123" }),
      /access denied/,
    );
    assert.equal(reads, 0);
    assert.equal((await service.readMessage(locator, { userId: "user-123" })).id, "message-123");
    await service.readMessage({ ...locator, channelId: "public" });
    assert.equal(reads, 2);
  } finally {
    await service.stop();
  }
});

test("reads channel history with pagination options", async () => {
  const fakeClient = new FakeDiscordClient();
  const pageRequests: unknown[] = [];
  fakeClient.channels.fetch = async (id) => ({
    id,
    guildId: "guild-123",
    isTextBased: () => true,
    isThread: () => false,
    messages: {
      fetch: createHistoryMessageFetch((options) => {
        pageRequests.push(options);
        return new Map<string, DiscordServiceMessage>([
          [
            "message-2",
            {
              ...createMessage({
                attachments: new Map([["attachment-1", createImageAttachment()]]),
                author: { bot: true, id: "bot-123" },
                content: "新しい本文",
              }),
              id: "message-2",
            },
          ],
          ["message-1", { ...createMessage({ content: "古い本文" }), id: "message-1" }],
        ]);
      }),
    },
  });
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  try {
    const messages = await service.readMessages({
      before: "message-3",
      channelId: "channel-123",
      limit: 2,
    });

    assert.deepEqual(pageRequests, [{ before: "message-3", limit: 2 }]);
    assert.deepEqual(
      messages.map((message) => ({
        attachments: message.attachments,
        authorBot: message.author.bot,
        content: message.content,
        id: message.id,
      })),
      [
        {
          attachments: [
            {
              filename: "sample.png",
              url: "https://cdn.discordapp.com/attachments/sample.png",
            },
          ],
          authorBot: true,
          content: "新しい本文",
          id: "message-2",
        },
        { attachments: [], authorBot: false, content: "古い本文", id: "message-1" },
      ],
    );
  } finally {
    await service.stop();
  }
});

test("channel history reads enforce inherited access", async () => {
  const fakeClient = new FakeDiscordClient();
  let reads = 0;
  fakeClient.channels.fetch = async (id) => ({
    id,
    guildId: "guild-123",
    isTextBased: () => true,
    isThread: () => id === "private-thread",
    parentId: "private",
    messages: {
      fetch: createHistoryMessageFetch(() => {
        reads += 1;
        return new Map<string, DiscordServiceMessage>();
      }),
    },
  });
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy(
      { default: "deny", directMessages: "deny" },
      "user-123",
      {
        getGuildRule: (guildId) =>
          guildId === "guild-123"
            ? {
                channels: {
                  private: { access: "allow", threads: { public: { access: "allow" } } },
                },
              }
            : undefined,
      },
      (target) => (target.threadId === "private-thread" ? "user-123" : undefined),
    ),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  try {
    await assert.rejects(
      service.readMessages({ channelId: "private-thread", limit: 10 }),
      /access denied/,
    );
    assert.equal(reads, 0);
    await service.readMessages({ channelId: "private-thread", limit: 10 }, { userId: "user-123" });
    assert.equal(reads, 1);
  } finally {
    await service.stop();
  }
});

test("resolves current channel locations, including thread parents and direct messages", async () => {
  const fakeClient = new FakeDiscordClient();
  const fetched: string[] = [];
  fakeClient.channels.fetch = async (id) => {
    fetched.push(id);
    if (id === "missing") return null;
    if (id === "voice") return { isTextBased: () => false };
    return {
      id,
      ...(id !== "dm" ? { guildId: "guild-123" } : {}),
      name: `${id}-name`,
      parentId: id === "thread" ? "parent-channel" : null,
      isTextBased: () => true,
      isThread: () => id === "thread",
    };
  };
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );
  try {
    assert.deepEqual(await service.getChannelLocation("channel"), {
      guildId: "guild-123",
      channelId: "channel",
      threadId: undefined,
      channelName: "channel-name",
    });
    assert.deepEqual(await service.getChannelLocation("thread"), {
      guildId: "guild-123",
      channelId: "parent-channel",
      threadId: "thread",
      channelName: "thread-name",
    });
    assert.deepEqual(await service.getChannelLocation("dm"), {
      guildId: undefined,
      channelId: "dm",
      threadId: undefined,
      channelName: "dm-name",
    });
    await assert.rejects(service.getChannelLocation("missing"), /cannot contain messages/);
    await assert.rejects(service.getChannelLocation("voice"), /cannot contain messages/);
    assert.deepEqual(fetched, ["channel", "thread", "dm", "missing", "voice"]);
  } finally {
    await service.stop();
  }
});

test("lists cached guild names", async () => {
  const fakeClient = new FakeDiscordClient();
  fakeClient.guilds.cache.set("guild-123", { name: "テストサーバー" });
  fakeClient.guilds.cache.set("guild-456", {});
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );
  try {
    assert.deepEqual([...service.listGuildNames()], [["guild-123", "テストサーバー"]]);
  } finally {
    await service.stop();
  }
});

test("opens the rule modal with the channel's own rule and a fresh custom id", async () => {
  const fakeClient = new FakeDiscordClient();
  const rules = new Map([
    ["channel-a", "チャンネルAのルール"],
    ["channel-b", "チャンネルBのルール"],
  ]);
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    {
      async get(_guildId, channelId) {
        return rules.get(channelId);
      },
      async set() {},
    },
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );
  const modals: Array<{ customId: string; inputCustomId?: string; inputValue?: string }> = [];
  const interactionFor = (channelId: string, interactionId: string) =>
    createChatInputInteraction({
      id: interactionId,
      commandName: "rule",
      channelId,
      showModal: async (modal) => {
        modals.push(readRuleModal(modal));
      },
    });

  try {
    await service.start(async () => undefined);
    fakeClient.emit(Events.InteractionCreate, interactionFor("channel-a", "interaction-a"));
    fakeClient.emit(Events.InteractionCreate, interactionFor("channel-b", "interaction-b"));
    await service.flush();

    assert.deepEqual(
      modals.map((modal) => modal.inputValue),
      ["チャンネルAのルール", "チャンネルBのルール"],
    );
    assert.notEqual(modals[0]?.customId, modals[1]?.customId);
    assert.notEqual(modals[0]?.inputCustomId, modals[1]?.inputCustomId);
  } finally {
    await service.stop();
  }
});

test("saves a submitted rule under the interaction's channel", async () => {
  const fakeClient = new FakeDiscordClient();
  const saved: Array<{ guildId: string; channelId: string; rule: string }> = [];
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    {
      async get() {
        return undefined;
      },
      async set(guildId, channelId, rule) {
        saved.push({ guildId, channelId, rule });
      },
    },
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );
  const replies: Array<string | undefined> = [];
  const interaction = createModalSubmitInteraction({
    id: "interaction-c",
    customId: "channel-rule-edit:1234567890",
    channelId: "channel-b",
    getTextInputValue: (customId) => {
      assert.equal(customId, "channel-rule:1234567890");
      return "  新しいルール  ";
    },
    reply: async (response) => {
      replies.push(extractFirstTextContent(response));
    },
  });

  try {
    await service.start(async () => undefined);
    fakeClient.emit(Events.InteractionCreate, interaction);
    await service.flush();

    assert.deepEqual(saved, [
      { guildId: "guild-123", channelId: "channel-b", rule: "  新しいルール  " },
    ]);
    assert.deepEqual(replies, ["このチャンネル／スレッドのルールを保存しました。"]);
  } finally {
    await service.stop();
  }
});

test("asks the owner when mentioned in a channel that is not allowed and shows a pending notice", async () => {
  const fakeClient = new FakeDiscordClient();
  fakeClient.user = createBotUser();
  const pendingMessages: unknown[] = [];
  const ownerMessages: unknown[] = [];
  fakeClient.channels.fetch = async () => ({
    isTextBased: () => false,
    send: async (payload: unknown) => {
      pendingMessages.push(payload);
      return { id: "pending-message" };
    },
    messages: {
      fetch: async () => Object.assign(createMessage(), { edit: async () => undefined }),
    },
  });
  fakeClient.users.fetch = async () => ({
    ...createProfileUser(),
    send: async (payload: unknown) => {
      ownerMessages.push(payload);
      return { id: "owner-message" };
    },
  });
  fakeClient.guilds.cache.set("guild-123", { name: "テストサーバー" });

  const accessRuleStore = {
    async load() {},
    async setAccess() {},
    getGuildRule: () => undefined,
  };
  const accessRequestStore = {
    async load() {},
    list: () => [],
    async save() {},
    async remove() {},
  };
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "deny", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    accessRuleStore,
    "owner-123",
    accessRequestStore,
    { createClient: () => fakeClient },
  );

  const received: DiscordMessage[] = [];

  try {
    await service.start(async (message) => {
      received.push(message);
    });
    fakeClient.emit(
      Events.MessageCreate,
      createMessage({ content: "<@bot-123> こんにちは", mentionedUserIds: ["bot-123"] }),
    );
    await service.flush();

    assert.equal(received.length, 0);
    assert.equal(pendingMessages.length, 1);
    assert.equal(ownerMessages.length, 1);
  } finally {
    await service.stop();
  }
});

test("does not ask the owner when a denied channel message does not mention the bot", async () => {
  const fakeClient = new FakeDiscordClient();
  fakeClient.user = createBotUser();
  const pendingMessages: unknown[] = [];
  fakeClient.channels.fetch = async () => ({
    isTextBased: () => false,
    send: async (payload: unknown) => {
      pendingMessages.push(payload);
      return { id: "pending-message" };
    },
  });

  const accessRuleStore = {
    async load() {},
    async setAccess() {},
    getGuildRule: () => undefined,
  };
  const accessRequestStore = {
    async load() {},
    list: () => [],
    async save() {},
    async remove() {},
  };
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "deny", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    accessRuleStore,
    "owner-123",
    accessRequestStore,
    { createClient: () => fakeClient },
  );

  try {
    await service.start(async () => undefined);
    fakeClient.emit(Events.MessageCreate, createMessage({ content: "こんにちは" }));
    await service.flush();

    assert.equal(pendingMessages.length, 0);
  } finally {
    await service.stop();
  }
});

test("returns sent message IDs from sendMessage", async () => {
  const fakeClient = new FakeDiscordClient();
  let counter = 0;
  fakeClient.channels.fetch = async () => ({
    isTextBased: () => true,
    send: async () => ({ id: `sent-${++counter}` }),
  });
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  try {
    const ids = await service.sendMessage("channel-123", `${"a".repeat(2_000)}b`);
    assert.deepEqual(ids, ["sent-1", "sent-2"]);
  } finally {
    await service.stop();
  }
});

test("forwards reactions on bot messages after resolving partials and filters unauthorized reactions", async () => {
  const fakeClient = new FakeDiscordClient();
  fakeClient.user = createBotUser();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy(
      {
        default: "deny",
        directMessages: "allow",
      },
      "owner-1",
      {
        getGuildRule: (guildId) =>
          guildId === "guild-123"
            ? {
                access: "allow",
                channels: { "channel-denied": { access: "deny" } },
              }
            : undefined,
      },
    ),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  const received: DiscordReactionEvent[] = [];

  try {
    await service.start(
      async () => undefined,
      async (reaction) => {
        received.push(reaction);
      },
    );

    fakeClient.emit(
      Events.MessageReactionAdd,
      {
        partial: true,
        async fetch() {
          return {
            partial: false,
            emoji: { name: "👎", identifier: "👎" },
            message: {
              partial: true,
              async fetch() {
                return {
                  partial: false,
                  id: "bot-msg-1",
                  channelId: "channel-allowed",
                  guildId: "guild-123",
                  content: "間違った返信",
                  author: { id: "bot-123" },
                  channel: { isThread: () => false, name: "general" },
                };
              },
            },
          };
        },
      },
      {
        partial: true,
        async fetch() {
          return { id: "user-1", bot: false };
        },
      },
    );

    fakeClient.emit(
      Events.MessageReactionAdd,
      {
        partial: false,
        emoji: { name: "👎", identifier: "👎" },
        message: {
          partial: false,
          id: "human-msg-1",
          channelId: "channel-allowed",
          guildId: "guild-123",
          content: null,
          author: { id: "user-2" },
          channel: { isThread: () => false },
        },
      },
      { partial: false, id: "user-1", bot: false },
    );

    fakeClient.emit(
      Events.MessageReactionAdd,
      {
        partial: false,
        emoji: { name: "👎", identifier: "👎" },
        message: {
          partial: false,
          id: "bot-msg-2",
          channelId: "channel-denied",
          guildId: "guild-123",
          content: null,
          author: { id: "bot-123" },
          channel: { isThread: () => false },
        },
      },
      { partial: false, id: "user-1", bot: false },
    );

    fakeClient.emit(
      Events.MessageReactionAdd,
      {
        partial: false,
        emoji: { name: "👎", identifier: "👎" },
        message: {
          partial: false,
          id: "bot-msg-3",
          channelId: "channel-allowed",
          guildId: "guild-123",
          content: null,
          author: { id: "bot-123" },
          channel: { isThread: () => false },
        },
      },
      { partial: false, id: "other-bot", bot: true },
    );

    await service.flush();

    assert.equal(received.length, 1);
    assert.deepEqual(
      {
        emoji: received[0]?.emoji,
        messageId: received[0]?.messageId,
        channelId: received[0]?.channelId,
        guildId: received[0]?.guildId,
        channelName: received[0]?.channelName,
        messageContent: received[0]?.messageContent,
        userId: received[0]?.userId,
      },
      {
        emoji: "👎",
        messageId: "bot-msg-1",
        channelId: "channel-allowed",
        guildId: "guild-123",
        channelName: "general",
        messageContent: "間違った返信",
        userId: "user-1",
      },
    );
  } finally {
    await service.stop();
  }
});

test("enables reaction intents, partials, and MessageReactionAdd listener only when opted in", async () => {
  const defaultClient = new FakeDiscordClient();
  const optInClient = new FakeDiscordClient();
  let defaultOptions: ClientOptions | undefined;
  let optInOptions: ClientOptions | undefined;

  const defaultService = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      createClient: (options) => {
        defaultOptions = options;
        return defaultClient;
      },
    },
  );
  const optInService = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      enableReactions: true,
      createClient: (options) => {
        optInOptions = options;
        return optInClient;
      },
    },
  );

  try {
    assert.ok(defaultOptions);
    assert.ok(optInOptions);
    const defaultIntents = new IntentsBitField(defaultOptions.intents);
    const optInIntents = new IntentsBitField(optInOptions.intents);

    assert.equal(defaultIntents.has(GatewayIntentBits.GuildMessageReactions), false);
    assert.equal(defaultIntents.has(GatewayIntentBits.DirectMessageReactions), false);
    assert.equal(defaultOptions.partials?.includes(Partials.Reaction), false);
    assert.equal(defaultOptions.partials?.includes(Partials.Message), false);
    assert.equal(defaultOptions.partials?.includes(Partials.User), false);

    assert.equal(optInIntents.has(GatewayIntentBits.GuildMessageReactions), true);
    assert.equal(optInIntents.has(GatewayIntentBits.DirectMessageReactions), true);
    assert.equal(optInOptions.partials?.includes(Partials.Reaction), true);
    assert.equal(optInOptions.partials?.includes(Partials.Message), true);
    assert.equal(optInOptions.partials?.includes(Partials.User), true);

    await defaultService.start(async () => undefined);
    assert.equal(defaultClient.listenerCount(Events.MessageReactionAdd), 0);

    await optInService.start(
      async () => undefined,
      async () => undefined,
    );
    assert.equal(optInClient.listenerCount(Events.MessageReactionAdd), 1);
  } finally {
    await defaultService.stop();
    await optInService.stop();
  }
});

test("reads a user profile with the current server's member fields", async () => {
  const userId = "123456789012345678";
  const guildId = "987654321098765432";
  const fakeClient = new FakeDiscordClient();
  let userFetchOptions: unknown;

  fakeClient.users.fetch = async (id: string, options?: { readonly force?: boolean }) => {
    userFetchOptions = options;
    return createProfileUser({
      id,
      username: "alice",
      globalName: "Alice Global",
      displayName: "Alice",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      avatarURL: () => "https://cdn.discordapp.com/avatars/123/avatar.png",
      bannerURL: () => "https://cdn.discordapp.com/banners/123/banner.png",
      hexAccentColor: "#abcdef",
      flags: { toArray: () => ["Staff"] },
    });
  };
  fakeClient.guilds.fetch = async (id) => ({
    id,
    name: "テストサーバー",
    members: {
      async fetch(memberId) {
        assert.equal(memberId, userId);
        return {
          nickname: "A",
          displayName: "A",
          joinedAt: new Date("2021-02-03T04:05:06.000Z"),
          premiumSince: new Date("2022-03-04T05:06:07.000Z"),
          roles: {
            cache: new Map([
              [guildId, { id: guildId, name: "@everyone", position: 0 }],
              ["role-admin", { id: "role-admin", name: "Admin", position: 10 }],
            ]),
          },
        };
      },
    },
  });
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  const profile = await service.readUserProfile(userId, guildId);

  assert.deepEqual(userFetchOptions, { force: true });
  assert.deepEqual(profile, {
    id: userId,
    username: "alice",
    displayName: "A",
    globalName: "Alice Global",
    bot: false,
    accountCreatedAt: "2020-01-01T00:00:00.000Z",
    avatarUrl: "https://cdn.discordapp.com/avatars/123/avatar.png",
    bannerUrl: "https://cdn.discordapp.com/banners/123/banner.png",
    accentColor: "#abcdef",
    flags: ["Staff"],
    guild: {
      id: guildId,
      name: "テストサーバー",
      nickname: "A",
      joinedAt: "2021-02-03T04:05:06.000Z",
      boostingSince: "2022-03-04T05:06:07.000Z",
      roles: [{ id: "role-admin", name: "Admin" }],
    },
  });
});

test("requestSecret はリンク済みユーザーにDMを送り、そのメッセージを記録する", async () => {
  const fakeClient = new FakeDiscordClient();
  const sent: unknown[] = [];
  fakeClient.users.fetch = async (id) => ({
    ...createProfileUser({ id }),
    send: async (payload: unknown) => {
      sent.push(payload);
      return { id: "dm-message-1", channelId: "dm-channel-1" };
    },
  });
  const attached: { requestId: string; dmChannelId: string; dmMessageId: string }[] = [];
  const secrets = createSecretControl({
    async request() {
      return { kind: "requested", request: createSecretRequest() };
    },
    async attachMessage(requestId, dmChannelId, dmMessageId) {
      attached.push({ requestId, dmChannelId, dmMessageId });
    },
  });
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient, secrets },
  );

  const outcome = await service.requestSecret(createSecretRequestDraft());

  assert.equal(outcome.kind, "requested");
  assert.equal(sent.length, 1);
  assert.deepEqual(attached, [
    { requestId: "request-1", dmChannelId: "dm-channel-1", dmMessageId: "dm-message-1" },
  ]);
});

test("requestSecret はシークレット機能が無い場合に unavailable を返す", async () => {
  const fakeClient = new FakeDiscordClient();
  const service = new DiscordJsService(
    "token",
    createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { createClient: () => fakeClient },
  );

  assert.deepEqual(await service.requestSecret(createSecretRequestDraft()), {
    kind: "unavailable",
  });
});
