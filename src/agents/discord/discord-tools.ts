import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentImageAnalyzer } from "@agents/core/agent-factory";
import type { AttachedTaskControl } from "@agents/core/attached-agent";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { DiscordUserResolver } from "@modules/discord/domain/discord-user";
import type { OwnerMemoryStore } from "@modules/memory/application/owner-memory-store";
import type { WatchCheckRunner } from "@modules/scheduling/application/watch-check-runner";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { TextToSpeech } from "@modules/tts/infrastructure/sbv2-tts";
import type { UserMemoryStore } from "@modules/user-memory/domain/user-memory";
import { ownerAccessScope, PUBLIC_ACCESS_SCOPE } from "@shared/access";
import { createOwnerMemoryTools } from "../tools/owner-memory";
import { createReminderTools } from "../tools/reminder";
import { createUserMemoryTools } from "../tools/user-memory";
import { createWatchTools } from "../tools/watch";
import { createDiscordAskTool } from "./tools/discord-ask";
import { createDiscordImageAnalysis, createDiscordReadTool } from "./tools/discord-read";
import { createDiscordSendTool } from "./tools/discord-send";
import { createDiscordSpeakTool } from "./tools/discord-speak";
import { createDiscordVoiceTool } from "./tools/discord-voice";
import { createAttachedControlTools } from "./tools/attached-control";

export interface DiscordAgentToolsOptions {
  readonly analyzeImage?: AgentImageAnalyzer;
  readonly channelApi: Pick<
    DiscordChannelApi,
    "readMessage" | "sendMessage" | "sendChoices" | "sendTyping" | "sendAudio"
  >;
  readonly channelId: string;
  readonly requesterUserId?: () => string | undefined;
  readonly ownerFeaturesAllowed: boolean;
  readonly ownerUserId?: string;
  readonly speak?: (text: string, toolCallId?: string) => Promise<void>;
  readonly tts?: TextToSpeech;
  readonly scheduledTaskStore?: ScheduledTaskStore;
  readonly watchCheckRunner: WatchCheckRunner;
  readonly ownerMemoryStore?: OwnerMemoryStore;
  readonly userMemoryStore?: UserMemoryStore;
  readonly discordUserDirectory?: DiscordUserResolver;
  readonly attachedTasks?: AttachedTaskControl;
}

/**
 * Discord チャンネル用エージェントのツール一式を組み立てる。
 * エージェント本体ではなく composition root から呼ぶ。
 */
export function createDiscordAgentTools(
  options: DiscordAgentToolsOptions,
): readonly ToolDefinition[] {
  const ownerFeaturesAllowed = options.ownerFeaturesAllowed && !!options.ownerUserId;
  const accessScope = ownerFeaturesAllowed
    ? ownerAccessScope(options.ownerUserId!)
    : PUBLIC_ACCESS_SCOPE;
  return [
    createDiscordReadTool(
      options.channelApi,
      options.channelId,
      createDiscordImageAnalysis(options.analyzeImage),
      ownerFeaturesAllowed ? { userId: options.ownerUserId! } : undefined,
    ),
    ...(options.requesterUserId
      ? [createDiscordAskTool(options.channelApi, options.channelId, options.requesterUserId)]
      : []),
    ...(options.speak
      ? [createDiscordSpeakTool(options.speak)]
      : [createDiscordSendTool(options.channelApi, options.channelId)]),
    ...(!options.speak && options.tts
      ? [createDiscordVoiceTool(options.channelApi, options.channelId, options.tts)]
      : []),
    ...(options.scheduledTaskStore
      ? createReminderTools(options.scheduledTaskStore, options.channelId, accessScope)
      : []),
    ...(options.scheduledTaskStore
      ? createWatchTools(
          options.scheduledTaskStore,
          options.channelId,
          accessScope,
          options.watchCheckRunner,
        )
      : []),
    ...(options.attachedTasks
      ? createAttachedControlTools(
          options.attachedTasks,
          options.channelId,
          accessScope,
          ownerFeaturesAllowed,
        )
      : []),
    ...(ownerFeaturesAllowed && options.ownerMemoryStore
      ? createOwnerMemoryTools(options.ownerMemoryStore, `communication:${options.channelId}`)
      : []),
    ...(options.userMemoryStore && options.discordUserDirectory
      ? createUserMemoryTools(options.userMemoryStore, options.discordUserDirectory)
      : []),
  ];
}
