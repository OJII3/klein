import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentImageAnalyzer } from "@agents/core/agent-factory";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";
import type { AccessScope } from "@shared/access";
import { createT3ThreadTools, type T3ThreadRunner } from "@agents/tools/t3-thread";
import { createWatchTools } from "@agents/tools/watch";
import { createDiscordImageAnalysis, createDiscordReadTool } from "./discord-read";

/**
 * Tools for an attached agent. The attached agent reads the conversation it
 * belongs to but never writes to the surface. A watch it registers belongs to
 * the worker, so its wake resumes this worker session instead of the
 * conversation session. An owner-scoped worker also receives the T3 Code
 * thread tools, which let it hand coding work to a T3 Code agent.
 */
export function createAttachedWorkerTools(
  channelApi: Pick<DiscordChannelApi, "readMessage">,
  channelId: string,
  accessScope: AccessScope,
  ownerTaskId: string,
  scheduledTaskStore: ScheduledTaskStore,
  watchCheckRunner: WatchCheckRunner,
  requester?: Parameters<DiscordChannelApi["readMessage"]>[1],
  analyzeImage?: AgentImageAnalyzer,
  t3ThreadRunner?: T3ThreadRunner,
): readonly ToolDefinition[] {
  return [
    createDiscordReadTool(
      channelApi,
      channelId,
      createDiscordImageAnalysis(analyzeImage),
      requester,
    ),
    ...createWatchTools(scheduledTaskStore, channelId, accessScope, watchCheckRunner, ownerTaskId),
    ...(t3ThreadRunner ? createT3ThreadTools(t3ThreadRunner) : []),
  ];
}
