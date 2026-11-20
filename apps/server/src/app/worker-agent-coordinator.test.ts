import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import type { WorkerScope, WorkerStartInput } from "@agents/core/worker-agent";
import type { AccessScope } from "@shared/access";
import type {
  AgentCreationOptions,
  AgentFactory,
  AgentToolContext,
} from "@agents/core/agent-factory";
import type { AgentRuntime } from "@agents/core/agent-runtime";
import {
  WORKER_IDLE_CLOSE_MS,
  WorkerAgentCoordinator,
  type WorkerDelivery,
  type WorkerReference,
  type ClosedWorker,
} from "./worker-agent-coordinator";
import type { WorkerStore, StoredWorker } from "./worker-store";
import { TaskCoordinator } from "./task-coordinator";

function scope(channelId: string, accessScope: AccessScope = "public"): WorkerScope {
  return {
    conversationKey: { kind: "discord", channelId },
    accessScope,
  };
}

function startInput(
  channelId: string,
  prompt: string,
  options: {
    readonly accessScope?: AccessScope;
    readonly ownerFeaturesAllowed?: boolean;
    readonly closeAfterResult?: boolean;
  } = {},
): WorkerStartInput {
  return {
    ...scope(channelId, options.accessScope ?? "public"),
    ownerFeaturesAllowed: options.ownerFeaturesAllowed ?? false,
    prompt,
    ...(options.closeAfterResult !== undefined
      ? { closeAfterResult: options.closeAfterResult }
      : {}),
  };
}

class MemoryWorkerStore implements WorkerStore {
  readonly workers = new Map<string, StoredWorker>();

  async list(): Promise<readonly StoredWorker[]> {
    return [...this.workers.values()];
  }

  async save(worker: StoredWorker): Promise<void> {
    this.workers.set(worker.id, worker);
  }

  async delete(id: string): Promise<void> {
    this.workers.delete(id);
  }
}

interface Harness {
  readonly coordinator: WorkerAgentCoordinator;
  readonly prompts: string[];
  readonly disposed: string[];
  readonly deliveries: WorkerDelivery[];
  readonly closedWorkers: ClosedWorker[];
  readonly roles: AgentCreationOptions["role"][];
  readonly resumeSessions: (boolean | undefined)[];
  readonly toolWorkerIds: string[];
  readonly receivedToolContexts: AgentToolContext[];
  readonly store: MemoryWorkerStore;
  readonly taskCoordinator: TaskCoordinator;
}

