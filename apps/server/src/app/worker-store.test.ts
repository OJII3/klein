import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { FileWorkerStore, type StoredWorker } from "./worker-store";
import { createTempDir } from "../testing/temp-dir";

function createWorker(overrides: Partial<StoredWorker> = {}): StoredWorker {
  return {
    id: "worker-1",
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

test("saves, lists, and deletes workers", async () => {
  await using temp = await createTempDir("klein-workers-");
  const store = new FileWorkerStore(temp.path);

  assert.deepEqual(await store.list(), []);

  await store.save(createWorker());
  await store.save(
    createWorker({
      id: "worker-2",
      conversationKey: { kind: "discord", channelId: "channel-b" },
    }),
  );

  const workers = await store.list();
  assert.deepEqual(workers.map((worker) => worker.id).toSorted(), ["worker-1", "worker-2"]);

  await store.delete("worker-1");
  assert.deepEqual(
    (await store.list()).map((worker) => worker.id),
    ["worker-2"],
  );

  await store.delete("worker-1");
});

test("ignores legacy and malformed worker files", async () => {
  await using temp = await createTempDir("klein-workers-");
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
      createWorker({
        id: "empty-channel",
        conversationKey: { kind: "discord", channelId: "" },
      }),
    ),
    "utf8",
  );
  await writeFile(
    resolve(temp.path, "invalid-access-scope.json"),
    JSON.stringify({ ...createWorker({ id: "invalid-access-scope" }), accessScope: "owner:" }),
    "utf8",
  );

  const store = new FileWorkerStore(temp.path);
  assert.deepEqual(await store.list(), []);
});
