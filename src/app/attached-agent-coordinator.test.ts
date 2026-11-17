import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import type { AttachedTaskScope, AttachedTaskStartInput } from "@agents/core/attached-agent";
import type {
  AgentCreationOptions,
  AgentFactory,
  AgentToolContext,
} from "@agents/core/agent-factory";
import type { AgentRuntime } from "@agents/core/agent-runtime";
import {
  ATTACHED_TASK_IDLE_CLOSE_MS,
  AttachedAgentCoordinator,
  type AttachedTaskDelivery,
  type AttachedTaskReference,
  type ClosedAttachedTask,
} from "./attached-agent-coordinator";
import type { AttachedTaskStore, StoredAttachedTask } from "./attached-task-store";
import { TaskCoordinator } from "./task-coordinator";

function scope(channelId: string, accessScope = "public"): AttachedTaskScope {
  return {
    conversationKey: { kind: "discord", channelId },
    accessScope,
  };
}

function startInput(
  channelId: string,
  prompt: string,
  options: {
    readonly accessScope?: string;
    readonly ownerFeaturesAllowed?: boolean;
    readonly closeAfterResult?: boolean;
  } = {},
): AttachedTaskStartInput {
  return {
    ...scope(channelId, options.accessScope ?? "public"),
    ownerFeaturesAllowed: options.ownerFeaturesAllowed ?? false,
    prompt,
    ...(options.closeAfterResult !== undefined
      ? { closeAfterResult: options.closeAfterResult }
      : {}),
  };
}

class MemoryTaskStore implements AttachedTaskStore {
  readonly tasks = new Map<string, StoredAttachedTask>();

  async list(): Promise<readonly StoredAttachedTask[]> {
    return [...this.tasks.values()];
  }

  async save(task: StoredAttachedTask): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async delete(id: string): Promise<void> {
    this.tasks.delete(id);
  }
}

interface Harness {
  readonly coordinator: AttachedAgentCoordinator;
  readonly prompts: string[];
  readonly disposed: string[];
  readonly deliveries: AttachedTaskDelivery[];
  readonly closedTasks: ClosedAttachedTask[];
  readonly roles: AgentCreationOptions["role"][];
  readonly resumeSessions: (boolean | undefined)[];
  readonly toolTaskIds: string[];
  readonly receivedToolContexts: AgentToolContext[];
  readonly store: MemoryTaskStore;
  readonly taskCoordinator: TaskCoordinator;
}

function createHarness(
  createRuntime?: (options: AgentCreationOptions) => Promise<AgentRuntime>,
  store = new MemoryTaskStore(),
  options?: {
    readonly idleCloseMs?: number;
    readonly hasOwnedWatches?: (task: AttachedTaskReference) => Promise<boolean>;
    readonly onResult?: (delivery: AttachedTaskDelivery) => Promise<void>;
    readonly onTaskClosed?: (task: ClosedAttachedTask) => Promise<void>;
    readonly toolContext?: AgentToolContext;
  },
): Harness {
  const prompts: string[] = [];
  const disposed: string[] = [];
  const deliveries: AttachedTaskDelivery[] = [];
  const closedTasks: ClosedAttachedTask[] = [];
  const roles: AgentCreationOptions["role"][] = [];
  const resumeSessions: (boolean | undefined)[] = [];
  const toolTaskIds: string[] = [];
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
  const coordinator = new AttachedAgentCoordinator({
    factory,
    systemPrompt: "system",
    logger: pino({ level: "silent" }),
    store,
    taskCoordinator,
    ...(options?.idleCloseMs !== undefined ? { idleCloseMs: options.idleCloseMs } : {}),
    ...(options?.hasOwnedWatches ? { hasOwnedWatches: options.hasOwnedWatches } : {}),
    createTools: (_conversationKey, _accessScope, taskId, toolContext) => {
      toolTaskIds.push(taskId);
      receivedToolContexts.push(toolContext);
      return [];
    },
    onResult: async (delivery) => {
      deliveries.push(delivery);
      await options?.onResult?.(delivery);
    },
    onTaskClosed: async (task) => {
      closedTasks.push(task);
      await options?.onTaskClosed?.(task);
    },
  });
  return {
    coordinator,
    prompts,
    disposed,
    deliveries,
    closedTasks,
    roles,
    resumeSessions,
    toolTaskIds,
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

test("starts a task and delivers the worker's text to the conversation", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start(startInput("channel-1", "investigate"));

  assert.match(taskId, /^attached-/);
  assert.deepEqual(harness.roles, [{ kind: "attached", taskId }]);
  await waitFor(() => harness.deliveries.length === 1);
  assert.deepEqual(harness.deliveries[0], {
    conversationKey: { kind: "discord", channelId: "channel-1" },
    accessScope: "public",
    result: { taskId, status: "completed", text: "result for investigate" },
  });
  assert.deepEqual(harness.prompts, ["investigate"]);
});

test("gives each worker its own task id to its tools", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  assert.deepEqual(harness.toolTaskIds, [taskId]);
});

