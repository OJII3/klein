import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { DEFAULT_PROFILE, resolveProfile } from "./profile";

test("resolves the Klein profile by default", () => {
  assert.equal(DEFAULT_PROFILE, "klein");
  assert.deepEqual(resolveProfile(), {
    systemPromptFile: resolve("config/klein/SOUL.md"),
    skillsDirectory: resolve("config/klein/skills"),
  });
});

test("resolves a named profile", () => {
  assert.deepEqual(resolveProfile("elysia"), {
    systemPromptFile: resolve("config/elysia/SOUL.md"),
    skillsDirectory: resolve("config/elysia/skills"),
  });
});

test("rejects unsafe profile names", () => {
  assert.throws(() => resolveProfile("../secrets"), /Invalid profile name/);
});
