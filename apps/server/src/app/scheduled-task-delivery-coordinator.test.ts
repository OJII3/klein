import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import type { AgentEvent } from "@agents/core/agent-event";
import type { ConversationAgent } from "@agents/core/conversation-agent";
import type { WorkerInfo, WorkerScope, WorkerStartInput } from "@agents/core/worker-agent";
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
import {
  MAX_REMINDER_WORKER_ATTEMPTS,
  reminderWorkerId,
  ScheduledTaskDeliveryCoordinator,
} from "./scheduled-task-delivery-coordinator";
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
  readonly store?: InMemoryScheduledTaskStore;
  readonly runner?: WatchCheckRunner;
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
  const completedWatchers: { kind: string; id: string }[] = [];
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
    async markWatcherCompleted(kind: "watch" | "reminder" | "worker", id: string): Promise<void> {
      completedWatchers.push({ kind, id });
    },
  } satisfies Pick<
    ProactiveCoordinator,
    "ingestWatchSignal" | "markSignalsSurfaced" | "markWatcherCompleted"
  >;
  const workerSends: {
    readonly workerId: string;
    readonly message: string;
  }[] = [];
  const workerStarts: WorkerStartInput[] = [];
  const runningWorkers = new Map<
    string,
    { readonly scope: WorkerScope; readonly info: WorkerInfo }
  >();
  let startError: Error | undefined;
  const store = options.store ?? new InMemoryScheduledTaskStore(options.tasks ?? [watch]);
  const coordinator = new ScheduledTaskDeliveryCoordinator({
    workers: {
      async start(input) {
        workerStarts.push(input);
        if (startError) {
          const error = startError;
          startError = undefined;
          throw error;
        }
        const id = input.id ?? "worker-1";
        const now = new Date().toISOString();
        runningWorkers.set(id, {
          scope: { conversationKey: input.conversationKey, accessScope: input.accessScope },
          info: { id, prompt: input.prompt, status: "running", createdAt: now, updatedAt: now },
        });
        return id;
      },
      async send(_scope, workerId, message) {
        workerSends.push({ workerId, message });
        return options.workerSendResult ?? true;
      },
      async close() {
        return false;
      },
      list(scope) {
        return [...runningWorkers.values()]
          .filter(
            (worker) =>
              worker.scope.conversationKey.channelId === scope.conversationKey.channelId &&
              worker.scope.accessScope === scope.accessScope,
          )
          .map((worker) => worker.info);
      },
    },
    channelApi,
    logger: pino({ level: "silent" }),
    operatingState: new DiscordOperatingState(),
    scheduledTaskStore: store,
    sessionManager,
    taskCoordinator: new TaskCoordinator(),
    watchCheckRunner: options.runner ?? createRunner(),
    proactive,
  });

  return {
    coordinator,
    store,
    events,
    ingestCalls,
    surfacedCalls,
    completedWatchers,
    workerSends,
    workerStarts,
    storedWatch: () => {
      const stored = store.tasks.get("watch-1");
      return stored?.kind === "watch" ? stored : undefined;
    },
    storedReminder: (id = "reminder-1") => {
      const stored = store.tasks.get(id);
      return stored?.kind === "reminder" ? stored : undefined;
    },
    addWorker: (id: string, scope: WorkerScope = defaultWorkerScope) => {
      const now = new Date().toISOString();
      runningWorkers.set(id, {
        scope,
        info: { id, prompt: "", status: "running", createdAt: now, updatedAt: now },
      });
    },
    removeWorker: (id: string) => {
      runningWorkers.delete(id);
    },
    failNextStart: (message = "start failed") => {
      startError = new Error(message);
    },
  };
}

const defaultWorkerScope: WorkerScope = {
  conversationKey: { kind: "discord", channelId: "channel-a" },
  accessScope: "public",
};

function createRunner(
  decision: "wake" | "silent" = "wake",
  beforeRun?: () => Promise<void> | void,
): WatchCheckRunner {
  return {
    async run() {
      await beforeRun?.();
      return { output: "changed", decision, exitCode: 0, durationMs: 1, state: { runs: 1 } };
    },
  };
}

