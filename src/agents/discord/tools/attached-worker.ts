import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type { WatchCheckRunner } from "@modules/scheduling/application/watch-check-runner";
import type { ScheduledTaskAccessScope } from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import { createWatchTools } from "@agents/tools/watch";
import { createDiscordReadTool } from "./discord-read";

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
): readonly ToolDefinition[] {
  return [
    createDiscordReadTool(channelApi, channelId, undefined, requester),
    ...createWatchTools(
      scheduledTaskStore,
      channelId,
      accessScope as ScheduledTaskAccessScope,
      watchCheckRunner,
      ownerTaskId,
    ),
  ];
}
