import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import { DiscordAgent } from "@agents/discord/discord-agent";
import type { AgentFactory } from "@agents/core/agent-factory";
import type { AgentRuntime, AgentTurnProgress } from "@agents/core/agent-runtime";
import type { AgentEvent } from "@agents/core/agent-event";
import type { AgentTurn } from "@agents/core/agent-turn";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { WorkerControl, WorkerScope, WorkerStartInput } from "@agents/core/worker-agent";

import {
  createDiscordAccessPolicy,
  type DiscordAccess,
} from "@modules/discord/domain/discord-access-policy";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { ProactiveDigestBatch } from "@modules/proactivity/application/proactive-coordinator";
import type { ProactiveSignal } from "@modules/proactivity/domain/proactive-signal";
import type { InitiativeGoalResult } from "@modules/initiative/application/initiative-coordinator";
import type { InitiativeGoal } from "@modules/initiative/domain/initiative-goal";
import type { UserMemory } from "@modules/user-memory/domain/user-memory";

import type {
  ReminderTask,
  ScheduledTask,
  ScheduledTaskAccessScope,
  WatchTask,
} from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";
import { isOwnerAccessScope, parseAccessScope } from "@shared/access";
import { TaskCoordinator } from "./task-coordinator";
import { AgentCoordinator, type AgentCoordinatorDependencies } from "./agent-coordinator";
import { ChannelSessionStateStore, getChannelRotationBucket } from "./channel-session-state-store";
import { MemoryInbox } from "../testing/memory-inbox";
import { createTempDir } from "../testing/temp-dir";

