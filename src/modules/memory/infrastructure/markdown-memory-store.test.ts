import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listMemoryGuildIds,
  MarkdownMemoryStore,
  renderMemoryDocument,
} from "./markdown-memory-store";

test("applies memory operations to a Markdown file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-memory-"));
  const store = new MarkdownMemoryStore(join(directory, "MEMORY.md"));

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

    const file = await readFile(join(directory, "MEMORY.md"), "utf8");
    assert.match(file, /^# Guild Memory/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects malformed managed entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-memory-"));
  const store = new MarkdownMemoryStore(join(directory, "MEMORY.md"));

  try {
    await writeFile(
      join(directory, "MEMORY.md"),
      "<!-- memory:start\nid: mem-1\nkind: unknown\n-->\n### 壊れたエントリ\n\n本文\n<!-- memory:end -->",
      "utf8",
    );

    await assert.rejects(store.read(), /malformed memory entry/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects an unclosed managed entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-memory-"));
  const store = new MarkdownMemoryStore(join(directory, "MEMORY.md"));

  try {
    await writeFile(
      join(directory, "MEMORY.md"),
      "<!-- memory:start\nid: mem-1\nkind: fact\ncreated_at: now\nupdated_at: now\n-->\n### 壊れたエントリ\n\n本文",
      "utf8",
    );

    await assert.rejects(store.read(), /unclosed memory entry/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("lists guilds with persisted memory files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-memory-"));

  try {
    const filePath = join(directory, "{guildId}", "MEMORY.md");
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
      join(directory, "guild-a", "MEMORY.md"),
      renderMemoryDocument({ entries: [entry] }),
      "utf8",
    );

    assert.deepEqual(await listMemoryGuildIds(filePath), ["guild-a"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