test("queues follow-ups on the same session", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  assert.equal(await harness.coordinator.send(scope("channel-1"), taskId, "second"), true);
  await waitFor(() => harness.deliveries.length === 2);
  assert.deepEqual(harness.prompts, ["first", "second"]);
  assert.equal(harness.deliveries[1]?.result.text, "result for second");
});

test("closes a task and disposes its session", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  assert.equal(await harness.coordinator.close(scope("channel-1"), taskId), true);
  assert.deepEqual(harness.disposed, [taskId]);
  assert.deepEqual(harness.coordinator.list(scope("channel-1")), []);
  assert.equal(await harness.coordinator.send(scope("channel-1"), taskId, "late"), false);
});

test("lists only the tasks of the requested conversation", async () => {
  const harness = createHarness();
  const first = await harness.coordinator.start(startInput("channel-1", "first"));
  const second = await harness.coordinator.start(startInput("channel-2", "second"));
  await waitFor(() => harness.deliveries.length === 2);

  const tasks = harness.coordinator.list(scope("channel-1"));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, first);
  assert.equal(tasks[0]?.status, "idle");
  assert.notEqual(first, second);
});

test("closes a task after delivering its result when requested", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start(
    startInput("channel-1", "remind", { closeAfterResult: true }),
  );

  await waitFor(() => harness.deliveries.length === 1);
  await waitFor(() => harness.disposed.length === 1);
  assert.deepEqual(harness.disposed, [taskId]);
  assert.deepEqual(harness.coordinator.list(scope("channel-1")), []);
  assert.equal(harness.store.tasks.has(taskId), false);
});

test("restores a saved task and resumes its session on the next prompt", async () => {
  const store = new MemoryTaskStore();
  const first = createHarness(undefined, store);
  const taskId = await first.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => first.deliveries.length === 1);
  await first.coordinator.dispose();

  const second = createHarness(undefined, store);
  await second.coordinator.load();
  const tasks = second.coordinator.list(scope("channel-1"));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, taskId);
  assert.equal(tasks[0]?.status, "idle");
  assert.deepEqual(second.resumeSessions, []);

  assert.equal(await second.coordinator.send(scope("channel-1"), taskId, "second"), true);
  await waitFor(() => second.deliveries.length === 1);
  assert.deepEqual(second.resumeSessions, [true]);
  assert.deepEqual(second.prompts, ["second"]);
  assert.equal(second.deliveries[0]?.result.text, "result for second");
});

