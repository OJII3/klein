import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "./config-schema";
import { collectModelNamesOfProvider, collectModelsInUse } from "./model-configuration";

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

test("collects the models used by the main agent, image, voice chat, and memory", () => {
  const config = createConfig({
    llm: {
      provider: "opencode-go",
      model: "main-model",
      image: { provider: "google", model: "image-model" },
    },
    features: {
      memory: { enabled: true, llm: { provider: "mistral", model: "memory-model" } },
      minecraft: { enabled: false },
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
  ]);
});

test("leaves out models that disabled features would not use", () => {
  const config = createConfig({
    features: {
      memory: { enabled: false, llm: { provider: "mistral", model: "memory-model" } },
      minecraft: { enabled: false },
      voiceChat: {
        enabled: false,
        asrServerUrl: "ws://asr.local",
        llm: { provider: "google", model: "voice-model" },
      },
    },
  });

  assert.deepEqual(describeModels(collectModelsInUse(config)), ["opencode-go/main-model"]);
});

test("lists unique model names for a provider", () => {
  const models = [
    { provider: "mistral" as const, model: "first-model" },
    { provider: "google" as const, model: "other-model" },
    { provider: "mistral" as const, model: "first-model" },
    { provider: "mistral" as const, model: "second-model" },
  ];

  assert.deepEqual(collectModelNamesOfProvider(models, "mistral"), ["first-model", "second-model"]);
});
