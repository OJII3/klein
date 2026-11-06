import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ChannelSessionStateStore } from "@app/channel-session-state-store";
import { PiSessionReader } from "@modules/webui/infrastructure/pi-session-reader";
import { createPiSessionManager } from "./pi-agent-runtime";
import { applyDeltaOps, migratePiDurableStorage } from "./pi-durable-migration";

function createTestDurableSqlite(sqlitePath: string): void {
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        address TEXT NOT NULL,
        kind TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        retired_at INTEGER,
        record TEXT NOT NULL
      );
      CREATE TABLE document_revisions (
        document_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        by_task_id INTEGER,
        PRIMARY KEY (document_id, seq)
      );
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY,
        record TEXT NOT NULL
      );
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        record TEXT NOT NULL
      );
    `);

    const insertDoc = db.prepare(
      "INSERT INTO documents (id, address, kind, doc_key, scope_kind, owner_id, retired_at, record) VALUES (?, ?, ?, ?, 'session', 0, NULL, ?)",
    );
    const insertRev = db.prepare(
      "INSERT INTO document_revisions (document_id, seq, kind, version, content, by_task_id) VALUES (?, ?, ?, ?, ?, NULL)",
    );
    const insertConv = db.prepare("INSERT INTO conversations (id, record) VALUES (?, ?)");
    const insertEntry = db.prepare(
      "INSERT INTO entries (id, conversation_id, record) VALUES (?, ?, ?)",
    );

    // 1. Channel session state with base + delta revisions
    insertDoc.run(
      1,
      "session\0klein.conversation-state\0discord:channel-123",
      "klein.conversation-state",
      "discord:channel-123",
      JSON.stringify({
        id: 1,
        kind: "klein.conversation-state",
        key: "discord:channel-123",
        scope: { kind: "session" },
      }),
    );
    insertRev.run(
      1,
      1,
      "base",
      1,
      JSON.stringify({
        conversationKey: { kind: "discord", channelId: "channel-123" },
        accessScope: "owner:user-1",
        sessionKey: "discord-channel:channel-123:owner:user-1:1",
        lastActivityAt: null,
        lastRotationDate: "2026-10-14T08",
        hasActivitySinceRotation: false,
        handoffContext: null,
      }),
    );
    insertRev.run(
      1,
      2,
      "delta",
      2,
      JSON.stringify([
        ["s", ["sessionKey"], "discord-channel:channel-123:owner:user-1:2"],
        ["s", ["lastActivityAt"], 1_700_000_030_000],
        ["s", ["lastRotationDate"], "2026-10-14T12"],
        ["s", ["hasActivitySinceRotation"], true],
        ["s", ["handoffContext"], "## Goal\nクラインとして振る舞う\n\n## 引き継ぎ\n- テスト要約"],
      ]),
    );

    // 2. Legacy channel session state (klein.discord-channel-state with channelId)
    insertDoc.run(
      2,
      "session\0klein.discord-channel-state\0legacy-channel",
      "klein.discord-channel-state",
      "legacy-channel",
      JSON.stringify({
        id: 2,
        kind: "klein.discord-channel-state",
        key: "legacy-channel",
        scope: { kind: "session" },
      }),
    );
    insertRev.run(
      2,
      1,
      "base",
      1,
      JSON.stringify({
        channelId: "legacy-channel",
        accessScope: null,
        sessionKey: "discord-channel:legacy-channel:1",
        lastActivityAt: 1_700_000_000_000,
        lastRotationDate: "2026-10-13T08",
        hasActivitySinceRotation: true,
        handoffContext: null,
      }),
    );

    // 3. Session conversations index for discord-channel:channel-123:owner:user-1:2 (conversations 10 and 20)
    const sessionKey = "discord-channel:channel-123:owner:user-1:2";
    insertDoc.run(
      3,
      `session\0klein.session-conversations\0${sessionKey}`,
      "klein.session-conversations",
      sessionKey,
      JSON.stringify({
        id: 3,
        kind: "klein.session-conversations",
        key: sessionKey,
        scope: { kind: "session" },
      }),
    );
    insertRev.run(
      3,
      1,
      "base",
      1,
      JSON.stringify({
        sessionKey,
        conversationIds: [10],
      }),
    );
    insertRev.run(3, 2, "delta", 2, JSON.stringify([["p", ["conversationIds"], 1, 0, [20]]]));

    // Conversation 10 (older conversation)
    insertConv.run(10, JSON.stringify({ id: 10 }));
    insertEntry.run(
      100,
      10,
      JSON.stringify({
        id: 100,
        conversationId: 10,
        kind: "pi.user",
        model: [
          { role: "user", content: "Old conversation message", timestamp: 1_700_000_000_000 },
        ],
      }),
    );
    insertEntry.run(
      101,
      10,
      JSON.stringify({
        id: 101,
        conversationId: 10,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Old conversation reply" }],
            api: "openai-completions",
            provider: "opencode-go",
            model: "kimi-k3",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
            },
            stopReason: "stop",
            timestamp: 1_700_000_001_000,
          },
        ],
      }),
    );

    // Conversation 20 (latest conversation with compaction and kept messages)
    insertConv.run(20, JSON.stringify({ id: 20 }));
    insertEntry.run(
      200,
      20,
      JSON.stringify({
        id: 200,
        conversationId: 20,
        kind: "pi.user",
        model: [
          { role: "user", content: "Summarized early message", timestamp: 1_700_000_010_000 },
        ],
      }),
    );
    insertEntry.run(
      201,
      20,
      JSON.stringify({
        id: 201,
        conversationId: 20,
        kind: "pi.user",
        model: [{ role: "user", content: "Kept recent message", timestamp: 1_700_000_020_000 }],
      }),
    );
    insertEntry.run(
      202,
      20,
      JSON.stringify({
        id: 202,
        conversationId: 20,
        head: 201,
        kind: "pi.compaction",
        model: [
          {
            role: "user",
            content:
              "The conversation history before this point was compacted into the following summary:\n\n<summary>\nCompacted durable summary\n</summary>",
            timestamp: 1_700_000_025_000,
          },
        ],
      }),
    );
    insertEntry.run(
      203,
      20,
      JSON.stringify({
        id: 203,
        conversationId: 20,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Latest durable reply" }],
            api: "openai-completions",
            provider: "opencode-go",
            model: "kimi-k3",
            usage: {
              input: 20,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 30,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
            },
            stopReason: "stop",
            timestamp: 1_700_000_030_000,
          },
        ],
      }),
    );
  } finally {
    db.close();
  }
}

test("migrates pi-durable SQLite channel states and conversations idempotently", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-pi-durable-migration-"));
  const durableDir = join(agentDir, "pi-durable");
  await mkdir(durableDir, { recursive: true });
  const sqlitePath = join(durableDir, "pi-durable.sqlite");
  createTestDurableSqlite(sqlitePath);

  try {
    const firstRun = await migratePiDurableStorage({ agentDir, cwd: process.cwd() });
    assert.equal(firstRun.migratedChannelStates, 2);
    assert.equal(firstRun.migratedConversations, 2);

    const channelStore = new ChannelSessionStateStore(join(agentDir, "channel-sessions"));
    const states = await channelStore.list();
    assert.equal(states.length, 2);
    const ownerState = states.find((s) => s.conversationKey.channelId === "channel-123");
    assert.deepEqual(ownerState, {
      conversationKey: { kind: "discord", channelId: "channel-123" },
      accessScope: "owner:user-1",
      sessionKey: "discord-channel:channel-123:owner:user-1:2",
      lastActivityAt: 1_700_000_030_000,
      lastRotationDate: "2026-10-14T12",
      hasActivitySinceRotation: true,
      handoffContext: "## Goal\nクラインとして振る舞う\n\n## 引き継ぎ\n- テスト要約",
    });
    const legacyState = states.find((s) => s.conversationKey.channelId === "legacy-channel");
    assert.deepEqual(legacyState, {
      conversationKey: { kind: "discord", channelId: "legacy-channel" },
      sessionKey: "discord-channel:legacy-channel:1",
      lastActivityAt: 1_700_000_000_000,
      lastRotationDate: "2026-10-13T08",
      hasActivitySinceRotation: true,
    });

    const sessionKey = "discord-channel:channel-123:owner:user-1:2";
    const resumed = createPiSessionManager(agentDir, sessionKey, "resume", process.cwd());
    const contextMessages = resumed.buildSessionContext().messages;
    const serialized = JSON.stringify(contextMessages);
    assert.match(serialized, /Compacted durable summary/);
    assert.match(serialized, /Kept recent message/);
    assert.match(serialized, /Latest durable reply/);
    assert.doesNotMatch(serialized, /Summarized early message/);
    assert.doesNotMatch(serialized, /Old conversation message/);

    const reader = new PiSessionReader(agentDir);
    const listed = await reader.list();
    assert.equal(listed.items.length, 2);

    const sessionDir = join(agentDir, "sessions", encodeURIComponent(sessionKey));
    const filesBefore = (await readdir(sessionDir)).sort();
    assert.equal(filesBefore.length, 2);

    const secondRun = await migratePiDurableStorage({ agentDir, cwd: process.cwd() });
    assert.equal(secondRun.migratedChannelStates, 0);
    assert.equal(secondRun.migratedConversations, 0);
    const filesAfter = (await readdir(sessionDir)).sort();
    assert.deepEqual(filesAfter, filesBefore);
  } finally {
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("converts legacy channel session state files instead of copying them", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "klein-pi-durable-migration-"));
  const legacyDir = join(agentDir, "channel-session-state");
  await mkdir(legacyDir, { recursive: true });
  await writeFile(
    join(legacyDir, "42.json"),
    JSON.stringify({
      channelId: "42",
      accessScope: "public",
      sessionKey: "discord-channel:42:public:rotation:2026-10-11",
      lastActivityAt: 1_700_000_000_000,
      lastRotationDate: "2026-10-11",
      hasActivitySinceRotation: false,
      handoffContext: "legacy handoff",
    }),
    "utf8",
  );

  try {
    const result = await migratePiDurableStorage({
      agentDir,
      cwd: process.cwd(),
      sqlitePaths: [],
    });
    assert.equal(result.migratedChannelStates, 1);

    const store = new ChannelSessionStateStore(join(agentDir, "channel-sessions"));
    assert.deepEqual(await store.list(), [
      {
        conversationKey: { kind: "discord", channelId: "42" },
        accessScope: "public",
        sessionKey: "discord-channel:42:public:rotation:2026-10-11",
        lastActivityAt: 1_700_000_000_000,
        lastRotationDate: "2026-10-11",
        hasActivitySinceRotation: false,
        handoffContext: "legacy handoff",
      },
    ]);

    const secondRun = await migratePiDurableStorage({
      agentDir,
      cwd: process.cwd(),
      sqlitePaths: [],
    });
    assert.equal(secondRun.migratedChannelStates, 0);
  } finally {
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("replays chord delta operations accurately", () => {
  const initial = {
    text: "hello",
    items: ["a", "b", "c"],
    nested: { removeMe: true, keep: 1 },
  };
  const updated = applyDeltaOps(initial, [
    ["a", ["text"], " world"],
    ["t", ["text"], 6],
    ["p", ["items"], 1, 1, ["x", "y"]],
    ["m", ["items"], [3, 0, 1, 2]],
    ["d", ["nested", "removeMe"]],
    ["s", ["nested", "keep"], 2],
  ]);

  assert.deepEqual(updated, {
    text: "world",
    items: ["c", "a", "x", "y"],
    nested: { keep: 2 },
  });
});
