import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDocFamily } from "@earendil-works/pi-durable";
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
    const conversationKey = { kind: "discord", channelId: "42" } as const;
    const initial = await opened.store.channelStates.getOrCreate(conversationKey, "2026-10-25");
    assert.deepEqual(initial, {
      conversationKey,
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
    assert.deepEqual(
      await opened.store.channelStates.getOrCreate(conversationKey, "2099-01-01"),
      state,
    );
    assert.deepEqual(await opened.store.channelStates.list(), [state]);
    await opened.store.channelStates.save(initial);
    assert.deepEqual(
      await opened.store.channelStates.getOrCreate(conversationKey, "2099-01-01"),
      initial,
    );
  } finally {
    await opened.session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps Discord and agent conversations separate when their IDs match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-durable-key-types-"));
  const { session, store } = await openStore(join(directory, "state.sqlite"));
  try {
    const discordKey = { kind: "discord", channelId: "calendar" } as const;
    const agentKey = { kind: "agent", agentId: "calendar" } as const;
    const discordState = await store.channelStates.getOrCreate(discordKey, "2026-10-25");
    const agentState = await store.channelStates.getOrCreate(agentKey, "2026-10-25");
    await Promise.all([
      store.channelStates.save(discordState),
      store.channelStates.save(agentState),
    ]);

    assert.notEqual(discordState.sessionKey, agentState.sessionKey);
    assert.deepEqual(
      (await store.channelStates.list())
        .map((state) => state.conversationKey)
        .sort((left, right) => left.kind.localeCompare(right.kind)),
      [agentKey, discordKey],
    );
  } finally {
    await session.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not restore state written in the removed channel-state format", async () => {
  type LegacyChannelState = {
    channelId: string;
    accessScope: string | null;
    sessionKey: string;
    lastActivityAt: number | null;
    lastRotationDate: string;
    hasActivitySinceRotation: boolean;
    handoffContext: string | null;
  };
  const LegacyChannelStates = defineDocFamily<LegacyChannelState, LegacyChannelState>({
    kind: "klein.discord-channel-state",
    version: 1,
    scope: "session",
    family: true,
    checkpointWhen: () => false,
    initial: (state) => state,
  });
  const directory = await mkdtemp(join(tmpdir(), "klein-durable-legacy-agent-"));
  const { session, store } = await openStore(join(directory, "state.sqlite"));
  const oldStorageKey = "domain-agent:calendar";
  const oldSessionKey = "discord-channel:domain-agent:calendar:owner:123";
  const oldState: LegacyChannelState = {
    channelId: oldStorageKey,
    accessScope: "owner:123",
    sessionKey: oldSessionKey,
    lastActivityAt: 123,
    lastRotationDate: "2026-10-25",
    hasActivitySinceRotation: false,
    handoffContext: "Continue the calendar conversation",
  };
  try {
    await session.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await store.registerConversation(tx, oldSessionKey, conversation.id);
      Object.assign(await tx.doc(LegacyChannelStates, oldStorageKey, oldState), oldState);
    }, BACKGROUND_CONTEXT);

    const conversationKey = { kind: "agent", agentId: "calendar" } as const;
    assert.deepEqual(await store.channelStates.getOrCreate(conversationKey, "2099-01-01"), {
      conversationKey,
      sessionKey: "agent:calendar",
      lastActivityAt: null,
      lastRotationDate: "2099-01-01",
      hasActivitySinceRotation: true,
    });
    assert.deepEqual(await store.channelStates.list(), []);
  } finally {
    await session.close(BACKGROUND_CONTEXT);
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
