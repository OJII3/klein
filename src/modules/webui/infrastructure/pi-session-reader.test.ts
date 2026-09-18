import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createPiSessionManager } from "@runtime/pi/pi-agent-runtime";
import { PiSessionReader } from "./pi-session-reader";

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
    sessionManager.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "403: RegionError",
      timestamp: Date.now(),
    } as never);

    const reader = new PiSessionReader(agentDirectory);
    const sessions = await reader.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, sessionManager.getSessionId());
    assert.equal(sessions[0]?.channelKey, "discord-channel:123");
    assert.equal(sessions[0]?.messageCount, 3);
    assert.equal(sessions[0]?.firstMessage, "hello");

    const detail = await reader.get(sessionManager.getSessionId());
    assert.ok(detail);
    assert.equal(detail.session.channelKey, "discord-channel:123");
    assert.equal(detail.items.length, 3);
    assert.equal(detail.items[0]?.role, "user");
    assert.equal(detail.items[0]?.summary, "hello");
    assert.deepEqual(detail.items[1]?.content, [
      { type: "text", text: "hello back" },
      { type: "image", mimeType: "image/png", omitted: true },
    ]);
    assert.equal(detail.items[2]?.summary, "Error: 403: RegionError");
    assert.equal(detail.items[2]?.errorMessage, "403: RegionError");
    assert.deepEqual(detail.items[2]?.content, []);
    assert.equal(detail.nextCursor, null);

    const firstPage = await reader.get(sessionManager.getSessionId(), { limit: 2 });
    assert.ok(firstPage?.nextCursor);
    assert.deepEqual(
      firstPage?.items.map((item) => item.summary),
      ["hello back", "Error: 403: RegionError"],
    );

    const secondPage = await reader.get(sessionManager.getSessionId(), {
      cursor: firstPage?.nextCursor ?? "",
      limit: 2,
    });
    assert.deepEqual(
      secondPage?.items.map((item) => item.summary),
      ["hello"],
    );
    assert.equal(secondPage?.nextCursor, null);

    await assert.rejects(
      () => reader.get(sessionManager.getSessionId(), { cursor: "bad" }),
      /Invalid session cursor/,
    );
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
