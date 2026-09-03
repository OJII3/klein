import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfiguredModel } from "./pi-agent-runtime.js";

test("resolves a configured built-in model", () => {
  const model = resolveConfiguredModel("opencode-go", "kimi-k3");

  assert.equal(model.provider, "opencode-go");
  assert.equal(model.id, "kimi-k3");
});

test("rejects an unknown configured model", () => {
  assert.throws(
    () => resolveConfiguredModel("opencode-go", "does-not-exist"),
    /Configured Pi model was not found: opencode-go\/does-not-exist/,
  );
});
