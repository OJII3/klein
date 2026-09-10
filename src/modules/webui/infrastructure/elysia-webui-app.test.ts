import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createPiSessionManager } from "../../../runtime/pi/pi-agent-runtime.js";
import { createWebUiApp } from "./elysia-webui-app.js";
import { PinoJsonlReader } from "./pino-jsonl-reader.js";
import { PiSessionReader } from "./pi-session-reader.js";

test("serves health, pino logs, and Pi sessions through Elysia", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "klein-webui-"));

  try {
    const logDirectory = join(rootDirectory, "logs");
    await mkdir(join(logDirectory, "pino"), { recursive: true });
    await writeFile(
      join(logDirectory, "pino", "2026-09-11.jsonl"),
      `${JSON.stringify({ event: "test_event", level: 30, msg: "hello", time: 1000 })}\n`,
    );

    const agentDirectory = join(rootDirectory, "pi");
    const sessionManager = createPiSessionManager(
      agentDirectory,
      "discord-channel:123",
      "new",
      process.cwd(),
    );
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello back" }],
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

    const app = createWebUiApp({
      piSessions: new PiSessionReader(agentDirectory),
      pinoLogs: new PinoJsonlReader(logDirectory),
    });

    const health = await app.handle(new Request("http://localhost/api/health"));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const logs = await app.handle(new Request("http://localhost/api/logs?limit=1"));
    assert.equal(logs.status, 200);
    assert.equal((await logs.json()).items[0].kind, "test_event");

    const sessions = await app.handle(new Request("http://localhost/api/sessions"));
    assert.equal(sessions.status, 200);
    const sessionList = (await sessions.json()) as {
      items: { id: string; firstMessage: string }[];
    };
    assert.equal(sessionList.items.length, 1);
    assert.equal(sessionList.items[0]?.id, sessionManager.getSessionId());
    assert.equal(sessionList.items[0]?.firstMessage, "hello");

    const detail = await app.handle(
      new Request(`http://localhost/api/sessions/${sessionManager.getSessionId()}`),
    );
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).items.length, 2);

    const invalid = await app.handle(new Request("http://localhost/api/logs?limit=0"));
    assert.equal(invalid.status, 422);
  } finally {
    await rm(rootDirectory, { force: true, recursive: true });
  }
});
