import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentImageAnalyzer } from "@agents/core/agent-factory";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";
import type { AccessScope } from "@shared/access";
import type { CodingBackendRegistry } from "@modules/coding/application/coding-backend-registry";
import { createCodingSessionTools } from "@agents/tools/coding-session";
import { createWatchTools } from "@agents/tools/watch";
import { createDiscordImageAnalysis, createDiscordReadTool } from "./discord-read";
import {
  createDiscordUserProfileTool,
  type DiscordUserProfileToolDependencies,
} from "./discord-user-profile";

export function createWorkerTools(
  channelApi: Pick<DiscordChannelApi, "readMessage" | "getChannelLocation">,
  channelId: string,
  accessScope: AccessScope,
  ownerWorkerId: string,
  scheduledTaskStore: ScheduledTaskStore,
  watchCheckRunner: WatchCheckRunner,
  requester?: Parameters<DiscordChannelApi["readMessage"]>[1],
  analyzeImage?: AgentImageAnalyzer,
  codingBackends?: CodingBackendRegistry,
  userProfiles?: DiscordUserProfileToolDependencies,
): readonly ToolDefinition[] {
  return [
    createDiscordReadTool(
      channelApi,
      channelId,
      createDiscordImageAnalysis(analyzeImage),
      requester,
    ),
    ...(userProfiles ? [createDiscordUserProfileTool(channelApi, channelId, userProfiles)] : []),
    ...createWatchTools(
      scheduledTaskStore,
      channelId,
      accessScope,
      watchCheckRunner,
      ownerWorkerId,
    ),
    ...(codingBackends ? createCodingSessionTools(codingBackends) : []),
  ];
}
