import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";

import type { AgentFactory } from "@agents/core/agent-factory";
import type { AgentRuntime } from "@agents/core/agent-runtime";
import type { AgentTurn } from "@agents/core/agent-turn";
import type { WorkerControl } from "@agents/core/worker-agent";
import { DiscordAgent } from "@agents/discord/discord-agent";
import { InMemoryScheduledTaskStore } from "@agents/testing/test-stubs";
import { createDiscordAccessPolicy } from "@modules/discord/domain/discord-access-policy";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { InitiativeGoalResult } from "@modules/initiative/application/initiative-coordinator";
import type { InitiativeGoal } from "@modules/initiative/domain/initiative-goal";
import { ProactiveCoordinator } from "@modules/proactivity/application/proactive-coordinator";
import type { FollowUp } from "@modules/proactivity/domain/follow-up";
import type { ProactiveSignal } from "@modules/proactivity/domain/proactive-signal";
import { FileFollowUpStore } from "@modules/proactivity/infrastructure/file-follow-up-store";
import { FileProactivePreferenceStore } from "@modules/proactivity/infrastructure/file-proactive-preference-store";
import { FileProactiveSignalStore } from "@modules/proactivity/infrastructure/file-proactive-signal-store";
import { MemoryInbox } from "../testing/memory-inbox";
import { createTempDir } from "../testing/temp-dir";
import { parseAccessScope } from "@shared/access";
import { AgentCoordinator, type AgentCoordinatorDependencies } from "./agent-coordinator";
import { TaskCoordinator } from "./task-coordinator";

const NOW = Date.parse("2026-11-20T01:00:00.000Z");

const digestSignal: ProactiveSignal = {
  version: 1,
  id: "signal-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  audience: "owner",
  source: { kind: "watch", ref: "watch-1" },
  topic: "在庫監視",
  summary: "在庫が3個になりました",
  urgency: "digest",
  dedupeKey: "dedupe-1",
  observedAt: "2026-11-19T23:30:00.000Z",
  status: "queued",
  delivery: { mode: "digest" },
};

const followUp: FollowUp = {
  version: 1,
  id: "follow-up-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  subject: "作業の結果を知らせる",
  watcher: { kind: "worker", id: "worker-1" },
  cadenceLabel: "ワーカーの完了時",
  status: "active",
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};

async function withIntegration(
  run: (harness: {
    readonly agentCoordinator: AgentCoordinator;
    readonly turns: AgentTurn[];
    readonly signalStore: FileProactiveSignalStore;
    readonly followUpStore: FileFollowUpStore;
    readonly proactive: ProactiveCoordinator;
  }) => Promise<void>,
  options: {
    readonly replyWithMessage?: boolean;
    readonly initiative?: AgentCoordinatorDependencies["initiative"];
    readonly accessPolicy?: AgentCoordinatorDependencies["accessPolicy"];
    readonly ownerUserId?: AgentCoordinatorDependencies["ownerUserId"];
  } = {},
): Promise<void> {
  await using temp = await createTempDir("klein-proactivity-integration-");
  const signalStore = new FileProactiveSignalStore(join(temp.path, "signals"));
  const followUpStore = new FileFollowUpStore(join(temp.path, "follow-ups"));
  const proactive = new ProactiveCoordinator({
    preferenceStore: new FileProactivePreferenceStore(join(temp.path, "preferences")),
    followUpStore,
    signalStore,
    scheduledTaskStore: new InMemoryScheduledTaskStore(),
    workers: {
      list() {
        return [];
      },
    },
    defaults: {
      defaultMode: "attach",
      digestAt: "09:00",
      maxPerDay: 3,
      publicChannels: false,
    },
    now: () => NOW,
  });
  const turns: AgentTurn[] = [];
  const sentHooks = new Map<string, () => void>();
  const agentFactory: AgentFactory = {
    async create(_definition, createTools, creationOptions): Promise<AgentRuntime> {
      const channelId = creationOptions.sessionKey.split(":")[1] ?? "";
      createTools({ requesterId: () => undefined });
      return {
        async prompt(turn) {
          turns.push(turn);
          if (options.replyWithMessage) sentHooks.get(channelId)?.();
        },
        dispose() {},
      };
    },
  };
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
      throw new Error("Unexpected read");
    },
    async readMessages() {
      throw new Error("Unexpected message list read");
    },
    async getChannelLocation(channelId) {
      return { channelId };
    },
  };
  const workers: WorkerControl = {
    async start() {
      return "worker-1";
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
  };
  const agentCoordinator = new AgentCoordinator({
    workers,
    createDiscordAgent: (channelId, sessionKey, handoffContext, accessScope) =>
      DiscordAgent.create(agentFactory, channelId, "system prompt", {
        accessScope: parseAccessScope(accessScope),
        sessionKey,
        handoffContext,
        ownerFeaturesAllowed: accessScope?.startsWith("owner:") === true,
        tools: (_toolContext, hooks) => {
          sentHooks.set(channelId, hooks.onMessageSent);
          return [];
        },
      }),
    channelApi,
    logger: pino({ level: "silent" }),
    operatingState: new DiscordOperatingState(),
    inbox: new MemoryInbox(),
    proactive,
    ...(options.initiative ? { initiative: options.initiative } : {}),
    ...(options.accessPolicy ? { accessPolicy: options.accessPolicy } : {}),
    ...(options.ownerUserId ? { ownerUserId: options.ownerUserId } : {}),
    watchCheckRunner: {
      async run() {
        throw new Error("Unexpected watch check");
      },
    },
    taskCoordinator: new TaskCoordinator(),
  });

  try {
    await run({ agentCoordinator, turns, signalStore, followUpStore, proactive });
  } finally {
    await agentCoordinator.dispose();
  }
}

