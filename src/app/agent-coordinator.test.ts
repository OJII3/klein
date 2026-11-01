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

import { DiscordAgent } from "@agents/discord/discord-agent";
import type { AgentFactory } from "@agents/core/agent-factory";
import type { AgentRuntime } from "@agents/core/agent-runtime";
import type { AgentEvent } from "@agents/core/agent-event";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import {
  createDiscordAccessPolicy,
  type DiscordAccess,
} from "@modules/discord/domain/discord-access-policy";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type {
  ReminderTask,
  ScheduledTask,
  WatchTask,
} from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/application/watch-check-runner";
import { TaskCoordinator } from "./task-coordinator";
import { AgentCoordinator, type AgentCoordinatorDependencies } from "./agent-coordinator";
import { getChannelRotationDate } from "./channel-session-state-store";

interface TestHarness {
  readonly agentCoordinator: AgentCoordinator;
  readonly createdSessionKeys: string[];
  readonly prompts: Map<string, AgentEvent[]>;
  readonly ownerFeaturesAllowed: boolean[];
}

function createHarness(
  createGate?: Promise<void>,
  scheduledTaskStore?: ScheduledTaskStore,
  options: Pick<
    AgentCoordinatorDependencies,
    "channelSessionStateStore" | "accessPolicy" | "ownerUserId"
  > = {},
  watchCheckRunner: WatchCheckRunner = {
    async run() {
      throw new Error("Unexpected watch check");
    },
  },
): TestHarness {
  const createdSessionKeys: string[] = [];
  const prompts = new Map<string, AgentEvent[]>();
  const ownerFeaturesAllowed: boolean[] = [];
  const agentFactory: AgentFactory = {
    async create(_definition, _tools, options): Promise<AgentRuntime> {
      createdSessionKeys.push(options.sessionKey);
      ownerFeaturesAllowed.push(options.ownerFeaturesAllowed ?? false);
      if (createGate) await createGate;

      const channelId = options.sessionKey.slice("discord-channel:".length);
      const channelPrompts: AgentEvent[] = [];
      prompts.set(channelId, channelPrompts);

      return {
        async prompt(prompt) {
          channelPrompts.push(prompt);
        },
        async compactForHandoff() {
          return "previous conversation summary";
        },
        dispose() {},
      };
    },
  };
  const message = createMessage("test-channel", "test-message", "テスト");
  const channelApi: DiscordChannelApi = {
    async sendTyping() {},
    async sendMessage() {},
    async sendAudio() {},
    async readMessage() {
      return message;
    },
    async getChannelLocation(channelId) {
      return { guildId: "guild-123", channelId };
    },
  };

  return {
    agentCoordinator: new AgentCoordinator({
      ...options,
      createDiscordAgent: (channelId, sessionKey, handoffContext, ownerFeaturesAllowed) =>
        DiscordAgent.create(agentFactory, channelId, "system prompt", {
          sessionKey,
          handoffContext,
          ownerFeaturesAllowed,
          ownerUserId: options.ownerUserId,
          tools: () => [],
        }),
      channelApi,
      logger: pino({ level: "silent" }),
      operatingState: new DiscordOperatingState(),
      scheduledTaskStore,
      watchCheckRunner,
      taskCoordinator: new TaskCoordinator(),
    }),
    createdSessionKeys,
    prompts,
    ownerFeaturesAllowed,
  };
}

function createMessage(
  channelId: string,
  id: string,
  content: string,
  options: Pick<DiscordMessage, "guildId" | "parentChannelId" | "threadId"> = {},
): DiscordMessage {
  return {
    author: {
      bot: false,
      id: "user-123",
      username: "user",
      displayName: "ユーザー",
    },
    channelId,
    content,
    id,
    occurredAt: "2026-10-14T09:30:42.123Z",
    images: [],
    ...options,
  };
}

