import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
