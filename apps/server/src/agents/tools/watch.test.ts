import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryScheduledTaskStore,
  createStubExtensionToolContext,
} from "@agents/testing/test-stubs";
import type { WatchTask } from "@modules/scheduling/domain/scheduled-task";
import {
  WatchCheckError,
  type WatchCheckRunner,
} from "@modules/scheduling/ports/watch-check-runner";
import { isRecord } from "@shared/type-guards";
import { createWatchTools } from "./watch";

function createSingleWatchStore() {
  const store = new InMemoryScheduledTaskStore([], {
    onListForScope(kind, channelId, accessScope) {
      assert.equal(kind, "watch");
      assert.equal(channelId, "channel-a");
      assert.equal(accessScope, "public");
    },
  });
  const getStored = (): WatchTask | undefined => {
    const first = [...store.tasks.values()][0];
    return first?.kind === "watch" ? first : undefined;
  };
  return { store, getStored, deletedIds: store.deletedIds };
}

function createRunner() {
  const runs: { script: string; args: readonly string[] }[] = [];
  let failure: string | undefined;
  const runner: WatchCheckRunner = {
    async run(watch) {
      runs.push({ script: watch.script, args: watch.args });
      if (failure) throw new WatchCheckError(failure);
      return { output: "", decision: "silent", exitCode: 0, durationMs: 0, state: {} };
    },
  };
  return { runner, runs, fail: (message: string) => (failure = message) };
}

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0];
  return isRecord(block) && block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

function unpackWatchTools(tools: ReturnType<typeof createWatchTools>) {
  const [addTool, updateTool, listTool, getTool, deleteTool] = tools;
  return { addTool, updateTool, listTool, getTool, deleteTool };
}

async function addWatch(
  tools: ReturnType<typeof createWatchTools>,
  priority?: "normal" | "urgent",
) {
  const { addTool } = unpackWatchTools(tools);
  return addTool.execute(
    "tool-call",
    {
      name: "在庫監視",
      schedule: { type: "every", minutes: 15 },
      script: "text(args[0]); silent();",
      args: ["--json"],
      message: "在庫の変化を確認してください。",
      ...(priority !== undefined ? { priority } : {}),
    },
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );
}

async function listWatches(tools: ReturnType<typeof createWatchTools>) {
  const { listTool } = unpackWatchTools(tools);
  const result = await listTool.execute(
    "tool-call",
    {},
    undefined,
    undefined,
    await createStubExtensionToolContext(),
  );
  return result.details.watches.map((watch) => watch.id);
}

