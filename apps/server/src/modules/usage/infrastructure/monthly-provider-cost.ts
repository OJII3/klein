import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { isFileNotFound } from "@shared/type-guards";

export async function sumMonthlyProviderCost(
  agentDirectory: string,
  provider: string,
  monthStart: number,
): Promise<number> {
  const sessionsDirectory = resolve(agentDirectory, "sessions");
  const sessionDirectories = await listSessionDirectories(sessionsDirectory);

  let cost = 0;
  for (const directory of sessionDirectories) {
    const sessionInfos = await SessionManager.listAll(directory);
    for (const info of sessionInfos) {
      const entries = parseSessionEntries(await readFile(info.path, "utf8"));
      for (const entry of entries) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        if (entry.message.provider !== provider || entry.message.timestamp < monthStart) {
          continue;
        }
        cost += entry.message.usage.cost.total;
      }
    }
  }

  return cost;
}

async function listSessionDirectories(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }

  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = resolve(root, entry.name);
    let children;
    try {
      children = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) continue;
      throw error;
    }
    if (children.some((child) => child.isFile() && child.name.endsWith(".jsonl"))) {
      directories.push(path);
    } else {
      directories.push(...(await listSessionDirectories(path)));
    }
  }
  return directories;
}
