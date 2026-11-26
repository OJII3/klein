import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { createTempDir } from "../testing/temp-dir";
import { DEFAULT_PROFILE, loadProfile, resolveProfile } from "./profile";

test("resolves the Klein profile by default", () => {
  assert.equal(DEFAULT_PROFILE, "klein");
  assert.deepEqual(resolveProfile(), {
    displayName: "Klein",
    profileFile: resolve("config/klein/profile.json"),
    systemPromptFile: resolve("config/klein/SOUL.md"),
    voiceSystemPromptFile: resolve("config/klein/SOUL.voice.md"),
    skillsDirectories: [resolve("config/klein/skills"), resolve("config/skills")],
  });
});

test("resolves a named profile", () => {
  assert.deepEqual(resolveProfile("elysia"), {
    displayName: "Elysia",
    profileFile: resolve("config/elysia/profile.json"),
    systemPromptFile: resolve("config/elysia/SOUL.md"),
    voiceSystemPromptFile: resolve("config/elysia/SOUL.voice.md"),
    skillsDirectories: [resolve("config/elysia/skills"), resolve("config/skills")],
  });
});

test("turns hyphenated profile names into a display name", () => {
  assert.equal(resolveProfile("moon-guide").displayName, "Moon Guide");
});

test("rejects unsafe profile names", () => {
  assert.throws(() => resolveProfile("../secrets"), /Invalid profile name/);
});

test("loads bundled klein and yachiyo character names from profile.json", async () => {
  const klein = await loadProfile("klein");
  const yachiyo = await loadProfile("yachiyo");

  assert.equal(klein.displayName, "Klein");
  assert.equal(klein.characterName, "クライン");
  assert.equal(yachiyo.displayName, "Yachiyo");
  assert.equal(yachiyo.characterName, "月見ヤチヨ");
});

test("throws when profile.json does not exist", async () => {
  await using temp = await createTempDir("klein-profile-missing-");
  await assert.rejects(
    () => loadProfile("moon-guide", temp.path),
    /Profile metadata was not found/,
  );
});

test("loads trimmed character name from profile.json", async () => {
  await using temp = await createTempDir("klein-profile-custom-");
  const profileDir = join(temp.path, "config", "elysia");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "profile.json"), JSON.stringify({ name: "  エリシア  " }));

  const loaded = await loadProfile("elysia", temp.path);

  assert.equal(loaded.displayName, "Elysia");
  assert.equal(loaded.characterName, "エリシア");
});

test("rejects invalid profile.json metadata", async () => {
  await using temp = await createTempDir("klein-profile-invalid-");
  const invalidJsonDir = join(temp.path, "config", "bad-json");
  await mkdir(invalidJsonDir, { recursive: true });
  await writeFile(join(invalidJsonDir, "profile.json"), "{");

  const emptyNameDir = join(temp.path, "config", "empty-name");
  await mkdir(emptyNameDir, { recursive: true });
  await writeFile(join(emptyNameDir, "profile.json"), JSON.stringify({ name: "   " }));

  const extraFieldDir = join(temp.path, "config", "extra-field");
  await mkdir(extraFieldDir, { recursive: true });
  await writeFile(
    join(extraFieldDir, "profile.json"),
    JSON.stringify({ name: "クライン", extra: true }),
  );

  await assert.rejects(() => loadProfile("bad-json", temp.path), /not valid JSON/);
  await assert.rejects(() => loadProfile("empty-name", temp.path), /Profile metadata is invalid/);
  await assert.rejects(() => loadProfile("extra-field", temp.path), /Profile metadata is invalid/);
});
