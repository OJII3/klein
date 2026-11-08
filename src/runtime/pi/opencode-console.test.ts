import assert from "node:assert/strict";
import test from "node:test";

import { resolveMistralConnectionUrl } from "./opencode-console";

test("resolves the enabled Mistral connection URL", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  let requestedAuthorization: string | null | undefined;

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requestedUrls.push(request.url);
    requestedAuthorization = request.headers.get("authorization");

    if (request.url.endsWith("/providers")) {
      return Response.json([
        { catalogSlug: "opencode", enabled: true, id: "conn_opencode" },
        { catalogSlug: "mistral", enabled: true, id: "conn_mistral" },
        { catalogSlug: "mistral", enabled: false, id: "conn_disabled" },
      ]);
    }

    return Response.json({
      requestBaseUrl: "https://opencode.ai/inference/custom/conn_mistral",
    });
  };

  try {
    assert.equal(
      await resolveMistralConnectionUrl("secret-key"),
      "https://opencode.ai/inference/custom/conn_mistral",
    );
    assert.deepEqual(requestedUrls, [
      "https://opencode.ai/console/api/providers",
      "https://opencode.ai/console/api/providers/conn_mistral",
    ]);
    assert.equal(requestedAuthorization, "Bearer secret-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns undefined when no Mistral connection is enabled", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json([{ catalogSlug: "mistral", enabled: false, id: "conn_disabled" }]);

  try {
    assert.equal(await resolveMistralConnectionUrl("secret-key"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects multiple enabled Mistral connections", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json([
      { catalogSlug: "mistral", enabled: true, id: "conn_one" },
      { catalogSlug: "mistral", enabled: true, id: "conn_two" },
    ]);

  try {
    await assert.rejects(
      resolveMistralConnectionUrl("secret-key"),
      /Multiple enabled Mistral connections found/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