test("delivers a collected digest through the conversation coordinator", async () => {
  await withIntegration(async ({ agentCoordinator, turns, signalStore }) => {
    await signalStore.create(digestSignal);

    await agentCoordinator.deliverDueDigests(NOW);

    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.event.type, "proactive.digest");
    assert.equal(turns[0]?.event.source, "proactivity");
    assert.match(eventText(turns[0]), /collected signals you may report together/u);
    assert.match(eventText(turns[0]), /在庫が3個になりました/u);
    assert.equal((await signalStore.get("signal-1"))?.status, "surfaced");
  });
});

test("completes a worker follow-up when its result reaches the conversation", async () => {
  await withIntegration(async ({ agentCoordinator, turns, followUpStore }) => {
    await followUpStore.create(followUp);

    await agentCoordinator.deliverWorkerResult(
      { kind: "discord", channelId: "channel-a" },
      "owner:123",
      { workerId: "worker-1", status: "completed", text: "終わりました" },
    );

    assert.equal(turns[0]?.event.type, "worker.result");
    assert.equal((await followUpStore.get("follow-up-1"))?.status, "done");
  });
});

test("holds an attach goal result until the next reply and marks it surfaced", async () => {
  let initiativeResult: InitiativeGoalResult | undefined;

  await withIntegration(
    async ({ agentCoordinator, proactive, signalStore, turns }) => {
      const ingested = await proactive.ingestGoalResult({
        goalId: "goal-1",
        channelId: "channel-a",
        accessScope: "owner:123",
        topic: "映画",
        summary: "映画の時間を確認した",
        delivery: "attach",
        now: NOW,
      });
      assert.deepEqual(ingested.decision, { mode: "attach", reason: "requested-attach" });
      assert.equal((await signalStore.get(ingested.signal.id))?.status, "queued");

      initiativeResult = {
        goal: makeInitiativeGoal(),
        decision: ingested.decision,
        signal: ingested.signal,
        resultText: "映画の時間を確認した",
        failed: false,
      };
      await agentCoordinator.deliverWorkerResult(
        { kind: "discord", channelId: "channel-a" },
        "owner:123",
        { workerId: "worker-1", status: "completed", text: "映画の時間を確認した" },
      );

      assert.equal(turns.length, 0);
      assert.equal((await signalStore.get(ingested.signal.id))?.status, "queued");

      await agentCoordinator.handleDiscordMessage(createIntegrationMessage());

      assert.equal(turns.length, 1);
      assert.equal((await signalStore.get(ingested.signal.id))?.status, "surfaced");
    },
    {
      replyWithMessage: true,
      accessPolicy: createDiscordAccessPolicy({ default: "owner", directMessages: "deny" }, "123"),
      ownerUserId: "123",
      initiative: {
        async handleWorkerResult() {
          if (!initiativeResult) throw new Error("Missing initiative result");
          return initiativeResult;
        },
        async markResultDelivered() {},
      },
    },
  );
});

function makeInitiativeGoal(): InitiativeGoal {
  return {
    version: 1,
    id: "goal-1",
    channelId: "channel-a",
    accessScope: "owner:123",
    title: "映画の時間を確認する",
    rationale: "今夜映画を見る予定だった",
    source: { kind: "conversation", messageIds: ["message-1"] },
    plan: "映画の上映時間を調べる",
    dueAt: "2026-11-20T01:00:00.000Z",
    expiresAt: "2026-11-21T01:00:00.000Z",
    risk: "low",
    status: "ready",
    dedupeKey: "goal-dedupe",
    createdBy: "planner",
    createdAt: "2026-11-19T01:00:00.000Z",
    updatedAt: "2026-11-20T01:00:00.000Z",
  };
}

function createIntegrationMessage(): DiscordMessage {
  return {
    author: { bot: false, id: "123", username: "user", displayName: "ユーザー" },
    channelId: "channel-a",
    content: "こんにちは",
    id: "message-1",
    occurredAt: new Date(NOW).toISOString(),
    images: [],
  };
}

function eventText(turn: AgentTurn | undefined): string {
  return (
    turn?.event.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? ""
  );
}
