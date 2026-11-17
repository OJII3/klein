import assert from "node:assert/strict";
import test from "node:test";

import { VadStream, type VadFrameScorer } from "./vad-stream";

test("frames arbitrary PCM chunks, keeps pre-roll, and ends after 512 ms of silence", async () => {
  let frameIndex = 0;
  const scorer: VadFrameScorer = {
    score: async () => {
      const current = frameIndex++;
      return current === 8 ? 0.9 : 0.1;
    },
  };
  const vad = new VadStream(scorer);
  const pcm = new Uint8Array(25 * 1024);
  const first = await vad.push(pcm.subarray(0, 318));
  assert.deepEqual(first, []);
  const events = await vad.push(pcm.subarray(318));
  assert.equal(events[0]?.type, "speech-start");
  assert.equal(events[0]?.pcm.byteLength, 8 * 1024);
  assert.equal(events.filter(({ type }) => type === "speech-end").length, 1);
});

test("does not report speech below the configured probability threshold", async () => {
  const vad = new VadStream({ score: async () => 0.49 });
  const events = await vad.push(new Uint8Array(10 * 1024));
  assert.deepEqual(events, []);
});
