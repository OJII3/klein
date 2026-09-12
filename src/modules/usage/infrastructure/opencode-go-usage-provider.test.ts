import assert from "node:assert/strict";
import test from "node:test";

import { OpenCodeGoUsageProvider } from "./opencode-go-usage-provider.js";

test("fetches and maps the monthly OpenCode Go usage", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | undefined;
  let requestedAuthorization: string | null | undefined;

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requestedUrl = request.url;
    requestedAuthorization = request.headers.get("authorization");

    return Response.json({
      usage: {
        rolling: {
          percent: 12,
          resetsAt: "2026-09-14T12:30:00.000Z",
          status: "ok",
        },
        monthly: {
          percent: 34.5,
          resetsAt: "2026-10-01T14:00:00.000Z",
          status: "ok",
        },
        weekly: {
          percent: 7,
          resetsAt: "2026-09-17T00:00:00.000Z",
          status: "ok",
        },
      },
    });
  };

  try {
    const usage = await new OpenCodeGoUsageProvider("secret-key").getMonthlyUsageLimit();

    assert.equal(requestedUrl, "https://opencode.ai/zen/go/v1/usage");
    assert.equal(requestedAuthorization, "Bearer secret-key");
    assert.deepEqual(usage, {
      resetsAt: new Date("2026-10-01T14:00:00.000Z"),
      status: "ok",
      usedPercentage: 34.5,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an invalid OpenCode Go usage response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      usage: {
        monthly: {
          percent: 101,
          resetsAt: "2026-10-01T14:00:00.000Z",
          status: "ok",
        },
      },
    });

  try {
    await assert.rejects(
      new OpenCodeGoUsageProvider("secret-key").getMonthlyUsageLimit(),
      /OpenCode Go usage response is invalid/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
