import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import { FileDiscordAccessRequestStore } from "./file-discord-access-request-store";

const request = {
  requestId: "request-1",
  guildId: "100",
  channelId: "200",
  threadId: "300",
  pendingChannelId: "300",
  channelName: "thread-name",
  requesterUserId: "400",
  pendingMessageId: "500",
} as const;

const requestWithoutThread = {
  requestId: "request-2",
  guildId: "100",
  channelId: "200",
  pendingChannelId: "300",
  channelName: "thread-name",
  requesterUserId: "400",
  pendingMessageId: "500",
} as const;

test("treats a missing file as no pending requests", async () => {
  await using temp = await createTempDir("klein-discord-access-requests-");
  const store = new FileDiscordAccessRequestStore(join(temp.path, "requests.json"));

  await store.load();

  assert.deepEqual(store.list(), []);
});

test("persists and removes pending requests", async () => {
  await using temp = await createTempDir("klein-discord-access-requests-");
  const filePath = join(temp.path, "requests.json");
  const store = new FileDiscordAccessRequestStore(filePath);
  await store.load();

  await store.save(request);
  await store.save(requestWithoutThread);

  const reloaded = new FileDiscordAccessRequestStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.list(), [request, requestWithoutThread]);

  await reloaded.remove("request-1");
  const afterRemoval = new FileDiscordAccessRequestStore(filePath);
  await afterRemoval.load();
  assert.deepEqual(afterRemoval.list(), [requestWithoutThread]);
});

test("rejects invalid pending request files", async () => {
  await using temp = await createTempDir("klein-discord-access-requests-");
  const filePath = join(temp.path, "requests.json");
  const store = new FileDiscordAccessRequestStore(filePath);

  await writeFile(filePath, "{");
  await assert.rejects(store.load(), /not valid JSON/u);

  await writeFile(filePath, JSON.stringify({ requests: [{ requestId: "request-1" }] }));
  await assert.rejects(store.load(), /invalid/u);
});
