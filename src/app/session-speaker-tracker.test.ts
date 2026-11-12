import assert from "node:assert/strict";
import test from "node:test";

import { SessionSpeakerTracker } from "./session-speaker-tracker";

test("reports each user's first message once per session", () => {
  const tracker = new SessionSpeakerTracker();

  assert.equal(tracker.observe("channel-a", "session-1", "user-a"), true);
  assert.equal(tracker.observe("channel-a", "session-1", "user-a"), false);
  assert.equal(tracker.observe("channel-a", "session-1", "user-b"), true);
});

test("forgets speakers when the conversation rotates to a new session", () => {
  const tracker = new SessionSpeakerTracker();

  tracker.observe("channel-a", "session-1", "user-a");

  assert.equal(tracker.observe("channel-a", "session-2", "user-a"), true);
  assert.equal(tracker.observe("channel-a", "session-2", "user-a"), false);
});

test("keeps conversations independent", () => {
  const tracker = new SessionSpeakerTracker();

  assert.equal(tracker.observe("channel-a", "session-a", "user-a"), true);
  assert.equal(tracker.observe("channel-b", "session-b", "user-a"), true);
});
