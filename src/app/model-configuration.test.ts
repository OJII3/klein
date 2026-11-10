import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "./config-schema";
import { collectModelsInUse } from "./model-configuration";

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

function describeModels(models: ReturnType<typeof collectModelsInUse>): string[] {
  return models.map((model) => `${model.provider}/${model.model}`);
}

test("collects the models used by the main agent, image, voice chat, memory, and user memory", () => {
  const config = createConfig({
    llm: {
      provider: "opencode-go",
      model: "main-model",
      image: { provider: "google", model: "image-model" },
    },
    features: {
      memory: { enabled: true, llm: { provider: "mistral", model: "memory-model" } },
      minecraft: { enabled: false },
      userMemory: { enabled: true, llm: { provider: "mistral", model: "user-memory-model" } },
      voiceChat: {
        enabled: true,
        asrServerUrl: "ws://asr.local",
        llm: { provider: "google", model: "voice-model" },
      },
    },
  });

  assert.deepEqual(describeModels(collectModelsInUse(config)), [
    "opencode-go/main-model",
    "google/image-model",
    "google/voice-model",
    "mistral/memory-model",
    "mistral/user-memory-model",
  ]);
});

test("leaves out models that disabled features would not use", () => {
  const config = createConfig({
    features: {
      memory: { enabled: false, llm: { provider: "mistral", model: "memory-model" } },
      minecraft: { enabled: false },
      userMemory: { enabled: false, llm: { provider: "mistral", model: "user-memory-model" } },
      voiceChat: {
        enabled: false,
        asrServerUrl: "ws://asr.local",
        llm: { provider: "google", model: "voice-model" },
      },
    },
  });

  assert.deepEqual(describeModels(collectModelsInUse(config)), ["opencode-go/main-model"]);
});
