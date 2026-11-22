import type { AppConfig } from "@app/config-schema";

const DEFAULT_VOICE_CHAT_LANGUAGE = "ja";

export interface VoiceChatConfig {
  readonly asrServerUrl: string;
  readonly language: string;
  readonly llm?: Pick<AppConfig["llm"], "provider" | "model" | "thinkingLevel">;
  readonly classifier?: {
    readonly provider: string;
    readonly model: string;
  };
}

export function resolveVoiceChatConfig(config: AppConfig): VoiceChatConfig | undefined {
  const voiceChat = config.features.voiceChat;
  if (!voiceChat?.enabled) {
    return undefined;
  }

  return {
    asrServerUrl: voiceChat.asrServerUrl,
    language: voiceChat.language ?? DEFAULT_VOICE_CHAT_LANGUAGE,
    ...(voiceChat.llm ? { llm: voiceChat.llm } : {}),
    ...(voiceChat.classifier ? { classifier: voiceChat.classifier } : {}),
  };
}
