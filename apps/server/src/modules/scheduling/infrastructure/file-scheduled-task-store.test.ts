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
  script: "text(args[0]); silent();",
  args: ["--json"],
  message: "在庫の変化を確認してください。",
  priority: "normal",
  enabled: true,
  state: { cursor: "abc" },
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

test("persists tasks in a linked user scope", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const userWatch: WatchTask = { ...watch, id: "watch-user", accessScope: "user:456" };
  const store = new FileScheduledTaskStore(temp.path);
  await store.create(userWatch);

  const reopened = new FileScheduledTaskStore(temp.path);
  assert.deepEqual(await reopened.listForScope("watch", "channel-a", "user:456"), [userWatch]);
});

test("round-trips a reminder's running worker, attempts, and error", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const store = new FileScheduledTaskStore(temp.path);
  const running: ReminderTask = {
    ...reminder,
    runningWorkerId: "reminder:reminder-1:2026-10-14T00:01:00.000Z",
    attempts: 2,
    lastError: "worker start failed",
  };
  await store.create(running);
  assert.deepEqual(await store.listForScope("reminder", "channel-a", "public"), [running]);
});

test("rejects invalid reminder run fields", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);
  const invalidFields = [
    { runningWorkerId: "" },
    { runningWorkerId: 1 },
    { attempts: -1 },
    { attempts: 1.5 },
    { attempts: "1" },
    { lastError: "" },
    { lastError: 1 },
  ];
  for (const [index, fields] of invalidFields.entries()) {
    await writeFile(
      join(directory, `invalid-reminder-${index}.json`),
      JSON.stringify({ ...reminder, ...fields }),
    );
  }
  await assert.rejects(
    store.listForScope("reminder", "channel-a", "public"),
    /リマインダーの保存内容/u,
  );
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

test("treats a watch without the enabled field as enabled", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);
  const { enabled: _enabled, ...legacyWatch } = watch;
  await writeFile(join(directory, "legacy-watch.json"), JSON.stringify(legacyWatch));
  assert.deepEqual(await store.listDue(Date.parse("2026-10-14T00:05:00.000Z")), [watch]);
});

test("keeps disabled watches out of the due list", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);
  const disabledWatch: WatchTask = { ...watch, enabled: false };
  await store.create(disabledWatch);
  assert.deepEqual(await store.listDue(Date.parse("2026-10-14T00:05:00.000Z")), []);
  assert.deepEqual(await store.listForScope("watch", "channel-a", "owner:123"), [disabledWatch]);
});

test("round-trips the worker that owns a watch", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);
  const workerWatch: WatchTask = { ...watch, ownerWorkerId: "worker-1" };
  await store.create(workerWatch);
  assert.deepEqual(await store.listForScope("watch", "channel-a", "owner:123"), [workerWatch]);
});

test("reads a watch saved with the legacy ownerTaskId", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);
  const legacyWatch = { ...watch, ownerTaskId: "worker-1" };
  await writeFile(join(directory, "legacy-owner.json"), JSON.stringify(legacyWatch));
  assert.deepEqual(await store.listForScope("watch", "channel-a", "owner:123"), [
    { ...watch, ownerWorkerId: "worker-1" },
  ]);
});

test("round-trips an urgent watch priority", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const store = new FileScheduledTaskStore(temp.path);
  const urgentWatch: WatchTask = { ...watch, priority: "urgent" };
  await store.create(urgentWatch);
  assert.deepEqual(await store.listForScope("watch", "channel-a", "owner:123"), [urgentWatch]);
});

test("treats a watch without priority as normal", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);
  const { priority: _priority, ...legacyWatch } = watch;
  await writeFile(join(directory, "legacy-priority.json"), JSON.stringify(legacyWatch));
  const parsed = await store.listForScope("watch", "channel-a", "owner:123");
  assert.deepEqual(parsed, [watch]);
  assert.equal(parsed[0]?.priority, "normal");
});

test("rejects an invalid watch priority", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);
  await writeFile(
    join(directory, "invalid-priority.json"),
    JSON.stringify({ ...watch, priority: "critical" }),
  );
  await assert.rejects(store.listForScope("watch", "channel-a", "owner:123"), /watch 設定/u);
});

test("round-trips a watch's delivery state", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const store = new FileScheduledTaskStore(temp.path);
  const failed: WatchTask = {
    ...watch,
    lastDeliveryAt: "2026-10-14T00:05:00.000Z",
    lastDeliveryStatus: "error",
    lastDeliveryError: "prompt failed",
    consecutiveDeliveryFailures: 2,
  };
  await store.create(failed);
  assert.deepEqual(await store.listForScope("watch", "channel-a", "owner:123"), [failed]);
});

test("rejects invalid watch delivery fields", async () => {
  await using temp = await createTempDir("klein-schedules-");
  const directory = temp.path;
  const store = new FileScheduledTaskStore(directory);
  const invalidFields = [
    { lastDeliveryAt: "not-a-date" },
    { lastDeliveryAt: 1 },
    { lastDeliveryStatus: "unknown" },
    { lastDeliveryError: "" },
    { lastDeliveryError: 1 },
    { consecutiveDeliveryFailures: -1 },
    { consecutiveDeliveryFailures: 1.5 },
    { consecutiveDeliveryFailures: "1" },
  ];
  for (const [index, fields] of invalidFields.entries()) {
    await writeFile(
      join(directory, `invalid-delivery-${index}.json`),
      JSON.stringify({ ...watch, ...fields }),
    );
  }
  await assert.rejects(store.listForScope("watch", "channel-a", "owner:123"), /watch 設定/u);
});
