import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { DEFAULT_PROFILE, resolveProfile } from "./profile";

test("resolves the Klein profile by default", () => {
  assert.equal(DEFAULT_PROFILE, "klein");
  assert.deepEqual(resolveProfile(), {
    displayName: "Klein",
    systemPromptFile: resolve("config/klein/SOUL.md"),
    voiceSystemPromptFile: resolve("config/klein/SOUL.voice.md"),
    skillsDirectory: resolve("config/klein/skills"),
  });
});

test("resolves a named profile", () => {
  assert.deepEqual(resolveProfile("elysia"), {
    displayName: "Elysia",
    systemPromptFile: resolve("config/elysia/SOUL.md"),
    voiceSystemPromptFile: resolve("config/elysia/SOUL.voice.md"),
    skillsDirectory: resolve("config/elysia/skills"),
  });
});

test("turns hyphenated profile names into a display name", () => {
  assert.equal(resolveProfile("moon-guide").displayName, "Moon Guide");
});

test("rejects unsafe profile names", () => {
  assert.throws(() => resolveProfile("../secrets"), /Invalid profile name/);
});
