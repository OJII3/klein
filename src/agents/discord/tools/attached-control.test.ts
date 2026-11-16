import assert from "node:assert/strict";
import test from "node:test";

import type {
  AttachedTaskControl,
  AttachedTaskScope,
  AttachedTaskStartInput,
} from "@agents/core/attached-agent";
import { createAttachedControlTools } from "./attached-control";

function createTarget() {
  const started: AttachedTaskStartInput[] = [];
  const sent: { scope: AttachedTaskScope; taskId: string; message: string }[] = [];
  const closed: { scope: AttachedTaskScope; taskId: string }[] = [];
  const listed: AttachedTaskScope[] = [];
  const target: AttachedTaskControl = {
    async start(input) {
      started.push(input);
      return "task-1";
    },
    async send(scope, taskId, message) {
      sent.push({ scope, taskId, message });
      return (
        taskId === "task-1" &&
        scope.conversationKey.channelId === "channel-1" &&
        scope.accessScope === "public"
      );
    },
    async close(scope, taskId) {
      closed.push({ scope, taskId });
      return (
        taskId === "task-1" &&
        scope.conversationKey.channelId === "channel-1" &&
        scope.accessScope === "public"
      );
    },
    list(scope) {
      listed.push(scope);
      return scope.conversationKey.channelId === "channel-1" && scope.accessScope === "public"
        ? [
            {
              id: "task-1",
              prompt: "investigate",
              status: "idle",
              createdAt: "2026-11-15T00:00:00.000Z",
              updatedAt: "2026-11-15T00:00:00.000Z",
            },
          ]
        : [];
    },
  };
  return { target, started, sent, closed, listed };
}

function findTool(tools: ReturnType<typeof createAttachedControlTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test("starts a task in the current conversation", async () => {
  const { target, started } = createTarget();
  const tool = findTool(
    createAttachedControlTools(target, "channel-1", "public", false),
    "worker_start",
  );

  const result = await tool.execute(
    "tool-call",
    { prompt: "investigate" } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(started, [
    {
      conversationKey: { kind: "discord", channelId: "channel-1" },
      accessScope: "public",
      ownerFeaturesAllowed: false,
      prompt: "investigate",
    },
  ]);
  assert.deepEqual(result.details, { taskId: "task-1" });
});

test("sends a follow-up to a task with bound scope", async () => {
  const { target, sent } = createTarget();
  const tool = findTool(
    createAttachedControlTools(target, "channel-1", "public", false),
    "worker_send",
  );

  const result = await tool.execute(
    "tool-call",
    { taskId: "task-1", message: "check again" } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(sent, [
    {
      scope: {
        conversationKey: { kind: "discord", channelId: "channel-1" },
        accessScope: "public",
      },
      taskId: "task-1",
      message: "check again",
    },
  ]);
  assert.deepEqual(result.details, { taskId: "task-1", sent: true });
});

test("closes a task with bound scope", async () => {
  const { target, closed } = createTarget();
  const tool = findTool(
    createAttachedControlTools(target, "channel-1", "public", false),
    "worker_close",
  );

  const result = await tool.execute(
    "tool-call",
    { taskId: "task-1" } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(closed, [
    {
      scope: {
        conversationKey: { kind: "discord", channelId: "channel-1" },
        accessScope: "public",
      },
      taskId: "task-1",
    },
  ]);
  assert.deepEqual(result.details, { taskId: "task-1", closed: true });
});

test("lists the tasks of the current conversation and accessScope", async () => {
  const { target, listed } = createTarget();
  const tool = findTool(
    createAttachedControlTools(target, "channel-1", "public", false),
    "worker_list",
  );

  const result = await tool.execute("tool-call", {} as never, undefined, undefined, {} as never);

  assert.deepEqual(listed, [
    { conversationKey: { kind: "discord", channelId: "channel-1" }, accessScope: "public" },
  ]);
  assert.match(JSON.stringify(result.content), /task-1/);
});

test("rejects worker_send, worker_close, and worker_list outside the bound scope", async () => {
  const { target } = createTarget();
  const otherChannelTools = createAttachedControlTools(target, "channel-2", "public", false);
  const otherScopeTools = createAttachedControlTools(target, "channel-1", "owner:123", true);

  for (const tools of [otherChannelTools, otherScopeTools]) {
    const sendResult = await findTool(tools, "worker_send").execute(
      "tool-call",
      { taskId: "task-1", message: "hijack" } as never,
      undefined,
      undefined,
      {} as never,
    );
    assert.deepEqual(sendResult.details, { taskId: "task-1", sent: false });

    const closeResult = await findTool(tools, "worker_close").execute(
      "tool-call",
      { taskId: "task-1" } as never,
      undefined,
      undefined,
      {} as never,
    );
    assert.deepEqual(closeResult.details, { taskId: "task-1", closed: false });

    const listResult = await findTool(tools, "worker_list").execute(
      "tool-call",
      {} as never,
      undefined,
      undefined,
      {} as never,
    );
    assert.deepEqual(listResult.details, { tasks: [] });
  }
});
