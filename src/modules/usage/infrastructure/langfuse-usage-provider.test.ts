import assert from "node:assert/strict";
import test from "node:test";

import { LangfuseUsageProvider } from "./langfuse-usage-provider";

function createProvider(): LangfuseUsageProvider {
  return new LangfuseUsageProvider({
    baseUrl: "https://cloud.langfuse.com",
    models: ["mistral-large-latest", "mistral-medium-latest"],
    monthlyBudgetUsd: 150,
    now: () => new Date("2026-11-09T12:00:00.000Z"),
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
  });
}

test("reads the current month's Mistral spend from the Langfuse metrics API", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: URL | undefined;
  let requestedAuthorization: string | null | undefined;

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requestedUrl = new URL(request.url);
    requestedAuthorization = request.headers.get("authorization");

    return Response.json({ data: [{ sum_totalCost: 24.5 }, { sum_totalCost: 0.5 }] });
  };

  try {
    const usage = await createProvider().getMonthlyUsageLimit();

    assert.equal(requestedUrl?.origin, "https://cloud.langfuse.com");
    assert.equal(requestedUrl?.pathname, "/api/public/v2/metrics");
    assert.equal(
      requestedAuthorization,
      `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`,
    );
    assert.deepEqual(JSON.parse(requestedUrl?.searchParams.get("query") ?? ""), {
      view: "observations",
      metrics: [{ measure: "totalCost", aggregation: "sum" }],
      filters: [
        {
          column: "providedModelName",
          operator: "any of",
          type: "stringOptions",
          value: ["mistral-large-latest", "mistral-medium-latest"],
        },
      ],
      fromTimestamp: "2026-11-01T00:00:00.000Z",
      toTimestamp: "2026-12-01T00:00:00.000Z",
    });
    assert.deepEqual(usage, {
      resetsAt: new Date(Date.UTC(2026, 11)),
      status: "ok",
      usedPercentage: (25 / 150) * 100,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("treats an empty Langfuse metrics response as zero spend", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [] });

  try {
    const usage = await createProvider().getMonthlyUsageLimit();

    assert.deepEqual(usage, {
      resetsAt: new Date(Date.UTC(2026, 11)),
      status: "ok",
      usedPercentage: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an invalid Langfuse metrics response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ sum_totalCost: "high" }] });

  try {
    await assert.rejects(
      createProvider().getMonthlyUsageLimit(),
      /Langfuse usage response is invalid/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