function createFailingRunner(message = "check failed"): WatchCheckRunner {
  return {
    async run() {
      throw new Error(message);
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
  assert.deepEqual(harness.workerSends, []);
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

test("delivers the first watch check failure as an event", async () => {
  const harness = createHarness({ runner: createFailingRunner() });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0]?.type, "watch.failed");
  assert.match(eventText(harness.events[0]), /check failed/u);
  assert.deepEqual(harness.ingestCalls, []);
  const stored = harness.storedWatch();
  assert.equal(stored?.lastStatus, "error");
  assert.equal(stored?.lastError, "check failed");
  assert.equal(stored?.consecutiveFailures, 1);
  assert.equal(stored?.lastTriggeredAt, undefined);
});

test("does not deliver the second consecutive watch check failure", async () => {
  const harness = createHarness({
    tasks: [{ ...watch, lastStatus: "error", lastError: "check failed", consecutiveFailures: 1 }],
    runner: createFailingRunner(),
  });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.deepEqual(harness.events, []);
  assert.equal(harness.storedWatch()?.consecutiveFailures, 2);
});

test("reminds the agent on the third consecutive watch check failure", async () => {
  const harness = createHarness({
    tasks: [{ ...watch, lastStatus: "error", lastError: "check failed", consecutiveFailures: 2 }],
    runner: createFailingRunner(),
  });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0]?.type, "watch.failed");
  assert.match(eventText(harness.events[0]), /3 times in a row/u);
  assert.match(eventText(harness.events[0]), /until it succeeds/u);
});

test("stays silent after the reminder until the watch recovers", async () => {
  const harness = createHarness({
    tasks: [{ ...watch, lastStatus: "error", lastError: "check failed", consecutiveFailures: 3 }],
    runner: createFailingRunner(),
  });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.deepEqual(harness.events, []);
  assert.equal(harness.storedWatch()?.consecutiveFailures, 4);
});

test("delivers a watch check failure to its worker", async () => {
  const workerWatch: WatchTask = { ...watch, ownerWorkerId: "worker-1" };
  const harness = createHarness({ tasks: [workerWatch], runner: createFailingRunner() });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.equal(harness.workerSends.length, 1);
  assert.equal(harness.workerSends[0]?.workerId, "worker-1");
  assert.match(harness.workerSends[0]?.message ?? "", /check failed/u);
  assert.deepEqual(harness.events, []);
  const stored = harness.storedWatch();
  assert.equal(stored?.lastStatus, "error");
  assert.equal(stored?.lastError, "check failed");
  assert.equal(stored?.lastTriggeredAt, undefined);
});

test("clears the failure count after a successful check", async () => {
  const harness = createHarness({
    tasks: [{ ...watch, lastStatus: "error", lastError: "check failed", consecutiveFailures: 2 }],
    runner: createRunner("silent"),
  });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  const stored = harness.storedWatch();
  assert.equal(stored?.lastStatus, "ok");
  assert.equal(stored?.consecutiveFailures, 0);
  assert.equal(stored?.lastError, undefined);
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
  const workerWatch: WatchTask = { ...watch, ownerWorkerId: "worker-1" };
  const harness = createHarness({ tasks: [workerWatch] });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.deepEqual(harness.ingestCalls, []);
  assert.equal(harness.workerSends.length, 1);
  assert.equal(harness.workerSends[0]?.workerId, "worker-1");
  assert.match(harness.workerSends[0]?.message ?? "", /changed/u);
  assert.ok(harness.storedWatch()?.lastTriggeredAt);
});

test("does not deliver a watch deleted while its check runs", async () => {
  const store = new InMemoryScheduledTaskStore([watch]);
  const harness = createHarness({
    store,
    mode: "interrupt",
    runner: createRunner("wake", async () => {
      await store.delete("watch", watch.channelId, watch.accessScope, watch.id);
    }),
  });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.deepEqual(harness.ingestCalls, []);
  assert.deepEqual(harness.events, []);
  assert.equal(store.tasks.has(watch.id), false);
});

test("does not recreate a watch deleted while its check runs", async () => {
  const store = new InMemoryScheduledTaskStore([watch]);
  const harness = createHarness({
    store,
    runner: createRunner("silent", async () => {
      await store.delete("watch", watch.channelId, watch.accessScope, watch.id);
    }),
  });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  assert.equal(store.tasks.has(watch.id), false);
});

test("does not re-enable a watch disabled while its check runs", async () => {
  const store = new InMemoryScheduledTaskStore([watch]);
  const harness = createHarness({
    store,
    runner: createRunner("silent", async () => {
      await store.update({ ...watch, enabled: false });
    }),
  });

  await harness.coordinator.deliverDueTasks(DUE_AT);

  const stored = harness.storedWatch();
  assert.equal(stored?.enabled, false);
  assert.equal(stored?.lastStatus, "ok");
  assert.equal(stored?.lastCheckedAt, new Date(DUE_AT).toISOString());
});

