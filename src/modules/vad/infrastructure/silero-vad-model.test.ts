import assert from "node:assert/strict";
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
