import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import { FileDiscordChannelLinkRequestStore } from "./file-discord-channel-link-request-store";

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

test("treats a missing file as no pending link requests", async () => {
  await using temp = await createTempDir("klein-discord-channel-link-requests-");
  const store = new FileDiscordChannelLinkRequestStore(join(temp.path, "requests.json"));

  await store.load();

  assert.deepEqual(store.list(), []);
});

test("persists and removes pending link requests", async () => {
  await using temp = await createTempDir("klein-discord-channel-link-requests-");
  const filePath = join(temp.path, "requests.json");
  const store = new FileDiscordChannelLinkRequestStore(filePath);
  await store.load();

  await store.save(request);

  const reloaded = new FileDiscordChannelLinkRequestStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.list(), [request]);

  await reloaded.remove("request-1");
  const afterRemoval = new FileDiscordChannelLinkRequestStore(filePath);
  await afterRemoval.load();
  assert.deepEqual(afterRemoval.list(), []);
});

test("rejects invalid pending link request files", async () => {
  await using temp = await createTempDir("klein-discord-channel-link-requests-");
  const filePath = join(temp.path, "requests.json");
  const store = new FileDiscordChannelLinkRequestStore(filePath);

  await writeFile(filePath, "{");
  await assert.rejects(store.load(), /not valid JSON/u);

  await writeFile(filePath, JSON.stringify({ requests: [{ requestId: "request-1" }] }));
  await assert.rejects(store.load(), /invalid/u);
});