test("reuses one Pi session for messages in the same Discord channel", async () => {
  const harness = createHarness();

  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-a", "最初のメッセージ"),
    );
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-b", "次のメッセージ"),
    );

    assert.deepEqual(harness.createdSessionKeys, ["discord-channel:channel-a"]);
    assert.deepEqual(
      harness.prompts.get("channel-a")?.map((prompt) =>
        prompt.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n\n"),
      ),
      ["ユーザー (@user):\n最初のメッセージ", "ユーザー (@user):\n次のメッセージ"],
    );
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("initializes every saved channel agent during startup", async () => {
  const states = ["channel-a", "channel-b"].map((channelId) => ({
    conversationKey: { kind: "discord" as const, channelId },
    sessionKey: `discord-channel:${channelId}`,
    lastActivityAt: null,
    lastRotationDate: getChannelRotationDate(Date.now()),
    hasActivitySinceRotation: false,
  }));
  const channelSessionStateStore = {
    async getOrCreate(conversationKey: { kind: "discord"; channelId: string }) {
      return states.find((state) => state.conversationKey.channelId === conversationKey.channelId)!;
    },
    async list() {
      return states;
    },
    async save() {},
  };
  const harness = createHarness(undefined, undefined, { channelSessionStateStore });

  try {
    await harness.agentCoordinator.initialize();

    assert.deepEqual(harness.createdSessionKeys, [
      "discord-channel:channel-a",
      "discord-channel:channel-b",
    ]);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("does not resume saved channel sessions after their access scope changes", async () => {
  const states = ["channel-a", "channel-b"].map((channelId) => ({
    conversationKey: { kind: "discord" as const, channelId },
    accessScope: "public",
    sessionKey: `discord-channel:${channelId}:public`,
    lastActivityAt: null,
    lastRotationDate: getChannelRotationDate(Date.now()),
    hasActivitySinceRotation: false,
  }));
  const channelSessionStateStore = {
    async getOrCreate(conversationKey: { kind: "discord"; channelId: string }) {
      return states.find((state) => state.conversationKey.channelId === conversationKey.channelId)!;
    },
    async list() {
      return states;
    },
    async save() {},
  };
  const harness = createHarness(undefined, undefined, {
    accessPolicy: createDiscordAccessPolicy(
      {
        default: "deny",
        directMessages: "deny",
        guilds: {
          "guild-123": {
            channels: {
              "channel-a": { access: "allow" },
              "channel-b": { access: "owner" },
            },
          },
        },
      },
      "user-123",
    ),
    channelSessionStateStore,
    ownerUserId: "user-123",
  });

  try {
    await harness.agentCoordinator.initialize();

    assert.deepEqual(harness.createdSessionKeys, ["discord-channel:channel-a:public"]);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("isolates Pi sessions between Discord channels", async () => {
  const harness = createHarness();

  try {
    await Promise.all([
      harness.agentCoordinator.handleDiscordMessage(
        createMessage("channel-a", "message-a", "A のメッセージ"),
      ),
      harness.agentCoordinator.handleDiscordMessage(
        createMessage("channel-b", "message-b", "B のメッセージ"),
      ),
    ]);

    assert.deepEqual([...harness.createdSessionKeys].sort(), [
      "discord-channel:channel-a",
      "discord-channel:channel-b",
    ]);
    assert.deepEqual(
      harness.prompts.get("channel-a")?.map((prompt) =>
        prompt.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n\n"),
      ),
      ["ユーザー (@user):\nA のメッセージ"],
    );
    assert.deepEqual(
      harness.prompts.get("channel-b")?.map((prompt) =>
        prompt.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n\n"),
      ),
      ["ユーザー (@user):\nB のメッセージ"],
    );
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("uses a separate Pi session for each Discord thread", async () => {
  const harness = createHarness();

  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("thread-a", "message-a", "スレッド A", {
        guildId: "guild-123",
        parentChannelId: "channel-a",
        threadId: "thread-a",
      }),
    );
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("thread-b", "message-b", "スレッド B", {
        guildId: "guild-123",
        parentChannelId: "channel-a",
        threadId: "thread-b",
      }),
    );

    assert.deepEqual([...harness.createdSessionKeys].sort(), [
      "discord-channel:thread-a",
      "discord-channel:thread-b",
    ]);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("does not create duplicate agents while a channel agent is initializing", async () => {
  let releaseCreation!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreation = resolve;
  });
  const harness = createHarness(createGate);

  try {
    const first = harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-a", "最初のメッセージ"),
    );
    const second = harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-b", "次のメッセージ"),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.createdSessionKeys, ["discord-channel:channel-a"]);

    releaseCreation();
    await Promise.all([first, second]);

    assert.deepEqual(
      harness.prompts.get("channel-a")?.map((prompt) =>
        prompt.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n\n"),
      ),
      ["ユーザー (@user):\n最初のメッセージ", "ユーザー (@user):\n次のメッセージ"],
    );
  } finally {
    releaseCreation();
    await harness.agentCoordinator.dispose();
  }
});

function createScheduledTaskStore(initial: ScheduledTask) {
  let stored: ScheduledTask | undefined = initial;
  const store = {
    async create(task: ScheduledTask) {
      stored = task;
    },
    async listForScope(kind: ScheduledTask["kind"], channelId: string, accessScope: string) {
      return stored &&
        stored.kind === kind &&
        stored.channelId === channelId &&
        stored.accessScope === accessScope
        ? [stored]
        : [];
    },
    async listDue(now: number) {
      return stored && Date.parse(stored.nextRunAt) <= now ? [stored] : [];
    },
    async delete(
      kind: ScheduledTask["kind"],
      channelId: string,
      accessScope: string,
      taskId: string,
    ) {
      if (
        stored?.id !== taskId ||
        stored.kind !== kind ||
        stored.channelId !== channelId ||
        stored.accessScope !== accessScope
      )
        return false;
      stored = undefined;
      return true;
    },
    async update(task: ScheduledTask) {
      stored = task;
    },
  } as unknown as ScheduledTaskStore;
  return { store, getStored: () => stored };
}

const dueReminder: ReminderTask = {
  kind: "reminder",
  id: "reminder-1",
  channelId: "test-channel",
  accessScope: "public",
  message: "定例会が始まります",
  createdAt: "2026-10-14T00:00:00.000Z",
  schedule: { type: "once", at: "2026-10-14T00:01:00.000Z" },
  nextRunAt: "2026-10-14T00:01:00.000Z",
};

const dueWatch: WatchTask = {
  kind: "watch",
  id: "watch-1",
  channelId: "test-channel",
  accessScope: "owner:123",
  name: "在庫監視",
  command: "check-stock",
  args: [],
  condition: "change",
  message: "在庫の変化を確認してください。",
  cooldownMinutes: 0,
  consecutiveFailures: 0,
  createdAt: "2026-10-14T00:00:00.000Z",
  schedule: { type: "every", minutes: 5 },
  nextRunAt: "2026-10-14T00:05:00.000Z",
};

test("delivers reminders to the current rotated session and reuses it for conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-reminder-session-"));
  const storage = await openNodeSqliteStorage(join(directory, "sessions.sqlite"));
  const session = createSession(storage);
  const channelSessionStateStore = new PiDurableSessionStore(session, storage).channelStates;
  const sessionKey = "discord-channel:test-channel:public:rotation:2026-10-14";
  await channelSessionStateStore.save({
    conversationKey: { kind: "discord", channelId: dueReminder.channelId },
    accessScope: "public",
    sessionKey,
    lastActivityAt: null,
    lastRotationDate: "2026-10-14",
    hasActivitySinceRotation: false,
  });
  const reminders = createScheduledTaskStore(dueReminder);
  const harness = createHarness(undefined, reminders.store, {
    channelSessionStateStore,
    accessPolicy: createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
  });

  try {
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    assert.deepEqual(harness.createdSessionKeys, [sessionKey]);
    assert.equal(reminders.getStored(), undefined);
    const events = harness.prompts.get(sessionKey.slice("discord-channel:".length));
    assert.equal(events?.[0].type, "reminder.due");
    assert.equal(events?.[0].source, "reminder");
    assert.match(
      events?.[0].content[0]?.type === "text" ? events[0].content[0].text : "",
      /定例会が始まります/u,
    );
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("test-channel", "reply", "ありがとう"),
    );
    assert.deepEqual(harness.createdSessionKeys, [sessionKey]);
    assert.equal(events?.[1].type, "discord.message");
  } finally {
    await harness.agentCoordinator.dispose();
    await session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotates an idle session before delivering a reminder into the new conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-reminder-rotation-"));
  const storage = await openNodeSqliteStorage(join(directory, "sessions.sqlite"));
  const session = createSession(storage);
  const channelSessionStateStore = new PiDurableSessionStore(session, storage).channelStates;
  const oldKey = "discord-channel:test-channel:public:rotation:2000-01-01";
  const newKey = `discord-channel:test-channel:public:rotation:${getChannelRotationDate(Date.now())}`;
  await channelSessionStateStore.save({
    conversationKey: { kind: "discord", channelId: dueReminder.channelId },
    accessScope: "public",
    sessionKey: oldKey,
    lastActivityAt: Date.now() - 2 * 60 * 60 * 1000,
    lastRotationDate: "2000-01-01",
    hasActivitySinceRotation: true,
  });
  const reminders = createScheduledTaskStore(dueReminder);
  const harness = createHarness(undefined, reminders.store, {
    channelSessionStateStore,
    accessPolicy: createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
  });
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    assert.deepEqual(harness.createdSessionKeys, [oldKey, newKey]);
    assert.deepEqual(harness.prompts.get(oldKey.slice("discord-channel:".length)), []);
    assert.equal(
      harness.prompts.get(newKey.slice("discord-channel:".length))?.[0].type,
      "reminder.due",
    );
    assert.equal(reminders.getStored(), undefined);
    const state = await channelSessionStateStore.getOrCreate(
      { kind: "discord", channelId: dueReminder.channelId },
      getChannelRotationDate(Date.now()),
    );
    assert.equal(state.sessionKey, newKey);
    assert.equal(state.handoffContext, undefined);
  } finally {
    await harness.agentCoordinator.dispose();
    await session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("delivers reminders through an already active channel agent", async () => {
  const reminders = createScheduledTaskStore(dueReminder);
  const harness = createHarness(undefined, reminders.store);
  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("test-channel", "first", "こんにちは"),
    );
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    assert.deepEqual(harness.createdSessionKeys, ["discord-channel:test-channel"]);
    assert.deepEqual(
      harness.prompts.get("test-channel")?.map((event) => event.type),
      ["discord.message", "reminder.due"],
    );
    assert.equal(reminders.getStored(), undefined);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

for (const { scope, access, owner, delivered } of [
  { scope: "public", access: "allow", owner: "123", delivered: true },
  { scope: "public", access: "deny", owner: "123", delivered: false },
  { scope: "public", access: "owner", owner: "123", delivered: false },
  { scope: "owner:123", access: "owner", owner: "123", delivered: true },
  { scope: "owner:123", access: "allow", owner: "123", delivered: false },
  { scope: "owner:123", access: "deny", owner: "123", delivered: false },
  { scope: "owner:123", access: "owner", owner: "456", delivered: false },
  { scope: "owner:123", access: "owner", owner: undefined, delivered: false },
] satisfies Array<{
  scope: ReminderTask["accessScope"];
  access: DiscordAccess;
  owner: string | undefined;
  delivered: boolean;
}>) {
  test(`rechecks reminder scope ${scope} against ${access} with owner ${owner}`, async () => {
    const reminder = { ...dueReminder, accessScope: scope };
    const reminders = createScheduledTaskStore(reminder);
    const harness = createHarness(undefined, reminders.store, {
      ownerUserId: owner,
      accessPolicy: createDiscordAccessPolicy({ default: access, directMessages: "deny" }, owner),
    });
    try {
      await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
      assert.equal(harness.createdSessionKeys.length, delivered ? 1 : 0);
      assert.equal(reminders.getStored() === undefined, delivered);
      if (delivered) {
        assert.equal(harness.createdSessionKeys[0], `discord-channel:test-channel:${scope}`);
        assert.equal(harness.ownerFeaturesAllowed[0], scope.startsWith("owner:"));
      }
    } finally {
      await harness.agentCoordinator.dispose();
    }
  });
}

test("advances a recurring reminder without changing its stable ownership", async () => {
  const reminder: ReminderTask = {
    ...dueReminder,
    schedule: { type: "daily", time: "09:00" },
  };
  const reminders = createScheduledTaskStore(reminder);
  const harness = createHarness(undefined, reminders.store);
  try {
    const before = Date.now();
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    const stored = reminders.getStored();
    assert.ok(stored);
    assert.equal(stored.channelId, reminder.channelId);
    assert.equal(stored.accessScope, reminder.accessScope);
    assert.ok(Date.parse(stored.nextRunAt) > before);
    assert.equal("sessionKey" in stored, false);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("delivers a watch only when its output changes", async () => {
  let output = "one";
  const runner: WatchCheckRunner = {
    async run() {
      return { output, exitCode: 0, durationMs: 1 };
    },
  };
  const watches = createScheduledTaskStore({ ...dueWatch });
  const harness = createHarness(
    undefined,
    watches.store,
    {
      accessPolicy: createDiscordAccessPolicy({ default: "owner", directMessages: "deny" }, "123"),
      ownerUserId: "123",
    },
    runner,
  );
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.now());
    const baseline = watches.getStored();
    assert.ok(baseline?.kind === "watch");
    assert.ok(baseline.lastOutputHash);
    assert.equal(harness.prompts.size, 0);

    output = "two";
    await harness.agentCoordinator.deliverDueTasks(Date.parse(baseline.nextRunAt));
    const first = watches.getStored();
    assert.ok(first?.kind === "watch");
    assert.ok(first.lastTriggeredAt);
    const events = harness.prompts.get("test-channel:owner:123");
    assert.equal(events?.length, 1);
    assert.equal(events?.[0].type, "watch.triggered");
    assert.equal(events?.[0].source, "watch");
    assert.match(eventText(events?.[0]), /two/u);

    await harness.agentCoordinator.deliverDueTasks(Date.parse(first.nextRunAt));
    assert.equal(harness.prompts.get("test-channel:owner:123")?.length, 1);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("suppresses watch events during cooldown and retries after it expires", async () => {
  const lastTriggeredAt = new Date(Date.now() - 30 * 60_000).toISOString();
  const runner: WatchCheckRunner = {
    async run() {
      return { output: "new", exitCode: 0, durationMs: 1 };
    },
  };
  const watches = createScheduledTaskStore({
    ...dueWatch,
    cooldownMinutes: 60,
    lastOutputHash: "old-hash",
    lastTriggeredAt,
  });
  const harness = createHarness(
    undefined,
    watches.store,
    {
      accessPolicy: createDiscordAccessPolicy({ default: "owner", directMessages: "deny" }, "123"),
      ownerUserId: "123",
    },
    runner,
  );
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.now());
    const suppressed = watches.getStored();
    assert.ok(suppressed?.kind === "watch");
    assert.equal(suppressed.lastOutputHash, "old-hash");
    assert.equal(suppressed.lastTriggeredAt, lastTriggeredAt);
    assert.equal(harness.prompts.size, 0);

    await harness.agentCoordinator.deliverDueTasks(Date.now() + 31 * 60_000);
    assert.equal(harness.prompts.get("test-channel:owner:123")?.length, 1);
    const delivered = watches.getStored();
    assert.ok(delivered?.kind === "watch");
    assert.notEqual(delivered.lastOutputHash, "old-hash");
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("records watch check failures without notifying the agent", async () => {
  const runner: WatchCheckRunner = {
    async run() {
      throw new Error("check failed");
    },
  };
  const watches = createScheduledTaskStore({ ...dueWatch });
  const harness = createHarness(
    undefined,
    watches.store,
    {
      accessPolicy: createDiscordAccessPolicy({ default: "owner", directMessages: "deny" }, "123"),
      ownerUserId: "123",
    },
    runner,
  );
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.now());
    const stored = watches.getStored();
    assert.ok(stored?.kind === "watch");
    assert.equal(stored.lastStatus, "error");
    assert.match(stored.lastError ?? "", /check failed/u);
    assert.equal(stored.consecutiveFailures, 1);
    assert.equal(harness.prompts.size, 0);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

function eventText(event: AgentEvent | undefined): string {
  return (
    event?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n") ?? ""
  );
}
