import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { ViewerSessionAgentRole } from "@klein/webui-api";
import { isFileNotFound } from "@shared/type-guards";

export interface PiSessionDirectory {
  readonly agentRole: ViewerSessionAgentRole;
  readonly sessionKey: string;
  readonly directory: string;
}

export async function listViewableSessionDirectories(
  agentDirectory: string,
): Promise<PiSessionDirectory[]> {
  const [conversationDirectories, workerDirectories] = await Promise.all([
    listSessionDirectories(agentDirectory, "conversation"),
    listSessionDirectories(agentDirectory, "worker"),
  ]);
  return [...conversationDirectories, ...workerDirectories];
}

export async function listPiSessionFiles(agentDirectory: string): Promise<string[]> {
  const files: string[] = [];
  for (const { directory } of await listSessionDirectories(agentDirectory, "conversation")) {
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

async function listSessionDirectories(
  agentDirectory: string,
  agentRole: ViewerSessionAgentRole,
): Promise<PiSessionDirectory[]> {
  const sessionsDirectory = resolve(agentDirectory, "sessions", agentRole);

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
      const sessionKey = decodeSessionKey(entry.name);
      return sessionKey === undefined
        ? []
        : [{ agentRole, sessionKey, directory: resolve(sessionsDirectory, entry.name) }];
    });
}

function decodeSessionKey(directoryName: string): string | undefined {
  try {
    return decodeURIComponent(directoryName);
  } catch {
    return undefined;
  }
}
