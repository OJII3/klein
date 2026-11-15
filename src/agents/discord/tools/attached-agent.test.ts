import assert from "node:assert/strict";
import test from "node:test";

import type { AttachedAgentStartInput, AttachedAgentToolTarget } from "@agents/core/attached-agent";
import { createAttachedAgentTools } from "./attached-agent";

function createTarget() {
  const started: AttachedAgentStartInput[] = [];
  const sent: { taskId: string; message: string }[] = [];
  const closed: string[] = [];
  const target: AttachedAgentToolTarget = {
    async start(input) {
      started.push(input);
      return "task-1";
    },
    async send(taskId, message) {
      sent.push({ taskId, message });
      return true;
    },
    async close(taskId) {
      closed.push(taskId);
      return true;
    },
    list() {
      return [
        {
          id: "task-1",
          prompt: "investigate",
          status: "idle",
          createdAt: "2026-11-15T00:00:00.000Z",
          updatedAt: "2026-11-15T00:00:00.000Z",
        },
      ];
    },
  };
  return { target, started, sent, closed };
}

function findTool(tools: ReturnType<typeof createAttachedAgentTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test("starts a task in the current conversation", async () => {
  const { target, started } = createTarget();
  const tool = findTool(createAttachedAgentTools(target, "channel-1", "public"), "attached_start");

  const result = await tool.execute(
    "tool-call",
    { prompt: "investigate" } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(started, [
    { channelId: "channel-1", accessScope: "public", prompt: "investigate" },
  ]);
  assert.deepEqual(result.details, { taskId: "task-1" });
});

test("sends a follow-up to a task", async () => {
  const { target, sent } = createTarget();
  const tool = findTool(createAttachedAgentTools(target, "channel-1", "public"), "attached_send");

  const result = await tool.execute(
    "tool-call",
    { taskId: "task-1", message: "check again" } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(sent, [{ taskId: "task-1", message: "check again" }]);
  assert.deepEqual(result.details, { taskId: "task-1", sent: true });
});

test("closes a task", async () => {
  const { target, closed } = createTarget();
  const tool = findTool(createAttachedAgentTools(target, "channel-1", "public"), "attached_close");

  const result = await tool.execute(
    "tool-call",
    { taskId: "task-1" } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(closed, ["task-1"]);
  assert.deepEqual(result.details, { taskId: "task-1", closed: true });
});

test("lists the tasks of the current conversation", async () => {
  const { target } = createTarget();
  const tool = findTool(createAttachedAgentTools(target, "channel-1", "public"), "attached_list");

  const result = await tool.execute("tool-call", {} as never, undefined, undefined, {} as never);

  assert.match(JSON.stringify(result.content), /task-1/);
});
