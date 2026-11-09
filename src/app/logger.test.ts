import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createLogFilePath, createLogger, flushLogger } from "./logger";
import { createTempDir } from "../testing/temp-dir";

test("redacts sensitive top-level fields", () => {
  const lines: string[] = [];
  const logger = createLogger({
    destination: {
      write(message) {
        lines.push(message);
      },
    },
  });

  logger.info(
    {
      apiKey: "api-key",
      event: "test",
      token: "token",
    },
    "test message",
  );

  const entry = JSON.parse(lines[0] ?? "{}");
  assert.equal(entry.apiKey, "[Redacted]");
  assert.equal(entry.token, "[Redacted]");
  assert.equal(entry.event, "test");
  assert.equal(entry.msg, "test message");
});

test("persists JSONL records when a log file path is configured", async () => {
  await using temp = await createTempDir("klein-logger-");
  const rootDirectory = temp.path;
  const filePath = createLogFilePath(rootDirectory, new Date("2026-09-11T00:00:00.000Z"));

  const logger = createLogger({ filePath });
  logger.info({ event: "file_test", value: 42 }, "written to file");
  flushLogger(logger);

  const lines = (await readFile(filePath, "utf8")).trim().split("\n");
  const entry = JSON.parse(lines[0] ?? "{}");
  assert.equal(entry.event, "file_test");
  assert.equal(entry.value, 42);
  assert.equal(entry.msg, "written to file");
});

test("falls back to info when KLEIN_LOG_LEVEL is empty", () => {
  const originalLevel = process.env.KLEIN_LOG_LEVEL;
  process.env.KLEIN_LOG_LEVEL = "";

  try {
    const logger = createLogger();

    assert.equal(logger.level, "info");
    flushLogger(logger);
  } finally {
    if (originalLevel === undefined) delete process.env.KLEIN_LOG_LEVEL;
    else process.env.KLEIN_LOG_LEVEL = originalLevel;
  }
});
