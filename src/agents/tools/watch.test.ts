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
      script: "return { stock: args[0] };",
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
  assert.equal(created?.script, "return { stock: args[0] };");
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
