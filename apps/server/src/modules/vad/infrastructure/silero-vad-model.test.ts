import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SileroVadModel } from "./silero-vad-model";

test("loads the pinned Silero ONNX model and runs a 512-sample frame in Bun", async () => {
  const model = await SileroVadModel.create();
  try {
    const probability = await model.score(new Float32Array(512));
    assert.ok(probability >= 0 && probability <= 1);
  } finally {
    await model.close();
  }
});

test("detects real speech and resets streaming history", async () => {
  const pcm = await readFile(new URL("./fixtures/speech-16khz.pcm", import.meta.url));
  const model = await SileroVadModel.create();
  const scoreSpeech = async (): Promise<number[]> => {
    const probabilities: number[] = [];
    for (let offset = 0; offset + 1024 <= pcm.byteLength; offset += 1024) {
      const frame = new Float32Array(512);
      for (let i = 0; i < frame.length; i += 1) {
        frame[i] = pcm.readInt16LE(offset + i * 2) / 32768;
      }
      probabilities.push(await model.score(frame));
    }
    return probabilities;
  };
  try {
    const probabilities = await scoreSpeech();
    assert.ok(probabilities.some((probability) => probability >= 0.5));
    model.reset();
    assert.deepEqual(await scoreSpeech(), probabilities);
  } finally {
    await model.close();
  }
});
