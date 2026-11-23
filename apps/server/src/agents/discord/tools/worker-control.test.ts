import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerControl, WorkerScope, WorkerStartInput } from "@agents/core/worker-agent";
import { createStubExtensionToolContext } from "@agents/testing/test-stubs";
import { createWorkerControlTools } from "./worker-control";

function createTarget() {
  const started: WorkerStartInput[] = [];
  const sent: { scope: WorkerScope; workerId: string; message: string }[] = [];
  const closed: { scope: WorkerScope; workerId: string }[] = [];
  const listed: WorkerScope[] = [];
  const target: WorkerControl = {
    async start(input) {
      started.push(input);
      return "worker-1";
    },
    async send(scope, workerId, message) {
      sent.push({ scope, workerId, message });
      return (
        workerId === "worker-1" &&
        scope.conversationKey.channelId === "channel-1" &&
        scope.accessScope === "public"
      );
    },
    async close(scope, workerId) {
      closed.push({ scope, workerId });
      return (
        workerId === "worker-1" &&
        scope.conversationKey.channelId === "channel-1" &&
        scope.accessScope === "public"
      );
    },
    list(scope) {
      listed.push(scope);
      return scope.conversationKey.channelId === "channel-1" && scope.accessScope === "public"
        ? [
            {
              id: "worker-1",
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

function unpackControlTools(tools: ReturnType<typeof createWorkerControlTools>) {
  const [workerStart, workerSend, workerClose, workerList] = tools;
  return { workerStart, workerSend, workerClose, workerList };
}

test("starts a worker in the current conversation", async () => {
  const { target, started } = createTarget();
  const { workerStart } = unpackControlTools(
    createWorkerControlTools(target, "channel-1", "public", false),
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
  assert.deepEqual(result.details, { workerId: "worker-1" });
});

test("passes the conversation session file to a new worker", async () => {
  const { target, started } = createTarget();
  const { workerStart } = unpackControlTools(
    createWorkerControlTools(target, "channel-1", "public", false, () => "/tmp/conversation.jsonl"),
  );

  await workerStart.execute(
    "tool-call",
    { prompt: "continue" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.equal(started[0]?.contextSessionFile, "/tmp/conversation.jsonl");
});

test("omits the conversation session file when the session is not persisted", async () => {
  const { target, started } = createTarget();
  const { workerStart } = unpackControlTools(
    createWorkerControlTools(target, "channel-1", "public", false, () => undefined),
  );

  await workerStart.execute(
    "tool-call",
    { prompt: "continue" },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );

  assert.equal("contextSessionFile" in (started[0] ?? {}), false);
});

test("sends a follow-up to a worker with bound scope", async () => {
  const { target, sent } = createTarget();
  const { workerSend } = unpackControlTools(
    createWorkerControlTools(target, "channel-1", "public", false),
  );

  const result = await workerSend.execute(
    "tool-call",
    { workerId: "worker-1", message: "check again" },
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
      workerId: "worker-1",
      message: "check again",
    },
  ]);
  assert.deepEqual(result.details, { workerId: "worker-1", sent: true });
});

test("closes a worker with bound scope", async () => {
  const { target, closed } = createTarget();
  const { workerClose } = unpackControlTools(
    createWorkerControlTools(target, "channel-1", "public", false),
  );

  const result = await workerClose.execute(
    "tool-call",
    { workerId: "worker-1" },
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
      workerId: "worker-1",
    },
  ]);
  assert.deepEqual(result.details, { workerId: "worker-1", closed: true });
});

test("lists the workers of the current conversation and accessScope", async () => {
  const { target, listed } = createTarget();
  const { workerList } = unpackControlTools(
    createWorkerControlTools(target, "channel-1", "public", false),
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
  assert.match(JSON.stringify(result.content), /worker-1/);
});

test("rejects worker_send, worker_close, and worker_list outside the bound scope", async () => {
  const { target } = createTarget();
  const otherChannelTools = createWorkerControlTools(target, "channel-2", "public", false);
  const otherScopeTools = createWorkerControlTools(target, "channel-1", "owner:123", true);
  const ctx = await createStubExtensionToolContext();

  for (const rawTools of [otherChannelTools, otherScopeTools]) {
    const { workerSend, workerClose, workerList } = unpackControlTools(rawTools);
    const sendResult = await workerSend.execute(
      "tool-call",
      { workerId: "worker-1", message: "hijack" },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(sendResult.details, { workerId: "worker-1", sent: false });

    const closeResult = await workerClose.execute(
      "tool-call",
      { workerId: "worker-1" },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(closeResult.details, { workerId: "worker-1", closed: false });

    const listResult = await workerList.execute("tool-call", {}, undefined, undefined, ctx);
    assert.deepEqual(listResult.details, { workers: [] });
  }
});

test("describes worker capabilities that the conversation scope grants", () => {
  const { target } = createTarget();
  const publicTools = unpackControlTools(
    createWorkerControlTools(target, "channel-1", "public", false),
  );
  const ownerTools = unpackControlTools(
    createWorkerControlTools(target, "channel-1", "owner:123", true),
  );
  const linkedTools = unpackControlTools(
    createWorkerControlTools(target, "channel-1", "user:456", false),
  );

  assert.match(publicTools.workerStart.description, /Prefer worker_start/);
  assert.doesNotMatch(
    publicTools.workerStart.description,
    /agent-browser|t3_thread_start|sandboxed shell/,
  );
  assert.match(ownerTools.workerStart.description, /agent-browser/);
  assert.match(ownerTools.workerStart.description, /t3_thread_start, t3_thread_send/);
  assert.match(linkedTools.workerStart.description, /agent-browser/);
  assert.match(linkedTools.workerStart.description, /sandboxed shell/);
  assert.doesNotMatch(linkedTools.workerStart.description, /t3_thread_start/);
});
