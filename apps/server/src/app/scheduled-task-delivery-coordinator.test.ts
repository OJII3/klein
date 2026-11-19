import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import type { AgentEvent } from "@agents/core/agent-event";
import type { ConversationAgent } from "@agents/core/conversation-agent";
import {
  createStubDiscordChannelApi,
  InMemoryScheduledTaskStore,
} from "@agents/testing/test-stubs";
import { DiscordOperatingState } from "@modules/discord/domain/discord-operating-state";
import type {
  ProactiveCoordinator,
  WatchSignalInput,
  WatchSignalResult,
} from "@modules/proactivity/application/proactive-coordinator";
import type { ProactiveDeliveryMode } from "@modules/proactivity/domain/proactive-preference";
import type { ProactiveSignal } from "@modules/proactivity/domain/proactive-signal";
import type { ReminderTask, WatchTask } from "@modules/scheduling/domain/scheduled-task";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";
import { ChannelSessionManager } from "./channel-session-manager";
import { ScheduledTaskDeliveryCoordinator } from "./scheduled-task-delivery-coordinator";
import { TaskCoordinator } from "./task-coordinator";

const DUE_AT = Date.parse("2026-10-14T00:05:00.000Z");

const watch: WatchTask = {
  kind: "watch",
  id: "watch-1",
  channelId: "channel-a",
  accessScope: "public",
  name: "在庫監視",
  script: "wake();",
  args: [],
  message: "在庫の変化を確認してください。",
  priority: "normal",
  enabled: true,
  consecutiveFailures: 0,
  createdAt: "2026-10-14T00:00:00.000Z",
  schedule: { type: "every", minutes: 5 },
  nextRunAt: "2026-10-14T00:05:00.000Z",
};

const reminder: ReminderTask = {
  kind: "reminder",
  id: "reminder-1",
  channelId: "channel-a",
  accessScope: "public",
  message: "定例会",
  createdAt: "2026-10-14T00:00:00.000Z",
  schedule: { type: "once", at: "2026-10-14T00:02:00.000Z" },
  nextRunAt: "2026-10-14T00:02:00.000Z",
};

function makeSignal(): ProactiveSignal {
  return {
    version: 1,
    id: "signal-1",
    channelId: "channel-a",
    accessScope: "public",
    audience: "public",
    source: { kind: "watch", ref: "watch-1" },
    topic: "在庫監視",
    summary: "在庫の変化を確認してください。",
    evidence: { text: "changed" },
    urgency: "today",
    dedupeKey: "dedupe-1",
    observedAt: new Date(DUE_AT).toISOString(),
    status: "queued",
  };
}

interface HarnessOptions {
  readonly mode?: ProactiveDeliveryMode;
  readonly ingestFails?: boolean;
  readonly promptFails?: boolean;
  readonly workerSendResult?: boolean;
  readonly tasks?: readonly (WatchTask | ReminderTask)[];
}

function createHarness(options: HarnessOptions = {}) {
  const events: AgentEvent[] = [];
  const agent: ConversationAgent = {
    async prompt() {},
    async promptEvent(event) {
      if (options.promptFails) throw new Error("prompt failed");
      events.push(event);
    },
    async steer() {},
    compactForHandoff() {
      return undefined;
    },
    dispose() {},
  };
  const channelApi = createStubDiscordChannelApi();
  const sessionManager = new ChannelSessionManager<ConversationAgent>({
    channelApi,
    createAgent: async () => agent,
    logger: pino({ level: "silent" }),
  });
  const ingestCalls: WatchSignalInput[] = [];
  const surfacedCalls: {
    readonly signals: readonly ProactiveSignal[];
    readonly mode: ProactiveDeliveryMode;
    readonly now: number;
  }[] = [];
  const proactive = {
    async ingestWatchSignal(input: WatchSignalInput): Promise<WatchSignalResult> {
      ingestCalls.push(input);
      if (options.ingestFails) throw new Error("ingest failed");
      return {
        decision: { mode: options.mode ?? "attach", reason: "test" },
        signal: makeSignal(),
      };
    },
    async markSignalsSurfaced(
      signals: readonly ProactiveSignal[],
      mode: ProactiveDeliveryMode,
      now: number,
    ): Promise<void> {
      surfacedCalls.push({ signals, mode, now });
    },
  } satisfies Pick<ProactiveCoordinator, "ingestWatchSignal" | "markSignalsSurfaced">;
  const attachedSends: {
    readonly taskId: string;
    readonly message: string;
  }[] = [];
  const attachedStarts: string[] = [];
  const store = new InMemoryScheduledTaskStore(options.tasks ?? [watch]);
  const coordinator = new ScheduledTaskDeliveryCoordinator({
    attachedTasks: {
      async start(input) {
        attachedStarts.push(input.prompt);
        return "attached-1";
      },
      async send(_scope, taskId, message) {
        attachedSends.push({ taskId, message });
        return options.workerSendResult ?? true;
      },
      async close() {
        return false;
      },
      list() {
        return [];
      },
    },
    channelApi,
    logger: pino({ level: "silent" }),
    operatingState: new DiscordOperatingState(),
    scheduledTaskStore: store,
    sessionManager,
    taskCoordinator: new TaskCoordinator(),
    watchCheckRunner: createRunner(),
    proactive,
  });

  return {
    coordinator,
    store,
    events,
    ingestCalls,
    surfacedCalls,
    attachedSends,
    attachedStarts,
    storedWatch: () => {
      const stored = store.tasks.get("watch-1");
      return stored?.kind === "watch" ? stored : undefined;
    },
  };
}

