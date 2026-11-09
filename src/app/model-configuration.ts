import type { AppConfig } from "./config-schema";
import { resolveVoiceChatConfig } from "@modules/discord/domain/voice-chat-config";
import { resolveMemoryConfig } from "@modules/memory/application/memory-config";

export type ConfiguredModel = Pick<AppConfig["llm"], "provider" | "model" | "thinkingLevel">;

export function collectModelsInUse(config: AppConfig): ConfiguredModel[] {
  const memory = resolveMemoryConfig(config);
  const voiceChat = resolveVoiceChatConfig(config);
  const models: (ConfiguredModel | undefined)[] = [
    config.llm,
    config.llm.image,
    voiceChat?.llm,
    memory.enabled ? memory.llm : undefined,
  ];

  return models.filter((model): model is ConfiguredModel => model !== undefined);
}

export function collectModelNamesOfProvider(
  models: readonly ConfiguredModel[],
  provider: ConfiguredModel["provider"],
): string[] {
  return [
    ...new Set(models.filter((model) => model.provider === provider).map((model) => model.model)),
  ];
}
