import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { createLogger } from "@app/logger";
import { createPiUsageReporterFromEnv, PiUsageReporter } from "./pi-usage-reporter";

const logger = createLogger({ level: "silent" });

function createReporter(fetchImpl: typeof fetch, flushIntervalMs = 0): PiUsageReporter {
  return new PiUsageReporter({
    endpoint: "https://usage.local/ingest",
    fetch: fetchImpl,
    flushIntervalMs,
    logger,
    token: "usage-token",
  });
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    content: [],
    provider: "mistral",
    model: "mistral-large-latest",
    responseId: "response-1",
    stopReason: "stop",
    timestamp: 1_794_000_000_000,
    usage: {
      input: 1_000,
      output: 200,
      reasoning: 50,
      cacheRead: 500,
      cacheWrite: 100,
      totalTokens: 1_850,
      cost: { input: 0.004, output: 0.002, cacheRead: 0.001, cacheWrite: 0.0005, total: 0.0075 },
    },
    ...overrides,
  };
}

test("sends assistant message usage to the usage endpoint", async () => {
  const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const reporter = createReporter(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: JSON.parse(await request.text()),
    });
    return new Response(null, { status: 200 });
  });

  reporter.recordAssistantMessage("session-1", assistantMessage());
  await reporter.flush();

  assert.deepEqual(requests, [
    {
      url: "https://usage.local/ingest",
      authorization: "Bearer usage-token",
      body: [
        {
          id: "session-1:response-1",
          ts: 1_794_000_000_000,
          provider: "mistral",
          model: "mistral-large-latest",
          input: 1_000,
          output: 200,
          reasoning: 50,
          cacheRead: 500,
          cacheWrite: 100,
          cost: 0.0075,
          sessionId: "session-1",
        },
      ],
    },
  ]);
});

test("falls back to the message timestamp when the response has no id", async () => {
  const requests: unknown[] = [];
  const reporter = createReporter(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 200 });
  });

  reporter.recordAssistantMessage("session-1", assistantMessage({ responseId: undefined }));
  await reporter.flush();

  assert.equal((requests[0] as Array<{ id: string }>)[0]?.id, "session-1:1794000000000");
});

test("does not send anything without a configured endpoint and token", async () => {
  const reporter = createPiUsageReporterFromEnv({
    env: { USAGE_ENDPOINT: "https://usage.local/ingest" },
    logger,
  });

  assert.equal(reporter, undefined);
});
