import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentImageAnalyzer } from "@agents/core/agent-factory";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";
import type { AccessScope } from "@shared/access";
import { createT3ProjectListTool, type T3ProjectLister } from "@agents/tools/t3-project";
import { createT3ThreadTools, type T3ThreadRunner } from "@agents/tools/t3-thread";
import { createWatchTools } from "@agents/tools/watch";
import { createDiscordImageAnalysis, createDiscordReadTool } from "./discord-read";
import {
  createDiscordUserProfileTool,
  type DiscordUserProfileToolDependencies,
} from "./discord-user-profile";

/**
 * Tools for a worker. The worker reads the conversation it
 * belongs to but never writes to the surface. A watch it registers belongs to
 * the worker, so its wake resumes this worker session instead of the
 * conversation session. An owner-scoped worker also receives the T3 Code
 * project and thread tools, which let it hand coding work to a T3 Code agent.
 */
export function createWorkerTools(
  channelApi: Pick<DiscordChannelApi, "readMessage" | "getChannelLocation">,
  channelId: string,
  accessScope: AccessScope,
  ownerWorkerId: string,
  scheduledTaskStore: ScheduledTaskStore,
  watchCheckRunner: WatchCheckRunner,
  requester?: Parameters<DiscordChannelApi["readMessage"]>[1],
  analyzeImage?: AgentImageAnalyzer,
  t3ThreadRunner?: T3ThreadRunner,
  t3ProjectLister?: T3ProjectLister,
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
    ...(t3ProjectLister ? [createT3ProjectListTool(t3ProjectLister)] : []),
    ...(t3ThreadRunner ? createT3ThreadTools(t3ThreadRunner) : []),
  ];
}