function createHarness(
  createRuntime?: (options: AgentCreationOptions) => Promise<AgentRuntime>,
  store = new MemoryWorkerStore(),
  options?: {
    readonly idleCloseMs?: number;
    readonly hasOwnedWatches?: (worker: WorkerReference) => Promise<boolean>;
    readonly onResult?: (delivery: WorkerDelivery) => Promise<void>;
    readonly onWorkerClosed?: (worker: ClosedWorker) => Promise<void>;
    readonly toolContext?: AgentToolContext;
  },
): Harness {
  const prompts: string[] = [];
  const disposed: string[] = [];
  const deliveries: WorkerDelivery[] = [];
  const closedWorkers: ClosedWorker[] = [];
  const roles: AgentCreationOptions["role"][] = [];
  const resumeSessions: (boolean | undefined)[] = [];
  const toolWorkerIds: string[] = [];
  const receivedToolContexts: AgentToolContext[] = [];
  const taskCoordinator = new TaskCoordinator();
  const factory: AgentFactory = {
    async create(_definition, createTools, creationOptions) {
      roles.push(creationOptions.role);
      resumeSessions.push(creationOptions.resumeSession);
      createTools(options?.toolContext ?? { requesterId: () => undefined });
      if (createRuntime) return createRuntime(creationOptions);
      return {
        async prompt(turn) {
          const text = turn.event.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          prompts.push(text);
          return `result for ${text}`;
        },
        dispose() {
          disposed.push(creationOptions.sessionKey);
        },
      };
    },
  };
  const coordinator = new WorkerAgentCoordinator({
    factory,
    systemPrompt: "system",
    logger: pino({ level: "silent" }),
    store,
    taskCoordinator,
    ...(options?.idleCloseMs !== undefined ? { idleCloseMs: options.idleCloseMs } : {}),
    ...(options?.hasOwnedWatches ? { hasOwnedWatches: options.hasOwnedWatches } : {}),
    createTools: (_conversationKey, _accessScope, workerId, toolContext) => {
      toolWorkerIds.push(workerId);
      receivedToolContexts.push(toolContext);
      return [];
    },
    onResult: async (delivery) => {
      deliveries.push(delivery);
      await options?.onResult?.(delivery);
    },
    onWorkerClosed: async (worker) => {
      closedWorkers.push(worker);
      await options?.onWorkerClosed?.(worker);
    },
  });
  return {
    coordinator,
    prompts,
    disposed,
    deliveries,
    closedWorkers,
    roles,
    resumeSessions,
    toolWorkerIds,
    receivedToolContexts,
    store,
    taskCoordinator,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error("condition was not met");
}

test("starts a worker and delivers the worker's text to the conversation", async () => {
  const harness = createHarness();
  const workerId = await harness.coordinator.start(startInput("channel-1", "investigate"));

  assert.match(workerId, /^worker-/);
  assert.deepEqual(harness.roles, [{ kind: "worker", workerId }]);
  await waitFor(() => harness.deliveries.length === 1);
  assert.deepEqual(harness.deliveries[0], {
    conversationKey: { kind: "discord", channelId: "channel-1" },
    accessScope: "public",
    result: { workerId, status: "completed", text: "result for investigate" },
  });
  assert.deepEqual(harness.prompts, ["investigate"]);
});

test("passes the worker id to its tools", async () => {
  const harness = createHarness();
  const workerId = await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  assert.deepEqual(harness.toolWorkerIds, [workerId]);
});

test("queues follow-ups on the same session", async () => {
  const harness = createHarness();
  const workerId = await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  assert.equal(await harness.coordinator.send(scope("channel-1"), workerId, "second"), true);
  await waitFor(() => harness.deliveries.length === 2);
  assert.deepEqual(harness.prompts, ["first", "second"]);
  assert.equal(harness.deliveries[1]?.result.text, "result for second");
});

test("closes a worker and disposes its session", async () => {
  const harness = createHarness();
  const workerId = await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  assert.equal(await harness.coordinator.close(scope("channel-1"), workerId), true);
  assert.deepEqual(harness.disposed, [workerId]);
  assert.deepEqual(harness.coordinator.list(scope("channel-1")), []);
  assert.equal(await harness.coordinator.send(scope("channel-1"), workerId, "late"), false);
});

test("lists only the workers of the requested conversation", async () => {
  const harness = createHarness();
  const first = await harness.coordinator.start(startInput("channel-1", "first"));
  const second = await harness.coordinator.start(startInput("channel-2", "second"));
  await waitFor(() => harness.deliveries.length === 2);

  const workers = harness.coordinator.list(scope("channel-1"));
  assert.equal(workers.length, 1);
  assert.equal(workers[0]?.id, first);
  assert.equal(workers[0]?.status, "idle");
  assert.notEqual(first, second);
});

test("closes a worker after delivering its result when requested", async () => {
  const harness = createHarness();
  const workerId = await harness.coordinator.start(
    startInput("channel-1", "remind", { closeAfterResult: true }),
  );

  await waitFor(() => harness.deliveries.length === 1);
  await waitFor(() => harness.disposed.length === 1);
  assert.deepEqual(harness.disposed, [workerId]);
  assert.deepEqual(harness.coordinator.list(scope("channel-1")), []);
  assert.equal(harness.store.workers.has(workerId), false);
});

test("restores a saved worker and resumes its session on the next prompt", async () => {
  const store = new MemoryWorkerStore();
  const first = createHarness(undefined, store);
  const workerId = await first.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => first.deliveries.length === 1);
  await first.coordinator.dispose();

  const second = createHarness(undefined, store);
  await second.coordinator.load();
  const workers = second.coordinator.list(scope("channel-1"));
  assert.equal(workers.length, 1);
  assert.equal(workers[0]?.id, workerId);
  assert.equal(workers[0]?.status, "idle");
  assert.deepEqual(second.resumeSessions, []);

  assert.equal(await second.coordinator.send(scope("channel-1"), workerId, "second"), true);
  await waitFor(() => second.deliveries.length === 1);
  assert.deepEqual(second.resumeSessions, [true]);
  assert.deepEqual(second.prompts, ["second"]);
  assert.equal(second.deliveries[0]?.result.text, "result for second");
});

