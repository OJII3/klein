import assert from "node:assert/strict";
import test from "node:test";

import { toDiscordPcm, toLivePcm } from "./discord-voice-service";

test("downsamples stereo Discord PCM to mono Live PCM", () => {
  const discordPcm = Buffer.alloc(8);
  discordPcm.writeInt16LE(1_000, 0);
  discordPcm.writeInt16LE(-1_000, 2);
  discordPcm.writeInt16LE(2_000, 4);
  discordPcm.writeInt16LE(2_000, 6);

  const livePcm = toLivePcm(discordPcm);

  assert.equal(livePcm.length, 2);
  assert.equal(livePcm.readInt16LE(0), 0);
});

test("upsamples mono Live PCM to stereo Discord PCM", () => {
  const livePcm = Buffer.alloc(4);
  livePcm.writeInt16LE(-500, 0);
  livePcm.writeInt16LE(1_500, 2);

  const discordPcm = toDiscordPcm(livePcm);

  assert.deepEqual(
    [
      discordPcm.readInt16LE(0),
      discordPcm.readInt16LE(2),
      discordPcm.readInt16LE(4),
      discordPcm.readInt16LE(6),
    ],
    [-500, -500, 1_500, 1_500],
  );
});
