import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "./logger.js";

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
