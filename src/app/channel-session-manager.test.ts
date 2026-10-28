import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import type { ChannelAgent } from "@agents/core/channel-agent";
import type { DiscordService } from "@modules/discord/ports/discord-service";
import {
  getChannelRotationDate,
  type ChannelSessionState,
  type ChannelSessionStateStore,
  type ConversationKey,
} from "./channel-session-state-store";
import { ChannelSessionManager } from "./channel-session-manager";

function createHarness(initialState: ChannelSessionState) {
  const events: string[] = [];
  const savedStates: ChannelSessionState[] = [];
  let storedState = initialState;
  let turnCompleted = false;
  let agentCount = 0;
  const stateStore: ChannelSessionStateStore = {
    async getOrCreate() {
      events.push("resolve");
      return storedState;
    },
    async list() {
      return [storedState];
    },
    async save(state) {
      savedStates.push(state);
      storedState = state;
      events.push(
        state.handoffContext
          ? "save:rotation"
          : turnCompleted
            ? "save:finally"
            : "save:before-turn",
      );
    },
  };
  const discordService: DiscordService = {
    async start() {},
    stopAccepting() {},
    setActivity() {},
    async sendTyping() {},
    async sendMessage() {},
    async sendAudio() {},
    async readMessage() {
      throw new Error("Unexpected message read");
    },
    async getChannelLocation(channelId) {
      return { guildId: "guild", channelId };
    },
    async stop() {},
  };
  const manager = new ChannelSessionManager({
    channelSessionStateStore: stateStore,
    createAgent: async (_conversationKey, sessionKey, handoffContext) => {
      const label = agentCount++ === 0 ? "old" : "new";
      events.push(`create:${label}`);
      assert.equal(handoffContext, label === "new" ? "handoff summary" : undefined);
      const agent: ChannelAgent = {
        async prompt() {},
        async promptEvent() {},
        async steer() {},
        compactForHandoff() {
          events.push(`compact:${label}`);
          return label === "old" ? Promise.resolve("handoff summary") : undefined;
        },
        dispose() {
          events.push(`dispose:${label}`);
        },
      };
      assert.ok(sessionKey);
      return agent;
    },
    discordService,
    logger: pino({ level: "silent" }),
  });

  return {
    events,
    manager,
    savedStates,
    completeTurn() {
      turnCompleted = true;
    },
  };
}

function createState(overrides: Partial<ChannelSessionState> = {}): ChannelSessionState {
  return {
    conversationKey: { kind: "discord", channelId: "channel-a" },
    accessScope: "public",
    sessionKey: "discord-channel:channel-a",
    lastActivityAt: null,
    lastRotationDate: getChannelRotationDate(Date.now()),
    hasActivitySinceRotation: false,
    ...overrides,
  };
}

test("runTurn rotates, clears handoff, and saves state around the turn in order", async () => {
  const conversationKey: ConversationKey = { kind: "discord", channelId: "channel-a" };
  const harness = createHarness(
    createState({
      lastActivityAt: Date.now() - 2 * 60 * 60 * 1_000,
      lastRotationDate: "2000-01-01",
      hasActivitySinceRotation: true,
    }),
  );
  const expectedSessionKey = `discord-channel:channel-a:rotation:${getChannelRotationDate(Date.now())}`;

  try {
    await harness.manager.runTurn(conversationKey, "public", async (_agent, state) => {
      harness.events.push("turn");
      assert.equal(state.sessionKey, expectedSessionKey);
      assert.equal(state.handoffContext, undefined);
      assert.equal(state.hasActivitySinceRotation, true);
      assert.notEqual(state.lastActivityAt, null);
      harness.completeTurn();
    });

    assert.deepEqual(harness.events, [
      "resolve",
      "create:old",
      "compact:old",
      "save:rotation",
      "dispose:old",
      "create:new",
      "save:before-turn",
      "turn",
      "save:finally",
    ]);
    assert.equal(harness.savedStates[0]?.handoffContext, "handoff summary");
    assert.equal(harness.savedStates[1]?.handoffContext, undefined);
    assert.equal(harness.savedStates[2]?.sessionKey, expectedSessionKey);
  } finally {
    await harness.manager.dispose();
  }
});

test("runTurn saves state after a failed turn", async () => {
  const harness = createHarness(createState());
  const failure = new Error("Turn failed");

  try {
    await assert.rejects(
      harness.manager.runTurn({ kind: "discord", channelId: "channel-a" }, "public", async () => {
        harness.events.push("turn");
        harness.completeTurn();
        throw failure;
      }),
      failure,
    );

    assert.deepEqual(harness.events, [
      "resolve",
      "create:old",
      "save:before-turn",
      "turn",
      "save:finally",
    ]);
    assert.equal(harness.savedStates.length, 2);
    assert.equal(harness.savedStates[1]?.hasActivitySinceRotation, true);
    assert.ok(harness.savedStates[1]?.lastActivityAt);
  } finally {
    await harness.manager.dispose();
  }
});
