import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ViewerSessionReader } from "../ports/viewer-readers";
import { createWebUiApp } from "./elysia-webui-app";
import { PinoJsonlReader } from "./pino-jsonl-reader";

test("serves health, logs, Pi sessions, and guild memory through Elysia", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "klein-webui-"));

  try {
    const logDirectory = join(rootDirectory, "logs");
    await mkdir(join(logDirectory, "pino"), { recursive: true });
    await writeFile(
      join(logDirectory, "pino", "2026-09-11.jsonl"),
      `${JSON.stringify({ event: "test_event", level: 30, msg: "hello", time: 1000 })}\n`,
    );

    const sessionId = "session-1";
    const session = {
      id: sessionId,
      channelKey: "discord-channel:123",
      created: "2026-09-11T00:00:00.000Z",
      modified: "2026-09-11T00:00:01.000Z",
      messageCount: 2,
      firstMessage: "hello",
    };
    const events = [
      {
        source: "pi" as const,
        id: "1",
        timestamp: session.created,
        sessionId,
        kind: "message" as const,
        role: "user",
        parentId: null,
        summary: "hello",
        content: "hello",
      },
      {
        source: "pi" as const,
        id: "2",
        timestamp: session.modified,
        sessionId,
        kind: "message" as const,
        role: "assistant",
        parentId: null,
        summary: "hello back",
        content: "hello back",
      },
    ];
    const piSessions: ViewerSessionReader = {
      list: async (query) => {
        if (query?.cursor) throw new Error("Invalid session list cursor");
        return { items: [session], nextCursor: null };
      },
      get: async (id, query) => {
        if (id !== sessionId) return undefined;
        if (query?.cursor && query.cursor !== "older") throw new Error("Invalid session cursor");
        return {
          session,
          items:
            query?.cursor === "older"
              ? events.slice(0, 1)
              : query?.limit === 1
                ? events.slice(1)
                : events,
          nextCursor: query?.cursor || query?.limit !== 1 ? null : "older",
        };
      },
    };

    const app = createWebUiApp({
      memory: {
        listGuilds: async () => [
          { entryCount: 1, guildId: "guild-a", updatedAt: "2026-09-11T00:00:00.000Z" },
        ],
        read: async (guildId) => ({
          entries: [
            {
              content: "本文",
              createdAt: "2026-09-11T00:00:00.000Z",
              id: "mem-1",
              kind: "fact" as const,
              sourceMessageIds: [],
              title: `${guildId} の事実`,
              updatedAt: "2026-09-11T00:00:00.000Z",
            },
          ],
        }),
      },
      memoryEditor: {
        addRule: async () => {},
        deleteEntry: async (guildId, entryId) => {
          assert.equal(guildId, "guild-a");
          assert.equal(entryId, "mem-1");
        },
      },
      piSessions,
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
      items: [{ entryCount: 1, guildId: "guild-a", updatedAt: "2026-09-11T00:00:00.000Z" }],
    });

    const memory = await app.handle(new Request("http://localhost/api/memory/guild-a"));
    assert.equal(memory.status, 200);
    assert.equal((await memory.json()).entries[0].title, "guild-a の事実");

    const deletedMemory = await app.handle(
      new Request("http://localhost/api/memory/guild-a/mem-1", { method: "DELETE" }),
    );
    assert.equal(deletedMemory.status, 200);
    assert.deepEqual(await deletedMemory.json(), { deleted: true });

    const invalidMemory = await app.handle(new Request("http://localhost/api/memory/guild.a"));
    assert.equal(invalidMemory.status, 422);

    const invalidMemoryEntry = await app.handle(
      new Request("http://localhost/api/memory/guild-a/mem.1", { method: "DELETE" }),
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
  } finally {
    await rm(rootDirectory, { force: true, recursive: true });
  }
});
