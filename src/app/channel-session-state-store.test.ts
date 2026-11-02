import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_ROTATION_IDLE_MS,
  createConversationSessionKey,
  getChannelRotationBucket,
  isChannelRotationDue,
  type ChannelSessionState,
} from "./channel-session-state-store";

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
