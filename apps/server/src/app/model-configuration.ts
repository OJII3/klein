import type { AppConfig } from "./config-schema";
import { resolveVoiceChatConfig } from "@modules/discord/domain/voice-chat-config";
import { resolveSharedMemoryConfig } from "@modules/shared-memory/application/shared-memory-config";
import { resolveUserMemoryConfig } from "@modules/user-memory/application/user-memory-config";

export type ConfiguredModel = Pick<AppConfig["llm"], "provider" | "model" | "thinkingLevel">;

export function collectModelsInUse(config: AppConfig): ConfiguredModel[] {
  const memory = resolveSharedMemoryConfig(config);
  const userMemory = resolveUserMemoryConfig(config);
  const voiceChat = resolveVoiceChatConfig(config);
  const proactivity = config.features.proactivity;
  const initiative =
    proactivity?.enabled && proactivity.initiative?.enabled
      ? (proactivity.initiative.llm ?? config.llm)
      : undefined;
  const models: (ConfiguredModel | undefined)[] = [
    config.llm,
    config.llm.image,
    voiceChat?.llm,
    memory.enabled ? memory.llm : undefined,
    userMemory?.enabled ? userMemory.llm : undefined,
    initiative,
  ];

  return models.filter((model): model is ConfiguredModel => model !== undefined);
}
