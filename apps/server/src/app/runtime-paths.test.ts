import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import type { AppConfig } from "@app/config-schema";
import { resolveStateDir } from "./runtime-paths";

function createConfig(runtime: Partial<AppConfig["runtime"]> = {}): AppConfig {
  return {
    version: 1,
    llm: { provider: "opencode-go", model: "main-model" },
    runtime: { agentDir: ".runtime/pi", ...runtime },
    discord: { access: { default: "deny", directMessages: "deny" } },
    features: { sharedMemory: { enabled: false }, minecraft: { enabled: false } },
  };
}

test("defaults the state directory to the agent directory's sibling state directory", () => {
  assert.equal(resolveStateDir(createConfig()), resolve(".runtime/state"));
});

test("keeps an explicit state directory", () => {
  assert.equal(
    resolveStateDir(createConfig({ stateDir: "var/klein-state" })),
    resolve("var/klein-state"),
  );
});

test("resolves the sibling of a nested absolute agent directory", () => {
  assert.equal(resolveStateDir(createConfig({ agentDir: "/srv/klein/pi" })), "/srv/klein/state");
});