interface TestHarness {
  readonly agentCoordinator: AgentCoordinator;
  readonly inbox: MemoryInbox;
  readonly taskCoordinator: TaskCoordinator;
  readonly workerStarts: WorkerStartInput[];
  readonly workerSends: {
    readonly scope: WorkerScope;
    readonly workerId: string;
    readonly message: string;
  }[];
  readonly channelLocationCalls: string[];
  readonly createdSessionKeys: string[];
  readonly prompts: Map<string, AgentTurn[]>;
  readonly ownerFeaturesAllowed: boolean[];
  readonly interruptedNotes: string[];
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
    | "proactive"
    | "initiative"
  > & {
    readonly inbox?: MemoryInbox;
    readonly operatingState?: DiscordOperatingState;
  } = {},
  watchCheckRunner?: WatchCheckRunner,
  workerSendResult = false,
  replyWithMessage = false,
  runtimeBehavior: {
    readonly gate?: Promise<void>;
    readonly error?: Error;
    readonly turnProgress?:
      AgentTurnProgress | ((eventId: string, sessionKey: string) => AgentTurnProgress);
  } = {},
): TestHarness {
  const resolvedWatchCheckRunner: WatchCheckRunner = watchCheckRunner ?? {
    async run() {
      throw new Error("Unexpected watch check");
    },
  };
  const inbox = options.inbox ?? new MemoryInbox();
  const operatingState = options.operatingState ?? new DiscordOperatingState();
  const taskCoordinator = new TaskCoordinator();
  const channelLocationCalls: string[] = [];
  const createdSessionKeys: string[] = [];
  const prompts = new Map<string, AgentTurn[]>();
  const ownerFeaturesAllowed: boolean[] = [];
  const interruptedNotes: string[] = [];
  const workerStarts: WorkerStartInput[] = [];
  const workerSends: { scope: WorkerScope; workerId: string; message: string }[] = [];
  const workers: WorkerControl = {
    async start(input) {
      workerStarts.push(input);
      return input.id ?? `worker-${workerStarts.length}`;
    },
    async send(scope, workerId, message) {
      workerSends.push({ scope, workerId, message });
      return workerSendResult;
    },
    async close() {
      return false;
    },
    list() {
      return [];
    },
  };
  const sentHooks = new Map<string, () => void>();
  const agentFactory: AgentFactory = {
    async create(_definition, createTools, creationOptions): Promise<AgentRuntime> {
      createdSessionKeys.push(creationOptions.sessionKey);
      ownerFeaturesAllowed.push(creationOptions.ownerFeaturesAllowed ?? false);
      if (createGate) await createGate;

      const channelId = creationOptions.sessionKey.slice("discord-channel:".length);
      const channelPrompts: AgentTurn[] = [];
      prompts.set(channelId, channelPrompts);
      createTools({ requesterId: () => undefined });

      return {
        async prompt(turn) {
          if (runtimeBehavior.gate) await runtimeBehavior.gate;
          if (runtimeBehavior.error) throw runtimeBehavior.error;
          channelPrompts.push(turn);
          if (replyWithMessage) sentHooks.get(channelId)?.();
        },
        getTurnProgress(eventId) {
          const progress = runtimeBehavior.turnProgress;
          if (typeof progress === "function") return progress(eventId, creationOptions.sessionKey);
          return progress ?? "none";
        },
        async markInterrupted(eventId) {
          interruptedNotes.push(eventId);
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
    async sendImage() {
      return [];
    },
    async readMessage() {
      return message;
    },
    async readMessages() {
      throw new Error("Unexpected message list read");
    },
    async getChannelLocation(channelId) {
      channelLocationCalls.push(channelId);
      return { guildId: "guild-123", channelId };
    },
  };

  return {
    agentCoordinator: new AgentCoordinator({
      ...options,
      inbox,
      operatingState,
      workers,
      createDiscordAgent: (channelId, sessionKey, handoffContext, accessScope) =>
        DiscordAgent.create(agentFactory, channelId, "system prompt", {
          accessScope: parseAccessScope(accessScope),
          sessionKey,
          handoffContext,
          ownerFeaturesAllowed: isOwnerAccessScope(accessScope, options.ownerUserId),
          ownerUserId: options.ownerUserId,
          tools: (_toolContext, hooks) => {
            sentHooks.set(channelId, hooks.onMessageSent);
            return [];
          },
        }),
      channelApi,
      logger: pino({ level: "silent" }),
      scheduledTaskStore,
      watchCheckRunner: resolvedWatchCheckRunner,
      taskCoordinator,
    }),
    inbox,
    taskCoordinator,
    workerStarts,
    workerSends,
    channelLocationCalls,
    createdSessionKeys,
    prompts,
    ownerFeaturesAllowed,
    interruptedNotes,
  };
}

function createProactiveStub(
  overrides: Partial<NonNullable<AgentCoordinatorDependencies["proactive"]>> = {},
): NonNullable<AgentCoordinatorDependencies["proactive"]> {
  return {
    async getContext() {
      return {};
    },
    async markPendingSignalsSurfaced() {},
    async ingestWatchSignal() {
      throw new Error("Unexpected watch signal ingest");
    },
    async markSignalsSurfaced() {},
    async collectDueDigests() {
      return [];
    },
    async markWatcherCompleted() {},
    ...overrides,
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

test("prompts once when the same Discord message id arrives twice", async () => {
  const harness = createHarness();

  try {
    const message = createMessage("channel-a", "message-a", "一度だけ");
    await harness.agentCoordinator.handleDiscordMessage(message);
    await harness.agentCoordinator.handleDiscordMessage(message);

    assert.equal(harness.prompts.get("channel-a")?.length, 1);
    assert.equal(harness.inbox.list().length, 1);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("drains items that were already pending when the coordinator initializes", async () => {
  const inbox = new MemoryInbox();
  const message = createMessage("channel-a", "message-pending", "起動前のメッセージ");
  const conversationKey = { kind: "discord", channelId: message.channelId } as const;
  await inbox.enqueue({
    kind: "discord.message",
    id: message.id,
    conversationKey,
    enqueuedAt: "2026-10-14T09:30:42.123Z",
    message,
  });
  const harness = createHarness(undefined, undefined, { inbox });

  try {
    await harness.agentCoordinator.initialize();

    assert.equal(harness.prompts.get("channel-a")?.length, 1);
    assert.equal(harness.inbox.get(conversationKey, message.id)?.status, "done");
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("keeps a message accepted before initialization pending until drains start", async () => {
  const harness = createHarness();

  try {
    const message = createMessage("channel-a", "message-a", "起動中");
    const conversationKey = { kind: "discord", channelId: message.channelId } as const;
    await harness.agentCoordinator.acceptDiscordMessage(message);

    assert.equal(harness.prompts.size, 0);
    assert.equal(harness.inbox.get(conversationKey, message.id)?.status, "pending");

    await harness.agentCoordinator.initialize();

    assert.equal(harness.prompts.get("channel-a")?.length, 1);
    assert.equal(harness.inbox.get(conversationKey, message.id)?.status, "done");
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("accepts a message without waiting for its gated turn", async () => {
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const harness = createHarness(undefined, undefined, {}, undefined, false, false, {
    gate: promptGate,
  });

  try {
    await harness.agentCoordinator.initialize();

    let accepted = false;
    const acceptance = (async () => {
      await harness.agentCoordinator.acceptDiscordMessage(
        createMessage("channel-a", "message-a", "急ぎ"),
      );
      accepted = true;
    })();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    assert.equal(accepted, true);
    assert.equal(harness.prompts.get("channel-a")?.length ?? 0, 0);

    releasePrompt();
    await acceptance;
    await harness.taskCoordinator.waitForCompletion();

    assert.equal(harness.prompts.get("channel-a")?.length, 1);
  } finally {
    releasePrompt();
    await harness.agentCoordinator.dispose();
  }
});

test("marks an inbox item failed when its prompt fails", async () => {
  const harness = createHarness(undefined, undefined, {}, undefined, false, false, {
    error: new Error("prompt failed"),
  });

  try {
    const message = createMessage("channel-a", "message-a", "失敗する");
    await harness.agentCoordinator.handleDiscordMessage(message);

    const item = harness.inbox.get({ kind: "discord", channelId: "channel-a" }, message.id);
    assert.equal(item?.status, "failed");
    assert.match(item?.error ?? "", /prompt failed/u);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("finishes an inbox item whose turn completed without prompting again", async () => {
  const inbox = new MemoryInbox();
  const message = createMessage("channel-a", "message-a", "返信済み");
  const conversationKey = { kind: "discord", channelId: message.channelId } as const;
  await inbox.enqueue({
    kind: "discord.message",
    id: message.id,
    conversationKey,
    enqueuedAt: "2026-10-14T09:30:42.123Z",
    message,
  });
  await inbox.claimNext(conversationKey);
  await inbox.recoverClaims();
  const progressReads: string[] = [];
  const harness = createHarness(undefined, undefined, { inbox }, undefined, false, false, {
    turnProgress(eventId) {
      progressReads.push(eventId);
      return "completed";
    },
  });

  try {
    await harness.agentCoordinator.initialize();

    assert.deepEqual(progressReads, ["message-a"]);
    assert.deepEqual(harness.createdSessionKeys, ["discord-channel:channel-a"]);
    assert.equal(harness.prompts.get("channel-a")?.length ?? 0, 0);
    assert.equal(harness.inbox.get(conversationKey, message.id)?.status, "done");
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("leaves an inbox item interrupted when its turn outcome is uncertain", async () => {
  const inbox = new MemoryInbox();
  const message = createMessage("channel-a", "message-a", "結果不明");
  const conversationKey = { kind: "discord", channelId: message.channelId } as const;
  await inbox.enqueue({
    kind: "discord.message",
    id: message.id,
    conversationKey,
    enqueuedAt: "2026-10-14T09:30:42.123Z",
    message,
  });
  await inbox.claimNext(conversationKey);
  await inbox.recoverClaims();
  const harness = createHarness(undefined, undefined, { inbox }, undefined, false, false, {
    turnProgress: "uncertain",
  });

  try {
    await harness.agentCoordinator.initialize();

    assert.equal(harness.prompts.get("channel-a")?.length ?? 0, 0);
    assert.equal(harness.inbox.get(conversationKey, message.id)?.status, "interrupted");
    assert.deepEqual(harness.interruptedNotes, ["message-a"]);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("prompts an inbox item again when its turn started without an assistant message", async () => {
  const inbox = new MemoryInbox();
  const message = createMessage("channel-a", "message-a", "未返信");
  const conversationKey = { kind: "discord", channelId: message.channelId } as const;
  await inbox.enqueue({
    kind: "discord.message",
    id: message.id,
    conversationKey,
    enqueuedAt: "2026-10-14T09:30:42.123Z",
    message,
  });
  await inbox.claimNext(conversationKey);
  await inbox.recoverClaims();
  const harness = createHarness(undefined, undefined, { inbox }, undefined, false, false, {
    turnProgress: "started",
  });

  try {
    await harness.agentCoordinator.initialize();

    assert.equal(harness.prompts.get("channel-a")?.length, 1);
    assert.equal(harness.inbox.get(conversationKey, message.id)?.status, "done");
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("interrupts an inbox item that exceeds the attempt limit without prompting", async () => {
  const inbox = new MemoryInbox();
  const message = createMessage("channel-a", "message-a", "毒メッセージ");
  const conversationKey = { kind: "discord", channelId: message.channelId } as const;
  await inbox.enqueue({
    kind: "discord.message",
    id: message.id,
    conversationKey,
    enqueuedAt: "2026-10-14T09:30:42.123Z",
    message,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.ok(await inbox.claimNext(conversationKey));
    await inbox.recoverClaims();
  }
  const harness = createHarness(undefined, undefined, { inbox });

  try {
    await harness.agentCoordinator.initialize();

    const item = harness.inbox.get(conversationKey, message.id);
    assert.equal(item?.status, "interrupted");
    assert.match(item?.error ?? "", /3 attempts/u);
    assert.equal(harness.prompts.size, 0);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("reads turn progress before rotating a due conversation session", async () => {
  const inbox = new MemoryInbox();
  const message = createMessage("channel-a", "message-a", "返信済み");
  const conversationKey = { kind: "discord", channelId: message.channelId } as const;
  await inbox.enqueue({
    kind: "discord.message",
    id: message.id,
    conversationKey,
    enqueuedAt: "2026-10-14T09:30:42.123Z",
    message,
  });
  await inbox.claimNext(conversationKey);
  await inbox.recoverClaims();
  const oldSessionKey = "discord-channel:channel-a:public:rotation:2000-01-01";
  const channelSessionStateStore = {
    async getOrCreate() {
      return {
        conversationKey,
        accessScope: "public",
        sessionKey: oldSessionKey,
        lastActivityAt: Date.now() - 2 * 60 * 60 * 1000,
        lastRotationDate: "2000-01-01",
        hasActivitySinceRotation: true,
      };
    },
    async list() {
      return [];
    },
    async listChannelNames() {
      return new Map();
    },
    async save() {},
  };
  const progressReads: { eventId: string; sessionKey: string }[] = [];
  const harness = createHarness(
    undefined,
    undefined,
    {
      accessPolicy: createDiscordAccessPolicy({ default: "allow", directMessages: "allow" }),
      channelSessionStateStore,
      inbox,
    },
    undefined,
    false,
    false,
    {
      turnProgress(eventId, sessionKey) {
        progressReads.push({ eventId, sessionKey });
        return sessionKey === oldSessionKey ? "completed" : "none";
      },
    },
  );

  try {
    await harness.agentCoordinator.initialize();

    assert.deepEqual(progressReads, [{ eventId: "message-a", sessionKey: oldSessionKey }]);
    assert.deepEqual(harness.createdSessionKeys, [oldSessionKey]);
    assert.equal(harness.prompts.get("channel-a")?.length ?? 0, 0);
    assert.equal(harness.inbox.get(conversationKey, message.id)?.status, "done");
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("finishes an agent event whose turn completed without prompting again", async () => {
  const inbox = new MemoryInbox();
  const event: AgentEvent = {
    id: "event-1",
    type: "reminder.due",
    source: "reminder",
    occurredAt: "2026-10-14T09:30:42.123Z",
    content: [{ type: "text", text: "定例会の時間" }],
  };
  const conversationKey = { kind: "discord", channelId: "channel-a" } as const;
  await inbox.enqueue({
    kind: "agent.event",
    id: event.id,
    conversationKey,
    enqueuedAt: "2026-10-14T09:30:42.123Z",
    event,
  });
  await inbox.claimNext(conversationKey);
  await inbox.recoverClaims();
  const harness = createHarness(undefined, undefined, { inbox }, undefined, false, false, {
    turnProgress: "completed",
  });

  try {
    await harness.agentCoordinator.initialize();

    assert.equal(harness.prompts.get("channel-a")?.length ?? 0, 0);
    assert.equal(harness.inbox.get(conversationKey, event.id)?.status, "done");
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("leaves pending inbox items pending while Klein is paused", async () => {
  const inbox = new MemoryInbox();
  const message = createMessage("channel-a", "message-a", "停止中のメッセージ");
  const conversationKey = { kind: "discord", channelId: message.channelId } as const;
  await inbox.enqueue({
    kind: "discord.message",
    id: message.id,
    conversationKey,
    enqueuedAt: "2026-10-14T09:30:42.123Z",
    message,
  });
  const harness = createHarness(undefined, undefined, {
    inbox,
    operatingState: new DiscordOperatingState("paused"),
  });

  try {
    await harness.agentCoordinator.initialize();

    assert.equal(harness.prompts.size, 0);
    assert.equal(harness.inbox.get(conversationKey, message.id)?.status, "pending");
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
    },
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

test("passes proactive preferences, waiting follow-ups, and pending signals to the turn", async () => {
  const calls: { channelId: string; accessScope: string }[] = [];
  const harness = createHarness(undefined, undefined, {
    proactive: createProactiveStub({
      async getContext(input) {
        calls.push(input);
        return {
          preferences: "# Proactive preferences\n\n## Notes\n- 短く",
          waitingOn: "天気を確認する（5分ごと / 追跡中）",
          pendingSignals: "在庫が3個（在庫監視 / 今日中）",
        };
      },
    }),
  });

  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-a", "こんにちは"),
    );

    assert.deepEqual(calls, [{ channelId: "channel-a", accessScope: "public" }]);
    assert.deepEqual(harness.prompts.get("channel-a")?.[0]?.context.blocks, [
      {
        name: "proactive-preferences",
        content: "# Proactive preferences\n\n## Notes\n- 短く",
      },
      { name: "waiting-on", content: "天気を確認する（5分ごと / 追跡中）" },
      { name: "pending-signals", content: "在庫が3個（在庫監視 / 今日中）" },
    ]);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("does not surface attach signals when the turn stays silent", async () => {
  const surfaced: ProactiveSignal[][] = [];
  const signal = attachSignal();
  const harness = createHarness(
    undefined,
    undefined,
    {
      proactive: createProactiveStub({
        async getContext() {
          return {
            pendingSignals: "在庫が3個（在庫監視 / 今日中）",
            pendingSignalsToSurface: [signal],
          };
        },
        async markPendingSignalsSurfaced(signals) {
          surfaced.push([...signals]);
        },
      }),
    },
    undefined,
    false,
    false,
  );

  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-a", "こんにちは"),
    );
    assert.deepEqual(surfaced, []);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("surfaces attach signals after the turn sends a reply", async () => {
  const surfaced: ProactiveSignal[][] = [];
  const signal = attachSignal();
  const harness = createHarness(
    undefined,
    undefined,
    {
      proactive: createProactiveStub({
        async getContext() {
          return {
            pendingSignals: "在庫が3個（在庫監視 / 今日中）",
            pendingSignalsToSurface: [signal],
          };
        },
        async markPendingSignalsSurfaced(signals) {
          surfaced.push([...signals]);
        },
      }),
    },
    undefined,
    false,
    true,
  );

  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-a", "こんにちは"),
    );
    assert.deepEqual(surfaced, [[signal]]);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

function attachSignal(): ProactiveSignal {
  return {
    version: 1,
    id: "attach-1",
    channelId: "channel-a",
    accessScope: "public",
    audience: "public",
    source: { kind: "watch", ref: "watch-1" },
    topic: "在庫監視",
    summary: "在庫が3個になりました",
    urgency: "today",
    dedupeKey: "dedupe-attach-1",
    observedAt: "2026-11-19T23:00:00.000Z",
    status: "queued",
    delivery: { mode: "attach" },
  };
}

const digestSignal: ProactiveSignal = {
  version: 1,
  id: "signal-1",
  channelId: "channel-a",
  accessScope: "public",
  audience: "public",
  source: { kind: "watch", ref: "watch-1" },
  topic: "在庫監視",
  summary: "在庫が3個になりました",
  urgency: "digest",
  dedupeKey: "dedupe-digest-1",
  observedAt: "2026-11-19T23:00:00.000Z",
  status: "queued",
  delivery: { mode: "digest" },
};

test("delivers due digests to the conversation as proactive events", async () => {
  const collectedAt: number[] = [];
  const batch: ProactiveDigestBatch = {
    channelId: "channel-a",
    accessScope: "public",
    signals: [digestSignal],
    text: "There are collected signals you may report together.\n在庫が3個になりました (在庫監視 / digest)",
  };
  const harness = createHarness(undefined, undefined, {
    proactive: createProactiveStub({
      async collectDueDigests(now) {
        collectedAt.push(now);
        return [batch];
      },
    }),
  });

  try {
    await harness.agentCoordinator.deliverDueDigests(1234);

    assert.deepEqual(collectedAt, [1234]);
    const events = harness.prompts.get("channel-a");
    assert.equal(events?.length, 1);
    assert.equal(events?.[0]?.event.type, "proactive.digest");
    assert.equal(events?.[0]?.event.source, "proactivity");
    assert.equal(events?.[0]?.event.id, "proactive:digest:channel-a:signal-1");
    assert.match(eventText(events?.[0]?.event), /在庫が3個になりました/u);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("keeps running when digest collection fails", async () => {
  const harness = createHarness(undefined, undefined, {
    proactive: createProactiveStub({
      async collectDueDigests() {
        throw new Error("collection failed");
      },
    }),
  });

  try {
    await harness.agentCoordinator.deliverDueDigests(1234);
    assert.equal(harness.prompts.size, 0);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("marks worker follow-ups done after delivering a worker result", async () => {
  const completed: { kind: string; id: string }[] = [];
  const harness = createHarness(undefined, undefined, {
    proactive: createProactiveStub({
      async markWatcherCompleted(kind, id) {
        completed.push({ kind, id });
      },
    }),
  });

  try {
    await harness.agentCoordinator.deliverWorkerResult(
      { kind: "discord", channelId: "test-channel" },
      "public",
      { workerId: "worker-1", status: "completed", text: "found it" },
    );

    assert.deepEqual(completed, [{ kind: "worker", id: "worker-1" }]);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("does not complete task follow-ups when delivery access is denied", async () => {
  const completed: { kind: string; id: string }[] = [];
  const harness = createHarness(undefined, undefined, {
    accessPolicy: createDiscordAccessPolicy({ default: "deny", directMessages: "deny" }),
    proactive: createProactiveStub({
      async markWatcherCompleted(kind, id) {
        completed.push({ kind, id });
      },
    }),
  });

  try {
    await harness.agentCoordinator.deliverWorkerResult(
      { kind: "discord", channelId: "test-channel" },
      "public",
      { workerId: "worker-1", status: "completed", text: "found it" },
    );

    assert.deepEqual(completed, []);
    assert.equal(harness.prompts.size, 0);
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
      const found = states.find(
        (state) => state.conversationKey.channelId === conversationKey.channelId,
      );
      if (!found) throw new Error(`Missing state for ${conversationKey.channelId}`);
      return found;
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
      const found = states.find(
        (state) => state.conversationKey.channelId === conversationKey.channelId,
      );
      if (!found) throw new Error(`Missing state for ${conversationKey.channelId}`);
      return found;
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
                  "channel-b": { access: "allow" },
                },
              }
            : undefined,
      },
      (target) =>
        target.guildId === "guild-123" && target.channelId === "channel-b" ? "user-123" : undefined,
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

    assert.deepEqual(harness.createdSessionKeys.toSorted(), [
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

    assert.deepEqual(harness.createdSessionKeys.toSorted(), [
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

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
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
  async function listForScope(
    kind: "reminder",
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly ReminderTask[]>;
  async function listForScope(
    kind: "watch",
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly WatchTask[]>;
  async function listForScope(
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly ScheduledTask[]>;
  async function listForScope(
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly ScheduledTask[]> {
    return stored &&
      stored.kind === kind &&
      stored.channelId === channelId &&
      stored.accessScope === accessScope
      ? [stored]
      : [];
  }
  const store: ScheduledTaskStore = {
    async create(task: ScheduledTask) {
      stored = task;
    },
    listForScope,
    async listDue(now: number) {
      return stored && Date.parse(stored.nextRunAt) <= now ? [stored] : [];
    },
    async delete(
      kind: ScheduledTask["kind"],
      channelId: string,
      accessScope: ScheduledTaskAccessScope,
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
  };
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

const repeatingReminder: ReminderTask = {
  ...dueReminder,
  id: "reminder-2",
  schedule: { type: "every", minutes: 10 },
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
    assert.equal(harness.workerStarts.length, 1);
    assert.deepEqual(harness.workerStarts[0]?.conversationKey, {
      kind: "discord",
      channelId: "test-channel",
    });
    assert.equal(harness.workerStarts[0]?.accessScope, "public");
    assert.equal(harness.workerStarts[0]?.closeAfterResult, true);
    assert.match(harness.workerStarts[0]?.prompt ?? "", /定例会が始まります/u);
    const stored = reminders.getStored();
    assert.ok(stored?.kind === "reminder");
    assert.match(stored.runningWorkerId ?? "", /^reminder:reminder-1:/u);
    assert.equal(stored.runningWorkerId, harness.workerStarts[0]?.id);
    assert.equal(stored.attempts, 1);

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

test("tells a one-time reminder worker that the reminder ends with this notification", async () => {
  const reminders = createScheduledTaskStore(dueReminder);
  const harness = createHarness(undefined, reminders.store);
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    const prompt = harness.workerStarts[0]?.prompt ?? "";
    assert.match(prompt, /The following reminder is one-time and will be deleted\./u);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("does not describe a repeating reminder as one-time to its worker", async () => {
  const reminders = createScheduledTaskStore(repeatingReminder);
  const harness = createHarness(undefined, reminders.store);
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    assert.doesNotMatch(harness.workerStarts[0]?.prompt ?? "", /one-time/u);
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
    assert.equal(harness.workerStarts.length, 1);
    const stored = reminders.getStored();
    assert.ok(stored?.kind === "reminder");
    assert.equal(stored.runningWorkerId, harness.workerStarts[0]?.id);
    assert.equal(stored.attempts, 1);
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
    assert.equal(harness.workerStarts.length, 1);
    const stored = reminders.getStored();
    assert.ok(stored?.kind === "reminder");
    assert.equal(stored.runningWorkerId, harness.workerStarts[0]?.id);
    assert.equal(stored.attempts, 1);
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
      assert.equal(harness.workerStarts.length, delivered ? 1 : 0);
      const stored = reminders.getStored();
      assert.ok(stored?.kind === "reminder");
      assert.equal(stored.runningWorkerId !== undefined, delivered);
      if (delivered) {
        assert.equal(stored.runningWorkerId, harness.workerStarts[0]?.id);
        assert.equal(stored.attempts, 1);
        assert.deepEqual(harness.workerStarts[0]?.conversationKey, {
          kind: "discord",
          channelId: "test-channel",
        });
        assert.equal(harness.workerStarts[0]?.accessScope, scope);
        assert.equal(harness.workerStarts[0]?.ownerFeaturesAllowed, scope.startsWith("owner:"));
      }
    } finally {
      await harness.agentCoordinator.dispose();
    }
  });
}

test("delivers a linked user's reminder while the channel link remains", async () => {
  const reminder: ReminderTask = { ...dueReminder, accessScope: "user:456" };
  const reminders = createScheduledTaskStore(reminder);
  const harness = createHarness(undefined, reminders.store, {
    ownerUserId: "123",
    accessPolicy: createDiscordAccessPolicy(
      { default: "deny", directMessages: "deny" },
      "123",
      undefined,
      (target) => (target.channelId === "test-channel" ? "456" : undefined),
    ),
  });
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    assert.equal(harness.workerStarts.length, 1);
    assert.equal(harness.workerStarts[0]?.accessScope, "user:456");
    assert.equal(harness.workerStarts[0]?.ownerFeaturesAllowed, false);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("advances a recurring reminder when its worker result is delivered", async () => {
  const reminder: ReminderTask = {
    ...dueReminder,
    schedule: { type: "daily", time: "09:00" },
  };
  const reminders = createScheduledTaskStore(reminder);
  const harness = createHarness(undefined, reminders.store);
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    const running = reminders.getStored();
    assert.ok(running?.kind === "reminder");
    assert.equal(running.channelId, reminder.channelId);
    assert.equal(running.accessScope, reminder.accessScope);
    assert.equal(running.nextRunAt, reminder.nextRunAt);
    assert.equal(running.runningWorkerId, harness.workerStarts[0]?.id);
    assert.equal(running.attempts, 1);
    assert.equal(harness.workerStarts.length, 1);

    const before = Date.now();
    const workerId = harness.workerStarts[0]?.id;
    assert.ok(workerId);
    await harness.agentCoordinator.deliverWorkerResult(
      { kind: "discord", channelId: reminder.channelId },
      reminder.accessScope,
      { workerId, status: "completed", text: "定例会が始まります" },
    );

    const stored = reminders.getStored();
    assert.ok(stored?.kind === "reminder");
    assert.ok(Date.parse(stored.nextRunAt) > before);
    assert.equal(stored.channelId, reminder.channelId);
    assert.equal(stored.accessScope, reminder.accessScope);
    assert.equal(stored.runningWorkerId, undefined);
    assert.equal(stored.attempts, undefined);
    assert.equal(stored.lastError, undefined);
    assert.equal("sessionKey" in stored, false);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("completes a one-time reminder when its worker result is delivered", async () => {
  const completedWatchers: { kind: string; id: string }[] = [];
  const reminders = createScheduledTaskStore(dueReminder);
  const harness = createHarness(undefined, reminders.store, {
    proactive: createProactiveStub({
      async markWatcherCompleted(kind, id) {
        completedWatchers.push({ kind, id });
      },
    }),
  });
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    const workerId = harness.workerStarts[0]?.id;
    assert.ok(workerId);
    assert.match(workerId, /^reminder:reminder-1:/u);
    assert.ok(reminders.getStored());

    await harness.agentCoordinator.deliverWorkerResult(
      { kind: "discord", channelId: dueReminder.channelId },
      dueReminder.accessScope,
      { workerId, status: "completed", text: "定例会が始まります" },
    );

    assert.equal(reminders.getStored(), undefined);
    assert.deepEqual(
      completedWatchers.filter((watcher) => watcher.kind === "reminder"),
      [{ kind: "reminder", id: "reminder-1" }],
    );
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("releases a reminder when its worker closes without a result", async () => {
  const reminders = createScheduledTaskStore(dueReminder);
  const harness = createHarness(undefined, reminders.store);
  try {
    await harness.agentCoordinator.deliverDueTasks(Date.parse("2026-10-14T00:02:00.000Z"));
    const workerId = harness.workerStarts[0]?.id;
    assert.ok(workerId);

    await harness.agentCoordinator.releaseWorkerSchedules({
      id: workerId,
      conversationKey: { kind: "discord", channelId: dueReminder.channelId },
      accessScope: dueReminder.accessScope,
    });

    const stored = reminders.getStored();
    assert.ok(stored?.kind === "reminder");
    assert.equal(stored.runningWorkerId, undefined);
    assert.equal(stored.attempts, 1);
    assert.match(stored.lastError ?? "", /closed/u);
    assert.equal(stored.nextRunAt, dueReminder.nextRunAt);
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
    await harness.taskCoordinator.waitForCompletion();
    const first = watches.getStored();
    assert.ok(first?.kind === "watch");
    assert.ok(first.lastTriggeredAt);
    assert.deepEqual(first.state, { runs: 1 });
    const events = harness.prompts.get("test-channel:owner:123");
    assert.equal(events?.length, 1);
    assert.equal(events?.[0]?.event.type, "watch.triggered");
    assert.equal(events?.[0]?.event.source, "watch");
    assert.match(eventText(events?.[0]?.event), /two/u);
    const inboxItem = harness.inbox.list().find((item) => item.kind === "agent.event");
    assert.equal(inboxItem?.status, "done");
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
  const watches = createScheduledTaskStore({ ...dueWatch, ownerWorkerId: "worker-1" });
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
      harness.workerSends.map((send) => ({ scope: send.scope, workerId: send.workerId })),
      [
        {
          scope: {
            conversationKey: { kind: "discord", channelId: "test-channel" },
            accessScope: "owner:123",
          },
          workerId: "worker-1",
        },
      ],
    );
    assert.match(harness.workerSends[0]?.message ?? "", /changed/u);
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
  const watches = createScheduledTaskStore({ ...dueWatch, ownerWorkerId: "worker-1" });
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
    await harness.taskCoordinator.waitForCompletion();
    assert.deepEqual(
      harness.workerSends.map((send) => send.workerId),
      ["worker-1"],
    );
    const events = harness.prompts.get("test-channel:owner:123");
    assert.equal(events?.[0]?.event.type, "watch.triggered");
    assert.match(eventText(events?.[0]?.event), /changed/u);
    const stored = watches.getStored();
    assert.ok(stored?.kind === "watch");
    assert.equal(stored.ownerWorkerId, undefined);
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
    await harness.taskCoordinator.waitForCompletion();
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

test("delivers watch check failures to the agent as events", async () => {
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
    await harness.taskCoordinator.waitForCompletion();
    const stored = watches.getStored();
    assert.ok(stored?.kind === "watch");
    assert.equal(stored.lastStatus, "error");
    assert.match(stored.lastError ?? "", /check failed/u);
    assert.equal(stored.consecutiveFailures, 1);
    const turns = [...harness.prompts.values()].flat();
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.event.type, "watch.failed");
    assert.match(eventText(turns[0]?.event), /check failed/u);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("delivers a worker result to the conversation agent", async () => {
  const harness = createHarness();
  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("test-channel", "m-1", "hello"),
    );
    await harness.agentCoordinator.deliverWorkerResult(
      { kind: "discord", channelId: "test-channel" },
      "public",
      { workerId: "worker-1", status: "completed", text: "found it" },
    );

    const turns = harness.prompts.get("test-channel") ?? [];
    assert.equal(turns.length, 2);
    assert.equal(turns[1]?.event.type, "worker.result");
    assert.match(eventText(turns[1]?.event), /found it/u);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("delivers an initiative result as an interrupt event", async () => {
  const delivered: string[] = [];
  const surfaced: { readonly ids: readonly string[]; readonly mode: string }[] = [];
  const initiativeResult = createInitiativeResult();
  const harness = createHarness(undefined, undefined, {
    proactive: createProactiveStub({
      async markSignalsSurfaced(signals, mode) {
        surfaced.push({ ids: signals.map((signal) => signal.id), mode });
      },
    }),
    initiative: {
      async handleWorkerResult() {
        return initiativeResult;
      },
      async markResultDelivered(goalId) {
        delivered.push(goalId);
      },
    },
  });

  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("test-channel", "m-1", "hello"),
    );
    await harness.agentCoordinator.deliverWorkerResult(
      { kind: "discord", channelId: "test-channel" },
      "public",
      { workerId: "worker-1", status: "completed", text: "ignored" },
    );

    const turns = harness.prompts.get("test-channel") ?? [];
    assert.equal(turns.length, 2);
    assert.equal(turns[1]?.event.type, "initiative.result");
    assert.match(eventText(turns[1]?.event), /店を3軒見つけた/u);
    assert.match(
      eventText(turns[1]?.event),
      /Premise captured at: 2026-11-21T12:00:00\+09:00 \(JST: /u,
    );
    assert.match(eventText(turns[1]?.event), /Executed at: 2026-11-22T12:00:00\+09:00 \(JST: /u);
    assert.match(eventText(turns[1]?.event), /Elapsed since premise capture: 24\.0 hours/u);
    assert.match(eventText(turns[1]?.event), /say the situation changed/u);
    assert.deepEqual(surfaced, [{ ids: ["signal-1"], mode: "interrupt" }]);
    assert.deepEqual(delivered, ["goal-1"]);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

function createInitiativeResult(): InitiativeGoalResult {
  return {
    goal: makeInitiativeGoal(),
    decision: { mode: "interrupt", reason: "test" },
    signal: makeInitiativeSignal(),
    resultText: "店を3軒見つけた",
    failed: false,
  };
}

function makeInitiativeGoal(): InitiativeGoal {
  return {
    version: 1,
    id: "goal-1",
    channelId: "test-channel",
    accessScope: "public",
    title: "店を調べる",
    rationale: "店の話をしていた",
    source: { kind: "conversation", messageIds: ["m1"] },
    plan: "好みに合う店を3軒調べる",
    dueAt: "2026-11-22T12:00:00+09:00",
    expiresAt: "2026-11-23T12:00:00+09:00",
    risk: "low",
    status: "ready",
    dedupeKey: "goal-dedupe",
    createdBy: "planner",
    createdAt: "2026-11-21T12:00:00+09:00",
    updatedAt: "2026-11-22T12:00:00+09:00",
  };
}

function makeInitiativeSignal(): ProactiveSignal {
  return {
    version: 1,
    id: "signal-1",
    channelId: "test-channel",
    accessScope: "public",
    audience: "public",
    source: { kind: "goal", ref: "goal-1" },
    topic: "店を調べる",
    summary: "店を3軒見つけた",
    urgency: "now",
    dedupeKey: "signal-dedupe",
    observedAt: "2026-11-21T12:00:00.000Z",
    status: "queued",
    delivery: { mode: "interrupt" },
  };
}

function eventText(event: AgentEvent | undefined): string {
  return (
    event?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n") ?? ""
  );
}

test("admits a bystander into the owner session without owner-only context", async () => {
  const observed: string[] = [];
  const proactiveChannels: string[] = [];
  let memoryReads = 0;
  const harness = createHarness(undefined, undefined, {
    accessPolicy: createDiscordAccessPolicy(
      { default: "owner", directMessages: "deny" },
      "owner-123",
    ),
    ownerUserId: "owner-123",
    userMemoryCoordinator: {
      async observe(message) {
        observed.push(message.id);
      },
    },
    userMemoryStore: {
      async read() {
        memoryReads += 1;
        return undefined;
      },
    },
    proactive: createProactiveStub({
      async getContext(input) {
        proactiveChannels.push(input.channelId);
        return {};
      },
    }),
  });

  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-a", "オーナー以外の雑談", {
        guildId: "guild-123",
        author: {
          bot: false,
          id: "user-456",
          username: "guest",
          displayName: "ゲスト",
        },
      }),
    );

    assert.deepEqual(observed, []);
    assert.deepEqual(proactiveChannels, []);
    assert.equal(memoryReads, 0);
    assert.deepEqual(harness.createdSessionKeys, ["discord-channel:channel-a:owner:owner-123"]);
    const turn = harness.prompts.get("channel-a:owner:owner-123")?.[0];
    assert.ok(turn);
    assert.match(eventText(turn.event), /someone other than your owner/u);
    assert.match(eventText(turn.event), /オーナー以外の雑談/u);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("keeps owner-channel messages from the owner on the existing path", async () => {
  const observed: string[] = [];
  const proactiveChannels: string[] = [];
  const harness = createHarness(undefined, undefined, {
    accessPolicy: createDiscordAccessPolicy(
      { default: "owner", directMessages: "deny" },
      "owner-123",
    ),
    ownerUserId: "owner-123",
    userMemoryCoordinator: {
      async observe(message) {
        observed.push(message.id);
      },
    },
    proactive: createProactiveStub({
      async getContext(input) {
        proactiveChannels.push(input.channelId);
        return {};
      },
    }),
  });

  try {
    await harness.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-a", "オーナーの発言", {
        guildId: "guild-123",
        author: {
          bot: false,
          id: "owner-123",
          username: "owner",
          displayName: "オーナー",
        },
      }),
    );

    assert.deepEqual(observed, ["message-a"]);
    assert.deepEqual(proactiveChannels, ["channel-a"]);
    assert.deepEqual(harness.createdSessionKeys, ["discord-channel:channel-a:owner:owner-123"]);
    const turn = harness.prompts.get("channel-a:owner:owner-123")?.[0];
    assert.ok(turn);
    assert.doesNotMatch(eventText(turn.event), /someone other than your owner/u);
  } finally {
    await harness.agentCoordinator.dispose();
  }
});

test("keeps bots and denied messages out of owner-channel message processing", async () => {
  const ownerChannel = createHarness(undefined, undefined, {
    accessPolicy: createDiscordAccessPolicy(
      { default: "owner", directMessages: "deny" },
      "owner-123",
    ),
    ownerUserId: "owner-123",
  });
  const deniedChannel = createHarness(undefined, undefined, {
    accessPolicy: createDiscordAccessPolicy(
      { default: "deny", directMessages: "deny" },
      "owner-123",
    ),
    ownerUserId: "owner-123",
  });

  try {
    await ownerChannel.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-bot", "bot", {
        guildId: "guild-123",
        author: {
          bot: true,
          id: "owner-123",
          username: "owner-bot",
          displayName: "オーナーBot",
        },
      }),
    );
    await deniedChannel.agentCoordinator.handleDiscordMessage(
      createMessage("channel-a", "message-denied", "拒否", { guildId: "guild-123" }),
    );

    assert.equal(ownerChannel.prompts.size, 0);
    assert.equal(ownerChannel.createdSessionKeys.length, 0);
    assert.equal(deniedChannel.prompts.size, 0);
    assert.equal(deniedChannel.createdSessionKeys.length, 0);
  } finally {
    await ownerChannel.agentCoordinator.dispose();
    await deniedChannel.agentCoordinator.dispose();
  }
});
