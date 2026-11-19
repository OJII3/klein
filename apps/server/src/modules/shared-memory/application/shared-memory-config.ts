import type { AppConfig } from "@app/config-schema";

const DEFAULT_SHARED_MEMORY_DIRECTORY = ".runtime/memory";
const DEFAULT_SHARED_MEMORY_IDLE_SECONDS = 180;
const DEFAULT_SHARED_MEMORY_MAX_BATCH_AGE_SECONDS = 1800;
const DEFAULT_SHARED_MEMORY_MAX_BATCH_MESSAGES = 32;

export interface SharedMemoryConfig {
  readonly enabled: boolean;
  readonly directory: string;
  readonly idleSeconds: number;
  readonly maxBatchAgeSeconds: number;
  readonly maxBatchMessages: number;
  readonly llm: Pick<AppConfig["llm"], "provider" | "model" | "thinkingLevel">;
}

export function resolveSharedMemoryConfig(config: AppConfig): SharedMemoryConfig {
  const sharedMemory = config.features.sharedMemory;

  return {
    enabled: sharedMemory.enabled,
    directory: sharedMemory.directory ?? DEFAULT_SHARED_MEMORY_DIRECTORY,
    idleSeconds: sharedMemory.idleSeconds ?? DEFAULT_SHARED_MEMORY_IDLE_SECONDS,
    maxBatchAgeSeconds:
      sharedMemory.maxBatchAgeSeconds ?? DEFAULT_SHARED_MEMORY_MAX_BATCH_AGE_SECONDS,
    maxBatchMessages: sharedMemory.maxBatchMessages ?? DEFAULT_SHARED_MEMORY_MAX_BATCH_MESSAGES,
    llm: sharedMemory.llm ?? config.llm,
  };
}
