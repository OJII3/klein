import type { AppConfig } from "@app/config-schema";

const DEFAULT_MEMORY_FILE_PATH = ".runtime/memory/{guildId}/MEMORY.json";
const DEFAULT_MEMORY_IDLE_SECONDS = 180;
const DEFAULT_MEMORY_MAX_BATCH_AGE_SECONDS = 1800;
const DEFAULT_MEMORY_MAX_BATCH_MESSAGES = 32;

export interface MemoryConfig {
  readonly enabled: boolean;
  readonly filePath: string;
  readonly idleSeconds: number;
  readonly maxBatchAgeSeconds: number;
  readonly maxBatchMessages: number;
  readonly llm: Pick<AppConfig["llm"], "provider" | "model" | "thinkingLevel">;
}

export function resolveMemoryConfig(config: AppConfig): MemoryConfig {
  const memory = config.features.memory;

  return {
    enabled: memory.enabled,
    filePath: memory.filePath ?? DEFAULT_MEMORY_FILE_PATH,
    idleSeconds: memory.idleSeconds ?? DEFAULT_MEMORY_IDLE_SECONDS,
    maxBatchAgeSeconds: memory.maxBatchAgeSeconds ?? DEFAULT_MEMORY_MAX_BATCH_AGE_SECONDS,
    maxBatchMessages: memory.maxBatchMessages ?? DEFAULT_MEMORY_MAX_BATCH_MESSAGES,
    llm: memory.llm ?? config.llm,
  };
}
