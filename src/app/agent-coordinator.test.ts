import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { DiscordAgent } from "@agents/discord/discord-agent";
import type { AgentFactory } from "@agents/core/agent-factory";
import type { AgentRuntime } from "@agents/core/agent-runtime";
import type { AgentEvent } from "@agents/core/agent-event";
import type { AgentTurn } from "@agents/core/agent-turn";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type {
  AttachedTaskControl,
  AttachedTaskScope,
  AttachedTaskStartInput,
} from "@agents/core/attached-agent";

import {
  createDiscordAccessPolicy,
  type DiscordAccess,
} from "@modules/discord/domain/discord-access-policy";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { UserMemoryCoordinator } from "@modules/user-memory/application/user-memory-coordinator";
import type { UserMemory } from "@modules/user-memory/domain/user-memory";

import type {
  ReminderTask,
  ScheduledTask,
  WatchTask,
} from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/application/watch-check-runner";
import { TaskCoordinator } from "./task-coordinator";
import { AgentCoordinator, type AgentCoordinatorDependencies } from "./agent-coordinator";
import { ChannelSessionStateStore, getChannelRotationBucket } from "./channel-session-state-store";
import { createTempDir } from "../testing/temp-dir";

interface TestHarness {
  readonly agentCoordinator: AgentCoordinator;
  readonly attachedStarts: AttachedTaskStartInput[];
  readonly attachedSends: {
    readonly scope: AttachedTaskScope;
    readonly taskId: string;
    readonly message: string;
  }[];
  readonly channelLocationCalls: string[];
  readonly createdSessionKeys: string[];
  readonly prompts: Map<string, AgentTurn[]>;
  readonly ownerFeaturesAllowed: boolean[];
}