test("provides watch add, update, get, list, and delete tools in the given scope", async () => {
  const { store, getStored, deletedIds } = createSingleWatchStore();
  const { runner, runs } = createRunner();
  const tools = createWatchTools(store, "channel-a", "public", runner);
  const { listTool, getTool, deleteTool } = unpackWatchTools(tools);
  const ctx = await createStubExtensionToolContext();

  const addResult = await addWatch(tools);
  const created = getStored();
  if (!created) {
    assert.fail("expected watch to be created");
  }
  assert.equal(created.kind, "watch");
  assert.equal(created.accessScope, "public");
  assert.deepEqual(created.args, ["--json"]);
  assert.equal(created.script, "text(args[0]); silent();");
  assert.equal(created.enabled, true);
  assert.deepEqual(runs, [{ script: "text(args[0]); silent();", args: ["--json"] }]);
  assert.match(textOf(addResult), /登録しました/u);

  const listResult = await listTool.execute("tool-call", {}, undefined, undefined, ctx);
  const listed = listResult.details.watches;
  assert.equal(Array.isArray(listed), true);
  assert.equal(listed[0]?.script, "text(args[0]); silent();");
  assert.equal(listed[0]?.enabled, true);
  assert.equal(listed[0]?.consecutiveFailures, 0);

  const getResult = await getTool.execute(
    "tool-call",
    { id: created.id },
    undefined,
    undefined,
    ctx,
  );
  assert.match(textOf(getResult), /在庫監視/u);
  assert.match(textOf(getResult), /text\(args\[0\]\); silent\(\);/u);
  assert.match(textOf(getResult), /--json/u);
  assert.match(textOf(getResult), /在庫の変化を確認してください。/u);
  assert.match(textOf(getResult), /保存値: なし/u);

  const missingGetResult = await getTool.execute(
    "tool-call",
    { id: "missing" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(textOf(missingGetResult), /ありません/u);

  await deleteTool.execute("tool-call", { id: created.id }, undefined, undefined, ctx);
  assert.deepEqual(deletedIds, [created.id]);
});

test("stores watch priority and reports it in details", async () => {
  const { store, getStored } = createSingleWatchStore();
  const { runner } = createRunner();
  const tools = createWatchTools(store, "channel-a", "public", runner);
  const { listTool, getTool } = unpackWatchTools(tools);
  const ctx = await createStubExtensionToolContext();

  await addWatch(tools, "urgent");
  const created = getStored();
  if (!created) {
    assert.fail("expected watch to be created");
  }
  assert.equal(created.priority, "urgent");

  const listResult = await listTool.execute("tool-call", {}, undefined, undefined, ctx);
  assert.equal(listResult.details.watches[0]?.priority, "urgent");

  const getResult = await getTool.execute(
    "tool-call",
    { id: created.id },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(getResult.details.priority, "urgent");
});

test("defaults watch priority to normal and changes it only when specified", async () => {
  const { store, getStored } = createSingleWatchStore();
  const { runner } = createRunner();
  const tools = createWatchTools(store, "channel-a", "public", runner);
  const { updateTool, listTool, getTool } = unpackWatchTools(tools);
  const ctx = await createStubExtensionToolContext();

  await addWatch(tools);
  const created = getStored();
  if (!created) {
    assert.fail("expected watch to be created");
  }
  assert.equal(created.priority, undefined);

  const listResult = await listTool.execute("tool-call", {}, undefined, undefined, ctx);
  assert.equal(listResult.details.watches[0]?.priority, "normal");
  const getResult = await getTool.execute(
    "tool-call",
    { id: created.id },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(getResult.details.priority, "normal");

  await updateTool.execute(
    "tool-call",
    { id: created.id, priority: "urgent" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(getStored()?.priority, "urgent");

  await updateTool.execute(
    "tool-call",
    { id: created.id, message: "在庫を確認しました。" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(getStored()?.priority, "urgent");
});

test("updates a watch and can disable and re-enable it", async () => {
  const { store, getStored } = createSingleWatchStore();
  const { runner, runs } = createRunner();
  const tools = createWatchTools(store, "channel-a", "public", runner);
  const { updateTool } = unpackWatchTools(tools);
  const ctx = await createStubExtensionToolContext();

  await addWatch(tools);
  const created = getStored();
  if (!created) {
    assert.fail("expected watch to be created");
  }
  const id = created.id;

  const disabledResult = await updateTool.execute(
    "tool-call",
    { id, script: "text('updated'); silent();", enabled: false },
    undefined,
    undefined,
    ctx,
  );
  const disabled = getStored();
  assert.equal(disabled?.script, "text('updated'); silent();");
  assert.equal(disabled?.enabled, false);
  assert.equal(runs.length, 1);
  assert.match(textOf(disabledResult), /停止中/u);

  const enabledResult = await updateTool.execute(
    "tool-call",
    { id, enabled: true },
    undefined,
    undefined,
    ctx,
  );
  const enabled = getStored();
  if (!enabled) {
    assert.fail("expected watch to remain stored");
  }
  assert.equal(enabled.enabled, true);
  assert.ok(Date.parse(enabled.nextRunAt) > Date.now());
  assert.deepEqual(runs.at(-1), { script: "text('updated'); silent();", args: ["--json"] });
  assert.match(textOf(enabledResult), /次回:/u);

  const missingResult = await updateTool.execute(
    "tool-call",
    { id: "missing", enabled: false },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(missingResult.details.updated, false);
});

test("does not register a watch when the dry run fails", async () => {
  const { store, getStored } = createSingleWatchStore();
  const { runner, fail } = createRunner();
  fail("watch script failed: boom");
  const tools = createWatchTools(store, "channel-a", "public", runner);

  await assert.rejects(addWatch(tools), /not registered.*boom/u);
  assert.equal(getStored(), undefined);
});

test("keeps a watch disabled when the dry run fails on re-enable", async () => {
  const { store, getStored } = createSingleWatchStore();
  const { runner, fail } = createRunner();
  const tools = createWatchTools(store, "channel-a", "public", runner);
  const { updateTool } = unpackWatchTools(tools);
  const ctx = await createStubExtensionToolContext();

  await addWatch(tools);
  const created = getStored();
  if (!created) {
    assert.fail("expected watch to be created");
  }
  const id = created.id;
  await updateTool.execute("tool-call", { id, enabled: false }, undefined, undefined, ctx);

  fail("watch script failed: boom");
  await assert.rejects(
    updateTool.execute("tool-call", { id, enabled: true }, undefined, undefined, ctx),
    /not enabled.*boom/u,
  );
  const stored = getStored();
  assert.equal(stored?.enabled, false);
  assert.equal(stored?.lastStatus, undefined);
});

const baseWatch: WatchTask = {
  kind: "watch",
  id: "watch-conversation",
  channelId: "channel-a",
  accessScope: "public",
  name: "会話の監視",
  script: "silent();",
  args: [],
  message: "会話の監視です。",
  enabled: true,
  consecutiveFailures: 0,
  createdAt: "2026-10-14T00:00:00.000Z",
  schedule: { type: "every", minutes: 5 },
  nextRunAt: "2026-10-14T00:05:00.000Z",
};

test("scopes worker watches to the worker that registered them", async () => {
  const store = new InMemoryScheduledTaskStore([
    baseWatch,
    { ...baseWatch, id: "watch-worker-1", ownerWorkerId: "worker-1" },
    { ...baseWatch, id: "watch-worker-2", ownerWorkerId: "worker-2" },
  ]);
  const { runner } = createRunner();
  const workerTools = createWatchTools(store, "channel-a", "public", runner, "worker-1");
  const conversationTools = createWatchTools(store, "channel-a", "public", runner);
  const ctx = await createStubExtensionToolContext();

  assert.deepEqual(await listWatches(workerTools), ["watch-worker-1"]);
  assert.deepEqual(await listWatches(conversationTools), [
    "watch-conversation",
    "watch-worker-1",
    "watch-worker-2",
  ]);

  const worker = unpackWatchTools(workerTools);
  const conversation = unpackWatchTools(conversationTools);

  const getResult = await worker.getTool.execute(
    "tool-call",
    { id: "watch-worker-2" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(textOf(getResult), /ありません/u);

  const updateResult = await worker.updateTool.execute(
    "tool-call",
    { id: "watch-worker-2", enabled: false },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(updateResult.details.updated, false);

  const deleteResult = await worker.deleteTool.execute(
    "tool-call",
    { id: "watch-worker-2" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(deleteResult.details.deleted, false);
  assert.equal(store.tasks.has("watch-worker-2"), true);

  await addWatch(workerTools);
  assert.equal(
    [...store.tasks.values()].findLast((task): task is WatchTask => task.kind === "watch")
      ?.ownerWorkerId,
    "worker-1",
  );

  const conversationGetResult = await conversation.getTool.execute(
    "tool-call",
    { id: "watch-worker-2" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(conversationGetResult.details.found, true);
});