test("marks a worker that was running at shutdown as interrupted", async () => {
  const store = new MemoryWorkerStore();
  await store.save({
    id: "worker-1",
    conversationKey: { kind: "discord", channelId: "channel-1" },
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "first",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closeAfterResult: false,
  });

  const harness = createHarness(undefined, store);
  await harness.coordinator.load();

  assert.equal(harness.coordinator.list(scope("channel-1"))[0]?.status, "interrupted");
  assert.equal(store.workers.get("worker-1")?.status, "interrupted");
});

test("keeps the saved workers when the process disposes the coordinator", async () => {
  const harness = createHarness();
  const workerId = await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  await harness.coordinator.dispose();

  assert.equal(harness.store.workers.has(workerId), true);
  assert.deepEqual(harness.coordinator.list(scope("channel-1")), []);
});

test("delivers a failed result when the worker throws", async () => {
  const harness = createHarness(async () => ({
    async prompt() {
      throw new Error("boom");
    },
    dispose() {},
  }));
  await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  assert.equal(harness.deliveries[0]?.result.status, "failed");
  assert.equal(harness.deliveries[0]?.result.error, "boom");
});

test("aborts a running worker on dispose, marks it interrupted, and lets taskCoordinator complete", async () => {
  let promptStarted = false;
  let aborted = false;
  let disposed = false;
  let releasePrompt: (() => void) | undefined;
  const harness = createHarness(async () => ({
    async prompt() {
      promptStarted = true;
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      return undefined;
    },
    async abort() {
      aborted = true;
      releasePrompt?.();
    },
    dispose() {
      disposed = true;
    },
  }));

  const workerId = await harness.coordinator.start(startInput("channel-1", "long work"));
  await waitFor(() => promptStarted);

  await harness.coordinator.dispose();
  await harness.taskCoordinator.waitForCompletion();

  assert.equal(aborted, true);
  assert.equal(disposed, true);
  assert.equal(harness.deliveries.length, 0);
  assert.equal(harness.store.workers.get(workerId)?.status, "interrupted");
});

test("deletes closeAfterResult workers on dispose instead of keeping them interrupted", async () => {
  let promptStarted = false;
  let releasePrompt: (() => void) | undefined;
  const harness = createHarness(async () => ({
    async prompt() {
      promptStarted = true;
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      return undefined;
    },
    async abort() {
      releasePrompt?.();
    },
    dispose() {},
  }));

  const workerId = await harness.coordinator.start(
    startInput("channel-1", "remind", {
      accessScope: "owner:123",
      ownerFeaturesAllowed: true,
      closeAfterResult: true,
    }),
  );
  await waitFor(() => promptStarted);

  await harness.coordinator.dispose();

  assert.equal(harness.store.workers.has(workerId), false);
  assert.deepEqual(harness.closedWorkers, [
    {
      id: workerId,
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "owner:123",
    },
  ]);
});

test("cleans up leftover closeAfterResult workers during load", async () => {
  const store = new MemoryWorkerStore();
  await store.save({
    id: "worker-1",
    conversationKey: { kind: "discord", channelId: "channel-1" },
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "remind",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closeAfterResult: true,
  });

  const harness = createHarness(undefined, store);
  await harness.coordinator.load();

  assert.deepEqual(harness.coordinator.list(scope("channel-1")), []);
  assert.equal(store.workers.has("worker-1"), false);
  assert.deepEqual(harness.closedWorkers, [
    {
      id: "worker-1",
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "public",
    },
  ]);
});

