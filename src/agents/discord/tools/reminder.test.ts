import assert from "node:assert/strict";
import test from "node:test";

import type { Reminder } from "@modules/reminders/domain/reminder";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
import { createReminderTools } from "./reminder";

test("provides deferred add, list, and delete tools scoped to the conversation", async () => {
  let created: Reminder | undefined;
  let deletedId: string | undefined;
  const tools = createReminderTools(
    {
      async create(reminder) {
        created = reminder;
      },
      async listForScope(channelId, accessScope) {
        assert.equal(channelId, "channel-a");
        assert.equal(accessScope, "public");
        return created ? [created] : [];
      },
      async listDue() {
        return [];
      },
      async delete(channelId, accessScope, reminderId) {
        assert.equal(channelId, "channel-a");
        assert.equal(accessScope, "public");
        deletedId = reminderId;
        return true;
      },
      async updateDueAt() {},
    } satisfies ReminderStore,
    "channel-a",
    "public",
  );
  const [addTool, listTool, deleteTool] = tools;
  const call = { callId: "tool-call" } as never;

  assert.deepEqual(
    tools.map((tool) => tool.deferred),
    [true, true, true],
  );
  const addResult = await addTool.execute(
    { message: "定例会", schedule: { type: "after", minutes: 1 } } as never,
    call,
    {} as never,
  );
  assert.equal(created?.accessScope, "public");
  assert.equal(created?.channelId, "channel-a");
  assert.equal(created?.message, "定例会");
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
