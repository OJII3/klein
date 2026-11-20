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
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import { ProactiveCoordinator } from "@modules/proactivity/application/proactive-coordinator";
import type { FollowUp } from "@modules/proactivity/domain/follow-up";
import type { ProactiveSignal } from "@modules/proactivity/domain/proactive-signal";
import { FileFollowUpStore } from "@modules/proactivity/infrastructure/file-follow-up-store";
import { FileProactivePreferenceStore } from "@modules/proactivity/infrastructure/file-proactive-preference-store";
import { FileProactiveSignalStore } from "@modules/proactivity/infrastructure/file-proactive-signal-store";
import { createTempDir } from "../testing/temp-dir";
import { parseAccessScope } from "@shared/access";
import { AgentCoordinator } from "./agent-coordinator";
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
  }) => Promise<void>,
): Promise<void> {
  await using temp = await createTempDir("klein-proactivity-integration-");
  const signalStore = new FileProactiveSignalStore(join(temp.path, "signals"));
  const followUpStore = new FileFollowUpStore(join(temp.path, "follow-ups"));
  const proactive = new ProactiveCoordinator({
    preferenceStore: new FileProactivePreferenceStore(join(temp.path, "preferences.md")),
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
  const agentFactory: AgentFactory = {
    async create(): Promise<AgentRuntime> {
      return {
        async prompt(turn) {
          turns.push(turn);
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
    async readMessage() {
      throw new Error("Unexpected read");
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
        tools: () => [],
      }),
    channelApi,
    logger: pino({ level: "silent" }),
    operatingState: new DiscordOperatingState(),
    proactive,
    watchCheckRunner: {
      async run() {
        throw new Error("Unexpected watch check");
      },
    },
    taskCoordinator: new TaskCoordinator(),
  });

  try {
    await run({ agentCoordinator, turns, signalStore, followUpStore });
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
    assert.match(eventText(turns[0]), /まとめて伝える候補があります/u);
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

function eventText(turn: AgentTurn | undefined): string {
  return (
    turn?.event.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? ""
  );
}
