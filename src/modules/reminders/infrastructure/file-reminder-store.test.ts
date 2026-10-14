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

for (const [sessionKey, ownerFeaturesAllowed, accessScope] of [
  ["discord-channel:123", false, "public"],
  ["discord-channel:123:rotation:2026-10-14", false, "public"],
  ["discord-channel:123:public:rotation:2026-10-14", false, "public"],
  ["discord-channel:123:owner:456", true, "owner:456"],
  ["discord-channel:123:owner:456:rotation:2026-10-14", true, "owner:456"],
] as const) {
  test(`fully migrates ${sessionKey} and is idempotent`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "klein-reminders-"));
    const path = join(directory, "legacy.json");
    const store = new FileReminderStore(directory);
    const legacy = {
      ...legacyReminder,
      sessionKey,
      ownerFeaturesAllowed,
      repeat: "daily",
      time: "09:00",
    };
    try {
      await writeFile(path, JSON.stringify(legacy));
      assert.equal(await store.migrateLegacyReminders(), 1);
      const { sessionKey: _, ownerFeaturesAllowed: __, ...fields } = legacy;
      const expected = { ...fields, accessScope };
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), expected);
      assert.deepEqual(await store.listForScope("123", accessScope), [expected]);
      assert.equal(await store.migrateLegacyReminders(), 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("rejects legacy records during normal reads and deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-reminders-"));
  const store = new FileReminderStore(directory);
  try {
    await writeFile(join(directory, "legacy.json"), JSON.stringify(legacyReminder));
    await assert.rejects(store.listForScope("123", "public"), /移行/u);
    await assert.rejects(store.listDue(Date.now()), /移行/u);
    await assert.rejects(store.delete("123", "public", "legacy"), /移行/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [sessionKey, ownerFeaturesAllowed] of [
  ["discord-channel:123", true],
  ["discord-channel:123:rotation:2026-10-14", true],
  ["discord-channel:123:public", true],
  ["discord-channel:123:owner:456", false],
  ["discord-channel:999:public", false],
] as const) {
  test(`retains every file when ownership is ambiguous or inconsistent: ${sessionKey}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "klein-reminders-"));
    const store = new FileReminderStore(directory);
    const publicPath = join(directory, "a-public.json");
    const ambiguousPath = join(directory, "legacy.json");
    const publicJson = JSON.stringify({ ...legacyReminder, id: "a-public" });
    const ambiguousJson = JSON.stringify({ ...legacyReminder, sessionKey, ownerFeaturesAllowed });
    try {
      await writeFile(publicPath, publicJson);
      await writeFile(ambiguousPath, ambiguousJson);
      await assert.rejects(store.migrateLegacyReminders(), /所有者を確定できません/u);
      assert.equal(await readFile(publicPath, "utf8"), publicJson);
      assert.equal(await readFile(ambiguousPath, "utf8"), ambiguousJson);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

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
  test(`rejects invalid reminder contents before migration: ${JSON.stringify(invalidFields)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "klein-reminders-"));
    const store = new FileReminderStore(directory);
    const path = join(directory, "legacy.json");
    try {
      const legacyJson = JSON.stringify({ ...legacyReminder, ...invalidFields });
      await writeFile(path, legacyJson);
      await assert.rejects(store.migrateLegacyReminders());
      assert.equal(await readFile(path, "utf8"), legacyJson);

      const { sessionKey: _, ownerFeaturesAllowed: __, ...fields } = legacyReminder;
      const newJson = JSON.stringify({ ...fields, accessScope: "public", ...invalidFields });
      await writeFile(path, newJson);
      await assert.rejects(store.migrateLegacyReminders());
      await assert.rejects(store.listDue(Date.now()));
      assert.equal(await readFile(path, "utf8"), newJson);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("rejects mismatched filenames before writing any migrated reminder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-reminders-"));
  const store = new FileReminderStore(directory);
  const publicPath = join(directory, "a-public.json");
  const mismatchedPath = join(directory, "wrong.json");
  const publicJson = JSON.stringify({ ...legacyReminder, id: "a-public" });
  const mismatchedJson = JSON.stringify(legacyReminder);
  try {
    await writeFile(publicPath, publicJson);
    await writeFile(mismatchedPath, mismatchedJson);
    await assert.rejects(store.migrateLegacyReminders(), /ファイル名がIDと一致しません/u);
    assert.equal(await readFile(publicPath, "utf8"), publicJson);
    assert.equal(await readFile(mismatchedPath, "utf8"), mismatchedJson);
    await assert.rejects(readFile(join(directory, "legacy.json")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
