import assert from "node:assert/strict";
import test from "node:test";

import { OpenCodeUsageProvider } from "./opencode-usage-provider";

function createProvider(provider = "mistral"): OpenCodeUsageProvider {
  return new OpenCodeUsageProvider({
    endpoint: "https://usage.local/ingest",
    monthlyBudgetUsd: 150,
    now: () => new Date("2026-11-09T12:00:00.000Z"),
    provider,
    token: "usage-token",
  });
}

test("reads the current JST month's spend from opencode-usage", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: URL | undefined;
  let requestedAuthorization: string | null | undefined;

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requestedUrl = new URL(request.url);
    requestedAuthorization = request.headers.get("authorization");

    return Response.json({
      days: 9,
      from: 1761951600000,
      to: 1762729200000,
      totals: {},
      rows: [
        { provider: "mistral", model: "mistral-large-latest", cost: 24.5 },
        { provider: "google", model: "gemini-3-pro-preview", cost: 100 },
        { provider: "mistral", model: "mistral-medium-latest", cost: 0.5 },
      ],
    });
  };

  try {
    const usage = await createProvider().getMonthlyUsageLimit();

    assert.equal(requestedUrl?.origin, "https://usage.local");
    assert.equal(requestedUrl?.pathname, "/usage");
    assert.equal(requestedUrl?.searchParams.get("days"), "9");
    assert.equal(requestedAuthorization, "Bearer usage-token");
    assert.deepEqual(usage, {
      resetsAt: new Date("2026-11-30T15:00:00.000Z"),
      status: "ok",
      usedPercentage: (25 / 150) * 100,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("treats a null opencode-usage cost as zero spend", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ rows: [{ provider: "mistral", model: "m", cost: null }] });

  try {
    const usage = await createProvider().getMonthlyUsageLimit();

    assert.equal(usage.usedPercentage, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an invalid opencode-usage response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ rows: [{ provider: "mistral", cost: "high" }] });

  try {
    await assert.rejects(
      createProvider().getMonthlyUsageLimit(),
      /opencode-usage response is invalid/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
