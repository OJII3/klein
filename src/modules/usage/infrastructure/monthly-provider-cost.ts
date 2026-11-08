import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";

export async function sumMonthlyProviderCost(
  agentDirectory: string,
  provider: string,
  monthStart: number,
): Promise<number> {
  const sessionsDirectory = resolve(agentDirectory, "sessions");
  let directories;
  try {
    directories = await readdir(sessionsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let cost = 0;
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const sessionInfos = await SessionManager.listAll(resolve(sessionsDirectory, directory.name));
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
