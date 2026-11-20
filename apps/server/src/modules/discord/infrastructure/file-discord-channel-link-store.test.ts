import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import { FileDiscordChannelLinkStore } from "./file-discord-channel-link-store";

const channelLink = {
  guildId: "100",
  channelId: "200",
  userId: "300",
  linkedAt: "2026-01-01T00:00:00.000Z",
} as const;

const threadLink = {
  guildId: "100",
  channelId: "200",
  threadId: "400",
  userId: "500",
  linkedAt: "2026-01-02T00:00:00.000Z",
} as const;

test("treats a missing file as no channel links", async () => {
  await using temp = await createTempDir("klein-discord-channel-links-");
  const store = new FileDiscordChannelLinkStore(join(temp.path, "links.json"));

  await store.load();

  assert.equal(store.getLink({ guildId: "100", channelId: "200" }), undefined);
});

test("persists channel and thread links", async () => {
  await using temp = await createTempDir("klein-discord-channel-links-");
  const filePath = join(temp.path, "links.json");
  const store = new FileDiscordChannelLinkStore(filePath);
  await store.load();

  await store.saveLink(channelLink);
  await store.saveLink(threadLink);

  const reloaded = new FileDiscordChannelLinkStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.getLink({ guildId: "100", channelId: "200" }), channelLink);
  assert.deepEqual(
    reloaded.getLink({ guildId: "100", channelId: "200", threadId: "400" }),
    threadLink,
  );
  assert.equal(reloaded.getLink({ guildId: "100", channelId: "999" }), undefined);
});

test("replaces a link for the same location", async () => {
  await using temp = await createTempDir("klein-discord-channel-links-");
  const filePath = join(temp.path, "links.json");
  const store = new FileDiscordChannelLinkStore(filePath);
  await store.load();

  await store.saveLink(channelLink);
  const replacement = { ...channelLink, userId: "600", linkedAt: "2026-02-01T00:00:00.000Z" };
  await store.saveLink(replacement);

  const reloaded = new FileDiscordChannelLinkStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.getLink({ guildId: "100", channelId: "200" }), replacement);
});

test("removes a link for a location", async () => {
  await using temp = await createTempDir("klein-discord-channel-links-");
  const filePath = join(temp.path, "links.json");
  const store = new FileDiscordChannelLinkStore(filePath);
  await store.load();
  await store.saveLink(channelLink);
  await store.saveLink(threadLink);

  await store.removeLink({ guildId: "100", channelId: "200" });

  const reloaded = new FileDiscordChannelLinkStore(filePath);
  await reloaded.load();
  assert.equal(reloaded.getLink({ guildId: "100", channelId: "200" }), undefined);
  assert.deepEqual(
    reloaded.getLink({ guildId: "100", channelId: "200", threadId: "400" }),
    threadLink,
  );
});

test("lists links for a guild", async () => {
  await using temp = await createTempDir("klein-discord-channel-links-");
  const store = new FileDiscordChannelLinkStore(join(temp.path, "links.json"));
  await store.load();

  await store.saveLink(channelLink);
  await store.saveLink(threadLink);
  await store.saveLink({
    guildId: "999",
    channelId: "888",
    userId: "777",
    linkedAt: "2026-01-03T00:00:00.000Z",
  });

  assert.deepEqual(
    store.listLinks("100").map(({ guildId, channelId, threadId, userId }) => ({
      guildId,
      channelId,
      threadId,
      userId,
    })),
    [
      { guildId: "100", channelId: "200", threadId: undefined, userId: "300" },
      { guildId: "100", channelId: "200", threadId: "400", userId: "500" },
    ],
  );
  assert.equal(store.listLinks("999").length, 1);
});

test("rejects invalid channel link files", async () => {
  await using temp = await createTempDir("klein-discord-channel-links-");
  const filePath = join(temp.path, "links.json");
  const store = new FileDiscordChannelLinkStore(filePath);

  await writeFile(filePath, "{");
  await assert.rejects(store.load(), /not valid JSON/u);

  await writeFile(filePath, JSON.stringify({ links: [{ guildId: "100" }] }));
  await assert.rejects(store.load(), /invalid/u);
});
