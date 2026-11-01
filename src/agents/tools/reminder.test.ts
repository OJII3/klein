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
  const call = { callId: "tool-call" } as never;

  assert.deepEqual(
    tools.map((tool) => tool.deferred),
    [true, true, true],
  );
  const addResult = await addTool.execute(
    { message: "定例会", schedule: { type: "every", minutes: 30 } } as never,
    call,
    {} as never,
  );
  assert.equal(created?.kind, "reminder");
  assert.equal(created?.accessScope, "public");
  assert.equal(created?.channelId, "channel-a");
  assert.equal(created?.message, "定例会");
  assert.deepEqual(created?.schedule, { type: "every", minutes: 30 });
  assert.match(
    addResult.output?.[0]?.type === "text" ? addResult.output[0].text : "",
    /登録しました/u,
  );

  const listResult = await listTool.execute({} as never, call, {} as never);
  assert.equal(
    (listResult.details as unknown as { reminders: unknown[] }).reminders instanceof Array,
    true,
  );

  await deleteTool.execute({ id: created!.id } as never, call, {} as never);
  assert.equal(deletedId, created?.id);
});
