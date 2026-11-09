import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { JsonMemoryStore, listMemoryGuildIds, renderMemoryDocument } from "./json-memory-store";
import { renderMemoryContext } from "./memory-context-renderer";
import { createTempDir } from "../../../testing/temp-dir";

test("applies memory operations to a JSON file", async () => {
  await using temp = await createTempDir("klein-memory-");
  const directory = temp.path;
  const filePath = join(directory, "MEMORY.json");
  const store = new JsonMemoryStore(filePath);

  const addResult = await store.apply(
    [
      {
        content: "このギルドでは毎週金曜日に定例会を行う。",
        kind: "rule",
        scope: { type: "guild" },
        title: "定例会の曜日",
        type: "add",
      },
    ],
    ["message-1"],
  );

  const added = (await store.read()).entries[0];
  assert.ok(added);
  assert.deepEqual(addResult.created, [added]);
  assert.deepEqual(addResult.updated, []);
  assert.deepEqual(addResult.deleted, []);
  assert.equal(added.kind, "rule");
  assert.deepEqual(added.scope, { type: "guild" });
  assert.deepEqual(added.sourceMessageIds, ["message-1"]);

  const updateResult = await store.apply(
    [
      {
        content: "このギルドでは毎週土曜日に定例会を行う。",
        id: added.id,
        kind: "decision",
        scope: { channelId: "channel-1", type: "channel" },
        title: "定例会の曜日",
        type: "update",
      },
    ],
    ["message-2"],
  );

  const updated = (await store.read()).entries[0];
  assert.ok(updated);
  assert.deepEqual(updateResult.updated, [updated]);
  assert.deepEqual(updateResult.created, []);
  assert.deepEqual(updateResult.deleted, []);
  assert.equal(updated.content, "このギルドでは毎週土曜日に定例会を行う。");
  assert.equal(updated.kind, "decision");
  assert.deepEqual(updated.scope, { channelId: "channel-1", type: "channel" });
  assert.deepEqual(updated.sourceMessageIds, ["message-1", "message-2"]);

  const deleteResult = await store.apply([{ id: updated.id, type: "delete" }], ["message-3"]);
  assert.deepEqual((await store.read()).entries, []);
  assert.deepEqual(deleteResult.created, []);
  assert.deepEqual(deleteResult.updated, []);
  assert.deepEqual(deleteResult.deleted, [updated]);

  const file = await readFile(filePath, "utf8");
  assert.deepEqual(JSON.parse(file), { entries: [] });
});

test("rejects malformed JSON memory entries", async () => {
  await using temp = await createTempDir("klein-memory-");
  const directory = temp.path;
  const store = new JsonMemoryStore(join(directory, "MEMORY.json"));

  await writeFile(
    join(directory, "MEMORY.json"),
    JSON.stringify({ entries: [{ id: "mem-1", kind: "unknown" }] }),
    "utf8",
  );

  await assert.rejects(store.read(), /malformed memory entry/u);
});

test("rejects invalid JSON memory documents", async () => {
  await using temp = await createTempDir("klein-memory-");
  const directory = temp.path;
  const store = new JsonMemoryStore(join(directory, "MEMORY.json"));

  await writeFile(join(directory, "MEMORY.json"), "{", "utf8");

  await assert.rejects(store.read(), /invalid JSON/u);
});

test("lists guilds with persisted memory files", async () => {
  await using temp = await createTempDir("klein-memory-");
  const directory = temp.path;

  const filePath = join(directory, "{guildId}", "MEMORY.json");
  const entry = {
    content: "本文",
    createdAt: "2026-09-11T00:00:00.000Z",
    id: "mem-1",
    kind: "fact" as const,
    scope: { type: "guild" as const },
    sourceMessageIds: [],
    title: "事実",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
  await mkdir(join(directory, "guild-a"));
  await writeFile(
    join(directory, "guild-a", "MEMORY.json"),
    renderMemoryDocument({ entries: [entry] }),
    "utf8",
  );

  assert.deepEqual(await listMemoryGuildIds(filePath), ["guild-a"]);
});

test("renders compact guild memory context without storage metadata", () => {
  const document = {
    entries: [
      {
        content: "本文",
        createdAt: "2026-09-10T12:30:00.000Z",
        id: "mem-1",
        kind: "rule" as const,
        scope: { channelId: "channel-1", type: "channel" as const },
        sourceMessageIds: ["message-1"],
        title: "発言について",
        updatedAt: "2026-10-05T03:26:33.905Z",
      },
    ],
  };

  const context = renderMemoryContext(document);
  assert.match(context, /Shared memory across channels in this guild\./u);
  assert.match(context, /Kind: rule · Scope: channel · Updated: 2026-10-05/u);
  assert.match(context, /### 発言について\n\n/u);
  assert.match(context, /本文/u);
  assert.doesNotMatch(context, /mem-1|message-1|channel-1|createdAt|T03:26:33/u);

  const processingContext = renderMemoryContext(document, { includeIds: true });
  assert.match(processingContext, /Scope: channel:channel-1/u);
  assert.match(processingContext, /Memory ID: mem-1/u);
  assert.doesNotMatch(processingContext, /message-1|T03:26:33/u);
});
