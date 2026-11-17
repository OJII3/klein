import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { isFileNotFound } from "@shared/type-guards";

export interface PiSessionDirectory {
  readonly channelKey: string;
  readonly directory: string;
}

export async function listPiSessionDirectories(
  agentDirectory: string,
): Promise<PiSessionDirectory[]> {
  const sessionsDirectory = resolve(agentDirectory, "sessions", "conversation");

  let entries;
  try {
    entries = await readdir(sessionsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const channelKey = decodeChannelKey(entry.name);
      return channelKey === undefined
        ? []
        : [{ channelKey, directory: resolve(sessionsDirectory, entry.name) }];
    });
}

export async function listPiSessionFiles(agentDirectory: string): Promise<string[]> {
  const files: string[] = [];
  for (const { directory } of await listPiSessionDirectories(agentDirectory)) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) continue;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(resolve(directory, entry.name));
      }
    }
  }

  return files.toSorted((left, right) => left.localeCompare(right));
}

function decodeChannelKey(directoryName: string): string | undefined {
  try {
    return decodeURIComponent(directoryName);
  } catch {
    return undefined;
  }
}
