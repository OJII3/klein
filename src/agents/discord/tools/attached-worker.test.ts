import assert from "node:assert/strict";
import test from "node:test";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { WatchCheckRunner } from "@modules/scheduling/application/watch-check-runner";
import type { ScheduledTask } from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import { createAttachedWorkerTools } from "./attached-worker";

function createStore() {
  const created: ScheduledTask[] = [];
  const store = {
    async create(task: ScheduledTask) {
      created.push(task);
    },
    async listForScope() {
      return [];
    },
    async listDue() {
      return [];
    },
    async delete() {
      return false;
    },
    async update() {},
  } as unknown as ScheduledTaskStore;
  return { store, created };
}

const runner: WatchCheckRunner = {
  async run() {
    return { output: "", decision: "silent", exitCode: 0, durationMs: 0, state: {} };
  },
};

test("gives a worker the read tool and its own watch tools", () => {
  const { store } = createStore();
  const tools = createAttachedWorkerTools(
    {} as DiscordChannelApi,
    "channel-a",
    "public",
    "attached-1",
    store,
    runner,
  );

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["discord_read", "watch_add", "watch_update", "watch_list", "watch_get", "watch_delete"],
  );
});

test("registers a worker watch with the worker's task id", async () => {
  const { store, created } = createStore();
  const tools = createAttachedWorkerTools(
    {} as DiscordChannelApi,
    "channel-a",
    "public",
    "attached-1",
    store,
    runner,
  );
  const addTool = tools.find((tool) => tool.name === "watch_add");
  assert.ok(addTool);

  await addTool.execute(
    "tool-call",
    {
      name: "在庫監視",
      schedule: { type: "every", minutes: 5 },
      script: "silent();",
      message: "在庫の変化を確認してください。",
    } as never,
    undefined,
    undefined,
    {} as never,
  );

  const watch = created[0];
  assert.equal(watch?.kind === "watch" ? watch.ownerTaskId : undefined, "attached-1");
});
