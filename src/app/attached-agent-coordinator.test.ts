import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";

import type { NonConversationAgentRole } from "@agents/core/agent-role";
import type { PiSession, PiSessionOptions } from "@runtime/pi/pi-non-conversation-session-runner";
import { AttachedAgentCoordinator, type AttachedTaskDelivery } from "./attached-agent-coordinator";
import { TaskCoordinator } from "./task-coordinator";

interface Harness {
  readonly coordinator: AttachedAgentCoordinator;
  readonly prompts: string[];
  readonly disposed: string[];
  readonly deliveries: AttachedTaskDelivery[];
  readonly roles: NonConversationAgentRole[];
}

function createHarness(createSession?: (options: PiSessionOptions) => Promise<PiSession>): Harness {
  const prompts: string[] = [];
  const disposed: string[] = [];
  const deliveries: AttachedTaskDelivery[] = [];
  const roles: NonConversationAgentRole[] = [];
  const sessionFactory =
    createSession ??
    (async (options: PiSessionOptions) => ({
      async prompt(text: string) {
        return `result for ${text}`;
      },
      dispose() {
        disposed.push(options.sessionId);
      },
    }));
  const coordinator = new AttachedAgentCoordinator({
    runner: {
      createSession: async (options) => {
        roles.push(options.role);
        const session = await sessionFactory(options);
        return {
          async prompt(text) {
            prompts.push(text);
            return session.prompt(text);
          },
          dispose() {
            session.dispose();
          },
        };
      },
    },
    model: {} as never,
    systemPrompt: "system",
    cwd: "/tmp",
    logger: pino({ level: "silent" }),
    taskCoordinator: new TaskCoordinator(),
    toolNames: ["discord_read"],
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
    prompt: "first",
  });
  const second = await harness.coordinator.start({
    channelId: "channel-2",
    accessScope: "public",
    prompt: "second",
  });
  await waitFor(() => harness.deliveries.length === 2);

  const tasks = harness.coordinator.list("channel-1");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, first);
  assert.equal(tasks[0]?.status, "idle");
  assert.notEqual(first, second);
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
    prompt: "first",
  });
  await waitFor(() => harness.deliveries.length === 1);

  assert.equal(harness.deliveries[0]?.result.status, "failed");
  assert.equal(harness.deliveries[0]?.result.error, "boom");
});