test("starts a reminder worker and keeps the reminder until its result is recorded", async () => {
  const harness = createHarness({ tasks: [reminder] });

  await harness.coordinator.deliverDueTasks(Date.parse(reminder.nextRunAt));

  assert.deepEqual(harness.ingestCalls, []);
  assert.equal(harness.workerStarts.length, 1);
  const workerId = reminderWorkerId(reminder);
  assert.equal(harness.workerStarts[0]?.id, workerId);
  assert.equal(harness.workerStarts[0]?.closeAfterResult, true);
  const running = harness.storedReminder();
  assert.equal(running?.runningWorkerId, workerId);
  assert.equal(running?.attempts, 1);
  assert.equal(running?.lastError, undefined);
  assert.equal(harness.store.tasks.has("reminder-1"), true);
  assert.deepEqual(harness.completedWatchers, []);

  await harness.coordinator.completeReminderForWorker("channel-a", "public", workerId);

  assert.equal(harness.store.tasks.has("reminder-1"), false);
  assert.deepEqual(harness.completedWatchers, [{ kind: "reminder", id: "reminder-1" }]);

  await harness.coordinator.completeReminderForWorker("channel-a", "public", workerId);
  assert.deepEqual(harness.completedWatchers, [{ kind: "reminder", id: "reminder-1" }]);
});

test("keeps a repeating reminder due until its worker result completes the occurrence", async () => {
  const repeating: ReminderTask = {
    ...reminder,
    id: "reminder-repeating",
    schedule: { type: "every", minutes: 30 },
  };
  const harness = createHarness({ tasks: [repeating] });

  await harness.coordinator.deliverDueTasks(Date.parse(repeating.nextRunAt));

  const workerId = reminderWorkerId(repeating);
  assert.equal(harness.workerStarts.length, 1);
  const running = harness.storedReminder("reminder-repeating");
  assert.equal(running?.runningWorkerId, workerId);
  assert.equal(running?.attempts, 1);
  assert.deepEqual(harness.completedWatchers, []);

  const before = Date.now();
  await harness.coordinator.completeReminderForWorker("channel-a", "public", workerId);

  const stored = harness.storedReminder("reminder-repeating");
  assert.ok(stored);
  assert.equal(stored.runningWorkerId, undefined);
  assert.equal(stored.attempts, undefined);
  assert.equal(stored.lastError, undefined);
  assert.ok(Date.parse(stored.nextRunAt) > before);
  assert.deepEqual(harness.completedWatchers, []);
});

test("waits for an existing reminder worker instead of starting another", async () => {
  const harness = createHarness({ tasks: [reminder] });
  const dueAt = Date.parse(reminder.nextRunAt);

  await harness.coordinator.deliverDueTasks(dueAt);
  await harness.coordinator.deliverDueTasks(dueAt + 10_000);

  assert.equal(harness.workerStarts.length, 1);
  assert.equal(harness.storedReminder()?.runningWorkerId, reminderWorkerId(reminder));
  assert.equal(harness.storedReminder()?.attempts, 1);
});

test("retries a reminder whose worker disappeared before recording a result", async () => {
  const harness = createHarness({ tasks: [reminder] });
  const dueAt = Date.parse(reminder.nextRunAt);
  await harness.coordinator.deliverDueTasks(dueAt);
  const workerId = reminderWorkerId(reminder);
  harness.removeWorker(workerId);

  await harness.coordinator.deliverDueTasks(dueAt + 10_000);

  const released = harness.storedReminder();
  assert.equal(released?.runningWorkerId, undefined);
  assert.equal(released?.attempts, 1);
  assert.match(released?.lastError ?? "", /disappeared/u);
  assert.equal(harness.workerStarts.length, 1);

  await harness.coordinator.deliverDueTasks(dueAt + 20_000);

  assert.equal(harness.workerStarts.length, 2);
  assert.equal(harness.workerStarts[1]?.id, workerId);
  assert.equal(harness.storedReminder()?.attempts, 2);
  assert.equal(harness.storedReminder()?.runningWorkerId, workerId);
});

test("leaves a reminder due with its attempt and error when the worker fails to start", async () => {
  const harness = createHarness({ tasks: [reminder] });
  const dueAt = Date.parse(reminder.nextRunAt);
  harness.failNextStart("boom");

  await harness.coordinator.deliverDueTasks(dueAt);

  assert.equal(harness.workerStarts.length, 1);
  const failed = harness.storedReminder();
  assert.equal(failed?.runningWorkerId, undefined);
  assert.equal(failed?.attempts, 1);
  assert.equal(failed?.lastError, "boom");
  assert.equal(harness.store.tasks.has("reminder-1"), true);
  assert.deepEqual(harness.completedWatchers, []);

  await harness.coordinator.deliverDueTasks(dueAt + 10_000);

  assert.equal(harness.workerStarts.length, 2);
  assert.equal(harness.storedReminder()?.attempts, 2);
  assert.equal(harness.storedReminder()?.runningWorkerId, reminderWorkerId(reminder));
});

