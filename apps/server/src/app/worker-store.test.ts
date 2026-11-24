import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
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

test("quarantines legacy and malformed worker files", async () => {
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
  assert.equal((await readdir(resolve(temp.path, "corrupt"))).length, 5);
});

test("persists a pending result and rejects malformed result fields", async () => {
  await using temp = await createTempDir("klein-workers-");
  const store = new FileWorkerStore(temp.path);

  await store.save(
    createWorker({
      lastResult: { workerId: "worker-1", status: "failed", text: "", error: "boom" },
    }),
  );
  await store.save(
    createWorker({
      id: "worker-2",
      lastResult: { workerId: "worker-2", status: "completed", text: "done" },
      resultDeliveredAt: "2026-01-01T00:05:00.000Z",
    }),
  );

  const workers = (await store.list()).toSorted((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(
    workers.map((worker) => [worker.id, worker.lastResult, worker.resultDeliveredAt]),
    [
      ["worker-1", { workerId: "worker-1", status: "failed", text: "", error: "boom" }, undefined],
      [
        "worker-2",
        { workerId: "worker-2", status: "completed", text: "done" },
        "2026-01-01T00:05:00.000Z",
      ],
    ],
  );

  for (const [index, invalidResult] of [
    { workerId: "worker-3", status: "running", text: "done" },
    { workerId: 3, status: "completed", text: "done" },
    { workerId: "worker-3", status: "completed" },
    { workerId: "worker-3", status: "completed", text: "done", error: 1 },
  ].entries()) {
    await writeFile(
      resolve(temp.path, `invalid-result-${index}.json`),
      JSON.stringify({ ...createWorker({ id: "worker-3" }), lastResult: invalidResult }),
      "utf8",
    );
  }
  await writeFile(
    resolve(temp.path, "invalid-delivered-at.json"),
    JSON.stringify(
      createWorker({
        id: "worker-4",
        lastResult: { workerId: "worker-4", status: "completed", text: "done" },
        resultDeliveredAt: "yesterday",
      }),
    ),
    "utf8",
  );

  assert.deepEqual((await store.list()).map((worker) => worker.id).toSorted(), [
    "worker-1",
    "worker-2",
  ]);
});