function createRunner(decision: "wake" | "silent" = "wake"): WatchCheckRunner {
  return {
    async run() {
      return { output: "changed", decision, exitCode: 0, durationMs: 1, state: { runs: 1 } };
    },
  };
}

test("holds an attach decision without delivering the wake", async () => {
  const harness = createHarness({ mode: "attach" });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.equal(harness.ingestCalls.length, 1);
  assert.equal(harness.ingestCalls[0]?.watch.id, "watch-1");
  assert.equal(harness.ingestCalls[0]?.output, "changed");
  assert.equal(harness.ingestCalls[0]?.now, DUE_AT);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.attachedSends, []);
  assert.deepEqual(harness.surfacedCalls, []);

  const stored = harness.storedWatch();
  assert.ok(stored?.lastTriggeredAt);
  assert.equal(stored.nextRunAt, "2026-10-14T00:10:00.000Z");
  assert.deepEqual(stored.state, { runs: 1 });
});

test("delivers an interrupt decision and marks the signal surfaced", async () => {
  const harness = createHarness({ mode: "interrupt" });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0]?.type, "watch.triggered");
  assert.match(eventText(harness.events[0]), /changed/u);
  assert.deepEqual(
    harness.surfacedCalls.map((call) => ({
      ids: call.signals.map((signal) => signal.id),
      mode: call.mode,
      now: call.now,
    })),
    [{ ids: ["signal-1"], mode: "interrupt", now: DUE_AT }],
  );
  assert.ok(harness.storedWatch()?.lastTriggeredAt);
});

test("keeps the signal queued when an interrupt delivery fails", async () => {
  const harness = createHarness({ mode: "interrupt", promptFails: true });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.surfacedCalls, []);
  const stored = harness.storedWatch();
  assert.equal(stored?.lastStatus, "error");
  assert.match(stored?.lastError ?? "", /prompt failed/u);
  assert.equal(stored?.consecutiveFailures, 1);
});

test("falls back to direct delivery when signal ingestion fails", async () => {
  const harness = createHarness({ ingestFails: true });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0]?.type, "watch.triggered");
  assert.deepEqual(harness.surfacedCalls, []);
  assert.ok(harness.storedWatch()?.lastTriggeredAt);
});

test("delivers a silent decision without prompting the conversation", async () => {
  const harness = createHarness({ mode: "silent" });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.surfacedCalls, []);
  assert.ok(harness.storedWatch()?.lastTriggeredAt);
});

test("sends a worker watch to its worker without consulting the gate", async () => {
  const workerWatch: WatchTask = { ...watch, ownerTaskId: "attached-1" };
  const harness = createHarness({ tasks: [workerWatch] });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.deepEqual(harness.ingestCalls, []);
  assert.equal(harness.attachedSends.length, 1);
  assert.equal(harness.attachedSends[0]?.taskId, "attached-1");
  assert.match(harness.attachedSends[0]?.message ?? "", /changed/u);
  assert.ok(harness.storedWatch()?.lastTriggeredAt);
});

test("leaves reminder delivery unchanged", async () => {
  const harness = createHarness({ tasks: [reminder] });

  await harness.coordinator.deliverDueTasks(Date.parse(reminder.nextRunAt));

  assert.deepEqual(harness.ingestCalls, []);
  assert.equal(harness.attachedStarts.length, 1);
  assert.equal(harness.store.tasks.has("reminder-1"), false);
});

function eventText(event: AgentEvent | undefined): string {
  return (
    event?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? ""
  );
}
