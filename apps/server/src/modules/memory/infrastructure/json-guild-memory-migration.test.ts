import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { isFileNotFound } from "@shared/type-guards";

import { migrateLegacyGuildMemory } from "./json-guild-memory-migration";
import { MarkdownGuildMemoryStore } from "./markdown-guild-memory-store";
import { createTempDir } from "../../../testing/temp-dir";

test("migrates legacy JSON entries into per-scope markdown files", async () => {
  await using temp = await createTempDir("klein-guild-memory-migration-");
  const guildDirectory = join(temp.path, "guild-a");
  await mkdir(guildDirectory, { recursive: true });
  await writeFile(
    join(guildDirectory, "MEMORY.json"),
    JSON.stringify({
      entries: [
        createEntry("ギルドの事実", "ギルド全体", { type: "guild" }),
        createEntry("チャンネルの事実", "チャンネル", { channelId: "channel-1", type: "channel" }),
        createEntry("スレッドの事実", "スレッド", {
          channelId: "channel-1",
          threadId: "thread-1",
          type: "thread",
        }),
      ],
    }),
    "utf8",
  );

  await migrateLegacyGuildMemory(temp.path);

  const store = new MarkdownGuildMemoryStore(temp.path);
  assert.deepEqual(await store.read("guild-a", { type: "guild" }), {
    facts: ["ギルドの事実: ギルド全体"],
    preferences: [],
  });
  assert.deepEqual(await store.read("guild-a", { channelId: "channel-1", type: "channel" }), {
    facts: ["チャンネルの事実: チャンネル"],
    preferences: [],
  });
  assert.deepEqual(
    await store.read("guild-a", {
      channelId: "channel-1",
      threadId: "thread-1",
      type: "thread",
    }),
    { facts: ["スレッドの事実: スレッド"], preferences: [] },
  );

  assert.match(await readFile(join(guildDirectory, "MEMORY.md"), "utf8"), /^# MEMORY\.md\n/u);
  await assert.rejects(access(join(guildDirectory, "MEMORY.json")), (error: unknown) =>
    isFileNotFound(error),
  );
  await access(join(guildDirectory, "MEMORY.json.migrated"));
});

test("leaves a malformed legacy file untouched", async () => {
  await using temp = await createTempDir("klein-guild-memory-migration-");
  const guildDirectory = join(temp.path, "guild-a");
  await mkdir(guildDirectory, { recursive: true });
  await writeFile(join(guildDirectory, "MEMORY.json"), "{", "utf8");

  await migrateLegacyGuildMemory(temp.path);

  await access(join(guildDirectory, "MEMORY.json"));
});

function createEntry(
  title: string,
  content: string,
  scope: { type: string; channelId?: string; threadId?: string },
) {
  return { content, scope, title };
}