test("aborts a running worker on close, runs onWorkerClosed, and prevents stale persistence", async () => {
  let promptStarted = false;
  let aborted = false;
  let disposed = false;
  let releasePrompt: (() => void) | undefined;
  const harness = createHarness(async () => ({
    async prompt() {
      promptStarted = true;
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      return undefined;
    },
    async abort() {
      aborted = true;
      releasePrompt?.();
    },
    dispose() {
      disposed = true;
    },
  }));

  const workerId = await harness.coordinator.start(startInput("channel-1", "investigate"));
  await waitFor(() => promptStarted);

  assert.equal(await harness.coordinator.close(scope("channel-1"), workerId), true);
  await harness.taskCoordinator.waitForCompletion();

  assert.equal(aborted, true);
  assert.equal(disposed, true);
  assert.equal(harness.deliveries.length, 0);
  assert.equal(harness.store.workers.has(workerId), false);
  assert.deepEqual(harness.closedWorkers, [
    {
      id: workerId,
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "public",
    },
  ]);
});

test("closing a worker while onResult is waiting does not deadlock", async () => {
  let releaseDelivery: (() => void) | undefined;
  let deliveryStarted = false;
  let workerId = "";
  const harness = createHarness(undefined, new MemoryWorkerStore(), {
    onResult: async () => {
      deliveryStarted = true;
      await new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
    },
  });

  workerId = await harness.coordinator.start(
    startInput("channel-1", "investigate", { closeAfterResult: true }),
  );
  await waitFor(() => deliveryStarted);

  assert.equal(await harness.coordinator.close(scope("channel-1"), workerId), true);
  assert.equal(harness.closedWorkers.length, 1);
  releaseDelivery?.();
  await harness.taskCoordinator.waitForCompletion();
  assert.equal(harness.closedWorkers.length, 1);
});

test("rejects new starts and ignores send/close after dispose", async () => {
  const harness = createHarness();
  const workerId = await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  await harness.coordinator.dispose();

  await assert.rejects(
    () => harness.coordinator.start(startInput("channel-1", "after")),
    /disposed/,
  );
  assert.equal(await harness.coordinator.send(scope("channel-1"), workerId, "follow-up"), false);
  assert.equal(await harness.coordinator.close(scope("channel-1"), workerId), false);
});

test("closeIdleWorkers closes idle workers past the timeout unless they own watches", async () => {
  const watchedIds = new Set<string>();
  const checkedWatchRefs: WorkerReference[] = [];
  const harness = createHarness(undefined, new MemoryWorkerStore(), {
    hasOwnedWatches: async (worker) => {
      checkedWatchRefs.push(worker);
      return watchedIds.has(worker.id);
    },
  });

  const idleWorkerId = await harness.coordinator.start(startInput("channel-1", "idle worker"));
  const watchedWorkerId = await harness.coordinator.start(
    startInput("channel-1", "watched worker", {
      accessScope: "owner:123",
      ownerFeaturesAllowed: true,
    }),
  );
  watchedIds.add(watchedWorkerId);
  await waitFor(() => harness.deliveries.length === 2);
  await harness.taskCoordinator.waitForCompletion();

  const idleWorker = harness.store.workers.get(idleWorkerId);
  if (!idleWorker) assert.fail("Expected idle worker to be stored");
  const updatedAtMs = Date.parse(idleWorker.updatedAt);
  assert.equal(
    await harness.coordinator.closeIdleWorkers(updatedAtMs + WORKER_IDLE_CLOSE_MS - 1),
    0,
  );
  assert.equal(harness.coordinator.list(scope("channel-1", "public")).length, 1);
  assert.equal(harness.coordinator.list(scope("channel-1", "owner:123")).length, 1);

  assert.equal(
    await harness.coordinator.closeIdleWorkers(updatedAtMs + WORKER_IDLE_CLOSE_MS + 1_000),
    1,
  );
  assert.deepEqual(checkedWatchRefs, [
    {
      id: idleWorkerId,
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "public",
    },
    {
      id: watchedWorkerId,
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "owner:123",
    },
  ]);
  assert.deepEqual(harness.disposed, [idleWorkerId]);
  assert.equal(harness.store.workers.has(idleWorkerId), false);
  assert.deepEqual(harness.closedWorkers, [
    {
      id: idleWorkerId,
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "public",
    },
  ]);
  assert.deepEqual(harness.coordinator.list(scope("channel-1", "public")), []);
  assert.deepEqual(
    harness.coordinator.list(scope("channel-1", "owner:123")).map((worker) => worker.id),
    [watchedWorkerId],
  );
});

