import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Reminder } from "../domain/reminder";
import { FileReminderStore } from "./file-reminder-store";

test("stores, lists, updates, and deletes reminders within their channel and access scopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-reminders-"));
  const store = new FileReminderStore(directory);
  const reminder: Reminder = {
    id: "reminder-1",
    channelId: "channel-a",
    accessScope: "public",
    message: "定例会",
    createdAt: "2026-10-14T00:00:00.000Z",
    dueAt: "2026-10-14T00:01:00.000Z",
  };

  try {
    await store.create(reminder);
    assert.deepEqual(await store.listForScope("channel-a", "public"), [reminder]);
    assert.deepEqual(await store.listForScope("channel-b", "public"), []);
    assert.deepEqual(await store.listForScope("channel-a", "owner:123"), []);
    assert.equal(await store.delete("channel-a", "owner:123", reminder.id), false);
    assert.deepEqual(await store.listDue(Date.parse("2026-10-14T00:01:00.000Z")), [reminder]);

    await store.updateDueAt(reminder, "2026-10-15T00:01:00.000Z");
    assert.equal(
      (await store.listForScope("channel-a", "public"))[0].dueAt,
      "2026-10-15T00:01:00.000Z",
    );
    assert.equal(await store.delete("channel-b", "public", reminder.id), false);
    assert.equal(await store.delete("channel-a", "public", reminder.id), true);
    assert.deepEqual(await store.listForScope("channel-a", "public"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const legacyReminder = {
  id: "legacy",
  channelId: "123",
  sessionKey: "discord-channel:123",
  ownerFeaturesAllowed: false,
  message: "定例会",
  createdAt: "2026-10-14T00:00:00.000Z",
  dueAt: "2026-10-14T00:01:00.000Z",
};

test("rejects legacy records during normal reads and deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-reminders-"));
  const store = new FileReminderStore(directory);
  try {
    await writeFile(join(directory, "legacy.json"), JSON.stringify(legacyReminder));
    await assert.rejects(store.listForScope("123", "public"), /旧形式には対応していません/u);
    await assert.rejects(store.listDue(Date.now()), /旧形式には対応していません/u);
    await assert.rejects(store.delete("123", "public", "legacy"), /旧形式には対応していません/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const invalidFields of [
  { id: undefined },
  { id: "" },
  { channelId: "" },
  { message: 123 },
  { createdAt: "invalid" },
  { dueAt: "invalid" },
  { repeat: "monthly" },
  { repeat: "daily" },
  { repeat: "daily", time: "25:00" },
  { repeat: "weekly", time: "09:00", weekdays: [] },
  { repeat: "weekly", time: "09:00", weekdays: ["invalid"] },
]) {
  test(`rejects invalid reminder contents during reads: ${JSON.stringify(invalidFields)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "klein-reminders-"));
    const store = new FileReminderStore(directory);
    const path = join(directory, "legacy.json");
    try {
      const { sessionKey: _, ownerFeaturesAllowed: __, ...fields } = legacyReminder;
      const newJson = JSON.stringify({ ...fields, accessScope: "public", ...invalidFields });
      await writeFile(path, newJson);
      await assert.rejects(store.listDue(Date.now()));
      await assert.rejects(store.listForScope("123", "public"));
      await assert.rejects(store.delete("123", "public", "legacy"));
      assert.equal(await readFile(path, "utf8"), newJson);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
