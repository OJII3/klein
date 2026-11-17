import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  CHANNEL_ROTATION_IDLE_MS,
  ChannelSessionStateStore,
  createConversationSessionKey,
  getChannelRotationBucket,
  isChannelRotationDue,
  type ChannelSessionState,
} from "./channel-session-state-store";
import { createTempDir } from "../testing/temp-dir";

function jst(isoLocal: string): number {
  // JST has no daylight saving time, so a fixed +09:00 offset is exact.
  return Date.parse(`${isoLocal}+09:00`);
}

function createState(overrides: Partial<ChannelSessionState> = {}): ChannelSessionState {
  return {
    conversationKey: { kind: "discord", channelId: "channel-a" },
    sessionKey: createConversationSessionKey({ kind: "discord", channelId: "channel-a" }),
    lastActivityAt: jst("2026-11-02T12:00:00"),
    lastRotationDate: "2026-11-02T12",
    hasActivitySinceRotation: true,
    ...overrides,
  };
}

test("buckets timestamps into four hour windows in JST", () => {
  assert.equal(getChannelRotationBucket(jst("2026-11-02T00:00:00")), "2026-11-02T00");
  assert.equal(getChannelRotationBucket(jst("2026-11-02T03:59:59")), "2026-11-02T00");
  assert.equal(getChannelRotationBucket(jst("2026-11-02T04:00:00")), "2026-11-02T04");
  assert.equal(getChannelRotationBucket(jst("2026-11-02T12:34:56")), "2026-11-02T12");
  assert.equal(getChannelRotationBucket(jst("2026-11-02T23:59:59")), "2026-11-02T20");
  assert.equal(getChannelRotationBucket(jst("2026-11-03T00:00:00")), "2026-11-03T00");
});

test("rotation is due only after an idle hour in a later bucket", () => {
  const now = jst("2026-11-02T16:30:00");

  assert.equal(isChannelRotationDue(createState(), now), true);
  assert.equal(
    isChannelRotationDue(createState({ lastRotationDate: "2026-11-02T16" }), now),
    false,
  );
  assert.equal(
    isChannelRotationDue(createState({ lastActivityAt: now - CHANNEL_ROTATION_IDLE_MS + 1 }), now),
    false,
  );
  assert.equal(isChannelRotationDue(createState({ hasActivitySinceRotation: false }), now), false);
  assert.equal(isChannelRotationDue(createState({ lastActivityAt: null }), now), false);
});

test("persists and reloads channel session state from disk", async () => {
  await using temp = await createTempDir("klein-channel-session-state-");
  const directory = temp.path;
  const store = new ChannelSessionStateStore(directory);
  const key = { kind: "discord" as const, channelId: "42" };
  const initial = await store.getOrCreate(key, "2026-10-25T12");
  assert.deepEqual(initial, {
    conversationKey: key,
    sessionKey: "discord-channel:42",
    lastActivityAt: null,
    lastRotationDate: "2026-10-25T12",
    hasActivitySinceRotation: true,
  });
  assert.deepEqual(await store.list(), []);

  const saved: ChannelSessionState = {
    ...initial,
    accessScope: "owner:123",
    channelName: "general",
    handoffContext: "A conversation to continue",
    lastActivityAt: 123,
    hasActivitySinceRotation: false,
  };
  await store.save(saved);

  const reopened = new ChannelSessionStateStore(directory);
  assert.deepEqual(await reopened.getOrCreate(key, "2099-01-01T00"), saved);
  assert.deepEqual(await reopened.list(), [saved]);
  assert.deepEqual(await reopened.listChannelNames(), new Map([["42", "general"]]));
});

test("ignores legacy and malformed state files when listing", async () => {
  await using temp = await createTempDir("klein-channel-session-state-");
  const directory = temp.path;
  await writeFile(
    join(directory, "legacy.json"),
    JSON.stringify({
      channelId: "42",
      sessionKey: "discord-channel:42",
      lastActivityAt: 1,
      lastRotationDate: "2026-10-11",
      hasActivitySinceRotation: false,
    }),
    "utf8",
  );
  await writeFile(join(directory, "broken.json"), "{not json", "utf8");

  const store = new ChannelSessionStateStore(directory);
  assert.deepEqual(await store.list(), []);
});
