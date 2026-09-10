import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PinoJsonlReader } from "./pino-jsonl-reader.js";

test("reads newest pino entries first and paginates across files", async () => {
  const logDirectory = await mkdtemp(join(tmpdir(), "klein-pino-reader-"));

  try {
    const pinoDirectory = join(logDirectory, "pino");
    await mkdir(pinoDirectory);
    await writeFile(
      join(pinoDirectory, "2026-09-10_old.jsonl"),
      `${JSON.stringify({ event: "old", level: 30, msg: "old message", time: 1000 })}\n` +
        `${JSON.stringify({ event: "older", level: 40, msg: "older message", time: 2000 })}\n`,
    );
    await writeFile(
      join(pinoDirectory, "2026-09-11_new.jsonl"),
      `${JSON.stringify({ channelId: "123", event: "new", level: 50, msg: "new message", time: 3000 })}\n` +
        "incomplete json",
    );

    const reader = new PinoJsonlReader(logDirectory);
    const firstPage = await reader.list({ limit: 1 });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0]?.kind, "new");
    assert.equal(firstPage.items[0]?.attributes.channelId, "123");
    assert.ok(firstPage.nextCursor);

    const secondPage = await reader.list({ cursor: firstPage.nextCursor ?? "", limit: 2 });
    assert.deepEqual(
      secondPage.items.map((item) => item.kind),
      ["older", "old"],
    );
    assert.equal(secondPage.nextCursor, null);
  } finally {
    await rm(logDirectory, { force: true, recursive: true });
  }
});

test("filters pino entries by level, event, channel, and search text", async () => {
  const logDirectory = await mkdtemp(join(tmpdir(), "klein-pino-reader-"));

  try {
    const pinoDirectory = join(logDirectory, "pino");
    await mkdir(pinoDirectory);
    await writeFile(
      join(pinoDirectory, "2026-09-11.jsonl"),
      [
        { channelId: "123", event: "ok", level: 30, msg: "all good", time: 1000 },
        { channelId: "456", event: "failed", level: 50, msg: "broken", time: 2000 },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    const result = await new PinoJsonlReader(logDirectory).list({
      channelId: "123",
      event: "ok",
      level: "info",
      q: "good",
    });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.kind, "ok");
    assert.equal(result.items[0]?.levelLabel, "info");
  } finally {
    await rm(logDirectory, { force: true, recursive: true });
  }
});

test("rejects malformed log cursors", async () => {
  const logDirectory = await mkdtemp(join(tmpdir(), "klein-pino-reader-"));

  try {
    await assert.rejects(
      () => new PinoJsonlReader(logDirectory).list({ cursor: "not-a-cursor" }),
      /Invalid log cursor/,
    );
  } finally {
    await rm(logDirectory, { force: true, recursive: true });
  }
});
