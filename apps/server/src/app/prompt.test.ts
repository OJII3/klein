import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import { loadConversationSystemPrompt, loadPromptFile } from "./prompt";
import { createTempDir } from "../testing/temp-dir";

test("loads and trims an external system prompt", async () => {
  await using temp = await createTempDir("klein-prompt-");
  const directory = temp.path;
  const promptPath = join(directory, "SOUL.md");
  await writeFile(promptPath, "\n  Be helpful.\n\n", "utf8");

  assert.equal(await loadPromptFile(promptPath), "Be helpful.");
});

test("rejects a missing system prompt", async () => {
  await assert.rejects(loadPromptFile("config/does-not-exist.md"), /System prompt was not found:/);
});

test("appends the proactivity prompt when configured", async () => {
  await using temp = await createTempDir("klein-prompt-");
  const directory = temp.path;
  const promptPath = join(directory, "SOUL.md");
  const proactivityPromptPath = join(directory, "PROACTIVITY.md");
  await writeFile(promptPath, "Be helpful.\n", "utf8");
  await writeFile(proactivityPromptPath, "Stay quiet unless addressed.\n", "utf8");

  assert.equal(
    await loadConversationSystemPrompt({
      systemPromptFile: promptPath,
      proactivityPromptFile: proactivityPromptPath,
    }),
    "Be helpful.\n\nStay quiet unless addressed.",
  );
  assert.equal(await loadConversationSystemPrompt({ systemPromptFile: promptPath }), "Be helpful.");
});

test("rejects a missing proactivity prompt", async () => {
  await using temp = await createTempDir("klein-prompt-");
  const directory = temp.path;
  const promptPath = join(directory, "SOUL.md");
  await writeFile(promptPath, "Be helpful.\n", "utf8");

  await assert.rejects(
    loadConversationSystemPrompt({
      systemPromptFile: promptPath,
      proactivityPromptFile: join(directory, "missing.md"),
    }),
    /System prompt was not found:/,
  );
});
