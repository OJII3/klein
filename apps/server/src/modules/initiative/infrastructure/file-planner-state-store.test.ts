import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import { FilePlannerStateStore } from "./file-planner-state-store";

test("saves and loads planner state per scope", async () => {
  await using temp = await createTempDir("klein-planner-state-");
  const store = new FilePlannerStateStore(join(temp.path, "planner"));
  const state = {
    version: 1 as const,
    channelId: "channel-1",
    accessScope: "owner:1" as const,
    lastMessageId: "m2",
    lastPlannedAt: "2026-11-21T12:00:00.000Z",
    plansOnDate: "2026-11-21",
    plansToday: 2,
  };

  await store.save(state);

  assert.deepEqual(await store.get("channel-1", "owner:1"), state);
  assert.equal(await store.get("channel-1", "user:2"), undefined);
});
