import assert from "node:assert/strict";
import test from "node:test";

import type { ScheduledTask, WatchTask } from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import { createWatchTools } from "./watch";

test("provides owner-only watch add, list, and delete tools", async () => {
  let created: WatchTask | undefined;
  let deletedId: string | undefined;
  const store = {
    async create(task: ScheduledTask) {
      created = task as WatchTask;
    },
    async listForScope(kind: ScheduledTask["kind"], channelId: string, accessScope: string) {
      assert.equal(kind, "watch");
      assert.equal(channelId, "channel-a");
      assert.equal(accessScope, "owner:123");
      return created ? [created] : [];
    },
    async listDue() {
      return [];
    },
    async delete(_kind: ScheduledTask["kind"], _channelId: string, _scope: string, id: string) {
      deletedId = id;
      return true;
    },
    async update() {},
  } as unknown as ScheduledTaskStore;
  const tools = createWatchTools(store, "channel-a", "123");
  const [addTool, listTool, deleteTool] = tools;
  const call = { callId: "tool-call" } as never;

  const addResult = await addTool.execute(
    {
      name: "在庫監視",
      schedule: { type: "every", minutes: 15 },
      command: "check-stock",
      args: ["--json"],
      message: "在庫の変化を確認してください。",
      cooldownMinutes: 60,
    } as never,
    call,
    {} as never,
  );
  assert.equal(created?.kind, "watch");
  assert.equal(created?.accessScope, "owner:123");
  assert.equal(created?.condition, "change");
  assert.equal(created?.cooldownMinutes, 60);
  assert.deepEqual(created?.args, ["--json"]);
  assert.equal(created?.runtime, "command");
  assert.equal(
    created && created.runtime === "command" ? created.command : undefined,
    "check-stock",
  );
  assert.match(
    addResult.output?.[0]?.type === "text" ? addResult.output[0].text : "",
    /登録しました/u,
  );

  const listResult = await listTool.execute({} as never, call, {} as never);
  assert.equal(
    (listResult.details as unknown as { watches: unknown[] }).watches instanceof Array,
    true,
  );

  await deleteTool.execute({ id: created!.id } as never, call, {} as never);
  assert.equal(deletedId, created?.id);
});

test("registers a JS watch script instead of a command", async () => {
  let created: WatchTask | undefined;
  const store = {
    async create(task: ScheduledTask) {
      created = task as WatchTask;
    },
  } as unknown as ScheduledTaskStore;
  const [addTool] = createWatchTools(store, "channel-a", "123");
  const script = 'const res = await fetch("https://example.com/rate"); return res.body;';

  await addTool.execute(
    {
      name: "為替監視",
      schedule: { type: "every", minutes: 30 },
      runtime: "javascript",
      script,
      message: "為替の変化を確認してください。",
    } as never,
    { callId: "tool-call" } as never,
    {} as never,
  );

  assert.equal(created?.runtime, "javascript");
  assert.ok(created && created.runtime === "javascript");
  assert.equal(created.script, script);

  await assert.rejects(
    addTool.execute(
      {
        name: "不正な監視",
        schedule: { type: "every", minutes: 30 },
        runtime: "javascript",
        script,
        command: "check-stock",
        message: "指定が重複しています。",
      } as never,
      { callId: "tool-call" } as never,
      {} as never,
    ),
    /command を指定できません/u,
  );
});
