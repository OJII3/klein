import assert from "node:assert/strict";
import test from "node:test";

import {
  WatchCheckError,
  type WatchCheckRunner,
} from "@modules/scheduling/application/watch-check-runner";
import type { ScheduledTask, WatchTask } from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import { createWatchTools } from "./watch";

function createStore() {
  let stored: WatchTask | undefined;
  const deletedIds: string[] = [];
  const store = {
    async create(task: ScheduledTask) {
      stored = task as WatchTask;
    },
    async listForScope(kind: ScheduledTask["kind"], channelId: string, accessScope: string) {
      assert.equal(kind, "watch");
      assert.equal(channelId, "channel-a");
      assert.equal(accessScope, "public");
      return stored ? [stored] : [];
    },
    async listDue() {
      return [];
    },
    async delete(_kind: ScheduledTask["kind"], _channelId: string, _scope: string, id: string) {
      deletedIds.push(id);
      return true;
    },
    async update(task: ScheduledTask) {
      stored = task as WatchTask;
    },
  } as unknown as ScheduledTaskStore;
  return { store, getStored: () => stored, deletedIds };
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
  const block = result.content[0] as { type: string; text: string } | undefined;
  return block?.type === "text" ? block.text : "";
}

async function addWatch(tools: ReturnType<typeof createWatchTools>) {
  const addTool = tools.find((tool) => tool.name === "watch_add");
  assert.ok(addTool);
  return addTool.execute(
    "tool-call",
    {
      name: "在庫監視",
      schedule: { type: "every", minutes: 15 },
      script: "text(args[0]); silent();",
      args: ["--json"],
      message: "在庫の変化を確認してください。",
    } as never,
    undefined,
    undefined,
    {} as never,
  );
}

test("provides watch add, update, get, list, and delete tools in the given scope", async () => {
  const { store, getStored, deletedIds } = createStore();
  const { runner, runs } = createRunner();
  const tools = createWatchTools(store, "channel-a", "public", runner);
  const updateTool = tools.find((tool) => tool.name === "watch_update");
  const listTool = tools.find((tool) => tool.name === "watch_list");
  const deleteTool = tools.find((tool) => tool.name === "watch_delete");
  assert.ok(updateTool && listTool && deleteTool);

  const addResult = await addWatch(tools);
  const created = getStored();
  assert.equal(created?.kind, "watch");
  assert.equal(created?.accessScope, "public");
  assert.deepEqual(created?.args, ["--json"]);
  assert.equal(created?.script, "text(args[0]); silent();");
  assert.equal(created?.enabled, true);
  assert.deepEqual(runs, [{ script: "text(args[0]); silent();", args: ["--json"] }]);
  assert.match(textOf(addResult), /登録しました/u);

  const listResult = await listTool.execute(
    "tool-call",
    {} as never,
    undefined,
    undefined,
    {} as never,
  );
  const listed = (listResult.details as unknown as { watches: Record<string, unknown>[] }).watches;
  assert.equal(listed instanceof Array, true);
  assert.equal(listed[0]?.script, "text(args[0]); silent();");
  assert.equal(listed[0]?.enabled, true);
  assert.equal(listed[0]?.consecutiveFailures, 0);

  const getTool = tools.find((tool) => tool.name === "watch_get");
  assert.ok(getTool);
  const getResult = await getTool.execute(
    "tool-call",
    { id: created!.id } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.match(textOf(getResult), /在庫監視/u);
  assert.match(textOf(getResult), /text\(args\[0\]\); silent\(\);/u);
  assert.match(textOf(getResult), /--json/u);
  assert.match(textOf(getResult), /在庫の変化を確認してください。/u);
  assert.match(textOf(getResult), /保存値: なし/u);

  const missingGetResult = await getTool.execute(
    "tool-call",
    { id: "missing" } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.match(textOf(missingGetResult), /ありません/u);

  await deleteTool.execute(
    "tool-call",
    { id: created!.id } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.deepEqual(deletedIds, [created!.id]);
});

test("updates a watch and can disable and re-enable it", async () => {
  const { store, getStored } = createStore();
  const { runner, runs } = createRunner();
  const tools = createWatchTools(store, "channel-a", "public", runner);
  const updateTool = tools.find((tool) => tool.name === "watch_update");
  assert.ok(updateTool);

  await addWatch(tools);
  const id = getStored()!.id;

  const disabledResult = await updateTool.execute(
    "tool-call",
    { id, script: "text('updated'); silent();", enabled: false } as never,
    undefined,
    undefined,
    {} as never,
  );
  const disabled = getStored();
  assert.equal(disabled?.script, "text('updated'); silent();");
  assert.equal(disabled?.enabled, false);
  assert.equal(runs.length, 1);
  assert.match(textOf(disabledResult), /停止中/u);

  const enabledResult = await updateTool.execute(
    "tool-call",
    { id, enabled: true } as never,
    undefined,
    undefined,
    {} as never,
  );
  const enabled = getStored();
  assert.equal(enabled?.enabled, true);
  assert.ok(Date.parse(enabled!.nextRunAt) > Date.now());
  assert.deepEqual(runs.at(-1), { script: "text('updated'); silent();", args: ["--json"] });
  assert.match(textOf(enabledResult), /次回:/u);

  const missingResult = await updateTool.execute(
    "tool-call",
    { id: "missing", enabled: false } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((missingResult.details as { updated: boolean }).updated, false);
});

test("does not register a watch when the dry run fails", async () => {
  const { store, getStored } = createStore();
  const { runner, fail } = createRunner();
  fail("監視スクリプトが失敗しました: boom");
  const tools = createWatchTools(store, "channel-a", "public", runner);

  await assert.rejects(addWatch(tools), /監視を登録しませんでした。.*boom/u);
  assert.equal(getStored(), undefined);
});

test("keeps a watch disabled when the dry run fails on re-enable", async () => {
  const { store, getStored } = createStore();
  const { runner, fail } = createRunner();
  const tools = createWatchTools(store, "channel-a", "public", runner);
  const updateTool = tools.find((tool) => tool.name === "watch_update");
  assert.ok(updateTool);

  await addWatch(tools);
  const id = getStored()!.id;
  await updateTool.execute(
    "tool-call",
    { id, enabled: false } as never,
    undefined,
    undefined,
    {} as never,
  );

  fail("監視スクリプトが失敗しました: boom");
  await assert.rejects(
    updateTool.execute(
      "tool-call",
      { id, enabled: true } as never,
      undefined,
      undefined,
      {} as never,
    ),
    /監視を有効にしませんでした。.*boom/u,
  );
  const stored = getStored();
  assert.equal(stored?.enabled, false);
  assert.equal(stored?.lastStatus, undefined);
});
