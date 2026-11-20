import assert from "node:assert/strict";
import test from "node:test";

import type {
  AttachedTaskControl,
  AttachedTaskScope,
  AttachedTaskStartInput,
} from "@agents/core/attached-agent";
import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
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

function unpackControlTools(tools: ReturnType<typeof createAttachedControlTools>) {
  const [workerStart, workerSend, workerClose, workerList] = tools;
  return { workerStart, workerSend, workerClose, workerList };
}

test("starts a task in the current conversation", async () => {
  const { target, started } = createTarget();
  const { workerStart } = unpackControlTools(
    createAttachedControlTools(target, "channel-1", "public", false),
  );

  const result = await workerStart.execute(
    "tool-call",
    { prompt: "investigate" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
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
  const { workerSend } = unpackControlTools(
    createAttachedControlTools(target, "channel-1", "public", false),
  );

  const result = await workerSend.execute(
    "tool-call",
    { taskId: "task-1", message: "check again" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
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
  const { workerClose } = unpackControlTools(
    createAttachedControlTools(target, "channel-1", "public", false),
  );

  const result = await workerClose.execute(
    "tool-call",
    { taskId: "task-1" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
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
  const { workerList } = unpackControlTools(
    createAttachedControlTools(target, "channel-1", "public", false),
  );

  const result = await workerList.execute(
    "tool-call",
    {},
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.deepEqual(listed, [
    { conversationKey: { kind: "discord", channelId: "channel-1" }, accessScope: "public" },
  ]);
  assert.match(JSON.stringify(result.content), /task-1/);
});

test("rejects worker_send, worker_close, and worker_list outside the bound scope", async () => {
  const { target } = createTarget();
  const otherChannelTools = createAttachedControlTools(target, "channel-2", "public", false);
  const otherScopeTools = createAttachedControlTools(target, "channel-1", "owner:123", true);
  const ctx = await createStubExtensionToolContext();

  for (const rawTools of [otherChannelTools, otherScopeTools]) {
    const { workerSend, workerClose, workerList } = unpackControlTools(rawTools);
    const sendResult = await workerSend.execute(
      "tool-call",
      { taskId: "task-1", message: "hijack" },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(sendResult.details, { taskId: "task-1", sent: false });

    const closeResult = await workerClose.execute(
      "tool-call",
      { taskId: "task-1" },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(closeResult.details, { taskId: "task-1", closed: false });

    const listResult = await workerList.execute("tool-call", {}, undefined, undefined, ctx);
    assert.deepEqual(listResult.details, { tasks: [] });
  }
});

test("describes owner-only worker capabilities only when owner features are allowed", () => {
  const { target } = createTarget();
  const publicTools = unpackControlTools(
    createAttachedControlTools(target, "channel-1", "public", false),
  );
  const ownerTools = unpackControlTools(
    createAttachedControlTools(target, "channel-1", "owner:123", true),
  );

  assert.match(publicTools.workerStart.description, /Prefer worker_start/);
  assert.doesNotMatch(publicTools.workerStart.description, /t3_thread_\*/);
  assert.match(ownerTools.workerStart.description, /agent-browser/);
  assert.match(ownerTools.workerStart.description, /t3_thread_\*/);
});
