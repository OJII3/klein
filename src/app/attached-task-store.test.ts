import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { FileAttachedTaskStore, type StoredAttachedTask } from "./attached-task-store";
import { createTempDir } from "../testing/temp-dir";

function createTask(overrides: Partial<StoredAttachedTask> = {}): StoredAttachedTask {
  return {
    id: "attached-1",
    conversationKey: { kind: "discord", channelId: "channel-a" },
    accessScope: "public",
    ownerFeaturesAllowed: false,
    prompt: "investigate",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closeAfterResult: false,
    ...overrides,
  };
}

test("saves, lists, and deletes attached tasks", async () => {
  await using temp = await createTempDir("klein-attached-tasks-");
  const store = new FileAttachedTaskStore(temp.path);

  assert.deepEqual(await store.list(), []);

  await store.save(createTask());
  await store.save(
    createTask({
      id: "attached-2",
      conversationKey: { kind: "discord", channelId: "channel-b" },
    }),
  );

  const tasks = await store.list();
  assert.deepEqual(tasks.map((task) => task.id).toSorted(), ["attached-1", "attached-2"]);

  await store.delete("attached-1");
  assert.deepEqual(
    (await store.list()).map((task) => task.id),
    ["attached-2"],
  );

  await store.delete("attached-1");
});

test("ignores legacy and malformed task files", async () => {
  await using temp = await createTempDir("klein-attached-tasks-");
  await writeFile(resolve(temp.path, "broken.json"), "{ not json", "utf8");
  await writeFile(resolve(temp.path, "invalid.json"), JSON.stringify({ id: "x" }), "utf8");
  await writeFile(
    resolve(temp.path, "legacy.json"),
    JSON.stringify({
      id: "legacy-1",
      channelId: "channel-a",
      accessScope: "public",
      ownerFeaturesAllowed: false,
      prompt: "investigate",
      status: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      closeAfterResult: false,
    }),
    "utf8",
  );
  await writeFile(
    resolve(temp.path, "empty-channel.json"),
    JSON.stringify(
      createTask({
        id: "empty-channel",
        conversationKey: { kind: "discord", channelId: "" },
      }),
    ),
    "utf8",
  );

  const store = new FileAttachedTaskStore(temp.path);
  assert.deepEqual(await store.list(), []);
});
