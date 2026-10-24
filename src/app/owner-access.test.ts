import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PiDurableSessionStore } from "@runtime/pi/pi-durable-session-store";

import type { AgentCreationOptions, AgentFactory } from "@agents/core/agent-factory";
import type { AgentEvent } from "@agents/core/agent-event";
import { DiscordAgent } from "@agents/discord/discord-agent";
import {
  createDiscordAccessPolicy,
  type DiscordAccess,
} from "@modules/discord/domain/discord-access-policy";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import type { MemoryCoordinator } from "@modules/memory/application/memory-coordinator";
import { AgentCoordinator } from "./agent-coordinator";
import {
  type ChannelSessionStateStore,
  getChannelRotationDate,
} from "./channel-session-state-store";
import { TaskCoordinator } from "./task-coordinator";

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

function createHarness(store: ChannelSessionStateStore, channelRule: { access: DiscordAccess }) {
  const creations: AgentCreationOptions[] = [];
  const prompts: AgentEvent[] = [];
  const remembered: DiscordMessage[] = [];
  let disposed = 0;
  const factory: AgentFactory = {
    async create(_definition, _tools, options) {
      creations.push(options);
      return {
        async prompt(prompt) {
          prompts.push(prompt);
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
  const service = {
    async sendMessage() {},
    async readMessage() {
      return message;
    },
  } as unknown as DiscordService;
  const coordinator = new AgentCoordinator({
    accessPolicy: createDiscordAccessPolicy(
      {
        default: "deny",
        directMessages: "deny",
        guilds: { guild: { channels: { channel: channelRule } } },
      },
      ownerId,
    ),
    ownerUserId: ownerId,
    channelSessionStateStore: store,
    createDiscordAgent: (channelId, sessionKey, handoffContext, ownerFeaturesAllowed) =>
      DiscordAgent.create(factory, service, channelId, "system prompt", {
        sessionKey,
        handoffContext,
        ownerFeaturesAllowed,
        ownerUserId: ownerId,
      }),
    discordService: service,
    memoryCoordinator: {
      async getContext() {
        return "shared memory";
      },
      enqueue(input: DiscordMessage) {
        remembered.push(input);
      },
    } as unknown as MemoryCoordinator,
    logger: pino({ level: "silent" }),
    operatingState: new DiscordOperatingState(),
    taskCoordinator: new TaskCoordinator(),
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
  const directory = await mkdtemp(join(tmpdir(), "klein-owner-"));
  const storage = await openNodeSqliteStorage(join(directory, "sessions.sqlite"));
  const session = createSession(storage);
  const store = new PiDurableSessionStore(session, storage).channelStates;
  const harness = createHarness(store, { access: "owner" });
  try {
    await harness.coordinator.handleDiscordMessage({
      ...message,
      author: { ...message.author, id: "other" },
    });
    await harness.coordinator.handleDiscordMessage({
      ...message,
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
    await session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("changing owner access to allow drops private history and handoff on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-owner-"));
  const storage = await openNodeSqliteStorage(join(directory, "sessions.sqlite"));
  const session = createSession(storage);
  const store = new PiDurableSessionStore(session, storage).channelStates;
  const privateHarness = createHarness(store, { access: "owner" });
  const publicHarness = createHarness(store, { access: "allow" });
  try {
    await privateHarness.coordinator.handleDiscordMessage(message);
    await privateHarness.coordinator.dispose();
    const state = await store.getOrCreate("channel", getChannelRotationDate(Date.now()));
    await store.save({ ...state, handoffContext: "secret Obsidian note" });
    await publicHarness.coordinator.handleDiscordMessage({
      ...message,
      author: { ...message.author, id: "other" },
    });
    assert.equal(publicHarness.creations[0].sessionKey, "discord-channel:channel:public");
    assert.equal(publicHarness.creations[0].ownerFeaturesAllowed, false);
    assert.equal(publicHarness.creations[0].initialContext, undefined);
    assert.doesNotMatch(JSON.stringify(publicHarness.prompts[0].content), /secret Obsidian/);
    assert.equal(publicHarness.remembered.length, 1);
  } finally {
    await publicHarness.coordinator.dispose();
    await session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner access changes replace cached agents and preserve private session scope on rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-owner-"));
  const storage = await openNodeSqliteStorage(join(directory, "sessions.sqlite"));
  const session = createSession(storage);
  const store = new PiDurableSessionStore(session, storage).channelStates;
  const rule: { access: DiscordAccess } = { access: "owner" };
  const harness = createHarness(store, rule);
  try {
    await harness.coordinator.handleDiscordMessage(message);
    const oldState = await store.getOrCreate("channel", getChannelRotationDate(Date.now()));
    await store.save({
      ...oldState,
      lastActivityAt: Date.now() - 2 * 60 * 60 * 1000,
      lastRotationDate: "2000-01-01",
    });
    // Restart removes the recent inbound timestamp while preserving the persisted private scope.
    await harness.coordinator.dispose();
    const resumed = createHarness(store, rule);
    try {
      await resumed.coordinator.rotateIdleChannels();
      const rotated = await store.getOrCreate("channel", getChannelRotationDate(Date.now()));
      assert.match(rotated.sessionKey, /^discord-channel:channel:owner:123:rotation:/);
      assert.equal(resumed.creations[0].ownerFeaturesAllowed, true);
      await resumed.coordinator.handleDiscordMessage(message);
      const disposedBeforeSwitch = resumed.disposed();
      rule.access = "allow";
      await resumed.coordinator.handleDiscordMessage(message);
      assert.equal(resumed.disposed(), disposedBeforeSwitch + 1);
      assert.equal(resumed.creations.at(-1)?.sessionKey, "discord-channel:channel:public");
      assert.equal(resumed.creations.at(-1)?.initialContext, undefined);
      assert.equal(resumed.creations.at(-1)?.ownerFeaturesAllowed, false);
    } finally {
      await resumed.coordinator.dispose();
    }
  } finally {
    await session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});
