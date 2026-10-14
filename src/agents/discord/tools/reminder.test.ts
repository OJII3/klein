import assert from "node:assert/strict";
import test from "node:test";

import type { Reminder } from "@modules/reminders/domain/reminder";
import type { ReminderStore } from "@modules/reminders/ports/reminder-store";
import { createReminderTools } from "./reminder";

test("provides deferred add, list, and delete tools scoped to the Pi session", async () => {
  let created: Reminder | undefined;
  let deletedId: string | undefined;
  const tools = createReminderTools(
    {
      async create(reminder) {
        created = reminder;
      },
      async listForSession(sessionKey) {
        assert.equal(sessionKey, "session-a");
        return created ? [created] : [];
      },
      async listDue() {
        return [];
      },
      async delete(sessionKey, reminderId) {
        assert.equal(sessionKey, "session-a");
        deletedId = reminderId;
        return true;
      },
      async updateDueAt() {},
    } satisfies ReminderStore,
    "session-a",
    "channel-a",
    false,
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
  assert.equal(created?.sessionKey, "session-a");
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
