import assert from "node:assert/strict";
import test from "node:test";

import type { ReminderTask, ScheduledTask } from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import { createReminderTools } from "./reminder";

test("provides deferred add, list, and delete tools scoped to the conversation", async () => {
  let created: ReminderTask | undefined;
  let deletedId: string | undefined;
  const store = {
    async create(task: ScheduledTask) {
      created = task as ReminderTask;
    },
    async listForScope(kind: ScheduledTask["kind"], channelId: string, accessScope: string) {
      assert.equal(kind, "reminder");
      assert.equal(channelId, "channel-a");
      assert.equal(accessScope, "public");
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
  const tools = createReminderTools(store, "channel-a", "public");
  const [addTool, listTool, deleteTool] = tools;

  assert.deepEqual(
    tools.map((tool) => tool.exposure),
    ["deferred", "deferred", "deferred"],
  );
  const addResult = await addTool.execute(
    "tool-call",
    { message: "定例会", schedule: { type: "every", minutes: 30 } } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(created?.kind, "reminder");
  assert.equal(created?.accessScope, "public");
  assert.equal(created?.channelId, "channel-a");
  assert.equal(created?.message, "定例会");
  assert.deepEqual(created?.schedule, { type: "every", minutes: 30 });
  assert.match(
    addResult.content[0]?.type === "text" ? addResult.content[0].text : "",
    /登録しました/u,
  );

  const listResult = await listTool.execute(
    "tool-call",
    {} as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(
    (listResult.details as unknown as { reminders: unknown[] }).reminders instanceof Array,
    true,
  );

  await deleteTool.execute(
    "tool-call",
    { id: created!.id } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(deletedId, created?.id);
});
