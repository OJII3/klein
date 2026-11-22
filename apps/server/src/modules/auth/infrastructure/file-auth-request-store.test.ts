import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import type { AuthRequest } from "../domain/auth-request";
import { FileAuthRequestStore } from "./file-auth-request-store";

const request: AuthRequest = {
  requestId: "request-1",
  userId: "123",
  channelId: "channel-1",
  accessScope: "user:123",
  workerId: "worker-1",
  service: "github",
  label: "GitHub",
  reason: "Issueを確認するため",
  fields: [{ key: "token", label: "トークン" }],
  createdAt: "2026-11-22T00:00:00.000Z",
  expiresAt: "2026-11-22T00:15:00.000Z",
};

test("persists pending requests without values", async () => {
  await using temp = await createTempDir("klein-auth-requests-");
  const path = `${temp.path}/auth-requests.json`;
  const store = new FileAuthRequestStore(path);

  await store.save(request);
  await store.save({
    ...request,
    requestId: "request-2",
    service: "example",
    dmChannelId: "dm-channel",
    dmMessageId: "dm-message",
  });

  const restarted = new FileAuthRequestStore(path);
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
  await using temp = await createTempDir("klein-auth-requests-missing-");
  const store = new FileAuthRequestStore(`${temp.path}/auth-requests.json`);

  await store.load();
  assert.deepEqual(store.list(), []);
});
