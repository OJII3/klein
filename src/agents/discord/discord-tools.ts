import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { TextToSpeech } from "@modules/tts/infrastructure/sbv2-tts";
import { createOwnerMemoryTools } from "../tools/owner-memory";
import { createReminderTools } from "../tools/reminder";
import { createWatchTools } from "../tools/watch";
import { createDiscordReadTool, type DiscordImageAnalysis } from "./tools/discord-read";
import { createDiscordSendTool } from "./tools/discord-send";
import { createDiscordSpeakTool } from "./tools/discord-speak";
import { createDiscordVoiceTool } from "./tools/discord-voice";

export interface DiscordAgentToolsOptions {
  readonly channelApi: Pick<
    DiscordChannelApi,
    "readMessage" | "sendMessage" | "sendTyping" | "sendAudio"
  >;
  readonly channelId: string;
  readonly ownerFeaturesAllowed: boolean;
  readonly ownerUserId?: string;
  readonly speak?: (text: string, toolCallId?: string) => Promise<void>;
  readonly tts?: TextToSpeech;
  readonly scheduledTaskStore?: ScheduledTaskStore;
  readonly ownerMemoryStore?: OwnerMemoryStore;
}

/**
 * Discord チャンネル用エージェントのツール一式を組み立てる。
 * エージェント本体ではなく composition root から呼ぶ。
 */
export function createDiscordAgentTools(
  options: DiscordAgentToolsOptions,
  analyzeImage: DiscordImageAnalysis,
): readonly ToolRegistration[] {
  const ownerFeaturesAllowed = options.ownerFeaturesAllowed && !!options.ownerUserId;
  return [
    createDiscordReadTool(
      options.channelApi,
      options.channelId,
      analyzeImage,
      ownerFeaturesAllowed ? { userId: options.ownerUserId! } : undefined,
    ),
    ...(options.speak
      ? [createDiscordSpeakTool(options.speak)]
      : [createDiscordSendTool(options.channelApi, options.channelId)]),
    ...(!options.speak && options.tts
      ? [createDiscordVoiceTool(options.channelApi, options.channelId, options.tts)]
      : []),
    ...(options.scheduledTaskStore
      ? createReminderTools(
          options.scheduledTaskStore,
          options.channelId,
          ownerFeaturesAllowed ? `owner:${options.ownerUserId!}` : "public",
        )
      : []),
    ...(options.scheduledTaskStore && ownerFeaturesAllowed
      ? createWatchTools(options.scheduledTaskStore, options.channelId, options.ownerUserId!)
      : []),
    ...(ownerFeaturesAllowed && options.ownerMemoryStore
      ? createOwnerMemoryTools(options.ownerMemoryStore, `communication:${options.channelId}`)
      : []),
  ];
}
