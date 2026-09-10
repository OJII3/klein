import { resolve } from "node:path";

import type { KleinConfig } from "../../../app/config-schema.js";

export const DEFAULT_WEBUI_HOST = "127.0.0.1";
export const DEFAULT_WEBUI_PORT = 4310;
export const DEFAULT_LOG_DIRECTORY = ".runtime/logs";

export interface ResolvedWebUiConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
}

export function resolveLogDirectory(config: KleinConfig): string {
  return resolve(config.runtime.logDir ?? DEFAULT_LOG_DIRECTORY);
}

export function resolveWebUiConfig(config: KleinConfig): ResolvedWebUiConfig {
  const webui = config.features.webui;

  return {
    enabled: webui?.enabled ?? false,
    host: webui?.host ?? DEFAULT_WEBUI_HOST,
    port: webui?.port ?? DEFAULT_WEBUI_PORT,
  };
}
