import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  SHARED_MEMORY_FILE_HEADER,
  MarkdownSharedMemoryStore,
  parseSharedMemory,
  renderSharedMemory,
} from "./markdown-shared-memory-store";
import { createTempDir } from "../../../testing/temp-dir";

test("writes each scope to its own channel or thread directory", async () => {
  await using temp = await createTempDir("klein-shared-memory-");
  const store = new MarkdownSharedMemoryStore(temp.path);

  await store.write(
    "guild-a",
    { type: "guild" },
    {
      facts: ["ギルド全体の事実"],
      preferences: ["丁寧な口調を好む"],
    },
  );
  await store.write(
    "guild-a",
    { channelId: "channel-1", type: "channel" },
    {
      facts: ["チャンネルの事実"],
      preferences: [],
    },
  );
  await store.write(
    "guild-a",
    { channelId: "channel-1", threadId: "thread-1", type: "thread" },
    {
      facts: [],
      preferences: ["スレッドの好み"],
    },
  );

  assert.deepEqual(await store.read("guild-a", { type: "guild" }), {
    facts: ["ギルド全体の事実"],
    preferences: ["丁寧な口調を好む"],
  });
  assert.deepEqual(await store.read("guild-a", { channelId: "channel-1", type: "channel" }), {
    facts: ["チャンネルの事実"],
    preferences: [],
  });
  assert.deepEqual(
    await store.read("guild-a", {
      channelId: "channel-1",
      threadId: "thread-1",
      type: "thread",
    }),
    { facts: [], preferences: ["スレッドの好み"] },
  );

  assert.match(
    await readFile(join(temp.path, "guild-a", "MEMORY.md"), "utf8"),
    /^# MEMORY\.md\n\n<!-- Your curated long-term memory/u,
  );
  assert.match(
    await readFile(join(temp.path, "guild-a", "channel-1", "MEMORY.md"), "utf8"),
    /## Facts\n\n- チャンネルの事実/u,
  );
  assert.match(
    await readFile(join(temp.path, "guild-a", "channel-1", "thread-1", "MEMORY.md"), "utf8"),
    /## Preferences\n\n- スレッドの好み/u,
  );
});

test("lists shared memory files with their scopes", async () => {
  await using temp = await createTempDir("klein-shared-memory-");
  const store = new MarkdownSharedMemoryStore(temp.path);

  await store.write("guild-a", { type: "guild" }, { facts: ["事実"], preferences: [] });
  await store.write(
    "guild-a",
    { channelId: "channel-1", type: "channel" },
    {
      facts: ["チャンネル"],
      preferences: ["好み"],
    },
  );
  await store.write(
    "guild-a",
    { channelId: "channel-1", threadId: "thread-1", type: "thread" },
    {
      facts: ["スレッド"],
      preferences: [],
    },
  );

  const files = await store.listFiles("guild-a");
  assert.deepEqual(
    files.map(({ scope }) => scope),
    [
      { type: "guild" },
      { channelId: "channel-1", type: "channel" },
      { channelId: "channel-1", threadId: "thread-1", type: "thread" },
    ],
  );
  assert.match(files[0]?.content ?? "", /^# MEMORY\.md/u);
  assert.equal(files[1]?.facts[0], "チャンネル");
  assert.deepEqual(await store.listGuildIds(), ["guild-a"]);
});

test("treats missing files as empty memory and deletes emptied files", async () => {
  await using temp = await createTempDir("klein-shared-memory-");
  const store = new MarkdownSharedMemoryStore(temp.path);
  const scope = { channelId: "channel-1", type: "channel" } as const;

  assert.deepEqual(await store.read("guild-a", scope), { facts: [], preferences: [] });
  await store.write("guild-a", scope, { facts: ["事実"], preferences: [] });
  await store.write("guild-a", scope, { facts: [], preferences: [] });
  assert.deepEqual(await store.read("guild-a", scope), { facts: [], preferences: [] });
  assert.deepEqual(await store.listFiles("guild-a"), []);
});

test("writes and deletes raw markdown content", async () => {
  await using temp = await createTempDir("klein-shared-memory-");
  const store = new MarkdownSharedMemoryStore(temp.path);
  const scope = { channelId: "channel-1", type: "channel" } as const;
  const content = "# MEMORY.md\n\n## Facts\n\n- 直接編集した事実\n";

  await store.writeContent("guild-a", scope, content);
  const [file] = await store.listFiles("guild-a");
  assert.equal(file?.content, content);
  assert.deepEqual(file?.facts, ["直接編集した事実"]);

  await store.delete("guild-a", scope);
  assert.deepEqual(await store.listFiles("guild-a"), []);
});

test("parses loosely structured markdown into facts and preferences", () => {
  assert.deepEqual(
    parseSharedMemory(`${SHARED_MEMORY_FILE_HEADER}

Some intro line.

## Facts

- 箇条書きの事実
* アスタリスクの事実
飾りなしの事実

## Preferences

+ 好み
`),
    {
      facts: ["箇条書きの事実", "アスタリスクの事実", "飾りなしの事実"],
      preferences: ["好み"],
    },
  );
});

test("renders the MEMORY.md header and both sections", () => {
  assert.equal(
    renderSharedMemory({ facts: ["事実"], preferences: ["好み"] }),
    `${SHARED_MEMORY_FILE_HEADER}

## Facts

- 事実

## Preferences

- 好み
`,
  );
});

test("rejects unsafe guild, channel, and thread ids", async () => {
  await using temp = await createTempDir("klein-shared-memory-");
  const store = new MarkdownSharedMemoryStore(temp.path);

  await assert.rejects(
    store.read("../escape", { type: "guild" }),
    /Invalid shared memory guild id/u,
  );
  await assert.rejects(
    store.read("guild-a", { channelId: "../escape", type: "channel" }),
    /Invalid shared memory channel id/u,
  );
  await assert.rejects(
    store.read("guild-a", { channelId: "channel-1", threadId: "../escape", type: "thread" }),
    /Invalid shared memory thread id/u,
  );
});
