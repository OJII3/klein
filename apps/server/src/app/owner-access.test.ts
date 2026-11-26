import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import type { AgentCreationOptions, AgentFactory } from "@agents/core/agent-factory";
import type { AgentTurn } from "@agents/core/agent-turn";
import { DiscordAgent } from "@agents/discord/discord-agent";

import { createDiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { isOwnerAccessScope, parseAccessScope } from "@shared/access";
import { AgentCoordinator } from "./agent-coordinator";
import { ChannelSessionStateStore, getChannelRotationBucket } from "./channel-session-state-store";
import { TaskCoordinator } from "./task-coordinator";
import { MemoryInbox } from "../testing/memory-inbox";
import { createTempDir } from "../testing/temp-dir";

const ownerId = "123";
const message: DiscordMessage = {
  id: "message",
  guildId: "guild",
  channelId: "channel",
  content: "private request",
  occurredAt: "2026-10-14T09:30:42.123Z",
  images: [],
  author: { id: ownerId, bot: false, username: "owner", displayName: "owner" },
};

function createHarness(
  store: ChannelSessionStateStore,
  ownerLinked: boolean | (() => boolean) = false,
  linkedUserId?: string,
) {
  const isOwnerLinked = typeof ownerLinked === "function" ? ownerLinked : () => ownerLinked;
  const creations: AgentCreationOptions[] = [];
  const prompts: AgentTurn[] = [];
  const remembered: DiscordMessage[] = [];
  let disposed = 0;
  const factory: AgentFactory = {
    async create(_definition, _tools, creationOptions) {
      creations.push(creationOptions);
      return {
        async prompt(turn) {
          prompts.push(turn);
          return undefined;
        },
        async compactForHandoff() {
          return "private conversation summary";
        },
        dispose() {
          disposed += 1;
        },
      };
    },
  };
  const service: DiscordChannelApi = {
    async getChannelLocation(channelId) {
      return { guildId: "guild", channelId };
    },
    async sendTyping() {},
    async sendMessage() {},
    async sendChoices() {
      throw new Error("Unexpected choice send");
    },
    async sendAudio() {},
    async sendImage() {
      return [];
    },
    async readMessage() {
      return message;
    },
    async readMessages() {
      throw new Error("Unexpected message list read");
    },
  };
  const coordinator = new AgentCoordinator({
    accessPolicy: createDiscordAccessPolicy(
      {
        default: "deny",
        directMessages: "deny",
      },
      ownerId,
      {
        getGuildRule: (guildId) =>
          guildId === "guild" ? { channels: { channel: { access: "allow" as const } } } : undefined,
      },
      (target) =>
        target.guildId === "guild" && target.channelId === "channel"
          ? isOwnerLinked()
            ? ownerId
            : linkedUserId
          : undefined,
    ),
    workers: {
      async start() {
        return "worker-test";
      },
      async send() {
        return false;
      },
      async close() {
        return false;
      },
      list() {
        return [];
      },
    },
    ownerUserId: ownerId,
    channelSessionStateStore: store,
    createDiscordAgent: (channelId, sessionKey, handoffContext, accessScope) =>
      DiscordAgent.create(factory, channelId, "system prompt", {
        accessScope: parseAccessScope(accessScope),
        sessionKey,
        handoffContext,
        ownerFeaturesAllowed: isOwnerAccessScope(accessScope, ownerId),
        ownerUserId: ownerId,
        tools: () => [],
      }),
    channelApi: service,
    sharedMemoryCoordinator: {
      async getContext() {
        return "shared memory";
      },
      enqueue(input: DiscordMessage) {
        remembered.push(input);
      },
    },
    logger: pino({ level: "silent" }),
    operatingState: new DiscordOperatingState(),
    inbox: new MemoryInbox(),
    taskCoordinator: new TaskCoordinator(),
    watchCheckRunner: {
      async run() {
        throw new Error("Unexpected watch check");
      },
    },
  });
  return {
    coordinator,
    creations,
    prompts,
    remembered,
    disposed: () => disposed,
  };
}

test("only owner messages create private sessions and never enter shared memory", async () => {
  await using temp = await createTempDir("klein-owner-");
  const directory = temp.path;
  const store = new ChannelSessionStateStore(directory);
  const harness = createHarness(store, true);
  try {
    await harness.coordinator.handleDiscordMessage({
      ...message,
      id: "message-other",
      author: { ...message.author, id: "other" },
    });
    await harness.coordinator.handleDiscordMessage({
      ...message,
      id: "message-bot",
      author: { ...message.author, bot: true },
    });
    assert.equal(harness.creations.length, 0);
    assert.equal(harness.remembered.length, 0);
    await harness.coordinator.handleDiscordMessage(message);
    assert.equal(harness.creations[0].sessionKey, "discord-channel:channel:owner:123");
    assert.equal(harness.creations[0].ownerFeaturesAllowed, true);
    assert.equal(harness.remembered.length, 0);
  } finally {
    await harness.coordinator.dispose();
  }
});

test("a linked non-owner user gets a private session without owner features", async () => {
  await using temp = await createTempDir("klein-owner-");
  const directory = temp.path;
  const store = new ChannelSessionStateStore(directory);
  const harness = createHarness(store, false, "linked-user");
  try {
    await harness.coordinator.handleDiscordMessage({
      ...message,
      id: "message-linked",
      author: { ...message.author, id: "linked-user" },
    });
    assert.equal(harness.creations[0].sessionKey, "discord-channel:channel:user:linked-user");
    assert.equal(harness.creations[0].ownerFeaturesAllowed, false);

    await harness.coordinator.handleDiscordMessage({
      ...message,
      id: "message-bystander",
      author: { ...message.author, id: "bystander" },
    });
    assert.equal(harness.creations.at(-1)?.sessionKey, "discord-channel:channel:public");
    assert.equal(harness.creations.at(-1)?.ownerFeaturesAllowed, false);
  } finally {
    await harness.coordinator.dispose();
  }
});

test("changing owner access to allow drops private history and handoff on restart", async () => {
  await using temp = await createTempDir("klein-owner-");
  const directory = temp.path;
  const store = new ChannelSessionStateStore(directory);
  const privateHarness = createHarness(store, true);
  const publicHarness = createHarness(store, false);
  try {
    await privateHarness.coordinator.handleDiscordMessage(message);
    await privateHarness.coordinator.dispose();
    const state = await store.getOrCreate(
      { kind: "discord", channelId: "channel" },
      getChannelRotationBucket(Date.now()),
    );
    await store.save({ ...state, handoffContext: "secret Obsidian note" });
    await publicHarness.coordinator.handleDiscordMessage({
      ...message,
      id: "message-other",
      author: { ...message.author, id: "other" },
    });
    assert.equal(publicHarness.creations[0].sessionKey, "discord-channel:channel:public");
    assert.equal(publicHarness.creations[0].ownerFeaturesAllowed, false);
    assert.equal(publicHarness.creations[0].initialContext, undefined);
    assert.doesNotMatch(JSON.stringify(publicHarness.prompts[0]?.event.content), /secret Obsidian/);
    assert.equal(publicHarness.remembered.length, 1);
  } finally {
    await publicHarness.coordinator.dispose();
  }
});

test("owner access changes replace cached agents and preserve private session scope on rotation", async () => {
  await using temp = await createTempDir("klein-owner-");
  const directory = temp.path;
  const store = new ChannelSessionStateStore(directory);
  const rule = { ownerLinked: true };
  const harness = createHarness(store, () => rule.ownerLinked);
  await harness.coordinator.handleDiscordMessage(message);
  const oldState = await store.getOrCreate(
    { kind: "discord", channelId: "channel" },
    getChannelRotationBucket(Date.now()),
  );
  await store.save({
    ...oldState,
    lastActivityAt: Date.now() - 2 * 60 * 60 * 1000,
    lastRotationDate: "2000-01-01",
  });
  await harness.coordinator.dispose();
  const resumed = createHarness(store, () => rule.ownerLinked);
  try {
    await resumed.coordinator.rotateIdleChannels();
    const rotated = await store.getOrCreate(
      { kind: "discord", channelId: "channel" },
      getChannelRotationBucket(Date.now()),
    );
    assert.match(rotated.sessionKey, /^discord-channel:channel:owner:123:rotation:/);
    assert.equal(resumed.creations[0].ownerFeaturesAllowed, true);
    await resumed.coordinator.handleDiscordMessage(message);
    const disposedBeforeSwitch = resumed.disposed();
    rule.ownerLinked = false;
    await resumed.coordinator.handleDiscordMessage({ ...message, id: "message-after-switch" });
    assert.equal(resumed.disposed(), disposedBeforeSwitch + 1);
    assert.equal(resumed.creations.at(-1)?.sessionKey, "discord-channel:channel:public");
    assert.equal(resumed.creations.at(-1)?.initialContext, undefined);
    assert.equal(resumed.creations.at(-1)?.ownerFeaturesAllowed, false);
  } finally {
    await resumed.coordinator.dispose();
  }
});
