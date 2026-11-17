import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "@app/config-schema";
import { resolveUserMemoryConfig } from "./user-memory-config";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    llm: { provider: "opencode-go", model: "main-model" },
    runtime: { agentDir: "/tmp/klein-agent" },
    discord: { access: { default: "deny", directMessages: "deny" } },
    features: { memory: { enabled: false }, minecraft: { enabled: false } },
    ...overrides,
  };
}

test("returns undefined when user memory is not configured", () => {
  assert.equal(resolveUserMemoryConfig(createConfig()), undefined);
});

test("keeps the configured directory and model", () => {
  const config = createConfig({
    features: {
      memory: { enabled: false },
      minecraft: { enabled: false },
      userMemory: {
        enabled: true,
        directory: "custom/user-memory",
        llm: { provider: "mistral", model: "user-memory-model", thinkingLevel: "low" },
      },
    },
  });

  assert.deepEqual(resolveUserMemoryConfig(config), {
    enabled: true,
    directory: "custom/user-memory",
    llm: { provider: "mistral", model: "user-memory-model", thinkingLevel: "low" },
  });
});

test("falls back to the main model when user memory has no model of its own", () => {
  const config = createConfig({
    llm: { provider: "google", model: "main-model", thinkingLevel: "high" },
    features: {
      memory: { enabled: false },
      minecraft: { enabled: false },
      userMemory: { enabled: true },
    },
  });

  assert.deepEqual(resolveUserMemoryConfig(config)?.llm, {
    provider: "google",
    model: "main-model",
    thinkingLevel: "high",
  });
});
