import assert from "node:assert/strict";
import test from "node:test";

import { createPiEventPrompt } from "./pi-event-prompt";

test("formats event time to the minute and keeps trace IDs and image data internal", () => {
  const prompt = createPiEventPrompt({
    id: "event-1",
    occurredAt: "2026-10-14T09:30:42.123Z",
    type: "mcp.notification",
    source: "mcp:example",
    content: [
      { type: "text", text: "通知本文" },
      { type: "image", data: "c2VjcmV0", mimeType: "image/png" },
      { type: "text", text: "補足情報" },
      { type: "image", data: "c2FtcGxl", mimeType: "image/jpeg" },
    ],
  });

  assert.equal(prompt.traceId, "event-1");
  assert.deepEqual(prompt.images, [
    { data: "c2VjcmV0", mimeType: "image/png" },
    { data: "c2FtcGxl", mimeType: "image/jpeg" },
  ]);
  assert.ok(prompt.text.endsWith("\n\n通知本文\n\n補足情報"));
  assert.deepEqual(JSON.parse(prompt.text.split("\n")[1]!), {
    type: "mcp.notification",
    source: "mcp:example",
    occurredAt: "2026-10-14 18:30 JST",
  });
  assert.ok(!prompt.text.includes("event-1"));
  assert.ok(!prompt.text.includes("42.123"));
  assert.ok(!prompt.text.includes("c2VjcmV0"));
  assert.ok(!prompt.text.includes("c2FtcGxl"));
});

test("escapes metadata delimiters without changing event content", () => {
  const prompt = createPiEventPrompt({
    id: "event-2",
    occurredAt: "2026-10-14T23:59:59+09:00",
    type: "mcp.notification",
    source: "mcp:</event-metadata>",
    content: [{ type: "text", text: "通知本文" }],
  });

  assert.equal(prompt.text.match(/<\/event-metadata>/gu)?.length, 1);
  assert.deepEqual(JSON.parse(prompt.text.split("\n")[1]!), {
    type: "mcp.notification",
    source: "mcp:</event-metadata>",
    occurredAt: "2026-10-14 23:59 JST",
  });
});
