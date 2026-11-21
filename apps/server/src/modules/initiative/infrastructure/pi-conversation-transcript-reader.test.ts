import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createTempDir } from "../../../testing/temp-dir";
import { PiConversationTranscriptReader } from "./pi-conversation-transcript-reader";

test("reads recent user and assistant messages from the latest Pi session", async () => {
  await using temp = await createTempDir("klein-transcript-");
  const sessionKey = "discord-channel:channel-1:owner:1";
  const sessionDirectory = join(
    temp.path,
    "sessions",
    "conversation",
    encodeURIComponent(sessionKey),
  );
  const manager = SessionManager.create(process.cwd(), sessionDirectory);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "店を調べたい" }],
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-1",
        name: "discord_send",
        arguments: { content: "いいね" },
      },
    ],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  const reader = new PiConversationTranscriptReader(temp.path);
  const messages = await reader.read({ sessionKey, limit: 10 });

  assert.deepEqual(
    messages.map((message) => [message.role, message.text]),
    [
      ["user", "店を調べたい"],
      ["assistant", "いいね"],
    ],
  );
});

test("includes a conversation handoff as context", async () => {
  await using temp = await createTempDir("klein-transcript-");
  const sessionKey = "discord-channel:channel-1:owner:1";
  const sessionDirectory = join(
    temp.path,
    "sessions",
    "conversation",
    encodeURIComponent(sessionKey),
  );
  const manager = SessionManager.create(process.cwd(), sessionDirectory);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "続きから" }],
    timestamp: Date.now(),
  });
  manager.appendCustomMessageEntry(
    "klein-context-handoff",
    "<previous-conversation-context>\n前回の要約\n</previous-conversation-context>",
    false,
  );

  const reader = new PiConversationTranscriptReader(temp.path);
  const messages = await reader.read({ sessionKey, limit: 10 });

  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.role, "user");
  assert.match(messages[1]?.text ?? "", /前回の要約/u);
});

test("limits the transcript to the newest messages", async () => {
  await using temp = await createTempDir("klein-transcript-");
  const sessionKey = "discord-channel:channel-1:owner:1";
  const sessionDirectory = join(
    temp.path,
    "sessions",
    "conversation",
    encodeURIComponent(sessionKey),
  );
  const manager = SessionManager.create(process.cwd(), sessionDirectory);
  for (const text of ["one", "two", "three"]) {
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
  }

  const reader = new PiConversationTranscriptReader(temp.path);
  const messages = await reader.read({ sessionKey, limit: 2 });

  assert.deepEqual(
    messages.map((message) => message.text),
    ["two", "three"],
  );
});
