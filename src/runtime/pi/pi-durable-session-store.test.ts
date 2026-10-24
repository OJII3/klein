import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PiDurableSessionStore } from "./pi-durable-session-store";

async function openStore(path: string) {
  const storage = await openNodeSqliteStorage(path);
  const session = createSession(storage);
  return { session, store: new PiDurableSessionStore(session, storage) };
}

test("persists opaque session keys and Discord state across SQLite reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-durable-store-"));
  let opened = await openStore(join(directory, "state.sqlite"));
  try {
    const keys = ["discord-channel:42", "other-channel:42", "__proto__"];
    const ids = await Promise.all(
      keys.map((key) =>
        opened.session.commit(async (tx) => {
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await opened.store.registerConversation(tx, key, conversation.id);
          await opened.store.registerConversation(tx, key, conversation.id);
          return conversation.id;
        }, BACKGROUND_CONTEXT),
      ),
    );
    const initial = await opened.store.channelStates.getOrCreate("42", "2026-10-25");
    assert.deepEqual(initial, {
      channelId: "42",
      sessionKey: "discord-channel:42",
      lastActivityAt: null,
      lastRotationDate: "2026-10-25",
      hasActivitySinceRotation: true,
    });
    assert.deepEqual(await opened.store.channelStates.list(), []);
    const state = {
      ...initial,
      accessScope: "owner",
      handoffContext: "A conversation to continue",
      lastActivityAt: 123,
      hasActivitySinceRotation: false,
    };
    await opened.store.channelStates.save(state);
    await opened.session.close(BACKGROUND_CONTEXT);
    opened = await openStore(join(directory, "state.sqlite"));
    const index = await opened.store.loadSessionIndex();
    assert.deepEqual(
      index,
      Object.fromEntries(keys.map((key, position) => [key, [ids[position]]])),
    );
    assert.deepEqual(await opened.store.getConversationIds("unknown:42"), []);
    assert.deepEqual(await opened.store.channelStates.getOrCreate("42", "2099-01-01"), state);
    assert.deepEqual(await opened.store.channelStates.list(), [state]);
    await opened.store.channelStates.save(initial);
    assert.deepEqual(await opened.store.channelStates.getOrCreate("42", "2099-01-01"), initial);
  } finally {
    await opened.session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("rolls back conversation creation and mapping together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-durable-rollback-"));
  const { session, store } = await openStore(join(directory, "state.sqlite"));
  try {
    await assert.rejects(
      session.commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await store.registerConversation(tx, "future-channel:42", conversation.id);
        throw new Error("interrupted before commit");
      }, BACKGROUND_CONTEXT),
      /interrupted before commit/,
    );
    assert.deepEqual(await store.loadSessionIndex(), {});
    const conversations = await session.commit(
      (tx) => tx.scanConversations({}, 100),
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(conversations.items, []);
  } finally {
    await session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports legacy JSON once, preserving ordered IDs and channel state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-durable-import-"));
  let opened = await openStore(join(directory, "state.sqlite"));
  try {
    const ids = await opened.session.commit(async (tx) => {
      const first = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const second = await tx.createConversation({ ownership: { kind: "ownerless" } });
      return [first.id, second.id];
    }, BACKGROUND_CONTEXT);
    const sessionIndexPath = join(directory, "sessions.json");
    const channelStateDirectory = join(directory, "channels");
    const index = { "discord-channel:old": ids, "future-channel:old": [ids[0]] };
    const state = {
      channelId: "old",
      sessionKey: "discord-channel:old:2026-10-25",
      accessScope: "owner",
      lastActivityAt: 100,
      lastRotationDate: "2026-10-25",
      hasActivitySinceRotation: false,
      handoffContext: "Preserved handoff",
    };
    const content = JSON.stringify(index);
    await writeFile(sessionIndexPath, content);
    await mkdir(channelStateDirectory);
    await writeFile(join(channelStateDirectory, "old.json"), JSON.stringify(state));
    await opened.store.migrateLegacyJson({ sessionIndexPath, channelStateDirectory });
    assert.deepEqual(await opened.store.loadSessionIndex(), index);
    assert.deepEqual(await opened.store.channelStates.list(), [state]);
    assert.equal(await readFile(sessionIndexPath, "utf8"), content);
    await opened.session.close(BACKGROUND_CONTEXT);
    opened = await openStore(join(directory, "state.sqlite"));
    await writeFile(sessionIndexPath, "corrupted stale backup");
    await writeFile(join(channelStateDirectory, "old.json"), "corrupted stale backup");
    await opened.store.migrateLegacyJson({ sessionIndexPath, channelStateDirectory });
    assert.deepEqual(await opened.store.loadSessionIndex(), index);
    assert.deepEqual(await opened.store.channelStates.list(), [state]);
  } finally {
    await opened.session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports Discord state later when its directory was initially unspecified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-durable-import-later-"));
  let opened = await openStore(join(directory, "state.sqlite"));
  try {
    const id = await opened.session.commit(
      async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
      BACKGROUND_CONTEXT,
    );
    const sessionIndexPath = join(directory, "sessions.json");
    const channelStateDirectory = join(directory, "channels");
    const index = { "discord-channel:42": [id] };
    const state = {
      channelId: "42",
      sessionKey: "discord-channel:42",
      lastActivityAt: null,
      lastRotationDate: "2026-10-25",
      hasActivitySinceRotation: true,
    };
    await writeFile(sessionIndexPath, JSON.stringify(index));
    await mkdir(channelStateDirectory);
    await writeFile(join(channelStateDirectory, "42.json"), JSON.stringify(state));
    await opened.store.migrateLegacyJson({ sessionIndexPath });
    assert.deepEqual(await opened.store.loadSessionIndex(), index);
    assert.deepEqual(await opened.store.channelStates.list(), []);
    await opened.session.close(BACKGROUND_CONTEXT);
    opened = await openStore(join(directory, "state.sqlite"));
    await writeFile(sessionIndexPath, "corrupted old index");
    await opened.store.migrateLegacyJson({ sessionIndexPath, channelStateDirectory });
    assert.deepEqual(await opened.store.loadSessionIndex(), index);
    assert.deepEqual(await opened.store.channelStates.list(), [state]);
    await writeFile(join(channelStateDirectory, "42.json"), "corrupted old state");
    await opened.store.migrateLegacyJson({ sessionIndexPath, channelStateDirectory });
    assert.deepEqual(await opened.store.channelStates.list(), [state]);
  } finally {
    await opened.session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid legacy state leaves both imports and completion marker uncommitted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-durable-import-invalid-"));
  const { session, store } = await openStore(join(directory, "state.sqlite"));
  try {
    const id = await session.commit(
      async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
      BACKGROUND_CONTEXT,
    );
    const sessionIndexPath = join(directory, "sessions.json");
    const channelStateDirectory = join(directory, "channels");
    await writeFile(sessionIndexPath, JSON.stringify({ "other:42": [id] }));
    await mkdir(channelStateDirectory);
    await writeFile(join(channelStateDirectory, "42.json"), "{}");
    await assert.rejects(
      store.migrateLegacyJson({ sessionIndexPath, channelStateDirectory }),
      /Invalid legacy/,
    );
    assert.deepEqual(await store.loadSessionIndex(), {});
    assert.deepEqual(await store.channelStates.list(), []);
    await rm(join(channelStateDirectory, "42.json"));
    await store.migrateLegacyJson({ sessionIndexPath, channelStateDirectory });
    assert.deepEqual(await store.getConversationIds("other:42"), [id]);
  } finally {
    await session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});
