import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ReminderTask, WatchTask } from "../domain/scheduled-task";
import { FileScheduledTaskStore } from "./file-scheduled-task-store";
import { createTempDir } from "../../../testing/temp-dir";

const reminder: ReminderTask = {
  kind: "reminder",
  id: "reminder-1",
  channelId: "channel-a",
  accessScope: "public",
  message: "定例会",
  createdAt: "2026-10-14T00:00:00.000Z",
  schedule: { type: "once", at: "2026-10-14T00:01:00.000Z" },
  nextRunAt: "2026-10-14T00:01:00.000Z",
};

const watch: WatchTask = {
  kind: "watch",
  id: "watch-1",
  channelId: "channel-a",
  accessScope: "owner:123",
  name: "在庫監視",
  script: "return args[0];",
  args: ["--json"],
  condition: "change",
  message: "在庫の変化を確認してください。",
  cooldownMinutes: 30,
  consecutiveFailures: 0,
  createdAt: "2026-10-14T00:00:00.000Z",
  schedule: { type: "every", minutes: 5 },
  nextRunAt: "2026-10-14T00:05:00.000Z",
};

test("stores, lists, updates, and deletes scheduled tasks by kind and scope", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);

  await store.create(reminder);
  await store.create(watch);
  assert.deepEqual(await store.listForScope("reminder", "channel-a", "public"), [reminder]);
  assert.deepEqual(await store.listForScope("watch", "channel-a", "owner:123"), [watch]);
  assert.deepEqual(await store.listForScope("watch", "channel-a", "public"), []);
  assert.deepEqual(await store.listForScope("reminder", "channel-b", "public"), []);
  assert.deepEqual(await store.listDue(Date.parse("2026-10-14T00:05:00.000Z")), [reminder, watch]);

  const updatedWatch = {
    ...watch,
    lastStatus: "ok" as const,
    lastCheckedAt: "2026-10-14T00:05:00.000Z",
    nextRunAt: "2026-10-14T00:10:00.000Z",
  };
  await store.update(updatedWatch);
  assert.deepEqual(await store.listForScope("watch", "channel-a", "owner:123"), [updatedWatch]);

  assert.equal(await store.delete("watch", "channel-a", "public", watch.id), false);
  assert.equal(await store.delete("reminder", "channel-a", "public", reminder.id), true);
  assert.equal(await store.delete("watch", "channel-a", "owner:123", watch.id), true);
  assert.deepEqual(await store.listForScope("reminder", "channel-a", "public"), []);
  assert.deepEqual(await store.listForScope("watch", "channel-a", "owner:123"), []);
});

test("rejects the old reminder file shape", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);
  await writeFile(
    join(directory, "legacy.json"),
    JSON.stringify({
      id: "legacy",
      channelId: "123",
      accessScope: "public",
      message: "定例会",
      createdAt: "2026-10-14T00:00:00.000Z",
      dueAt: "2026-10-14T00:01:00.000Z",
    }),
  );
  await assert.rejects(store.listForScope("reminder", "123", "public"), /旧形式/u);
  await assert.rejects(store.listDue(Date.now()), /旧形式/u);
});

test("accepts public watch records", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);
  const publicWatch: WatchTask = { ...watch, accessScope: "public" };
  await writeFile(join(directory, "public-watch.json"), JSON.stringify(publicWatch));
  assert.deepEqual(await store.listDue(Date.parse("2026-10-14T00:05:00.000Z")), [publicWatch]);
  assert.deepEqual(await store.listForScope("watch", "channel-a", "public"), [publicWatch]);
});
