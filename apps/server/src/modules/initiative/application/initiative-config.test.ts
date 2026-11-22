import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import type { AppConfig } from "@app/config-schema";

import { resolveInitiativeConfig } from "./initiative-config";

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

test("returns disabled defaults when initiative is not configured", () => {
  const config = resolveInitiativeConfig(createConfig(), "/tmp/klein-agent", false);

  assert.deepEqual(config, {
    enabled: false,
    goalsDirectory: resolve("/tmp/klein-agent", "initiative/goals"),
    plannerStateDirectory: resolve("/tmp/klein-agent", "initiative/planner"),
    llm: { provider: "opencode-go", model: "main-model" },
    planAfterIdleMinutes: 30,
    planWithinHours: 48,
    maxMessages: 80,
    maxPlansPerDay: 12,
    maxGoalsPerDay: 4,
    maxActiveGoals: 3,
    maxGoalsPerPlan: 2,
    approval: "auto",
  });
});

test("keeps explicit values and enables initiative only with proactivity", () => {
  const proactivity = {
    enabled: true,
    initiative: {
      enabled: true,
      goalsDirectory: "custom/goals",
      plannerStateDirectory: "/srv/klein/planner",
      llm: { provider: "mistral" as const, model: "small-model", thinkingLevel: "low" as const },
      planAfterIdleMinutes: 45,
      planWithinHours: 72,
      maxMessages: 40,
      maxPlansPerDay: 6,
      maxGoalsPerDay: 2,
      maxActiveGoals: 5,
      maxGoalsPerPlan: 1,
      approval: "off" as const,
    },
  };

  const config = resolveInitiativeConfig(createConfig(proactivity), "/tmp/klein-agent", true);

  assert.equal(config.enabled, true);
  assert.equal(config.goalsDirectory, resolve("custom/goals"));
  assert.equal(config.plannerStateDirectory, resolve("/srv/klein/planner"));
  assert.deepEqual(config.llm, {
    provider: "mistral",
    model: "small-model",
    thinkingLevel: "low",
  });
  assert.equal(config.planAfterIdleMinutes, 45);
  assert.equal(config.planWithinHours, 72);
  assert.equal(config.maxMessages, 40);
  assert.equal(config.maxPlansPerDay, 6);
  assert.equal(config.maxGoalsPerDay, 2);
  assert.equal(config.maxActiveGoals, 5);
  assert.equal(config.maxGoalsPerPlan, 1);
  assert.equal(config.approval, "off");
});

test("stays disabled when proactivity is disabled", () => {
  const config = resolveInitiativeConfig(
    createConfig({ enabled: false, initiative: { enabled: true } }),
    "/tmp/klein-agent",
    false,
  );

  assert.equal(config.enabled, false);
});

test("rejects propose mode until the approval flow exists", () => {
  assert.throws(
    () =>
      resolveInitiativeConfig(
        createConfig({
          enabled: true,
          initiative: { enabled: true, approval: "propose" },
        }),
        "/tmp/klein-agent",
        true,
      ),
    /propose is not implemented/u,
  );
});
