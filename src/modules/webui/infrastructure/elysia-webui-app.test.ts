import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import { createPiSessionManager } from "@runtime/pi/pi-agent-runtime";
import { createWebUiApp } from "./elysia-webui-app";
import { PinoJsonlReader } from "./pino-jsonl-reader";
import { PiSessionReader } from "./pi-session-reader";
import { PiToolUsageReader } from "./pi-tool-usage-reader";
import { createTempDir } from "../../../testing/temp-dir";

test("serves health, logs, Pi sessions, and scoped memory through Elysia", async () => {
  await using temp = await createTempDir("klein-webui-");
  const rootDirectory = temp.path;

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
  const sessionId = sessionManager.getSessionId();

  const app = createWebUiApp({
    memory: {
      listScopes: async () => [
        {
          entryCount: 1,
          scope: { type: "owner" },
          updatedAt: "2026-09-11T00:00:00.000Z",
        },
        {
          entryCount: 1,
          scope: { type: "guild", guildId: "guild-a" },
          updatedAt: "2026-09-11T00:00:00.000Z",
        },
      ],
      read: async (scope) => ({
        entries: [
          {
            content: "本文",
            createdAt: "2026-09-11T00:00:00.000Z",
            id: "mem-1",
            kind: "fact" as const,
            scope: { type: "guild" as const },
            sourceMessageIds: [],
            title: scope.type === "owner" ? "オーナーの事実" : `${scope.guildId} の事実`,
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
        ],
      }),
    },
    memoryEditor: {
      addRule: async (scope) => {
        assert.ok(scope.type === "owner" || scope.guildId === "guild-a");
      },
      deleteEntry: async (scope, entryId) => {
        assert.deepEqual(scope, { type: "guild", guildId: "guild-a" });
        assert.equal(entryId, "mem-1");
      },
    },
    piSessions: new PiSessionReader(agentDirectory),
    pinoLogs: new PinoJsonlReader(logDirectory),
    toolUsage: new PiToolUsageReader(agentDirectory),
  });

  const health = await app.handle(new Request("http://localhost/api/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const logs = await app.handle(new Request("http://localhost/api/logs?limit=1"));
  assert.equal(logs.status, 200);
  assert.equal((await logs.json()).items[0].kind, "test_event");

  const tools = await app.handle(new Request("http://localhost/api/tools"));
  assert.equal(tools.status, 200);
  assert.deepEqual(await tools.json(), {
    mcpServers: [],
    sessionCount: 1,
    tools: [],
    totalCalls: 0,
    totalErrors: 0,
  });

  const sessions = await app.handle(new Request("http://localhost/api/sessions"));
  assert.equal(sessions.status, 200);
  const sessionList = (await sessions.json()) as {
    items: { id: string; firstMessage: string }[];
    nextCursor: string | null;
  };
  assert.equal(sessionList.items.length, 1);
  assert.equal(sessionList.items[0]?.id, sessionId);
  assert.equal(sessionList.items[0]?.firstMessage, "hello");
  assert.equal(sessionList.nextCursor, null);

  const detail = await app.handle(new Request(`http://localhost/api/sessions/${sessionId}`));
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.items.length, 2);
  assert.equal(detailBody.nextCursor, null);

  const firstSessionPage = await app.handle(
    new Request(`http://localhost/api/sessions/${sessionId}?limit=1`),
  );
  assert.equal(firstSessionPage.status, 200);
  const firstSessionPageBody = (await firstSessionPage.json()) as {
    items: { summary: string }[];
    nextCursor: string | null;
  };
  assert.equal(firstSessionPageBody.items[0]?.summary, "hello back");
  assert.ok(firstSessionPageBody.nextCursor);

  const secondSessionPage = await app.handle(
    new Request(
      `http://localhost/api/sessions/${sessionId}?limit=1&cursor=${encodeURIComponent(firstSessionPageBody.nextCursor ?? "")}`,
    ),
  );
  assert.equal(secondSessionPage.status, 200);
  assert.equal((await secondSessionPage.json()).items[0].summary, "hello");

  const memoryGuilds = await app.handle(new Request("http://localhost/api/memory"));
  assert.equal(memoryGuilds.status, 200);
  assert.deepEqual(await memoryGuilds.json(), {
    enabled: true,
    items: [
      {
        entryCount: 1,
        scope: { type: "owner" },
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
      {
        entryCount: 1,
        scope: { type: "guild", guildId: "guild-a" },
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
    ],
  });

  const ownerMemory = await app.handle(new Request("http://localhost/api/memory/owner"));
  assert.equal(ownerMemory.status, 200);
  assert.equal((await ownerMemory.json()).entries[0].title, "オーナーの事実");

  const memory = await app.handle(new Request("http://localhost/api/memory/guild/guild-a"));
  assert.equal(memory.status, 200);
  assert.equal((await memory.json()).entries[0].title, "guild-a の事実");

  const deletedMemory = await app.handle(
    new Request("http://localhost/api/memory/guild/guild-a/mem-1", { method: "DELETE" }),
  );
  assert.equal(deletedMemory.status, 200);
  assert.deepEqual(await deletedMemory.json(), { deleted: true });

  const ownerRule = await app.handle(
    new Request("http://localhost/api/memory/owner/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "ルール", content: "内容" }),
    }),
  );
  assert.equal(ownerRule.status, 200);

  const invalidMemory = await app.handle(new Request("http://localhost/api/memory/guild/guild.a"));
  assert.equal(invalidMemory.status, 422);

  const invalidMemoryEntry = await app.handle(
    new Request("http://localhost/api/memory/guild/guild-a/mem.1", { method: "DELETE" }),
  );
  assert.equal(invalidMemoryEntry.status, 422);

  const invalid = await app.handle(new Request("http://localhost/api/logs?limit=0"));
  assert.equal(invalid.status, 422);

  const invalidSession = await app.handle(
    new Request(`http://localhost/api/sessions/${sessionId}?limit=0`),
  );
  assert.equal(invalidSession.status, 422);

  const invalidSessionListCursor = await app.handle(
    new Request("http://localhost/api/sessions?cursor=bad"),
  );
  assert.equal(invalidSessionListCursor.status, 400);
});
