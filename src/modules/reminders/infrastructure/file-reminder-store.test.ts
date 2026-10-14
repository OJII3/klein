import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Reminder } from "../domain/reminder";
import { FileReminderStore } from "./file-reminder-store";

test("stores, lists, updates, and deletes reminders within their sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-reminders-"));
  const store = new FileReminderStore(directory);
  const reminder: Reminder = {
    id: "reminder-1",
    sessionKey: "session-a",
    channelId: "channel-a",
    ownerFeaturesAllowed: false,
    message: "定例会",
    createdAt: "2026-10-14T00:00:00.000Z",
    dueAt: "2026-10-14T00:01:00.000Z",
  };

  try {
    await store.create(reminder);
    assert.deepEqual(await store.listForSession("session-a"), [reminder]);
    assert.deepEqual(await store.listForSession("session-b"), []);
    assert.deepEqual(await store.listDue(Date.parse("2026-10-14T00:01:00.000Z")), [reminder]);

    await store.updateDueAt(reminder, "2026-10-15T00:01:00.000Z");
    assert.equal((await store.listForSession("session-a"))[0].dueAt, "2026-10-15T00:01:00.000Z");
    assert.equal(await store.delete("session-b", reminder.id), false);
    assert.equal(await store.delete("session-a", reminder.id), true);
    assert.deepEqual(await store.listForSession("session-a"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
