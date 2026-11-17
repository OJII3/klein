import type { AppConfig } from "@app/config-schema";

export interface UserMemoryConfig {
  readonly enabled: boolean;
  readonly directory?: string;
  readonly llm: Pick<AppConfig["llm"], "provider" | "model" | "thinkingLevel">;
}

export function resolveUserMemoryConfig(config: AppConfig): UserMemoryConfig | undefined {
  const userMemory = config.features.userMemory;
  if (!userMemory) return undefined;

  return {
    enabled: userMemory.enabled,
    ...(userMemory.directory ? { directory: userMemory.directory } : {}),
    llm: userMemory.llm ?? config.llm,
  };
}
