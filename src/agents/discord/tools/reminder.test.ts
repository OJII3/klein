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

  assert.deepEqual(
    tools.map((tool) => tool.exposure),
    ["deferred", "deferred", "deferred"],
  );
  const addResult = await addTool.execute(
    "tool-call",
    { message: "定例会", schedule: { type: "after", minutes: 1 } },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(created?.accessScope, "public");
  assert.equal(created?.channelId, "channel-a");
  assert.equal(created?.message, "定例会");
  assert.match(
    addResult.content[0].type === "text" ? addResult.content[0].text : "",
    /登録しました/u,
  );

  const listResult = await listTool.execute("tool-call", {}, undefined, undefined, {} as never);
  assert.equal(listResult.details?.reminders instanceof Array, true);

  await deleteTool.execute("tool-call", { id: created!.id }, undefined, undefined, {} as never);
  assert.equal(deletedId, created?.id);
});
