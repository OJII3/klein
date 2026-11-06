import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";

import type { MonthlyUsageLimit } from "../domain/monthly-usage-limit";
import type { UsageLimitProvider } from "../ports/usage-limit-provider";

const MONTHLY_BUDGET_USD = 10;

export class VertexAiEstimatedUsageProvider implements UsageLimitProvider {
  constructor(private readonly agentDirectory: string) {}

  async getMonthlyUsageLimit(): Promise<MonthlyUsageLimit> {
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth());
    const sessionsDirectory = resolve(this.agentDirectory, "sessions");
    let directories;
    try {
      directories = await readdir(sessionsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { status: "ok", usedPercentage: 0 };
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
          if (entry.message.provider !== "google-vertex" || entry.message.timestamp < monthStart) {
            continue;
          }
          cost += entry.message.usage.cost.total;
        }
      }
    }

    return {
      status: "ok",
      usedPercentage: (cost / MONTHLY_BUDGET_USD) * 100,
    };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
