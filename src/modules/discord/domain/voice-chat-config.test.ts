import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "@app/config-schema";
import { resolveVoiceChatConfig } from "./voice-chat-config";

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

test("returns undefined when voice chat is not configured", () => {
  assert.equal(resolveVoiceChatConfig(createConfig()), undefined);
});

test("returns undefined when voice chat is disabled", () => {
  const config = createConfig({
    features: {
      memory: { enabled: false },
      minecraft: { enabled: false },
      voiceChat: { enabled: false, asrServerUrl: "ws://asr.local" },
    },
  });

  assert.equal(resolveVoiceChatConfig(config), undefined);
});

test("defaults the language to Japanese", () => {
  const config = createConfig({
    features: {
      memory: { enabled: false },
      minecraft: { enabled: false },
      voiceChat: { enabled: true, asrServerUrl: "ws://asr.local" },
    },
  });

  assert.deepEqual(resolveVoiceChatConfig(config), {
    asrServerUrl: "ws://asr.local",
    language: "ja",
  });
});

test("keeps the configured language, model, and reactions", () => {
  const config = createConfig({
    features: {
      memory: { enabled: false },
      minecraft: { enabled: false },
      voiceChat: {
        enabled: true,
        asrServerUrl: "ws://asr.local",
        language: "en",
        llm: { provider: "google", model: "voice-model" },
        reactions: {
          provider: "google",
          model: "classifier-model",
          presetsFile: "reactions.json",
        },
      },
    },
  });

  assert.deepEqual(resolveVoiceChatConfig(config), {
    asrServerUrl: "ws://asr.local",
    language: "en",
    llm: { provider: "google", model: "voice-model" },
    reactions: {
      provider: "google",
      model: "classifier-model",
      presetsFile: "reactions.json",
    },
  });
});
