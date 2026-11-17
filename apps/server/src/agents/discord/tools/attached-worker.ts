import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentImageAnalyzer } from "@agents/core/agent-factory";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { WatchCheckRunner } from "@modules/scheduling/ports/watch-check-runner";
import { parseAccessScope } from "@shared/access";
import { createWatchTools } from "@agents/tools/watch";
import { createDiscordImageAnalysis, createDiscordReadTool } from "./discord-read";

/**
 * Tools for an attached agent. The attached agent reads the conversation it
 * belongs to but never writes to the surface. A watch it registers belongs to
 * the worker, so its wake resumes this worker session instead of the
 * conversation session.
 */
export function createAttachedWorkerTools(
  channelApi: Pick<DiscordChannelApi, "readMessage">,
  channelId: string,
  accessScope: string,
  ownerTaskId: string,
  scheduledTaskStore: ScheduledTaskStore,
  watchCheckRunner: WatchCheckRunner,
  requester?: Parameters<DiscordChannelApi["readMessage"]>[1],
  analyzeImage?: AgentImageAnalyzer,
): readonly ToolDefinition[] {
  const parsedAccessScope = parseAccessScope(accessScope);
  if (!parsedAccessScope) {
    throw new Error(`Invalid access scope: ${accessScope}`);
  }
  return [
    createDiscordReadTool(
      channelApi,
      channelId,
      createDiscordImageAnalysis(analyzeImage),
      requester,
    ),
    ...createWatchTools(
      scheduledTaskStore,
      channelId,
      parsedAccessScope,
      watchCheckRunner,
      ownerTaskId,
    ),
  ];
}
