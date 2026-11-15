import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import type { AgentCreationOptions, AgentFactory } from "@agents/core/agent-factory";
import type { AgentRuntime } from "@agents/core/agent-runtime";
import { AttachedAgentCoordinator, type AttachedTaskDelivery } from "./attached-agent-coordinator";
import type { AttachedTaskStore, StoredAttachedTask } from "./attached-task-store";
import { TaskCoordinator } from "./task-coordinator";

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
  readonly roles: AgentCreationOptions["role"][];
  readonly resumeSessions: (boolean | undefined)[];
  readonly store: MemoryTaskStore;
}

function createHarness(
  createRuntime?: (options: AgentCreationOptions) => Promise<AgentRuntime>,
  store = new MemoryTaskStore(),
): Harness {
  const prompts: string[] = [];
  const disposed: string[] = [];
  const deliveries: AttachedTaskDelivery[] = [];
  const roles: AgentCreationOptions["role"][] = [];
  const resumeSessions: (boolean | undefined)[] = [];
  const factory: AgentFactory = {
    async create(_definition, _tools, options) {
      roles.push(options.role);
      resumeSessions.push(options.resumeSession);
      if (createRuntime) return createRuntime(options);
      return {
        async prompt(turn) {
          const text = turn.event.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          prompts.push(text);
        },
        lastAssistantText() {
          return `result for ${prompts.at(-1)}`;
        },
        dispose() {
          disposed.push(options.sessionKey);
        },
      };
    },
  };
  const coordinator = new AttachedAgentCoordinator({
    factory,
    systemPrompt: "system",
    logger: pino({ level: "silent" }),
    store,
    taskCoordinator: new TaskCoordinator(),
    createTools: () => [],
    onResult: async (delivery) => {
      deliveries.push(delivery);
    },
  });
  return { coordinator, prompts, disposed, deliveries, roles, resumeSessions, store };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

test("starts a task and delivers the worker's text to the conversation", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start({
    channelId: "channel-1",
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "investigate",
  });

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

test("queues follow-ups on the same session", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start({
    channelId: "channel-1",
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "first",
  });
  await waitFor(() => harness.deliveries.length === 1);

  assert.equal(await harness.coordinator.send(taskId, "second"), true);
  await waitFor(() => harness.deliveries.length === 2);
  assert.deepEqual(harness.prompts, ["first", "second"]);
  assert.equal(harness.deliveries[1]?.result.text, "result for second");
});

test("closes a task and disposes its session", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start({
    channelId: "channel-1",
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "first",
  });
  await waitFor(() => harness.deliveries.length === 1);

  assert.equal(await harness.coordinator.close(taskId), true);
  assert.deepEqual(harness.disposed, [taskId]);
  assert.deepEqual(harness.coordinator.list("channel-1"), []);
  assert.equal(await harness.coordinator.send(taskId, "late"), false);
});

test("lists only the tasks of the requested conversation", async () => {
  const harness = createHarness();
  const first = await harness.coordinator.start({
    channelId: "channel-1",
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "first",
  });
  const second = await harness.coordinator.start({
    channelId: "channel-2",
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "second",
  });
  await waitFor(() => harness.deliveries.length === 2);

  const tasks = harness.coordinator.list("channel-1");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, first);
  assert.equal(tasks[0]?.status, "idle");
  assert.notEqual(first, second);
});

test("closes a task after delivering its result when requested", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start({
    channelId: "channel-1",
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "remind",
    closeAfterResult: true,
  });

  await waitFor(() => harness.deliveries.length === 1);
  await waitFor(() => harness.disposed.length === 1);
  assert.deepEqual(harness.disposed, [taskId]);
  assert.deepEqual(harness.coordinator.list("channel-1"), []);
  assert.equal(harness.store.tasks.has(taskId), false);
});

test("restores a saved task and resumes its session on the next prompt", async () => {
  const store = new MemoryTaskStore();
  const first = createHarness(undefined, store);
  const taskId = await first.coordinator.start({
    channelId: "channel-1",
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "first",
  });
  await waitFor(() => first.deliveries.length === 1);
  await first.coordinator.dispose();

  const second = createHarness(undefined, store);
  await second.coordinator.load();
  const tasks = second.coordinator.list("channel-1");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, taskId);
  assert.equal(tasks[0]?.status, "idle");
  assert.deepEqual(second.resumeSessions, []);

  assert.equal(await second.coordinator.send(taskId, "second"), true);
  await waitFor(() => second.deliveries.length === 1);
  assert.deepEqual(second.resumeSessions, [true]);
  assert.deepEqual(second.prompts, ["second"]);
  assert.equal(second.deliveries[0]?.result.text, "result for second");
});

test("marks a task that was running at shutdown as interrupted", async () => {
  const store = new MemoryTaskStore();
  await store.save({
    id: "attached-1",
    channelId: "channel-1",
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

  assert.equal(harness.coordinator.list("channel-1")[0]?.status, "interrupted");
  assert.equal(store.tasks.get("attached-1")?.status, "interrupted");
});

test("keeps the saved tasks when the process disposes the coordinator", async () => {
  const harness = createHarness();
  const taskId = await harness.coordinator.start({
    channelId: "channel-1",
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "first",
  });
  await waitFor(() => harness.deliveries.length === 1);

  await harness.coordinator.dispose();

  assert.equal(harness.store.tasks.has(taskId), true);
  assert.deepEqual(harness.coordinator.list("channel-1"), []);
});

test("delivers a failed result when the worker throws", async () => {
  const harness = createHarness(async () => ({
    async prompt() {
      throw new Error("boom");
    },
    dispose() {},
  }));
  await harness.coordinator.start({
    channelId: "channel-1",
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "first",
  });
  await waitFor(() => harness.deliveries.length === 1);

  assert.equal(harness.deliveries[0]?.result.status, "failed");
  assert.equal(harness.deliveries[0]?.result.error, "boom");
});
