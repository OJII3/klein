import assert from "node:assert/strict";
import test from "node:test";

import { MistralConsoleUsageProvider } from "./mistral-console-usage-provider";

test("fetches the current month's Mistral spend from the OpenCode Console", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: URL | undefined;
  let requestedAuthorization: string | null | undefined;

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requestedUrl = new URL(request.url);
    requestedAuthorization = request.headers.get("authorization");

    return Response.json({
      items: [
        {
          model: "deepseek-v4.1-flash",
          provider: "opencode-go",
          totalCostMicroCents: "200000000",
        },
        {
          model: "deepseek-v4-1-flash-1017",
          provider: "mistral",
          totalCostMicroCents: "100000000",
        },
        {
          model: "zai-glm-5-3-flash",
          provider: "mistral",
          totalCostMicroCents: "50000000",
        },
      ],
    });
  };

  try {
    const provider = new MistralConsoleUsageProvider(
      "secret-key",
      () => new Date("2026-09-14T14:00:00.000Z"),
    );

    assert.deepEqual(await provider.getMonthlyUsageLimit(), {
      resetsAt: new Date(Date.UTC(2026, 9)),
      status: "ok",
      usedPercentage: 1,
    });
    assert.equal(requestedUrl?.origin, "https://opencode.ai");
    assert.equal(requestedUrl?.pathname, "/console/api/usage/models");
    assert.equal(requestedUrl?.searchParams.get("from"), "2026-09-01");
    assert.equal(requestedUrl?.searchParams.get("to"), "2026-10-01");
    assert.equal(requestedAuthorization, "Bearer secret-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an invalid OpenCode Console usage response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ items: [{ provider: "mistral" }] });

  try {
    await assert.rejects(
      new MistralConsoleUsageProvider("secret-key").getMonthlyUsageLimit(),
      /OpenCode Console usage response is invalid/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
