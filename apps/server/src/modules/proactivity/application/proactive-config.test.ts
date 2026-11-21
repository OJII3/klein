import assert from "node:assert/strict";
import { resolve } from "node:path";

import { test } from "bun:test";

import type { AppConfig } from "@app/config-schema";

import { resolveProactivityConfig } from "./proactive-config";

function createConfig(proactivity?: NonNullable<AppConfig["features"]["proactivity"]>): AppConfig {
  return {
    version: 1,
    llm: { provider: "opencode-go", model: "main-model" },
    runtime: { agentDir: "/tmp/klein-agent" },
    discord: { access: { default: "deny", directMessages: "deny" } },
    features: {
      sharedMemory: { enabled: false },
      ...(proactivity ? { proactivity } : {}),
      minecraft: { enabled: false },
    },
  };
}

test("returns disabled defaults when proactivity is not configured", () => {
  const config = resolveProactivityConfig(createConfig(), "/tmp/klein-agent");

  assert.deepEqual(config, {
    enabled: false,
    preferencesDirectory: resolve("/tmp/klein-agent", "proactive/preferences"),
    followUpDirectory: resolve("/tmp/klein-agent", "proactive/follow-ups"),
    signalDirectory: resolve("/tmp/klein-agent", "proactive/signals"),
    defaults: {
      defaultMode: "attach",
      maxPerDay: 3,
      publicChannels: false,
    },
    promiseGuard: "log",
  });
});

test("keeps explicit paths and policy values", () => {
  const config = resolveProactivityConfig(
    createConfig({
      enabled: true,
      preferencesDirectory: "custom/preferences",
      followUpDirectory: "/srv/klein/follow-ups",
      signalDirectory: "signals",
      defaultMode: "digest",
      quietHours: { start: "22:30", end: "07:30" },
      digestAt: "08:15",
      maxPerDay: 5,
      publicChannels: true,
      promiseGuard: "block",
    }),
    "/tmp/klein-agent",
  );

  assert.deepEqual(config, {
    enabled: true,
    preferencesDirectory: resolve("custom/preferences"),
    followUpDirectory: resolve("/srv/klein/follow-ups"),
    signalDirectory: resolve("signals"),
    defaults: {
      defaultMode: "digest",
      quietHours: { start: "22:30", end: "07:30" },
      digestAt: "08:15",
      maxPerDay: 5,
      publicChannels: true,
    },
    promiseGuard: "block",
  });
});

test("allows zero as the daily limit", () => {
  const config = resolveProactivityConfig(
    createConfig({ enabled: true, maxPerDay: 0 }),
    "/tmp/klein-agent",
  );

  assert.equal(config.defaults.maxPerDay, 0);
});
