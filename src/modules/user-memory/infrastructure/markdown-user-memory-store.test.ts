import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import { MarkdownUserMemoryStore, renderUserMemory } from "./markdown-user-memory-store";

test("creates and reads a user memory markdown file by username", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const store = new MarkdownUserMemoryStore(temp.path);

  assert.equal(await store.read("alice"), undefined);

  const created = await store.update("alice", {
    displayName: "Alice",
    nickname: "A",
    firstName: "Alice",
    lastName: "Smith",
    summary: "TypeScriptが好きなユーザー",
    impression: 10,
    facts: "- birthday: 2000-01-02",
    history: "- 2026-01-01: 初めて話した",
    inCommon: "- TypeScript",
    strengthening: "- 次は誕生日を祝う",
  });

  assert.equal(created.discordId, "alice");
  assert.equal(created.impression, 10);
  assert.deepEqual(await store.read("alice"), created);
  assert.deepEqual(await store.read("@Alice"), created);

  const markdown = await readFile(join(temp.path, "alice.md"), "utf8");
  assert.match(markdown, /^---\ndiscord_id: "alice"\n/u);
  assert.match(markdown, /display_name: "Alice"/u);
  assert.match(markdown, /nickname: "A"/u);
  assert.match(markdown, /first_name: "Alice"/u);
  assert.match(markdown, /last_name: "Smith"/u);
  assert.match(markdown, /summary: "TypeScriptが好きなユーザー"/u);
  assert.match(markdown, /impression: 10/u);
  assert.match(markdown, /## Facts\n\n- birthday: 2000-01-02/u);
  assert.match(markdown, /## History\n\n- 2026-01-01: 初めて話した/u);
  assert.match(markdown, /## In common\n\n- TypeScript/u);
  assert.match(markdown, /## Strengthening\n\n- 次は誕生日を祝う/u);
});

test("updates only the provided fields and clamps impression", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const store = new MarkdownUserMemoryStore(temp.path);

  await store.update("alice", {
    displayName: "Alice",
    nickname: "A",
    summary: "最初の要約",
    impression: 90,
    facts: "- birthday: 2000-01-02",
    history: "- 2026-01-01: 初めて話した",
  });

  const updated = await store.update("alice", {
    nickname: null,
    impressionDelta: 50,
    history: "- 2026-02-01: 二回目に話した",
  });

  assert.equal(updated.displayName, "Alice");
  assert.equal(updated.nickname, undefined);
  assert.equal(updated.summary, "最初の要約");
  assert.equal(updated.impression, 100);
  assert.equal(updated.facts, "- birthday: 2000-01-02");
  assert.equal(updated.history, "- 2026-02-01: 二回目に話した");
  assert.equal(updated.inCommon, "なし");
  assert.equal(updated.strengthening, "なし");
});

test("uses default section contents for a new memory", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const store = new MarkdownUserMemoryStore(temp.path);

  const memory = await store.update("alice", { displayName: "Alice" });

  assert.equal(memory.facts, "不明");
  assert.equal(memory.history, "なし");
  assert.equal(memory.inCommon, "なし");
  assert.equal(memory.strengthening, "なし");
  assert.equal(memory.impression, 0);
  assert.equal(memory.summary, "");
});

test("keeps front matter values on one line", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const store = new MarkdownUserMemoryStore(temp.path);

  const memory = await store.update("alice", {
    displayName: " Alice\nSmith ",
    nickname: "A\nB",
    summary: "一行目\n二行目",
  });

  assert.equal(memory.displayName, "Alice Smith");
  assert.equal(memory.nickname, "A B");
  assert.equal(memory.summary, "一行目 二行目");
  assert.deepEqual(await store.read("alice"), memory);
});

test("requires display_name when creating a new memory", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const store = new MarkdownUserMemoryStore(temp.path);

  await assert.rejects(store.update("alice", { summary: "要約" }), /display_name/u);
});

test("rejects invalid Discord usernames and conflicting impression updates", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const store = new MarkdownUserMemoryStore(temp.path);

  await assert.rejects(store.read("../escape"), /Invalid Discord username/u);
  await assert.rejects(
    store.update("alice", {
      displayName: "Alice",
      impression: 1,
      impressionDelta: 1,
    }),
    /either impression or impression_delta/u,
  );
});

test("parses a manually written memory file and rejects a mismatched ID", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const store = new MarkdownUserMemoryStore(temp.path);
  const discordId = "alice";
  const markdown = [
    "---",
    `discord_id: "${discordId}"`,
    "display_name: 'Alice'",
    'summary: "a: b"',
    "impression: 42",
    'updated_at: "2026-01-01T00:00:00.000Z"',
    "---",
    "",
    "## Facts",
    "",
    "- birthday: 2000-01-02",
    "",
    "## History",
    "",
    "- 2026-01-01: 初めて話した",
    "",
  ].join("\n");
  await writeFile(join(temp.path, `${discordId}.md`), markdown, "utf8");

  const memory = await store.read(discordId);
  assert.ok(memory);
  assert.equal(memory.displayName, "Alice");
  assert.equal(memory.summary, "a: b");
  assert.equal(memory.impression, 42);
  assert.equal(memory.facts, "- birthday: 2000-01-02");
  assert.equal(memory.history, "- 2026-01-01: 初めて話した");
  assert.equal(memory.inCommon, "なし");

  const mismatched = markdown.replace(`discord_id: "${discordId}"`, 'discord_id: "bob"');
  await writeFile(join(temp.path, `${discordId}.md`), mismatched, "utf8");
  await assert.rejects(store.read(discordId), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Failed to parse user memory file/u);
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, /does not match/u);
    return true;
  });
});

test("renders the documented section headings and front matter order", async () => {
  await using temp = await createTempDir("klein-user-memory-");
  const store = new MarkdownUserMemoryStore(temp.path);
  const memory = await store.update("alice", {
    displayName: "Alice",
    summary: "要約",
  });

  assert.equal(
    renderUserMemory(memory),
    [
      "---",
      'discord_id: "alice"',
      'display_name: "Alice"',
      'summary: "要約"',
      "impression: 0",
      `updated_at: "${memory.updatedAt}"`,
      "---",
      "",
      "## Facts",
      "",
      "不明",
      "",
      "## History",
      "",
      "なし",
      "",
      "## In common",
      "",
      "なし",
      "",
      "## Strengthening",
      "",
      "なし",
      "",
    ].join("\n"),
  );
});
