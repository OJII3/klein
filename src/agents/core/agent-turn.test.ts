import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "./agent-event";
import { formatAgentTurn } from "./agent-turn";

test("formats context tags in one order before event text without mutating the event", () => {
  const event: AgentEvent = {
    id: "event-123",
    occurredAt: "2026-10-14T09:30:42.123Z",
    type: "test.event",
    source: "test",
    content: [
      { type: "text", text: "event text" },
      { type: "image", data: "c2VjcmV0", mimeType: "image/png" },
    ],
  };

  const formatted = formatAgentTurn({
    event,
    context: {
      ownerMemory: "owner context",
      guildMemory: "guild context",
      channelRule: "channel rule",
    },
  });

  assert.equal(
    formatted.content[0]?.type === "text" ? formatted.content[0].text : "",
    [
      "<owner-memory>\nowner context\n</owner-memory>",
      "<guild-memory>\nguild context\n</guild-memory>",
      "<channel-rule>\nchannel rule\n</channel-rule>",
      "event text",
    ].join("\n\n"),
  );
  assert.deepEqual(formatted.content[1], event.content[1]);
  assert.deepEqual(event.content[0], { type: "text", text: "event text" });
});

test("adds context text before an event without a text block", () => {
  const event: AgentEvent = {
    id: "event-456",
    occurredAt: "2026-10-14T09:30:42.123Z",
    type: "test.event",
    source: "test",
    content: [{ type: "image", data: "c2VjcmV0", mimeType: "image/png" }],
  };

  const formatted = formatAgentTurn({ event, context: { ownerMemory: "owner context" } });

  assert.deepEqual(formatted.content, [
    { type: "text", text: "<owner-memory>\nowner context\n</owner-memory>" },
    { type: "image", data: "c2VjcmV0", mimeType: "image/png" },
  ]);
});
