import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "@app/config-schema";
import { resolveMemoryConfig } from "./memory-config";

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

test("applies the default memory settings", () => {
  assert.deepEqual(resolveMemoryConfig(createConfig()), {
    enabled: false,
    filePath: ".runtime/memory/{guildId}/MEMORY.json",
    idleSeconds: 180,
    maxBatchAgeSeconds: 1800,
    maxBatchMessages: 32,
    llm: { provider: "opencode-go", model: "main-model" },
  });
});

test("keeps configured values", () => {
  const config = createConfig({
    features: {
      memory: {
        enabled: true,
        filePath: "custom/MEMORY.json",
        idleSeconds: 30,
        maxBatchAgeSeconds: 60,
        maxBatchMessages: 8,
        llm: { provider: "mistral", model: "memory-model", thinkingLevel: "low" },
      },
      minecraft: { enabled: false },
    },
  });

  assert.deepEqual(resolveMemoryConfig(config), {
    enabled: true,
    filePath: "custom/MEMORY.json",
    idleSeconds: 30,
    maxBatchAgeSeconds: 60,
    maxBatchMessages: 8,
    llm: { provider: "mistral", model: "memory-model", thinkingLevel: "low" },
  });
});

test("falls back to the main model when memory has no model of its own", () => {
  const config = createConfig({
    llm: { provider: "google", model: "main-model", thinkingLevel: "high" },
    features: { memory: { enabled: true }, minecraft: { enabled: false } },
  });

  assert.deepEqual(resolveMemoryConfig(config).llm, {
    provider: "google",
    model: "main-model",
    thinkingLevel: "high",
  });
});
