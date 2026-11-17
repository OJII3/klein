import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isRecord, parseJson } from "@shared/type-guards";

import type { VoiceReactionPreset } from "../ports/voice-reaction-selector";

function readNonEmptyString(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Voice reaction preset at index ${index} has an empty or invalid ${key}`);
  }
  return value;
}

export async function loadVoiceReactionPresets(
  filePath: string,
): Promise<readonly VoiceReactionPreset[]> {
  const parsed = parseJson(await readFile(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new TypeError(`Voice reaction presets must be a JSON array: ${filePath}`);
  }
  if (parsed.length === 0) {
    throw new Error(`Voice reaction presets must not be empty: ${filePath}`);
  }

  const ids = new Set<string>();
  return parsed.map((item: unknown, index) => {
    if (!isRecord(item)) {
      throw new Error(`Voice reaction preset at index ${index} must be an object`);
    }
    const id = readNonEmptyString(item, "id", index);
    const text = readNonEmptyString(item, "text", index);
    const description = readNonEmptyString(item, "description", index);
    const audioFile = readNonEmptyString(item, "audioFile", index);
    if (ids.has(id)) throw new Error(`Duplicate voice reaction preset id: ${id}`);
    ids.add(id);
    return {
      id,
      text,
      description,
      audioFile: resolve(dirname(filePath), audioFile),
    };
  });
}
