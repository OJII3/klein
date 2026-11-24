import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import type { SecretRequest } from "../domain/secret-request";
import { FileSecretRequestStore } from "./file-secret-request-store";

const request: SecretRequest = {
  requestId: "request-1",
  userId: "123",
  channelId: "channel-1",
  accessScope: "user:123",
  workerId: "worker-1",
  service: "github",
  label: "GitHub",
  reason: "Issueを確認するため",
  fields: [{ key: "token", label: "トークン", env: "GH_TOKEN" }],
  createdAt: "2026-11-22T00:00:00.000Z",
  expiresAt: "2026-11-22T00:15:00.000Z",
};

test("persists pending requests without values", async () => {
  await using temp = await createTempDir("klein-secret-requests-");
  const path = `${temp.path}/secret-requests.json`;
  const store = new FileSecretRequestStore(path);

  await store.save(request);
  await store.save({
    ...request,
    requestId: "request-2",
    service: "example",
    dmChannelId: "dm-channel",
    dmMessageId: "dm-message",
  });

  const restarted = new FileSecretRequestStore(path);
  await restarted.load();
  assert.deepEqual(restarted.list(), [
    request,
    {
      ...request,
      requestId: "request-2",
      service: "example",
      dmChannelId: "dm-channel",
      dmMessageId: "dm-message",
    },
  ]);

  const raw = await readFile(path, "utf8");
  assert.doesNotMatch(raw, /secret|password/iu);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }

  await restarted.remove("request-1");
  assert.deepEqual(
    restarted.list().map((entry) => entry.requestId),
    ["request-2"],
  );
});

test("treats a missing file as no pending requests", async () => {
  await using temp = await createTempDir("klein-secret-requests-missing-");
  const store = new FileSecretRequestStore(`${temp.path}/secret-requests.json`);

  await store.load();
  assert.deepEqual(store.list(), []);
});

test("loads an empty list and quarantines a corrupt file", async () => {
  await using temp = await createTempDir("klein-secret-requests-corrupt-");
  const path = `${temp.path}/secret-requests.json`;
  await writeFile(path, "{not json", "utf8");
  const store = new FileSecretRequestStore(path);

  await store.load();
  assert.deepEqual(store.list(), []);

  await writeFile(path, JSON.stringify({ requests: [{ requestId: "request-1" }] }), "utf8");
  await store.load();
  assert.deepEqual(store.list(), []);
  assert.equal((await readdir(`${temp.path}/corrupt`)).length, 2);
});