test("closeIdleWorkers skips running workers, watch-check failures, and workers receiving a concurrent send", async () => {
  let releaseRunning: (() => void) | undefined;
  let runningStarted = false;
  let watchCheckStarted = false;
  let releaseWatchCheck: (() => void) | undefined;
  let failWatchCheckFor: string | undefined;

  const harness = createHarness(
    async (creationOptions) => {
      if (creationOptions.sessionKey === failWatchCheckFor) {
        return {
          async prompt() {
            return "ok";
          },
          dispose() {},
        };
      }
      return {
        async prompt(turn) {
          const text = turn.event.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          if (text === "long") {
            runningStarted = true;
            await new Promise<void>((resolve) => {
              releaseRunning = resolve;
            });
          }
          return "done";
        },
        dispose() {},
      };
    },
    new MemoryWorkerStore(),
    {
      hasOwnedWatches: async ({ id }) => {
        if (id === failWatchCheckFor) {
          throw new Error("watch store unavailable");
        }
        watchCheckStarted = true;
        await new Promise<void>((resolve) => {
          releaseWatchCheck = resolve;
        });
        return false;
      },
    },
  );

  const sendRaceWorkerId = await harness.coordinator.start(startInput("channel-1", "quick"));
  const watchErrorWorkerId = await harness.coordinator.start(startInput("channel-1", "quick"));
  failWatchCheckFor = watchErrorWorkerId;
  await waitFor(() => harness.deliveries.length === 2);
  await harness.taskCoordinator.waitForCompletion();

  const runningWorkerId = await harness.coordinator.start(startInput("channel-1", "long"));
  await waitFor(() => runningStarted);

  const cleanupPromise = harness.coordinator.closeIdleWorkers(
    Date.now() + WORKER_IDLE_CLOSE_MS + 10_000,
  );
  await waitFor(() => watchCheckStarted);
  assert.equal(
    await harness.coordinator.send(scope("channel-1"), sendRaceWorkerId, "follow-up"),
    true,
  );
  releaseWatchCheck?.();

  assert.equal(await cleanupPromise, 0);
  await waitFor(() => harness.deliveries.length === 3);
  assert.equal(harness.coordinator.list(scope("channel-1")).length, 3);

  releaseRunning?.();
  await waitFor(() => harness.deliveries.length === 4);
  await harness.taskCoordinator.waitForCompletion();
  assert.equal(harness.store.workers.has(runningWorkerId), true);
  assert.equal(harness.store.workers.has(sendRaceWorkerId), true);
  assert.equal(harness.store.workers.has(watchErrorWorkerId), true);
});

test("closeIdleWorkers closes failed and restored interrupted workers after timeout", async () => {
  const store = new MemoryWorkerStore();
  const staleTime = "2026-01-01T00:00:00.000Z";
  await store.save({
    id: "worker-interrupted",
    conversationKey: { kind: "discord", channelId: "channel-1" },
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "restored",
    status: "interrupted",
    createdAt: staleTime,
    updatedAt: staleTime,
    closeAfterResult: false,
  });

  const harness = createHarness(
    async () => ({
      async prompt() {
        throw new Error("boom");
      },
      dispose() {},
    }),
    store,
  );
  await harness.coordinator.load();

  const failedWorkerId = await harness.coordinator.start(startInput("channel-1", "fail"));
  await waitFor(() => harness.deliveries.length === 1);
  await harness.taskCoordinator.waitForCompletion();

  const futureNow = Date.now() + WORKER_IDLE_CLOSE_MS + 1_000;
  assert.equal(await harness.coordinator.closeIdleWorkers(futureNow), 2);
  assert.deepEqual(harness.coordinator.list(scope("channel-1")), []);
  assert.equal(store.workers.has("worker-interrupted"), false);
  assert.equal(store.workers.has(failedWorkerId), false);
});

