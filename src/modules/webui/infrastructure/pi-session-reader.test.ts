import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

    const secondSessionManager = createPiSessionManager(
      agentDirectory,
      "discord-channel:456",
      "new",
      process.cwd(),
    );
    secondSessionManager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
    secondSessionManager.appendMessage({
      role: "assistant",
      content: "second response",
      timestamp: Date.now(),
    } as never);

    const reader = new PiSessionReader(agentDirectory);
    const sessions = await reader.list();
    assert.equal(sessions.items.length, 2);
    const sessionSummary = sessions.items.find((item) => item.id === sessionManager.getSessionId());
    assert.equal(sessionSummary?.channelKey, "discord-channel:123");
    assert.equal(sessionSummary?.messageCount, 3);
    assert.equal(sessionSummary?.firstMessage, "hello");

    const firstSessionPage = await reader.list({ limit: 1 });
    assert.equal(firstSessionPage.items.length, 1);
    assert.ok(firstSessionPage.nextCursor);
    const secondSessionPage = await reader.list({
      cursor: firstSessionPage.nextCursor ?? "",
      limit: 1,
    });
    assert.equal(secondSessionPage.items.length, 1);
    assert.notEqual(secondSessionPage.items[0]?.id, firstSessionPage.items[0]?.id);
    assert.equal(secondSessionPage.nextCursor, null);

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
    await assert.rejects(() => reader.list({ cursor: "bad" }), /Invalid session list cursor/);
  } finally {
    await rm(agentDirectory, { force: true, recursive: true });
  }
});

test("migrates legacy session entries before serving them", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "klein-pi-reader-"));

  try {
    const sessionId = "8a1f1d8e-1b0f-4e5a-9d1c-2f3b4a5c6d7e";
    const channelDirectory = join(
      agentDirectory,
      "sessions",
      encodeURIComponent("discord-channel:123"),
    );
    await mkdir(channelDirectory, { recursive: true });
    const legacyEntries = [
      {
        type: "session",
        version: 1,
        id: sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: process.cwd(),
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "assistant", content: "hello back" },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "user", content: "again" },
      },
    ];
    await writeFile(
      join(channelDirectory, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      `${legacyEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const reader = new PiSessionReader(agentDirectory);
    const newestPage = await reader.get(sessionId, { limit: 2 });
    assert.ok(newestPage);
    assert.deepEqual(
      newestPage.items.map((item) => item.summary),
      ["hello back", "again"],
    );
    assert.ok(newestPage.items.every((item) => typeof item.id === "string" && item.id.length > 0));
    assert.ok(newestPage.nextCursor);

    const previousPage = await reader.get(sessionId, {
      cursor: newestPage.nextCursor,
      limit: 2,
    });
    assert.deepEqual(
      previousPage?.items.map((item) => item.summary),
      ["hello"],
    );
  } finally {
    await rm(agentDirectory, { force: true, recursive: true });
  }
});

test("returns no Pi sessions when the session directory is absent", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "klein-pi-reader-"));

  try {
    const reader = new PiSessionReader(agentDirectory);
    assert.deepEqual(await reader.list(), { items: [], nextCursor: null });
    assert.equal(await reader.get("missing"), undefined);
  } finally {
    await rm(agentDirectory, { force: true, recursive: true });
  }
});

test("reads usage and context edits without exposing replacement image data", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "klein-pi-reader-"));

  try {
    const sessionManager = createPiSessionManager(
      agentDirectory,
      "discord-channel:123",
      "new",
      process.cwd(),
    );
    const targetId = sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: "hello back",
      timestamp: Date.now(),
    } as never);
    const usage = {
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    sessionManager.appendUsage("cache_warm", "opencode-go", "kimi-k3", usage, "Warm cache");
    sessionManager.appendContextEdit(targetId, {
      content: [{ type: "image", data: "secret-image-data", mimeType: "image/png" }],
    });
    sessionManager.appendContextEdit(targetId, null);

    const detail = await new PiSessionReader(agentDirectory).get(sessionManager.getSessionId());
    assert.ok(detail);
    assert.equal(detail.items[2]?.kind, "usage");
    assert.equal(detail.items[2]?.summary, "Warm cache");
    assert.deepEqual(detail.items[2]?.content, {
      kind: "cache_warm",
      provider: "opencode-go",
      model: "kimi-k3",
      usage,
      note: "Warm cache",
    });
    assert.equal(detail.items[3]?.kind, "context_edit");
    assert.deepEqual(detail.items[3]?.content, {
      targetId,
      replacement: { content: [{ type: "image", mimeType: "image/png", omitted: true }] },
    });
    assert.deepEqual(detail.items[4]?.content, { targetId, replacement: null });
  } finally {
    await rm(agentDirectory, { force: true, recursive: true });
  }
});
