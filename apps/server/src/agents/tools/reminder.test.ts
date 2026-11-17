import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryScheduledTaskStore,
  createStubExtensionToolContext,
} from "@agents/testing/test-stubs";
import { createReminderTools } from "./reminder";

test("provides deferred add, list, and delete tools scoped to the conversation", async () => {
  const store = new InMemoryScheduledTaskStore([], {
    onListForScope(kind, channelId, accessScope) {
      assert.equal(kind, "reminder");
      assert.equal(channelId, "channel-a");
      assert.equal(accessScope, "public");
    },
  });
  const tools = createReminderTools(store, "channel-a", "public");
  const [addTool, listTool, deleteTool] = tools;
  const ctx = await createStubExtensionToolContext();

  assert.deepEqual(
    tools.map((tool) => tool.exposure),
    ["deferred", "deferred", "deferred"],
  );
  const addResult = await addTool.execute(
    "tool-call",
    { message: "定例会", schedule: { type: "every", minutes: 30 } },
    undefined,
    undefined,
    ctx,
  );
  const created = store.created[0];
  if (!created || created.kind !== "reminder") {
    assert.fail("expected a created reminder");
  }
  assert.equal(created.accessScope, "public");
  assert.equal(created.channelId, "channel-a");
  assert.equal(created.message, "定例会");
  assert.deepEqual(created.schedule, { type: "every", minutes: 30 });
  assert.match(
    addResult.content[0]?.type === "text" ? addResult.content[0].text : "",
    /登録しました/u,
  );

  const listResult = await listTool.execute("tool-call", {}, undefined, undefined, ctx);
  assert.equal(Array.isArray(listResult.details.reminders), true);

  await deleteTool.execute("tool-call", { id: created.id }, undefined, undefined, ctx);
  assert.deepEqual(store.deletedIds, [created.id]);
});
