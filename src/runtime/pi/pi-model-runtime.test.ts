import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  registerMistralConsoleProvider,
  resolveConfiguredImageModel,
  resolveConfiguredModel,
  withOpenCodeSessionHeader,
} from "./pi-model-runtime";

test("resolves a configured built-in model", () => {
  const model = resolveConfiguredModel("opencode-go", "kimi-k3");

  assert.equal(model.provider, "opencode-go");
  assert.equal(model.id, "kimi-k3");
});

test("resolves DeepSeek V4.1 Flash when the local catalog is stale", () => {
  const model = resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash", {
    getModel: () => undefined,
  });

  assert.equal(model.id, "deepseek-v4.1-flash");
  assert.equal(model.baseUrl, "https://opencode.ai/zen/go/v1");
  assert.deepEqual(model.input, ["text", "image"]);
});

test("resolves Mistral DeepSeek V4.1 Flash 1017 when the local catalog is stale", () => {
  const model = resolveConfiguredModel("mistral", "deepseek-v4-1-flash-1017", {
    getModel: () => undefined,
  });

  assert.equal(model.id, "deepseek-v4-1-flash-1017");
  assert.equal(model.api, "mistral-conversations");
  assert.equal(model.baseUrl, "https://api.mistral.ai");
  assert.equal(model.contextWindow, 1_048_576);
});

test("prefers the online catalog model over the local fallback", () => {
  const onlineModel = {
    ...resolveConfiguredModel("opencode-go", "kimi-k3"),
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash (online)",
  };

  const model = resolveConfiguredModel("opencode-go", "deepseek-v4.1-flash", {
    getModel: () => onlineModel,
  });

  assert.equal(model, onlineModel);
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

test("rejects an unknown configured model", () => {
  assert.throws(
    () => resolveConfiguredModel("opencode-go", "does-not-exist"),
    /Configured Pi model was not found: opencode-go\/does-not-exist/,
  );
});

test("rejects an image model without image input", () => {
  assert.throws(
    () => resolveConfiguredImageModel("opencode-go", "glm-5.3"),
    /Configured Pi image model does not support image input: opencode-go\/glm-5.3/,
  );
});

test("registers the Mistral Console connection as the mistral provider", () => {
  const registrations: Array<Parameters<ModelRuntime["registerProvider"]>> = [];
  const runtime = {
    registerProvider: (...args: Parameters<ModelRuntime["registerProvider"]>) => {
      registrations.push(args);
    },
  };

  registerMistralConsoleProvider(
    runtime,
    "https://opencode.ai/inference/custom/conn_test",
    "secret-key",
  );

  assert.equal(registrations.length, 1);
  const [providerId, config] = registrations[0];
  assert.equal(providerId, "mistral");
  assert.equal(config.baseUrl, "https://opencode.ai/inference/custom/conn_test");
  assert.equal(config.apiKey, "secret-key");
  assert.deepEqual(
    config.models?.map((model) => [model.id, model.api]),
    [["deepseek-v4-1-flash-1017", "openai-completions"]],
  );
});
