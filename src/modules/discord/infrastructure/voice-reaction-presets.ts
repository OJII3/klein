import { readFile } from "node:fs/promises";

import type { VoiceReactionPreset } from "../ports/voice-reaction-selector";

export async function loadVoiceReactionPresets(
  filePath: string,
): Promise<readonly VoiceReactionPreset[]> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Voice reaction presets must be a JSON array: ${filePath}`);
  }
  if (parsed.length === 0) {
    throw new Error(`Voice reaction presets must not be empty: ${filePath}`);
  }

  const ids = new Set<string>();
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Voice reaction preset at index ${index} must be an object`);
    }
    const preset = item as Record<string, unknown>;
    for (const key of ["id", "text", "description", "audioFile"] as const) {
      if (typeof preset[key] !== "string" || !preset[key].trim()) {
        throw new Error(`Voice reaction preset at index ${index} has an empty or invalid ${key}`);
      }
    }
    const id = preset.id as string;
    if (ids.has(id)) throw new Error(`Duplicate voice reaction preset id: ${id}`);
    ids.add(id);
    return {
      id,
      text: preset.text as string,
      description: preset.description as string,
      audioFile: preset.audioFile as string,
    };
  });
}