test("marks a task that was running at shutdown as interrupted", async () => {
  const store = new MemoryTaskStore();
  await store.save({
    id: "attached-1",
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
  assert.equal(store.tasks.get("attached-1")?.status, "interrupted");
});

test("keeps the saved tasks when the process disposes the coordinator", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  await harness.coordinator.dispose();

  assert.equal(harness.store.tasks.has(taskId), true);
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

  const taskId = await harness.coordinator.start(startInput("channel-1", "long work"));
  await waitFor(() => promptStarted);

  await harness.coordinator.dispose();
  await harness.taskCoordinator.waitForCompletion();

  assert.equal(aborted, true);
  assert.equal(disposed, true);
  assert.equal(harness.deliveries.length, 0);
  assert.equal(harness.store.tasks.get(taskId)?.status, "interrupted");
});

test("deletes closeAfterResult tasks on dispose instead of keeping them interrupted", async () => {
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

  const taskId = await harness.coordinator.start(
    startInput("channel-1", "remind", {
      accessScope: "owner:123",
      ownerFeaturesAllowed: true,
      closeAfterResult: true,
    }),
  );
  await waitFor(() => promptStarted);

  await harness.coordinator.dispose();

  assert.equal(harness.store.tasks.has(taskId), false);
  assert.deepEqual(harness.closedTasks, [
    {
      id: taskId,
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "owner:123",
    },
  ]);
});

test("cleans up leftover closeAfterResult tasks during load", async () => {
  const store = new MemoryTaskStore();
  await store.save({
    id: "attached-1",
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
  assert.equal(store.tasks.has("attached-1"), false);
  assert.deepEqual(harness.closedTasks, [
    {
      id: "attached-1",
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "public",
    },
  ]);
});

test("aborts a running worker on close, runs onTaskClosed, and prevents stale persistence", async () => {
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

  const taskId = await harness.coordinator.start(startInput("channel-1", "investigate"));
  await waitFor(() => promptStarted);

  assert.equal(await harness.coordinator.close(scope("channel-1"), taskId), true);
  await harness.taskCoordinator.waitForCompletion();

  assert.equal(aborted, true);
  assert.equal(disposed, true);
  assert.equal(harness.deliveries.length, 0);
  assert.equal(harness.store.tasks.has(taskId), false);
  assert.deepEqual(harness.closedTasks, [
    {
      id: taskId,
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "public",
    },
  ]);
});

test("closing a worker while onResult is waiting does not deadlock", async () => {
  let releaseDelivery: (() => void) | undefined;
  let deliveryStarted = false;
  let taskId = "";
  const harness = createHarness(undefined, new MemoryTaskStore(), {
    onResult: async () => {
      deliveryStarted = true;
      await new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
    },
  });

  taskId = await harness.coordinator.start(
    startInput("channel-1", "investigate", { closeAfterResult: true }),
  );
  await waitFor(() => deliveryStarted);

  assert.equal(await harness.coordinator.close(scope("channel-1"), taskId), true);
  assert.equal(harness.closedTasks.length, 1);
  releaseDelivery?.();
  await harness.taskCoordinator.waitForCompletion();
  assert.equal(harness.closedTasks.length, 1);
});

test("rejects new starts and ignores send/close after dispose", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start(startInput("channel-1", "first"));
  await waitFor(() => harness.deliveries.length === 1);

  await harness.coordinator.dispose();

  await assert.rejects(
    () => harness.coordinator.start(startInput("channel-1", "after")),
    /disposed/,
  );
  assert.equal(await harness.coordinator.send(scope("channel-1"), taskId, "follow-up"), false);
  assert.equal(await harness.coordinator.close(scope("channel-1"), taskId), false);
});

test("closeIdleTasks closes idle tasks past the timeout unless they own watches", async () => {
  const watchedIds = new Set<string>();
  const checkedWatchRefs: AttachedTaskReference[] = [];
  const harness = createHarness(undefined, new MemoryTaskStore(), {
    hasOwnedWatches: async (task) => {
      checkedWatchRefs.push(task);
      return watchedIds.has(task.id);
    },
  });

  const idleTaskId = await harness.coordinator.start(startInput("channel-1", "idle task"));
  const watchedTaskId = await harness.coordinator.start(
    startInput("channel-1", "watched task", {
      accessScope: "owner:123",
      ownerFeaturesAllowed: true,
    }),
  );
  watchedIds.add(watchedTaskId);
  await waitFor(() => harness.deliveries.length === 2);
  await harness.taskCoordinator.waitForCompletion();

  const idleTask = harness.store.tasks.get(idleTaskId);
  if (!idleTask) assert.fail("Expected idle task to be stored");
  const updatedAtMs = Date.parse(idleTask.updatedAt);
  assert.equal(
    await harness.coordinator.closeIdleTasks(updatedAtMs + ATTACHED_TASK_IDLE_CLOSE_MS - 1),
    0,
  );
  assert.equal(harness.coordinator.list(scope("channel-1", "public")).length, 1);
  assert.equal(harness.coordinator.list(scope("channel-1", "owner:123")).length, 1);

  assert.equal(
    await harness.coordinator.closeIdleTasks(updatedAtMs + ATTACHED_TASK_IDLE_CLOSE_MS + 1_000),
    1,
  );
  assert.deepEqual(checkedWatchRefs, [
    {
      id: idleTaskId,
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "public",
    },
    {
      id: watchedTaskId,
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "owner:123",
    },
  ]);
  assert.deepEqual(harness.disposed, [idleTaskId]);
  assert.equal(harness.store.tasks.has(idleTaskId), false);
  assert.deepEqual(harness.closedTasks, [
    {
      id: idleTaskId,
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "public",
    },
  ]);
  assert.deepEqual(harness.coordinator.list(scope("channel-1", "public")), []);
  assert.deepEqual(
    harness.coordinator.list(scope("channel-1", "owner:123")).map((task) => task.id),
    [watchedTaskId],
  );
});

test("closeIdleTasks skips running tasks, watch-check failures, and tasks receiving a concurrent send", async () => {
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
    new MemoryTaskStore(),
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

  const sendRaceTaskId = await harness.coordinator.start(startInput("channel-1", "quick"));
  const watchErrorTaskId = await harness.coordinator.start(startInput("channel-1", "quick"));
  failWatchCheckFor = watchErrorTaskId;
  await waitFor(() => harness.deliveries.length === 2);
  await harness.taskCoordinator.waitForCompletion();

  const runningTaskId = await harness.coordinator.start(startInput("channel-1", "long"));
  await waitFor(() => runningStarted);

  const cleanupPromise = harness.coordinator.closeIdleTasks(
    Date.now() + ATTACHED_TASK_IDLE_CLOSE_MS + 10_000,
  );
  await waitFor(() => watchCheckStarted);
  assert.equal(
    await harness.coordinator.send(scope("channel-1"), sendRaceTaskId, "follow-up"),
    true,
  );
  releaseWatchCheck?.();

  assert.equal(await cleanupPromise, 0);
  await waitFor(() => harness.deliveries.length === 3);
  assert.equal(harness.coordinator.list(scope("channel-1")).length, 3);

  releaseRunning?.();
  await waitFor(() => harness.deliveries.length === 4);
  await harness.taskCoordinator.waitForCompletion();
  assert.equal(harness.store.tasks.has(runningTaskId), true);
  assert.equal(harness.store.tasks.has(sendRaceTaskId), true);
  assert.equal(harness.store.tasks.has(watchErrorTaskId), true);
});

test("closeIdleTasks closes failed and restored interrupted tasks after timeout", async () => {
  const store = new MemoryTaskStore();
  const staleTime = "2026-01-01T00:00:00.000Z";
  await store.save({
    id: "attached-interrupted",
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

  const failedTaskId = await harness.coordinator.start(startInput("channel-1", "fail"));
  await waitFor(() => harness.deliveries.length === 1);
  await harness.taskCoordinator.waitForCompletion();

  const futureNow = Date.now() + ATTACHED_TASK_IDLE_CLOSE_MS + 1_000;
  assert.equal(await harness.coordinator.closeIdleTasks(futureNow), 2);
  assert.deepEqual(harness.coordinator.list(scope("channel-1")), []);
  assert.equal(store.tasks.has("attached-interrupted"), false);
  assert.equal(store.tasks.has(failedTaskId), false);
});

test("forwards AgentToolContext to createTools for started and restored tasks", async () => {
  const store = new MemoryTaskStore();
  await store.save({
    id: "attached-restored",
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

  await harness.coordinator.start(startInput("channel-1", "new task"));
  assert.equal(
    await harness.coordinator.send(scope("channel-1"), "attached-restored", "follow-up"),
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
  const ownerTaskId = await harness.coordinator.start(
    startInput("channel-1", "owner work", {
      accessScope: "owner:123",
      ownerFeaturesAllowed: true,
    }),
  );
  const publicTaskId = await harness.coordinator.start(startInput("channel-1", "public work"));
  await waitFor(() => harness.deliveries.length === 2);

  assert.deepEqual(
    harness.coordinator.list(scope("channel-1", "owner:123")).map((task) => task.id),
    [ownerTaskId],
  );
  assert.deepEqual(
    harness.coordinator.list(scope("channel-1", "public")).map((task) => task.id),
    [publicTaskId],
  );

  // Another channel cannot send to or close tasks in channel-1.
  assert.equal(
    await harness.coordinator.send(scope("channel-2", "owner:123"), ownerTaskId, "cross-channel"),
    false,
  );
  assert.equal(
    await harness.coordinator.close(scope("channel-2", "owner:123"), ownerTaskId),
    false,
  );

  // Another accessScope in the same channel cannot send to or close the task.
  assert.equal(
    await harness.coordinator.send(scope("channel-1", "public"), ownerTaskId, "cross-scope"),
    false,
  );
  assert.equal(await harness.coordinator.close(scope("channel-1", "public"), ownerTaskId), false);

  await harness.taskCoordinator.waitForCompletion();
  assert.equal(harness.prompts.length, 2);
  assert.equal(harness.disposed.length, 0);

  // The owning scope can still send and close.
  assert.equal(
    await harness.coordinator.send(scope("channel-1", "owner:123"), ownerTaskId, "owner follow-up"),
    true,
  );
  await waitFor(() => harness.deliveries.length === 3);
  assert.equal(harness.prompts[2], "owner follow-up");
  assert.equal(await harness.coordinator.close(scope("channel-1", "owner:123"), ownerTaskId), true);
  assert.deepEqual(harness.disposed, [ownerTaskId]);
});

test("enforces conversationKey and accessScope boundaries for restored tasks", async () => {
  const store = new MemoryTaskStore();
  await store.save({
    id: "attached-owner",
    conversationKey: { kind: "discord", channelId: "channel-1" },
    accessScope: "owner:123",
    ownerFeaturesAllowed: true,
    prompt: "owner task",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closeAfterResult: false,
  });

  const harness = createHarness(undefined, store);
  await harness.coordinator.load();

  assert.deepEqual(harness.coordinator.list(scope("channel-1", "public")), []);
  assert.equal(
    await harness.coordinator.send(scope("channel-1", "public"), "attached-owner", "hijack"),
    false,
  );
  assert.equal(
    await harness.coordinator.close(scope("channel-2", "owner:123"), "attached-owner"),
    false,
  );
  assert.equal(
    harness.coordinator.list(scope("channel-1", "owner:123")).map((task) => task.id).length,
    1,
  );
  assert.equal(
    await harness.coordinator.close(scope("channel-1", "owner:123"), "attached-owner"),
    true,
  );
  assert.equal(store.tasks.has("attached-owner"), false);
});