test("forwards AgentToolContext to createTools for started and restored workers", async () => {
  const store = new MemoryWorkerStore();
  await store.save({
    id: "worker-restored",
    conversationKey: { kind: "discord", channelId: "channel-1" },
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "restored",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closeAfterResult: false,
  });
  const toolContext: AgentToolContext = {
    analyzeImage: async () => "解析結果",
    requesterId: () => undefined,
  };
  const harness = createHarness(undefined, store, { toolContext });
  await harness.coordinator.load();

  await harness.coordinator.start(startInput("channel-1", "new worker"));
  assert.equal(
    await harness.coordinator.send(scope("channel-1"), "worker-restored", "follow-up"),
    true,
  );
  await waitFor(() => harness.deliveries.length === 2);
  await harness.taskCoordinator.waitForCompletion();

  assert.equal(harness.receivedToolContexts.length, 2);
  assert.equal(harness.receivedToolContexts[0], toolContext);
  assert.equal(harness.receivedToolContexts[1], toolContext);
});

test("isolates send, close, and list across channels and accessScopes", async () => {
  const harness = createHarness();
  const ownerWorkerId = await harness.coordinator.start(
    startInput("channel-1", "owner work", {
      accessScope: "owner:123",
      ownerFeaturesAllowed: true,
    }),
  );
  const publicWorkerId = await harness.coordinator.start(startInput("channel-1", "public work"));
  await waitFor(() => harness.deliveries.length === 2);

  assert.deepEqual(
    harness.coordinator.list(scope("channel-1", "owner:123")).map((worker) => worker.id),
    [ownerWorkerId],
  );
  assert.deepEqual(
    harness.coordinator.list(scope("channel-1", "public")).map((worker) => worker.id),
    [publicWorkerId],
  );

  assert.equal(
    await harness.coordinator.send(scope("channel-2", "owner:123"), ownerWorkerId, "cross-channel"),
    false,
  );
  assert.equal(
    await harness.coordinator.close(scope("channel-2", "owner:123"), ownerWorkerId),
    false,
  );

  assert.equal(
    await harness.coordinator.send(scope("channel-1", "public"), ownerWorkerId, "cross-scope"),
    false,
  );
  assert.equal(await harness.coordinator.close(scope("channel-1", "public"), ownerWorkerId), false);

  await harness.taskCoordinator.waitForCompletion();
  assert.equal(harness.prompts.length, 2);
  assert.equal(harness.disposed.length, 0);

  assert.equal(
    await harness.coordinator.send(
      scope("channel-1", "owner:123"),
      ownerWorkerId,
      "owner follow-up",
    ),
    true,
  );
  await waitFor(() => harness.deliveries.length === 3);
  assert.equal(harness.prompts[2], "owner follow-up");
  assert.equal(
    await harness.coordinator.close(scope("channel-1", "owner:123"), ownerWorkerId),
    true,
  );
  assert.deepEqual(harness.disposed, [ownerWorkerId]);
});

test("enforces conversationKey and accessScope boundaries for restored workers", async () => {
  const store = new MemoryWorkerStore();
  await store.save({
    id: "worker-owner",
    conversationKey: { kind: "discord", channelId: "channel-1" },
    accessScope: "owner:123",
    ownerFeaturesAllowed: true,
    prompt: "owner worker",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closeAfterResult: false,
  });

  const harness = createHarness(undefined, store);
  await harness.coordinator.load();

  assert.deepEqual(harness.coordinator.list(scope("channel-1", "public")), []);
  assert.equal(
    await harness.coordinator.send(scope("channel-1", "public"), "worker-owner", "hijack"),
    false,
  );
  assert.equal(
    await harness.coordinator.close(scope("channel-2", "owner:123"), "worker-owner"),
    false,
  );
  assert.equal(
    harness.coordinator.list(scope("channel-1", "owner:123")).map((worker) => worker.id).length,
    1,
  );
  assert.equal(
    await harness.coordinator.close(scope("channel-1", "owner:123"), "worker-owner"),
    true,
  );
  assert.equal(store.workers.has("worker-owner"), false);
});
