import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createPiSessionManager } from "../../../runtime/pi/pi-agent-runtime.js";
import { PiSessionReader } from "./pi-session-reader.js";

test("lists and reads Pi sessions without exposing image data", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "klein-pi-reader-"));

  try {
    const sessionManager = createPiSessionManager(
      agentDirectory,
      "discord-channel:123",
      "new",
      process.cwd(),
    );
    sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "hello back" },
        { type: "image", data: "secret-image-data", mimeType: "image/png" },
      ],
      api: "openai-completions",
      provider: "opencode-go",
      model: "kimi-k3",
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
    } as never);

    const reader = new PiSessionReader(agentDirectory);
    const sessions = await reader.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, sessionManager.getSessionId());
    assert.equal(sessions[0]?.channelKey, "discord-channel:123");
    assert.equal(sessions[0]?.messageCount, 2);
    assert.equal(sessions[0]?.firstMessage, "hello");

    const detail = await reader.get(sessionManager.getSessionId());
    assert.ok(detail);
    assert.equal(detail.session.channelKey, "discord-channel:123");
    assert.equal(detail.items.length, 2);
    assert.equal(detail.items[0]?.role, "user");
    assert.equal(detail.items[0]?.summary, "hello");
    assert.deepEqual(detail.items[1]?.content, [
      { type: "text", text: "hello back" },
      { type: "image", mimeType: "image/png", omitted: true },
    ]);
  } finally {
    await rm(agentDirectory, { force: true, recursive: true });
  }
});

test("returns no Pi sessions when the session directory is absent", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "klein-pi-reader-"));

  try {
    const reader = new PiSessionReader(agentDirectory);
    assert.deepEqual(await reader.list(), []);
    assert.equal(await reader.get("missing"), undefined);
  } finally {
    await rm(agentDirectory, { force: true, recursive: true });
  }
});
