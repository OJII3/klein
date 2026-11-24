import { dirname, resolve } from "node:path";

import type { AppConfig } from "@app/config-schema";

export function resolveStateDir(config: AppConfig): string {
  const agentDir = resolve(config.runtime.agentDir);
  return resolve(config.runtime.stateDir ?? resolve(dirname(agentDir), "state"));
}
