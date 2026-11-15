import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import type { AgentCreationOptions, AgentFactory } from "@agents/core/agent-factory";
import type { AgentRuntime } from "@agents/core/agent-runtime";
import { AttachedAgentCoordinator, type AttachedTaskDelivery } from "./attached-agent-coordinator";
import { TaskCoordinator } from "./task-coordinator";

interface Harness {
  readonly coordinator: AttachedAgentCoordinator;
  readonly prompts: string[];
  readonly disposed: string[];
  readonly deliveries: AttachedTaskDelivery[];
  readonly roles: AgentCreationOptions["role"][];
}

function createHarness(
  createRuntime?: (options: AgentCreationOptions) => Promise<AgentRuntime>,
): Harness {
  const prompts: string[] = [];
  const disposed: string[] = [];
  const deliveries: AttachedTaskDelivery[] = [];
  const roles: AgentCreationOptions["role"][] = [];
  const factory: AgentFactory = {
    async create(_definition, _tools, options) {
      roles.push(options.role);
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
    taskCoordinator: new TaskCoordinator(),
    createTools: () => [],
    onResult: async (delivery) => {
      deliveries.push(delivery);
    },
  });
  return { coordinator, prompts, disposed, deliveries, roles };
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
