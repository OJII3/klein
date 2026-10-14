import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonMemoryStore, listMemoryGuildIds, renderMemoryDocument } from "./json-memory-store";
import { renderMemoryContext } from "./memory-context-renderer";

test("applies memory operations to a JSON file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-memory-"));
  const filePath = join(directory, "MEMORY.json");
  const store = new JsonMemoryStore(filePath);

  try {
    await store.apply(
      [
        {
          content: "このギルドでは毎週金曜日に定例会を行う。",
          kind: "rule",
          title: "定例会の曜日",
          type: "add",
        },
      ],
      ["message-1"],
    );

    const added = (await store.read()).entries[0];
    assert.ok(added);
    assert.equal(added.kind, "rule");
    assert.deepEqual(added.sourceMessageIds, ["message-1"]);

    await store.apply(
      [
        {
          content: "このギルドでは毎週土曜日に定例会を行う。",
          id: added.id,
          kind: "decision",
          title: "定例会の曜日",
          type: "update",
        },
      ],
      ["message-2"],
    );

    const updated = (await store.read()).entries[0];
    assert.ok(updated);
    assert.equal(updated.content, "このギルドでは毎週土曜日に定例会を行う。");
    assert.equal(updated.kind, "decision");
    assert.deepEqual(updated.sourceMessageIds, ["message-1", "message-2"]);

    await store.apply([{ id: updated.id, type: "delete" }], ["message-3"]);
    assert.deepEqual((await store.read()).entries, []);

    const file = await readFile(filePath, "utf8");
    assert.deepEqual(JSON.parse(file), { entries: [] });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects malformed JSON memory entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-memory-"));
  const store = new JsonMemoryStore(join(directory, "MEMORY.json"));

  try {
    await writeFile(
      join(directory, "MEMORY.json"),
      JSON.stringify({ entries: [{ id: "mem-1", kind: "unknown" }] }),
      "utf8",
    );

    await assert.rejects(store.read(), /malformed memory entry/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects invalid JSON memory documents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-memory-"));
  const store = new JsonMemoryStore(join(directory, "MEMORY.json"));

  try {
    await writeFile(join(directory, "MEMORY.json"), "{", "utf8");

    await assert.rejects(store.read(), /invalid JSON/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("lists guilds with persisted memory files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-memory-"));

  try {
    const filePath = join(directory, "{guildId}", "MEMORY.json");
    const entry = {
      content: "本文",
      createdAt: "2026-09-11T00:00:00.000Z",
      id: "mem-1",
      kind: "fact" as const,
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
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("renders compact guild memory context without storage metadata", () => {
  const document = {
    entries: [
      {
        content: "本文",
        createdAt: "2026-09-10T12:30:00.000Z",
        id: "mem-1",
        kind: "rule" as const,
        sourceMessageIds: ["message-1"],
        title: "発言について",
        updatedAt: "2026-10-05T03:26:33.905Z",
      },
    ],
  };

  const context = renderMemoryContext(document);
  assert.match(context, /Shared memory across channels in this guild\./u);
  assert.match(context, /Kind: rule · Updated: 2026-10-05/u);
  assert.match(context, /### 発言について\n\n/u);
  assert.match(context, /本文/u);
  assert.doesNotMatch(context, /mem-1|message-1|createdAt|T03:26:33/u);

  const processingContext = renderMemoryContext(document, { includeIds: true });
  assert.match(processingContext, /Memory ID: mem-1/u);
  assert.doesNotMatch(processingContext, /message-1|T03:26:33/u);
});
