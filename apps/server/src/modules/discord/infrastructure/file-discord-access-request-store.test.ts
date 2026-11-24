import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
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

test("persists and restores the request expiry", async () => {
  await using temp = await createTempDir("klein-discord-access-requests-");
  const filePath = join(temp.path, "requests.json");
  const store = new FileDiscordAccessRequestStore(filePath);
  await store.load();

  const expiring = { ...request, expiresAt: "2026-11-26T00:00:00.000Z" };
  await store.save(expiring);

  const reloaded = new FileDiscordAccessRequestStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.list(), [expiring]);
});

test("persists and restores the owner message id", async () => {
  await using temp = await createTempDir("klein-discord-access-requests-");
  const filePath = join(temp.path, "requests.json");
  const store = new FileDiscordAccessRequestStore(filePath);
  await store.load();

  const withOwnerMessage = { ...request, ownerMessageId: "600" };
  await store.save(withOwnerMessage);

  const reloaded = new FileDiscordAccessRequestStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.list(), [withOwnerMessage]);
});

test("loads an empty list and quarantines a request with an empty expiry", async () => {
  await using temp = await createTempDir("klein-discord-access-requests-");
  const filePath = join(temp.path, "requests.json");
  const store = new FileDiscordAccessRequestStore(filePath);
  await writeFile(filePath, JSON.stringify({ requests: [{ ...request, expiresAt: "" }] }));

  await store.load();

  assert.deepEqual(store.list(), []);
  assert.deepEqual(await readdir(temp.path), ["corrupt"]);
  assert.equal((await readdir(join(temp.path, "corrupt"))).length, 1);
});

test("loads an empty list and quarantines invalid pending request files", async () => {
  await using temp = await createTempDir("klein-discord-access-requests-");
  const filePath = join(temp.path, "requests.json");
  const store = new FileDiscordAccessRequestStore(filePath);

  await writeFile(filePath, "{");
  await store.load();
  assert.deepEqual(store.list(), []);

  await writeFile(filePath, JSON.stringify({ requests: [{ requestId: "request-1" }] }));
  await store.load();
  assert.deepEqual(store.list(), []);
  assert.equal((await readdir(join(temp.path, "corrupt"))).length, 2);
});
