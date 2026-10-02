import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AppConfig } from "@app/config-schema";

export const DEFAULT_WEBUI_HOST = "127.0.0.1";
export const DEFAULT_WEBUI_PORT = 4310;
export const DEFAULT_LOG_DIRECTORY = ".runtime/logs";

export interface ResolvedWebUiConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
}

export function resolveLogDirectory(config: AppConfig): string {
  return resolve(config.runtime.logDir ?? DEFAULT_LOG_DIRECTORY);
}

export function resolveWebUiStaticDirectory(
  executablePath = process.argv[1],
  workingDirectory = process.cwd(),
): string {
  const executableDirectory = executablePath ? dirname(resolve(executablePath)) : undefined;
  const candidates = [
    ...(executableDirectory ? [resolve(executableDirectory, "web")] : []),
    resolve(workingDirectory, "dist/web"),
  ];
  const staticDirectory = candidates.find((candidate) => existsSync(candidate));

  if (!staticDirectory) {
    throw new Error(`Web UI static directory was not found. Tried: ${candidates.join(", ")}`);
  }

  return staticDirectory;
}

export function resolveWebUiConfig(config: AppConfig): ResolvedWebUiConfig {
  const webui = config.features.webui;

  return {
    enabled: webui?.enabled ?? false,
    host: webui?.host ?? DEFAULT_WEBUI_HOST,
    port: webui?.port ?? DEFAULT_WEBUI_PORT,
  };
}
