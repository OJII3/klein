import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig } from "../src/app/config";
import { loadVoiceReactionPresets } from "../src/modules/discord/infrastructure/voice-reaction-presets";
import { Sbv2Tts } from "../src/modules/tts/infrastructure/sbv2-tts";

const config = await loadConfig();
const ttsConfiguration = config.features.tts;
if (!ttsConfiguration?.enabled) {
  throw new Error(
    "Enable features.tts and configure its serverUrl before generating voice presets",
  );
}

const presetsFile =
  config.features.voiceChat?.reactions?.presetsFile ?? "config/klein/voice-presets.json";
const presets = await loadVoiceReactionPresets(presetsFile);
const tts = new Sbv2Tts(ttsConfiguration.serverUrl);

for (const preset of presets) {
  const outputPath = resolve(preset.audioFile);
  const audio = await tts.synthesize(preset.text);
  const header = String.fromCharCode(...audio.subarray(0, 12));
  if (audio.byteLength < 12 || header.slice(0, 4) !== "RIFF" || header.slice(8, 12) !== "WAVE") {
    throw new Error(`SBV2 returned an invalid WAV for voice reaction preset: ${preset.id}`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, audio);
  console.info(`Generated ${preset.id}: ${preset.audioFile}`);
}
