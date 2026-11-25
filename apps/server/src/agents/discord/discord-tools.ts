import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import type { AgentImageAnalyzer } from "@agents/core/agent-factory";
import type { WorkerControl } from "@agents/core/worker-agent";
import type { CodingBackendRegistry } from "@modules/coding/application/coding-backend-registry";
import { createCodingProjectListTool } from "@agents/tools/coding-project";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { DiscordUserResolver } from "@modules/discord/ports/discord-user-resolver";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";
import type { TextToSpeech } from "@modules/tts/ports/text-to-speech";
import type { UserMemoryStore } from "@modules/user-memory/ports/user-memory-store";
import { ownerAccessScope, PUBLIC_ACCESS_SCOPE, type AccessScope } from "@shared/access";
import { createReminderTools } from "../tools/reminder";
import { createProactiveTools, type ProactiveToolCoordinator } from "../tools/proactive";
import { createInitiativeTools, type InitiativeToolCoordinator } from "../tools/initiative";
import { createPromiseGuard, type PromiseGuardMode } from "../tools/promise-guard";
import { createUserMemoryTools } from "../tools/user-memory";
import { createWatchTools } from "../tools/watch";
import { createDiscordAskTool } from "./tools/discord-ask";
import {
  createDiscordChannelHistoryContentTool,
  createDiscordChannelHistoryTool,
  DiscordChannelHistoryStore,
} from "./tools/discord-channel-history";
import { createDiscordImageAnalysis, createDiscordReadTool } from "./tools/discord-read";
import { createDiscordSendTool } from "./tools/discord-send";
import { createDiscordSpeakTool } from "./tools/discord-speak";
import { createDiscordVoiceTool } from "./tools/discord-voice";
import { createWorkerControlTools } from "./tools/worker-control";

export interface DiscordAgentToolsOptions {
  readonly analyzeImage?: AgentImageAnalyzer;
  readonly channelApi: Pick<
    DiscordChannelApi,
    "readMessage" | "readMessages" | "sendMessage" | "sendChoices" | "sendTyping" | "sendAudio"
  >;
  readonly channelId: string;
  readonly requesterUserId?: () => string | undefined;
  readonly ownerFeaturesAllowed: boolean;
  readonly ownerUserId?: string;
  readonly accessScope?: AccessScope;
  readonly speak?: (text: string, toolCallId?: string) => Promise<void>;
  readonly tts?: TextToSpeech;
  readonly scheduledTaskStore?: ScheduledTaskStore;
  readonly watchCheckRunner: WatchCheckRunner;
  readonly userMemoryStore?: UserMemoryStore;
  readonly discordUserDirectory?: DiscordUserResolver;
  readonly workers?: WorkerControl;
  readonly codingBackends?: CodingBackendRegistry;
  readonly sessionFilePath?: () => string | undefined;
  readonly proactive?: ProactiveToolCoordinator;
  readonly initiative?: InitiativeToolCoordinator;
  readonly promiseGuard?: { readonly mode: PromiseGuardMode; readonly logger: Logger };
  readonly onMessageSent?: () => void;
}

/** エージェント本体ではなく composition root から呼ぶ。 */
export function createDiscordAgentTools(
  options: DiscordAgentToolsOptions,
): readonly ToolDefinition[] {
  const ownerUserId =
    options.ownerFeaturesAllowed && options.ownerUserId ? options.ownerUserId : undefined;
  const ownerFeaturesAllowed = ownerUserId !== undefined;
  const accessScope =
    options.accessScope ??
    (ownerUserId !== undefined ? ownerAccessScope(ownerUserId) : PUBLIC_ACCESS_SCOPE);
  const proactive = options.proactive;
  const promiseGuard =
    proactive && options.promiseGuard
      ? createPromiseGuard({
          mode: options.promiseGuard.mode,
          channelId: options.channelId,
          listActiveFollowUps: async () =>
            (await proactive.listFollowUps(options.channelId, accessScope)).filter(
              (followUp) => followUp.status === "active" || followUp.status === "notified",
            ),
          logger: options.promiseGuard.logger,
        })
      : undefined;
  const channelHistoryStore = new DiscordChannelHistoryStore();
  return [
    createDiscordReadTool(
      options.channelApi,
      options.channelId,
      createDiscordImageAnalysis(options.analyzeImage),
      ownerUserId !== undefined ? { userId: ownerUserId } : undefined,
    ),
    createDiscordChannelHistoryTool(
      options.channelApi,
      options.channelId,
      channelHistoryStore,
      ownerUserId !== undefined ? { userId: ownerUserId } : undefined,
    ),
    createDiscordChannelHistoryContentTool(channelHistoryStore),
    ...(options.requesterUserId
      ? [
          createDiscordAskTool(
            options.channelApi,
            options.channelId,
            options.requesterUserId,
            options.onMessageSent,
          ),
        ]
      : []),
    ...(options.speak
      ? [createDiscordSpeakTool(options.speak, options.onMessageSent)]
      : [
          createDiscordSendTool(
            options.channelApi,
            options.channelId,
            promiseGuard,
            options.onMessageSent,
          ),
        ]),
    ...(!options.speak && options.tts
      ? [
          createDiscordVoiceTool(
            options.channelApi,
            options.channelId,
            options.tts,
            options.onMessageSent,
          ),
        ]
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
    ...(options.workers
      ? createWorkerControlTools(
          options.workers,
          options.channelId,
          accessScope,
          ownerFeaturesAllowed,
          options.sessionFilePath,
        )
      : []),
    ...(ownerFeaturesAllowed && options.codingBackends
      ? [createCodingProjectListTool(options.codingBackends)]
      : []),
    ...(options.userMemoryStore && options.discordUserDirectory
      ? createUserMemoryTools(options.userMemoryStore, options.discordUserDirectory)
      : []),
    ...(options.proactive
      ? createProactiveTools(
          options.proactive,
          options.channelId,
          accessScope,
          options.requesterUserId ?? (() => undefined),
          options.ownerUserId,
        )
      : []),
    ...(options.initiative && accessScope !== PUBLIC_ACCESS_SCOPE
      ? createInitiativeTools(options.initiative, options.channelId, accessScope)
      : []),
  ];
}