test("adopts a reminder worker that already exists after a start error", async () => {
  const harness = createHarness({ tasks: [reminder] });
  const workerId = reminderWorkerId(reminder);
  harness.addWorker(workerId);
  harness.failNextStart(`Worker already exists: ${workerId}`);

  await harness.coordinator.deliverDueTasks(Date.parse(reminder.nextRunAt));

  const running = harness.storedReminder();
  assert.equal(running?.runningWorkerId, workerId);
  assert.equal(running?.attempts, 1);
  assert.equal(running?.lastError, undefined);
});

test("fails a one-time reminder whose worker attempts are exhausted", async () => {
  const harness = createHarness({ tasks: [reminder] });
  const dueAt = Date.parse(reminder.nextRunAt);
  for (let attempt = 1; attempt <= MAX_REMINDER_WORKER_ATTEMPTS; attempt += 1) {
    harness.failNextStart("boom");
    await harness.coordinator.deliverDueTasks(dueAt + attempt);
    assert.equal(harness.workerStarts.length, attempt);
    assert.equal(harness.storedReminder()?.attempts, attempt);
  }
  assert.equal(harness.store.tasks.has("reminder-1"), true);

  await harness.coordinator.deliverDueTasks(dueAt + MAX_REMINDER_WORKER_ATTEMPTS + 1);

  assert.equal(harness.workerStarts.length, MAX_REMINDER_WORKER_ATTEMPTS);
  assert.equal(harness.store.tasks.has("reminder-1"), false);
  assert.deepEqual(harness.completedWatchers, [{ kind: "reminder", id: "reminder-1" }]);
});

test("advances a repeating reminder whose worker attempts are exhausted", async () => {
  const repeating: ReminderTask = {
    ...reminder,
    id: "reminder-repeating",
    schedule: { type: "every", minutes: 30 },
    attempts: MAX_REMINDER_WORKER_ATTEMPTS,
  };
  const harness = createHarness({ tasks: [repeating] });

  const before = Date.now();
  await harness.coordinator.deliverDueTasks(Date.parse(repeating.nextRunAt));

  assert.equal(harness.workerStarts.length, 0);
  const stored = harness.storedReminder("reminder-repeating");
  assert.ok(stored);
  assert.equal(stored.runningWorkerId, undefined);
  assert.equal(stored.attempts, undefined);
  assert.equal(stored.lastError, undefined);
  assert.ok(Date.parse(stored.nextRunAt) > before);
  assert.deepEqual(harness.completedWatchers, []);
});

test("releases a reminder whose worker closed without a result", async () => {
  const harness = createHarness({ tasks: [reminder] });
  const dueAt = Date.parse(reminder.nextRunAt);
  await harness.coordinator.deliverDueTasks(dueAt);
  const workerId = reminderWorkerId(reminder);

  await harness.coordinator.releaseReminderWorker("channel-a", "public", workerId);

  const released = harness.storedReminder();
  assert.equal(released?.runningWorkerId, undefined);
  assert.equal(released?.attempts, 1);
  assert.match(released?.lastError ?? "", /closed/u);
  assert.equal(released?.nextRunAt, reminder.nextRunAt);

  await harness.coordinator.releaseReminderWorker("channel-a", "public", "other-worker");
  assert.equal(harness.storedReminder()?.attempts, 1);

  await harness.coordinator.deliverDueTasks(dueAt + 10_000);

  assert.equal(harness.workerStarts.length, 2);
  assert.equal(harness.storedReminder()?.attempts, 2);
  assert.equal(harness.storedReminder()?.runningWorkerId, workerId);
});

test("does not deliver a reminder deleted between the due list and its delivery", async () => {
  let listCalls = 0;
  const store = new InMemoryScheduledTaskStore([reminder], {
    onListForScope: (kind, channelId, accessScope) => {
      if (kind !== "reminder" || channelId !== "channel-a" || accessScope !== "public") return;
      listCalls += 1;
      if (listCalls === 2) store.tasks.delete("reminder-1");
    },
  });
  const harness = createHarness({ store });

  await harness.coordinator.deliverDueTasks(Date.parse(reminder.nextRunAt));

  assert.equal(harness.workerStarts.length, 0);
  assert.equal(store.tasks.has("reminder-1"), false);
});

function eventText(event: AgentEvent | undefined): string {
  return (
    event?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? ""
  );
}
