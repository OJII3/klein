import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureConfiguredModels,
  resolveConfiguredImageModel,
  resolveConfiguredModel,
  withOpenCodeSessionHeader,
} from "./pi-model-runtime";

test("resolves a configured built-in model", () => {
  const model = resolveConfiguredModel("opencode-go", "kimi-k3");

  assert.equal(model.provider, "opencode-go");
  assert.equal(model.id, "kimi-k3");
});

test("does not refresh the catalog when every configured model is present", async () => {
  let refreshes = 0;
  const catalog = {
    getModel: () => resolveConfiguredModel("opencode-go", "kimi-k3"),
    refresh: async () => {
      refreshes += 1;
    },
  };

  await ensureConfiguredModels(catalog, [{ provider: "opencode-go", model: "kimi-k3" }]);

  assert.equal(refreshes, 0);
});

test("refreshes the catalog once when a configured model is missing", async () => {
  const model = resolveConfiguredModel("opencode-go", "kimi-k3");
  let refreshed = false;
  const refreshes: { providers?: readonly string[]; force?: boolean }[] = [];
  const catalog = {
    getModel: (provider: string, modelId: string) =>
      refreshed && provider === "mistral" && modelId === "deepseek-v4-1-flash-1017"
        ? model
        : undefined,
    refresh: async (options: { providers?: readonly string[]; force?: boolean }) => {
      refreshes.push(options);
      refreshed = true;
    },
  };

  await ensureConfiguredModels(catalog, [
    { provider: "mistral", model: "deepseek-v4-1-flash-1017" },
  ]);

  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0]?.force, true);
  assert.deepEqual(refreshes[0]?.providers, ["mistral"]);
});

test("fails with the models still missing after refreshing the catalog", async () => {
  const catalog = {
    getModel: () => undefined,
    refresh: async () => {},
  };

  await assert.rejects(
    ensureConfiguredModels(catalog, [
      { provider: "mistral", model: "deepseek-v4-1-flash-1017" },
      { provider: "mistral", model: "deepseek-v4-1-flash-1017" },
      { provider: "opencode-go", model: "does-not-exist" },
    ]),
    /Configured Pi model was not found after refreshing the catalog: mistral\/deepseek-v4-1-flash-1017, opencode-go\/does-not-exist$/,
  );
});

test("reports why the catalog refresh failed", async () => {
  const catalog = {
    getModel: () => undefined,
    refresh: async () => ({ errors: new Map([["mistral", new Error("404 Not Found")]]) }),
  };

  await assert.rejects(
    ensureConfiguredModels(catalog, [{ provider: "mistral", model: "deepseek-v4-1-flash-1017" }]),
    /catalog refresh failed: mistral: 404 Not Found/,
  );
});

test("rejects a configured model that the catalog does not contain", () => {
  assert.throws(
    () => resolveConfiguredModel("opencode-go", "does-not-exist"),
    /Configured Pi model was not found: opencode-go\/does-not-exist/,
  );
});

test("adds the stable session header to OpenCode models", () => {
  const model = resolveConfiguredModel("opencode-go", "kimi-k3");
  const configured = withOpenCodeSessionHeader(model, "session-123");

  assert.equal(configured.headers?.["x-opencode-session"], "session-123");
  assert.equal(model.headers, undefined);
});

test("does not add a session header to other providers", () => {
  const model = resolveConfiguredModel("anthropic", "claude-sonnet-4-5");

  assert.equal(withOpenCodeSessionHeader(model, "session-123"), model);
});

test("rejects an image model without image input", () => {
  assert.throws(
    () => resolveConfiguredImageModel("opencode-go", "glm-5.3"),
    /Configured Pi image model does not support image input: opencode-go\/glm-5.3/,
  );
});