function createHarness(
  createGate?: Promise<void>,
  scheduledTaskStore?: ScheduledTaskStore,
  options: Pick<
    AgentCoordinatorDependencies,
    | "channelSessionStateStore"
    | "accessPolicy"
    | "ownerUserId"
    | "userMemoryCoordinator"
    | "userMemoryStore"
  > = {},
  watchCheckRunner: WatchCheckRunner = {
    async run() {
      throw new Error("Unexpected watch check");
    },
  },
  attachedSendResult = false,
): TestHarness {
  const channelLocationCalls: string[] = [];
  const createdSessionKeys: string[] = [];
  const prompts = new Map<string, AgentTurn[]>();
  const ownerFeaturesAllowed: boolean[] = [];
  const attachedStarts: AttachedTaskStartInput[] = [];
  const attachedSends: { scope: AttachedTaskScope; taskId: string; message: string }[] = [];
  const attachedTasks: AttachedTaskControl = {
    async start(input) {
      attachedStarts.push(input);
      return `attached-${attachedStarts.length}`;
    },
    async send(scope, taskId, message) {
      attachedSends.push({ scope, taskId, message });
      return attachedSendResult;
    },
    async close() {
      return false;
    },
    list() {
      return [];
    },
  };
  const agentFactory: AgentFactory = {
    async create(_definition, _tools, options): Promise<AgentRuntime> {
      createdSessionKeys.push(options.sessionKey);
      ownerFeaturesAllowed.push(options.ownerFeaturesAllowed ?? false);
      if (createGate) await createGate;

      const channelId = options.sessionKey.slice("discord-channel:".length);
      const channelPrompts: AgentTurn[] = [];
      prompts.set(channelId, channelPrompts);

      return {
        async prompt(turn) {
          channelPrompts.push(turn);
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
    async sendChoices() {
      throw new Error("Unexpected choice send");
    },
    async sendAudio() {},
    async readMessage() {
      return message;
    },
    async getChannelLocation(channelId) {
      channelLocationCalls.push(channelId);
      return { guildId: "guild-123", channelId };
    },
  };

  return {
    agentCoordinator: new AgentCoordinator({
      ...options,
      attachedTasks,
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
    attachedStarts,
    attachedSends,
    channelLocationCalls,
    createdSessionKeys,
    prompts,
    ownerFeaturesAllowed,
  };
}

function createMessage(
  channelId: string,
  id: string,
  content: string,
  options: Pick<DiscordMessage, "guildId" | "parentChannelId" | "threadId"> & {
    readonly author?: DiscordMessage["author"];
  } = {},
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
      harness.prompts.get("channel-a")?.map((turn) =>
        turn.event.content
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

test("asks user memory to observe each handled message", async () => {
  const observed: string[] = [];
  const harness = createHarness(undefined, undefined, {
    userMemoryCoordinator: {
      async observe(message: DiscordMessage) {
        observed.push(message.id);
      },
    } as unknown as UserMemoryCoordinator,
  });

  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-a", "覚えておいて"),
    );

    assert.deepEqual(observed, ["message-a"]);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("injects user memory only when a user first speaks in a session", async () => {
  const memories = new Map<string, UserMemory>([
    [
      "user-123",
      {
        discordId: "user",
        displayName: "ユーザー",
        summary: "TypeScriptが好きなユーザー",
        impression: 0,
        updatedAt: "2026-11-01T00:00:00.000Z",
        facts: "- 好きなもの: Bun",
        history: "なし",
        inCommon: "なし",
        strengthening: "なし",
      },
    ],
  ]);
  const harness = createHarness(undefined, undefined, {
    userMemoryStore: {
      async read(userId) {
        return memories.get(userId);
      },
    },
  });

  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-a", "最初のメッセージ"),
    );
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-b", "次のメッセージ"),
    );
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-c", "別の人のメッセージ", {
        author: {
          bot: false,
          id: "user-456",
          username: "newcomer",
          displayName: "新入り",
        },
      }),
    );

    const turns = harness.prompts.get("channel-a");
    assert.match(turns?.[0]?.context.userMemory ?? "", /TypeScriptが好きなユーザー/u);
    assert.equal(turns?.[1]?.context.userMemory, undefined);
    assert.match(turns?.[2]?.context.userMemory ?? "", /first meeting/u);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("initializes every saved channel agent during startup", async () => {
  const states = ["channel-a", "channel-b"].map((channelId) => ({
    conversationKey: { kind: "discord" as const, channelId },
    sessionKey: `discord-channel:${channelId}`,
    lastActivityAt: null,
    lastRotationDate: getChannelRotationBucket(Date.now()),
    hasActivitySinceRotation: false,
  }));
  const channelSessionStateStore = {
    async getOrCreate(conversationKey: { kind: "discord"; channelId: string }) {
      return states.find((state) => state.conversationKey.channelId === conversationKey.channelId)!;
    },
    async list() {
      return states;
    },
    async listChannelNames() {
      return new Map();
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
    lastRotationDate: getChannelRotationBucket(Date.now()),
    hasActivitySinceRotation: false,
  }));
  const channelSessionStateStore = {
    async getOrCreate(conversationKey: { kind: "discord"; channelId: string }) {
      return states.find((state) => state.conversationKey.channelId === conversationKey.channelId)!;
    },
    async list() {
      return states;
    },
    async listChannelNames() {
      return new Map();
    },
    async save() {},
  };
  const harness = createHarness(undefined, undefined, {
    accessPolicy: createDiscordAccessPolicy(
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
                  "channel-a": { access: "allow" },
                  "channel-b": { access: "owner" },
                },
              }
            : undefined,
      },
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
      harness.prompts.get("channel-a")?.map((turn) =>
        turn.event.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n\n"),
      ),
      ["ユーザー (@user):\nA のメッセージ"],
    );
    assert.deepEqual(
      harness.prompts.get("channel-b")?.map((turn) =>
        turn.event.content
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
      harness.prompts.get("channel-a")?.map((turn) =>
        turn.event.content
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
  script: "text(args[0]); silent();",
  args: [],
  message: "在庫の変化を確認してください。",
  enabled: true,
  consecutiveFailures: 0,
  createdAt: "2026-10-14T00:00:00.000Z",
  schedule: { type: "every", minutes: 5 },
  nextRunAt: "2026-10-14T00:05:00.000Z",
};

test("starts a reminder worker and keeps the conversation session for conversation", async () => {
  await using temp = await createTempDir("klein-reminder-session-");
  const directory = temp.path;
  const channelSessionStateStore = new ChannelSessionStateStore(directory);
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
    assert.deepEqual(harness.createdSessionKeys, []);
    assert.equal(reminders.getStored(), undefined);
    assert.equal(harness.attachedStarts.length, 1);
    assert.deepEqual(harness.attachedStarts[0]?.conversationKey, {
      kind: "discord",
      channelId: "test-channel",
    });
    assert.equal(harness.attachedStarts[0]?.accessScope, "public");
    assert.equal(harness.attachedStarts[0]?.closeAfterResult, true);
    assert.match(harness.attachedStarts[0]?.prompt ?? "", /定例会が始まります/u);

    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("test-channel", "reply", "ありがとう"),
    );
    assert.deepEqual(harness.createdSessionKeys, [sessionKey]);
    assert.equal(
      harness.prompts.get(sessionKey.slice("discord-channel:".length))?.[0]?.event.type,
      "discord.message",
    );
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("starts a reminder worker without rotating the conversation session", async () => {
  await using temp = await createTempDir("klein-reminder-rotation-");
  const directory = temp.path;
  const channelSessionStateStore = new ChannelSessionStateStore(directory);
  const oldKey = "discord-channel:test-channel:public:rotation:2000-01-01";
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
    assert.deepEqual(harness.createdSessionKeys, []);
    assert.equal(harness.attachedStarts.length, 1);
    assert.equal(reminders.getStored(), undefined);
    const state = await channelSessionStateStore.getOrCreate(
      { kind: "discord", channelId: dueReminder.channelId },
      getChannelRotationBucket(Date.now()),
    );
    assert.equal(state.sessionKey, oldKey);
    assert.equal(state.handoffContext, undefined);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("starts a reminder worker without prompting an active channel agent", async () => {
  const reminders = createScheduledTaskStore(dueReminder);
  const harness = createHarness(undefined, reminders.store);
  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("test-channel", "first", "こんにちは"),
    );
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    assert.deepEqual(harness.createdSessionKeys, ["discord-channel:test-channel"]);
    assert.deepEqual(
      harness.prompts.get("test-channel")?.map((turn) => turn.event.type),
      ["discord.message"],
    );
    assert.equal(harness.attachedStarts.length, 1);
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
      assert.equal(harness.createdSessionKeys.length, 0);
      assert.equal(harness.attachedStarts.length, delivered ? 1 : 0);
      assert.equal(reminders.getStored() === undefined, delivered);
      if (delivered) {
        assert.deepEqual(harness.attachedStarts[0]?.conversationKey, {
          kind: "discord",
          channelId: "test-channel",
        });
        assert.equal(harness.attachedStarts[0]?.accessScope, scope);
        assert.equal(harness.attachedStarts[0]?.ownerFeaturesAllowed, scope.startsWith("owner:"));
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
    assert.equal(harness.attachedStarts.length, 1);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("delivers a watch when the script calls wake()", async () => {
  let decision: "wake" | "silent" = "silent";
  const runner: WatchCheckRunner = {
    async run() {
      return { output: "two", decision, exitCode: 0, durationMs: 1, state: { runs: 1 } };
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
    const silent = watches.getStored();
    assert.ok(silent?.kind === "watch");
    assert.deepEqual(silent.state, { runs: 1 });
    assert.equal(harness.prompts.size, 0);

    decision = "wake";
    await harness.agentCoordinator.deliverDueTasks(Date.parse(silent.nextRunAt));
    const first = watches.getStored();
    assert.ok(first?.kind === "watch");
    assert.ok(first.lastTriggeredAt);
    assert.deepEqual(first.state, { runs: 1 });
    const events = harness.prompts.get("test-channel:owner:123");
    assert.equal(events?.length, 1);
    assert.equal(events?.[0]?.event.type, "watch.triggered");
    assert.equal(events?.[0]?.event.source, "watch");
    assert.match(eventText(events?.[0]?.event), /two/u);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("resumes the worker that registered a watch instead of the conversation", async () => {
  const runner: WatchCheckRunner = {
    async run() {
      return { output: "changed", decision: "wake", exitCode: 0, durationMs: 1, state: {} };
    },
  };
  const watches = createScheduledTaskStore({ ...dueWatch, ownerTaskId: "attached-1" });
  const harness = createHarness(
    undefined,
    watches.store,
    {
      accessPolicy: createDiscordAccessPolicy({ default: "owner", directMessages: "deny" }, "123"),
      ownerUserId: "123",
    },
    runner,
    true,
  );
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:05:00.000Z"));
    assert.deepEqual(
      harness.attachedSends.map((send) => ({ scope: send.scope, taskId: send.taskId })),
      [
        {
          scope: {
            conversationKey: { kind: "discord", channelId: "test-channel" },
            accessScope: "owner:123",
          },
          taskId: "attached-1",
        },
      ],
    );
    assert.match(harness.attachedSends[0]?.message ?? "", /changed/u);
    assert.equal(harness.prompts.size, 0);
    const stored = watches.getStored();
    assert.ok(stored?.kind === "watch");
    assert.ok(stored.lastTriggeredAt);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("delivers a worker watch to the conversation when the worker is gone", async () => {
  const runner: WatchCheckRunner = {
    async run() {
      return { output: "changed", decision: "wake", exitCode: 0, durationMs: 1, state: {} };
    },
  };
  const watches = createScheduledTaskStore({ ...dueWatch, ownerTaskId: "attached-1" });
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
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:05:00.000Z"));
    assert.deepEqual(
      harness.attachedSends.map((send) => send.taskId),
      ["attached-1"],
    );
    const events = harness.prompts.get("test-channel:owner:123");
    assert.equal(events?.[0]?.event.type, "watch.triggered");
    assert.match(eventText(events?.[0]?.event), /changed/u);
    const stored = watches.getStored();
    assert.ok(stored?.kind === "watch");
    assert.equal(stored.ownerTaskId, undefined);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("persists watch state even when the check does not notify", async () => {
  const runner: WatchCheckRunner = {
    async run() {
      return { output: "", decision: "silent", exitCode: 0, durationMs: 1, state: { runs: 3 } };
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
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:05:00.000Z"));
    const stored = watches.getStored();
    assert.ok(stored?.kind === "watch");
    assert.deepEqual(stored.state, { runs: 3 });
    assert.equal(harness.prompts.size, 0);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("delivers a public watch without an access policy", async () => {
  const runner: WatchCheckRunner = {
    async run() {
      return { output: "hello", decision: "wake", exitCode: 0, durationMs: 1, state: {} };
    },
  };
  const watches = createScheduledTaskStore({
    ...dueWatch,
    accessScope: "public",
  });
  const harness = createHarness(undefined, watches.store, {}, runner);
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.now());
    const events = harness.prompts.get("test-channel");
    assert.equal(events?.[0]?.event.type, "watch.triggered");
    assert.match(eventText(events?.[0]?.event), /hello/u);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("reschedules a disallowed watch instead of rechecking it every tick", async () => {
  const watches = createScheduledTaskStore({ ...dueWatch, accessScope: "public" });
  const harness = createHarness(undefined, watches.store, {
    accessPolicy: createDiscordAccessPolicy({ default: "deny", directMessages: "deny" }),
  });
  try {
    const dueAt = Date.parse("2026-10-14T00:05:00.000Z");
    await harness.agentCoordinator.deliverDueTasks(dueAt);
    const stored = watches.getStored();
    assert.ok(stored?.kind === "watch");
    assert.equal(stored.nextRunAt, "2026-10-14T00:10:00.000Z");
    assert.equal(harness.channelLocationCalls.length, 1);
    assert.equal(harness.prompts.size, 0);

    await harness.agentCoordinator.deliverDueTasks(dueAt + 10_000);
    assert.equal(harness.channelLocationCalls.length, 1);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("skips a disallowed one-time reminder without rechecking it every tick", async () => {
  const reminders = createScheduledTaskStore(dueReminder);
  const harness = createHarness(undefined, reminders.store, {
    accessPolicy: createDiscordAccessPolicy({ default: "deny", directMessages: "deny" }),
  });
  try {
    const dueAt = Date.parse("2026-10-14T00:02:00.000Z");
    await harness.agentCoordinator.deliverDueTasks(dueAt);
    assert.equal(harness.channelLocationCalls.length, 1);
    assert.ok(reminders.getStored());

    await harness.agentCoordinator.deliverDueTasks(dueAt + 10_000);
    assert.equal(harness.channelLocationCalls.length, 1);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("does not deliver or recreate a watch deleted while its check runs", async () => {
  const watches = createScheduledTaskStore({ ...dueWatch });
  const runner: WatchCheckRunner = {
    async run() {
      await watches.store.delete("watch", "test-channel", "owner:123", "watch-1");
      return { output: "changed", decision: "wake", exitCode: 0, durationMs: 1, state: {} };
    },
  };
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
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:05:00.000Z"));
    assert.equal(watches.getStored(), undefined);
    assert.equal(harness.prompts.size, 0);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("uses the check time for the next interval run", async () => {
  const runner: WatchCheckRunner = {
    async run() {
      return { output: "changed", decision: "wake", exitCode: 0, durationMs: 1, state: {} };
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
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:05:00.000Z"));
    const stored = watches.getStored();
    assert.ok(stored?.kind === "watch");
    assert.equal(stored.nextRunAt, "2026-10-14T00:10:00.000Z");
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

test("delivers an attached task result to the conversation agent", async () => {
  const harness = createHarness();
  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("test-channel", "m-1", "hello"),
    );
    await harness.agentCoordinator.deliverAttachedTaskResult(
      { kind: "discord", channelId: "test-channel" },
      "public",
      { taskId: "task-1", status: "completed", text: "found it" },
    );

    const turns = harness.prompts.get("test-channel") ?? [];
    assert.equal(turns.length, 2);
    assert.equal(turns[1]?.event.type, "worker.result");
    assert.match(eventText(turns[1]?.event), /found it/u);
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
