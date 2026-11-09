import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

import { loadVoiceReactionPresets } from "./voice-reaction-presets";
import { createTempDir } from "../../../testing/temp-dir";

test("resolves audio paths relative to the manifest outside the working directory", async () => {
  await using temp = await createTempDir("klein-voice-presets-");
  const directory = temp.path;
  const path = join(directory, "presets.json");
  await writeFile(
    path,
    JSON.stringify([
      {
        id: "neutral",
        text: "うん",
        description: "軽い相槌",
        audioFile: "audio/neutral.wav",
      },
    ]),
  );

  const expected = [
    {
      id: "neutral",
      text: "うん",
      description: "軽い相槌",
      audioFile: join(directory, "audio/neutral.wav"),
    },
  ];
  assert.deepEqual(await loadVoiceReactionPresets(path), expected);
  assert.deepEqual(await loadVoiceReactionPresets(relative(process.cwd(), path)), expected);
});

test("preserves absolute audio paths", async () => {
  await using temp = await createTempDir("klein-voice-presets-");
  const directory = temp.path;
  const path = join(directory, "presets.json");
  const preset = {
    id: "neutral",
    text: "うん",
    description: "軽い相槌",
    audioFile: join(directory, "neutral.wav"),
  };
  await writeFile(path, JSON.stringify([preset]));
  assert.deepEqual(await loadVoiceReactionPresets(path), [preset]);
});

test("rejects duplicate ids and empty preset fields", async () => {
  await using temp = await createTempDir("klein-voice-presets-");
  const directory = temp.path;
  const path = join(directory, "presets.json");
  const valid = {
    id: "neutral",
    text: "うん",
    description: "軽い相槌",
    audioFile: "audio/neutral.wav",
  };
  await writeFile(path, JSON.stringify([valid, valid]));
  await assert.rejects(loadVoiceReactionPresets(path), /Duplicate voice reaction preset id/);

  await writeFile(path, JSON.stringify([{ ...valid, text: " " }]));
  await assert.rejects(loadVoiceReactionPresets(path), /invalid text/);

  await writeFile(path, "[]");
  await assert.rejects(loadVoiceReactionPresets(path), /must not be empty/);
});
