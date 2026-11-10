import assert from "node:assert/strict";
import test from "node:test";

import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import { toViewerSessionSummary } from "./pi-session-event-mapper";

function createInfo(firstMessage: string): SessionInfo {
  return {
    path: "/tmp/session.jsonl",
    id: "session-1",
    cwd: "",
    created: new Date("2026-11-10T00:00:00.000Z"),
    modified: new Date("2026-11-10T00:00:00.000Z"),
    messageCount: 1,
    firstMessage,
    allMessagesText: firstMessage,
  };
}

test("strips event metadata from the first message preview", () => {
  const summary = toViewerSessionSummary(
    createInfo('<event-metadata>\n{"type":"watch","source":"x"}\n</event-metadata>\n\n京都の天気'),
    "discord-channel:123",
    new Map([["123", "general"]]),
  );

  assert.equal(summary.firstMessage, "京都の天気");
  assert.equal(summary.channelId, "123");
  assert.equal(summary.channelName, "general");
});

test("leaves a first message without event metadata unchanged", () => {
  const summary = toViewerSessionSummary(createInfo("こんにちは"), "discord-channel:123");

  assert.equal(summary.firstMessage, "こんにちは");
});

test("empties a preview that only contains event metadata", () => {
  const summary = toViewerSessionSummary(
    createInfo('<event-metadata>\n{"type":"watch"}\n</event-metadata>\n'),
    "discord-channel:123",
  );

  assert.equal(summary.firstMessage, "");
});
