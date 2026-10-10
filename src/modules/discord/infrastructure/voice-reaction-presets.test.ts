import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { loadVoiceReactionPresets } from "./voice-reaction-presets";

test("resolves audio paths relative to the manifest outside the working directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-voice-presets-"));
  const path = join(directory, "presets.json");
  try {
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves absolute audio paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-voice-presets-"));
  const path = join(directory, "presets.json");
  const preset = {
    id: "neutral",
    text: "うん",
    description: "軽い相槌",
    audioFile: join(directory, "neutral.wav"),
  };
  try {
    await writeFile(path, JSON.stringify([preset]));
    assert.deepEqual(await loadVoiceReactionPresets(path), [preset]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects duplicate ids and empty preset fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-voice-presets-"));
  const path = join(directory, "presets.json");
  const valid = {
    id: "neutral",
    text: "うん",
    description: "軽い相槌",
    audioFile: "audio/neutral.wav",
  };
  try {
    await writeFile(path, JSON.stringify([valid, valid]));
    await assert.rejects(loadVoiceReactionPresets(path), /Duplicate voice reaction preset id/);

    await writeFile(path, JSON.stringify([{ ...valid, text: " " }]));
    await assert.rejects(loadVoiceReactionPresets(path), /invalid text/);

    await writeFile(path, "[]");
    await assert.rejects(loadVoiceReactionPresets(path), /must not be empty/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
